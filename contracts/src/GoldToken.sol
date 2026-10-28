// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ERC20CappedUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20CappedUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice Gold (`GOLD`). Created only as Round rewards by `GoldMine`, with a capped supply (P4).
contract GoldToken is ERC20CappedUpgradeable, OwnableUpgradeable, UUPSUpgradeable {
    address public minter;

    event MinterSet(address indexed minter);

    error NotMinter(address caller);
    error MinterAlreadySet();
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, uint256 cap_) external initializer {
        __ERC20_init("linked-realms Gold", "GOLD");
        __ERC20Capped_init(cap_);
        __Ownable_init(owner_);
    }

    /// @notice Set once, right after deployment, to the `GoldMine` proxy.
    function setMinter(address minter_) external onlyOwner {
        if (minter != address(0)) revert MinterAlreadySet();
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterSet(minter_);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _mint(to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
