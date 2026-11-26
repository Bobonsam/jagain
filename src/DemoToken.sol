// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoToken
/// @notice Freely mintable ERC-20 used only to demonstrate Sentinel on testnet.
///         It has no value and no mainnet counterpart.
contract DemoToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Anyone can mint on testnet — this token exists purely as demo liquidity.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
