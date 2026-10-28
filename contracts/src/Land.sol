// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice A Land: one 64×64 plot per wallet at a fixed spiral coordinate (PLAN.md section 5.1).
/// Lands are soulbound: a Land is the world its owner hosts on their own machine (ADR 0002).
/// Only `PlayerRegistry` mints, together with the Character.
contract Land is ERC721Upgradeable, OwnableUpgradeable, UUPSUpgradeable {
    struct Coordinates {
        int32 x;
        int32 y;
    }

    address public registry;
    uint256 public totalLands;
    mapping(address owner => uint256 landId) public landOf;
    mapping(int32 x => mapping(int32 y => uint256 landId)) public landAt;
    mapping(uint256 landId => bytes32 designHash) public designHashOf;
    mapping(uint256 landId => Coordinates) private _coordinates;

    event RegistrySet(address indexed registry);
    event LandMinted(uint256 indexed landId, address indexed owner, int32 x, int32 y);
    event DesignHashSet(uint256 indexed landId, bytes32 designHash);

    error Soulbound();
    error NotRegistry(address caller);
    error RegistryAlreadySet();
    error AlreadyHasLand(address owner);
    error NotLandOwner(uint256 landId, address caller);
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        __ERC721_init("linked-realms Land", "LAND");
        __Ownable_init(owner_);
    }

    /// @notice Set once, right after deployment: Land and PlayerRegistry each need the other's address.
    function setRegistry(address registry_) external onlyOwner {
        if (registry != address(0)) revert RegistryAlreadySet();
        if (registry_ == address(0)) revert ZeroAddress();
        registry = registry_;
        emit RegistrySet(registry_);
    }

    function mint(address to) external returns (uint256 landId) {
        if (msg.sender != registry) revert NotRegistry(msg.sender);
        if (landOf[to] != 0) revert AlreadyHasLand(to);
        landId = ++totalLands;
        (int32 x, int32 y) = spiralCoordinates(landId - 1);
        landOf[to] = landId;
        landAt[x][y] = landId;
        _coordinates[landId] = Coordinates(x, y);
        _mint(to, landId);
        emit LandMinted(landId, to, x, y);
    }

    function setDesignHash(uint256 landId, bytes32 designHash) external {
        if (_ownerOf(landId) != msg.sender) revert NotLandOwner(landId, msg.sender);
        designHashOf[landId] = designHash;
        emit DesignHashSet(landId, designHash);
    }

    function coordinatesOf(uint256 landId) external view returns (int32 x, int32 y) {
        _requireOwned(landId);
        Coordinates memory c = _coordinates[landId];
        return (c.x, c.y);
    }

    /// @notice Coordinates of spiral index `n`; must match `spiralCoordinates` in packages/shared (P9).
    function spiralCoordinates(uint256 n) public pure returns (int32 x, int32 y) {
        if (n == 0) return (0, 0);
        // Ring k holds indices (2k-1)^2 .. (2k+1)^2 - 1; the integer division is intended.
        // slither-disable-next-line divide-before-multiply
        uint256 k = (Math.sqrt(n) + 1) / 2;
        int256 ki = SafeCast.toInt256(k);
        int256 t = SafeCast.toInt256(n - (2 * k - 1) ** 2);
        if (t < 2 * ki) return (_int32(ki), _int32(-ki + 1 + t));
        if (t < 4 * ki) return (_int32(ki - 1 - (t - 2 * ki)), _int32(ki));
        if (t < 6 * ki) return (_int32(-ki), _int32(ki - 1 - (t - 4 * ki)));
        return (_int32(-ki + 1 + (t - 6 * ki)), _int32(-ki));
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    /// @dev Every ownership change other than the mint reverts.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _int32(int256 value) private pure returns (int32) {
        return SafeCast.toInt32(value);
    }
}
