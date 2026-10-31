// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/// @title HyperPumpToken
/// @notice Fixed-supply ERC-20 deployed as a minimal clone by HyperPumpFactory.
/// There is no owner, no mint after initialization, no blacklist and no tax.
/// The only restriction: until the bonding curve graduates, nobody may send
/// tokens to the token's future DEX pair, not even the factory (so a curve buy
/// cannot name the pair as recipient). That stops anyone from seeding the pair
/// and owning its first LP shares before liquidity migrates. The factory marks
/// the token graduated before it funds the pair.
contract HyperPumpToken is ERC20Upgradeable {
    address public factory;
    address public pair;
    bool public graduated;

    error OnlyFactory();
    error PairLockedUntilGraduation();

    constructor() {
        _disableInitializers();
    }

    function initialize(string calldata name_, string calldata symbol_, uint256 supply, address pair_) external initializer {
        __ERC20_init(name_, symbol_);
        factory = msg.sender;
        pair = pair_;
        _mint(msg.sender, supply);
    }

    function markGraduated() external {
        if (msg.sender != factory) revert OnlyFactory();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && to == pair) revert PairLockedUntilGraduation();
        super._update(from, to, value);
    }
}
