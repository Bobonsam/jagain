// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "reactive-lib/interfaces/IReactive.sol";
import "reactive-lib/abstract-base/AbstractReactive.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SentinelReactive
 * @notice Reactive half of Sentinel, deployed on the Reactive Network (Lasna).
 *
 * It watches one user's SentinelCallback contract on Base Sepolia:
 *  - When the owner creates an order, this contract starts tracking it and
 *    subscribes to the traded pair's Uniswap V2 `Sync` events.
 *  - On every `Sync`, it recomputes the pair price from the event's reserves
 *    and checks each active order on that pair:
 *      StopLoss     fires when price <= trigger
 *      TakeProfit   fires when price >= trigger
 *      TrailingStop ratchets a stop level up behind the highest price seen
 *                   (stop = peak * (10_000 - trailBps) / 10_000) and fires
 *                   when the price falls back to that level.
 *  - A crossed trigger emits a `Callback` to Base Sepolia, which the Reactive
 *    Network delivers to SentinelCallback.executeOrder. The callback contract
 *    re-verifies the price on-chain before swapping.
 *  - When an order is executed or cancelled, tracking stops; when a pair has
 *    no orders left, the `Sync` subscription is dropped.
 *
 * No server, keeper or cron job is involved: the contract reacts to events
 * on its own, which is the entire point of the Reactive Network.
 */
contract SentinelReactive is IReactive, AbstractReactive {
    // -------------------------------------------------------------- constants

    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84532;

    uint256 private constant SYNC_TOPIC_0 =
        0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1; // Sync(uint112,uint112)
    uint256 private constant ORDER_CREATED_TOPIC_0 =
        0xe5f4bfc11585eea2384e5b7db9a6b061ca2dec75ad70c8e7602bcece3c46a80d; // OrderCreated(address,uint256,bool,uint256,uint256,uint256,uint8,uint256)
    uint256 private constant ORDER_CANCELLED_TOPIC_0 =
        0x61b9399f2f0f32ca39ce8d7be32caed5ec22fe07a6daba3a467ed479ec606582; // OrderCancelled(uint256)
    uint256 private constant ORDER_EXECUTED_TOPIC_0 =
        0x73175b857aaab88954249d56aa482abb7402f221b484927103a33f78f8c851a5; // OrderExecuted(address,uint256,uint256,uint256)
    uint256 private constant ORDER_PAUSED_TOPIC_0 =
        0xb2aa97a59862c8fed8c78bbcc3e42be45ee4c3859bdde1dd13b09583d7a7b022; // OrderPaused(uint256)
    uint256 private constant ORDER_RESUMED_TOPIC_0 =
        0x8ff350fd005bad03f5006956e5e01218ef5bed91c6ddb7470b9875aa3b49c3b4; // OrderResumed(uint256)

    uint64 private constant CALLBACK_GAS_LIMIT = 1_000_000;
    uint256 private constant TRIGGER_COOLDOWN = 60; // seconds between trigger attempts per order
    uint8 private constant MAX_TRIGGER_ATTEMPTS = 5;

    uint8 private constant KIND_STOP_LOSS = 0;
    uint8 private constant KIND_TAKE_PROFIT = 1;
    uint8 private constant KIND_TRAILING_STOP = 2;

    uint8 private constant STATUS_ACTIVE = 0;
    uint8 private constant STATUS_PAUSED = 1;
    uint8 private constant STATUS_CANCELLED = 2;
    uint8 private constant STATUS_EXECUTED = 3;
    uint8 private constant STATUS_FAILED = 4;

    // ------------------------------------------------------------------ types

    struct TrackedOrder {
        bool exists;
        address pair;
        bool sellToken0;
        uint256 coefficient;
        uint256 triggerPrice;
        uint8 kind;
        uint256 trailBps;
        uint8 status;
        // TrailingStop bookkeeping
        uint256 startPrice;
        uint256 peakPrice;
        uint256 stopLevel;
        // Retry bookkeeping
        uint256 lastTriggeredAt;
        uint8 triggerCount;
    }

    struct Reserves {
        uint112 reserve0;
        uint112 reserve1;
    }

    // ----------------------------------------------------------------- events

    event OrderTracked(address indexed pair, uint256 indexed orderId);
    event OrderUntracked(address indexed pair, uint256 indexed orderId);
    event PairSubscribed(address indexed pair);
    event PairUnsubscribed(address indexed pair);
    event TrailingStopUpdated(uint256 indexed orderId, uint256 peakPrice, uint256 stopLevel);
    event ExecutionTriggered(uint256 indexed orderId, address indexed pair, uint256 price, uint256 effectiveTrigger);
    event TriggerDropped(uint256 indexed orderId, string reason);

    // ------------------------------------------------------------------ state

    address public immutable owner;
    address public immutable sentinelCallback;

    mapping(uint256 => TrackedOrder) public trackedOrders;
    mapping(address => uint256[]) public pairOrders;
    mapping(address => uint256) public pairOrderCount;
    mapping(address => bool) public subscribedPairs;

    constructor(address _owner, address _sentinelCallback) payable {
        owner = _owner;
        sentinelCallback = _sentinelCallback;

        if (!vm) {
            service.subscribe(
                BASE_SEPOLIA_CHAIN_ID, sentinelCallback, ORDER_CREATED_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
            );
            service.subscribe(
                BASE_SEPOLIA_CHAIN_ID, sentinelCallback, ORDER_CANCELLED_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
            );
            service.subscribe(
                BASE_SEPOLIA_CHAIN_ID, sentinelCallback, ORDER_EXECUTED_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
            );
            service.subscribe(
                BASE_SEPOLIA_CHAIN_ID, sentinelCallback, ORDER_PAUSED_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
            );
            service.subscribe(
                BASE_SEPOLIA_CHAIN_ID, sentinelCallback, ORDER_RESUMED_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
            );
        }
    }

    // ------------------------------------------------------------------ react

    function react(LogRecord calldata log) external vmOnly {
        if (log._contract == sentinelCallback) {
            if (log.topic_0 == ORDER_CREATED_TOPIC_0) {
                _onOrderCreated(log);
            } else if (log.topic_0 == ORDER_CANCELLED_TOPIC_0) {
                _onOrderClosed(log, STATUS_CANCELLED, false);
            } else if (log.topic_0 == ORDER_EXECUTED_TOPIC_0) {
                _onOrderClosed(log, STATUS_EXECUTED, true);
            } else if (log.topic_0 == ORDER_PAUSED_TOPIC_0) {
                _setStatus(uint256(log.topic_1), STATUS_PAUSED);
            } else if (log.topic_0 == ORDER_RESUMED_TOPIC_0) {
                _setStatus(uint256(log.topic_1), STATUS_ACTIVE);
            }
        } else if (log.topic_0 == SYNC_TOPIC_0 && subscribedPairs[log._contract]) {
            _onSync(log);
        }
    }

    // --------------------------------------------------------- lifecycle logs

    function _onOrderCreated(LogRecord calldata log) internal {
        address pair = address(uint160(log.topic_1));
        uint256 orderId = uint256(log.topic_2);
        (bool sellToken0, , uint256 coefficient, uint256 triggerPrice, uint8 kind, uint256 trailBps) =
            abi.decode(log.data, (bool, uint256, uint256, uint256, uint8, uint256));

        TrackedOrder storage order = trackedOrders[orderId];
        order.exists = true;
        order.pair = pair;
        order.sellToken0 = sellToken0;
        order.coefficient = coefficient;
        order.triggerPrice = triggerPrice;
        order.kind = kind;
        order.trailBps = trailBps;
        order.status = STATUS_ACTIVE;

        pairOrders[pair].push(orderId);
        if (pairOrderCount[pair] == 0) {
            subscribedPairs[pair] = true;
            service.subscribe(BASE_SEPOLIA_CHAIN_ID, pair, SYNC_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            emit PairSubscribed(pair);
        }
        pairOrderCount[pair]++;

        emit OrderTracked(pair, orderId);
    }

    /// @param executedTopic True when the order id is topic_2 (OrderExecuted),
    ///        false when it is topic_1 (OrderCancelled).
    function _onOrderClosed(LogRecord calldata log, uint8 newStatus, bool executedTopic) internal {
        uint256 orderId = executedTopic ? uint256(log.topic_2) : uint256(log.topic_1);
        TrackedOrder storage order = trackedOrders[orderId];
        if (!order.exists) return;

        order.status = newStatus;
        address pair = order.pair;
        emit OrderUntracked(pair, orderId);

        if (pairOrderCount[pair] > 0) {
            pairOrderCount[pair]--;
        }
        if (pairOrderCount[pair] == 0 && subscribedPairs[pair]) {
            subscribedPairs[pair] = false;
            service.unsubscribe(BASE_SEPOLIA_CHAIN_ID, pair, SYNC_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
            emit PairUnsubscribed(pair);
        }
    }

    function _setStatus(uint256 orderId, uint8 status) internal {
        if (trackedOrders[orderId].exists) {
            trackedOrders[orderId].status = status;
        }
    }

    // --------------------------------------------------------------- sync log

    function _onSync(LogRecord calldata log) internal {
        address pair = log._contract;
        Reserves memory reserves = abi.decode(log.data, (Reserves));

        uint256[] storage ids = pairOrders[pair];
        for (uint256 i = 0; i < ids.length; i++) {
            TrackedOrder storage order = trackedOrders[ids[i]];
            if (!order.exists || order.status != STATUS_ACTIVE) continue;

            uint256 price = order.sellToken0
                ? Math.mulDiv(uint256(reserves.reserve1), order.coefficient, uint256(reserves.reserve0))
                : Math.mulDiv(uint256(reserves.reserve0), order.coefficient, uint256(reserves.reserve1));

            uint256 effectiveTrigger = order.triggerPrice;
            bool crossed;

            if (order.kind == KIND_TRAILING_STOP) {
                if (order.startPrice == 0) {
                    order.startPrice = price;
                    order.peakPrice = price;
                    order.stopLevel = (price * (10_000 - order.trailBps)) / 10_000;
                    emit TrailingStopUpdated(ids[i], order.peakPrice, order.stopLevel);
                } else if (price > order.peakPrice) {
                    order.peakPrice = price;
                    order.stopLevel = (price * (10_000 - order.trailBps)) / 10_000;
                    emit TrailingStopUpdated(ids[i], order.peakPrice, order.stopLevel);
                }
                effectiveTrigger = order.stopLevel;
                crossed = price <= order.stopLevel;
            } else if (order.kind == KIND_TAKE_PROFIT) {
                crossed = price >= order.triggerPrice;
            } else {
                crossed = price <= order.triggerPrice;
            }

            if (!crossed) continue;

            if (order.lastTriggeredAt > 0 && block.timestamp < order.lastTriggeredAt + TRIGGER_COOLDOWN) {
                continue;
            }
            if (order.triggerCount >= MAX_TRIGGER_ATTEMPTS) {
                order.status = STATUS_FAILED;
                emit TriggerDropped(ids[i], "max trigger attempts reached");
                continue;
            }

            order.lastTriggeredAt = block.timestamp;
            order.triggerCount++;
            emit ExecutionTriggered(ids[i], pair, price, effectiveTrigger);
            emit Callback(
                BASE_SEPOLIA_CHAIN_ID,
                sentinelCallback,
                CALLBACK_GAS_LIMIT,
                abi.encodeWithSignature("executeOrder(address,uint256,uint256)", address(0), ids[i], effectiveTrigger)
            );
        }
    }
}
