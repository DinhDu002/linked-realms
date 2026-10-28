// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Land} from "./Land.sol";

/// @notice One soulbound Character per wallet. Stats are key–value pairs (P10) so new stats can be
/// added later without migrating data. Creating a Character also mints the wallet's Land (ADR 0002).
contract PlayerRegistry is OwnableUpgradeable, UUPSUpgradeable {
    Land public land;
    uint256 public initialStatValue;
    bytes32[] private _statKeys;
    mapping(address player => bool) public hasCharacter;
    mapping(address player => mapping(bytes32 key => uint256 value)) private _stats;

    event CharacterCreated(address indexed player, uint256 indexed landId);
    event StatChanged(address indexed player, bytes32 indexed key, uint256 value);

    error CharacterExists(address player);
    error NoStatKeys();

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, Land land_, bytes32[] calldata statKeys_, uint256 initialStatValue_)
        external
        initializer
    {
        if (statKeys_.length == 0) revert NoStatKeys();
        __Ownable_init(owner_);
        land = land_;
        _statKeys = statKeys_;
        initialStatValue = initialStatValue_;
    }

    function createCharacter() external returns (uint256 landId) {
        if (hasCharacter[msg.sender]) revert CharacterExists(msg.sender);
        hasCharacter[msg.sender] = true;
        uint256 value = initialStatValue;
        uint256 count = _statKeys.length;
        for (uint256 i = 0; i < count; ++i) {
            bytes32 key = _statKeys[i];
            _stats[msg.sender][key] = value;
            emit StatChanged(msg.sender, key, value);
        }
        // `land` is our own contract and mints with _mint (no receiver callback), so the event order is safe.
        // slither-disable-next-line reentrancy-events
        landId = land.mint(msg.sender);
        emit CharacterCreated(msg.sender, landId);
    }

    function statOf(address player, bytes32 key) external view returns (uint256) {
        return _stats[player][key];
    }

    function statKeys() external view returns (bytes32[] memory) {
        return _statKeys;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
