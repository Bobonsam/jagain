// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "reactive-lib/abstract-base/AbstractCallback.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "v2-core/interfaces/IUniswapV2Pair.sol";
import "v2-periphery/interfaces/IUniswapV2Router02.sol";

/**
 * @title SentinelCallback
 * @notice Destination-chain half of Sentinel (deployed per user on Base Sepolia).
 *
 * The owner creates protection orders against a Uniswap V2 pair:
 *  - StopLoss:     sell when the price falls to `triggerPrice`.
 *  - TakeProfit:   sell when the price rises to `triggerPrice`.
 *  - TrailingStop: sell when the price falls `trailBps` below its observed peak.
 *                  `triggerPrice` records the price when the order was created;
 *                  the matching SentinelReactive contract tracks the peak and
 *                  passes the live stop level in as `effectiveTrigger`.
 *
 * This contract never watches anything itself. A SentinelReactive contract on
 * the Reactive Network observes the pair's `Sync` events and, when a trigger
 * is crossed, calls {executeOrder} back through the Reactive callback proxy.
 * Execution re-verifies the price from the pair's live reserves before it
 * swaps, so a stale or forged trigger cannot force a bad trade.
 *
 * Prices are quoted scaled by `coefficient` (e.g. 10_000 = 4 decimal places):
 * price(sell token0) = reserve1 * coefficient / reserve0.
 */
contract SentinelCallback is AbstractCallback {
    using SafeERC20 for IERC20;

    enum Kind {
        StopLoss,
        TakeProfit,
        TrailingStop
    }

    enum Status {
        Active,
        Paused,
        Cancelled,
        Executed,
        Failed
    }

    struct Order {
        address pair;
        bool sellToken0;
        uint256 amount;
        uint256 coefficient;
        uint256 triggerPrice;
        Kind kind;
        uint256 trailBps;
        Status status;
    }

    event OrderCreated(
        address indexed pair,
        uint256 indexed orderId,
        bool sellToken0,
        uint256 amount,
        uint256 coefficient,
        uint256 triggerPrice,
        uint8 kind,
        uint256 trailBps
    );
    event OrderCancelled(uint256 indexed orderId);
    event OrderPaused(uint256 indexed orderId);
    event OrderResumed(uint256 indexed orderId);
    event OrderExecuted(address indexed pair, uint256 indexed orderId, uint256 amountIn, uint256 amountOut);

    /// @notice Slippage guard applied to the expected output at trigger time (5%).
    uint256 private constant SLIPPAGE_NUM = 95;
    uint256 private constant SLIPPAGE_DEN = 100;

    address public immutable owner;
    IUniswapV2Router02 public immutable router;

    Order[] public orders;

    modifier onlyOwner() {
        require(msg.sender == owner, "Sentinel: not owner");
        _;
    }

    constructor(address _owner, address _callbackProxy, address _router) AbstractCallback(_callbackProxy) payable {
        owner = _owner;
        router = IUniswapV2Router02(_router);
    }

    // ---------------------------------------------------------------- orders

    function createOrder(
        address pair,
        bool sellToken0,
        uint256 amount,
        uint256 coefficient,
        uint256 triggerPrice,
        Kind kind,
        uint256 trailBps
    ) external onlyOwner returns (uint256 orderId) {
        require(pair != address(0), "Sentinel: pair is zero");
        require(amount > 0, "Sentinel: amount is zero");
        require(coefficient > 0, "Sentinel: coefficient is zero");
        require(triggerPrice > 0, "Sentinel: trigger is zero");
        if (kind == Kind.TrailingStop) {
            require(trailBps > 0 && trailBps <= 5_000, "Sentinel: trail out of range");
        }

        orderId = orders.length;
        orders.push(
            Order({
                pair: pair,
                sellToken0: sellToken0,
                amount: amount,
                coefficient: coefficient,
                triggerPrice: triggerPrice,
                kind: kind,
                trailBps: trailBps,
                status: Status.Active
            })
        );

        emit OrderCreated(pair, orderId, sellToken0, amount, coefficient, triggerPrice, uint8(kind), trailBps);
    }

    function cancelOrder(uint256 orderId) external onlyOwner {
        Order storage order = _order(orderId);
        require(order.status == Status.Active || order.status == Status.Paused, "Sentinel: not cancellable");
        order.status = Status.Cancelled;
        emit OrderCancelled(orderId);
    }

    function pauseOrder(uint256 orderId) external onlyOwner {
        Order storage order = _order(orderId);
        require(order.status == Status.Active, "Sentinel: not active");
        order.status = Status.Paused;
        emit OrderPaused(orderId);
    }

    function resumeOrder(uint256 orderId) external onlyOwner {
        Order storage order = _order(orderId);
        require(order.status == Status.Paused, "Sentinel: not paused");
        order.status = Status.Active;
        emit OrderResumed(orderId);
    }

    // ------------------------------------------------------------- execution

    /**
     * @notice Called only by the Reactive callback proxy when SentinelReactive
     *         reports a crossed trigger.
     * @param orderId        The order to execute.
     * @param effectiveTrigger The trigger level the reactive contract fired on.
     *        For StopLoss/TakeProfit this must equal the order's triggerPrice;
     *        for TrailingStop it is the live (ratcheted) stop level.
     */
    function executeOrder(address, uint256 orderId, uint256 effectiveTrigger) external authorizedSenderOnly {
        Order storage order = _order(orderId);
        require(order.status == Status.Active, "Sentinel: order not active");

        if (order.kind != Kind.TrailingStop) {
            require(effectiveTrigger == order.triggerPrice, "Sentinel: trigger mismatch");
        } else {
            require(effectiveTrigger > 0, "Sentinel: trigger is zero");
        }

        IUniswapV2Pair pair = IUniswapV2Pair(order.pair);
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        uint256 price = _price(order.sellToken0, reserve0, reserve1, order.coefficient);

        if (order.kind == Kind.TakeProfit) {
            require(price >= effectiveTrigger, "Sentinel: price below take-profit");
        } else {
            require(price <= effectiveTrigger, "Sentinel: price above stop");
        }

        address tokenIn = order.sellToken0 ? pair.token0() : pair.token1();
        address tokenOut = order.sellToken0 ? pair.token1() : pair.token0();

        IERC20(tokenIn).safeTransferFrom(owner, address(this), order.amount);
        IERC20(tokenIn).forceApprove(address(router), order.amount);

        uint256 expectedOut = Math.mulDiv(order.amount, effectiveTrigger, order.coefficient);
        uint256 minOut = (expectedOut * SLIPPAGE_NUM) / SLIPPAGE_DEN;

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts =
            router.swapExactTokensForTokens(order.amount, minOut, path, owner, block.timestamp + 600);

        order.status = Status.Executed;
        emit OrderExecuted(order.pair, orderId, order.amount, amounts[amounts.length - 1]);
    }

    // ------------------------------------------------------------------ misc

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _order(orderId);
    }

    /// @notice Current pair price for an order's direction, scaled by its coefficient.
    function currentPrice(uint256 orderId) external view returns (uint256) {
        Order storage order = _order(orderId);
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(order.pair).getReserves();
        return _price(order.sellToken0, reserve0, reserve1, order.coefficient);
    }

    /// @notice Recover ETH or tokens stuck in this contract (owner only).
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "Sentinel: rescue failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // -------------------------------------------------------------- internal

    function _order(uint256 orderId) internal view returns (Order storage) {
        require(orderId < orders.length, "Sentinel: no such order");
        return orders[orderId];
    }

    function _price(bool sellToken0, uint112 reserve0, uint112 reserve1, uint256 coefficient)
        internal
        pure
        returns (uint256)
    {
        if (sellToken0) {
            return Math.mulDiv(uint256(reserve1), coefficient, uint256(reserve0));
        }
        return Math.mulDiv(uint256(reserve0), coefficient, uint256(reserve1));
    }
}
