// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {WorldDeployer} from "../script/WorldDeployer.sol";
import {Land} from "../src/Land.sol";

contract LandTest is Test, WorldDeployer {
    World internal world;
    Land internal land;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        world = _deployWorld(address(this));
        land = world.land;
    }

    function _claim(address player) internal returns (uint256) {
        vm.prank(player);
        return world.registry.createCharacter();
    }

    function test_FirstLandSitsAtTheCentre() public {
        uint256 id = _claim(alice);
        assertEq(id, 1);
        assertEq(land.ownerOf(1), alice);
        assertEq(land.landOf(alice), 1);
        (int32 x, int32 y) = land.coordinatesOf(1);
        assertEq(x, 0);
        assertEq(y, 0);
        assertEq(land.landAt(0, 0), 1);
    }

    function test_NoDuplicateCoordinates() public {
        uint256 count = 300;
        for (uint256 i = 1; i <= count; ++i) {
            uint256 id = _claim(address(uint160(0x10000 + i)));
            (int32 x, int32 y) = land.coordinatesOf(id);
            assertEq(land.landAt(x, y), id, "coordinate already taken");
        }
        assertEq(land.totalLands(), count);
    }

    function test_SpiralMatchesSharedRules() public view {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../packages/shared/test-vectors/spiral.json"));
        uint256[] memory ns = vm.parseJsonUintArray(json, ".n");
        int256[] memory xs = vm.parseJsonIntArray(json, ".x");
        int256[] memory ys = vm.parseJsonIntArray(json, ".y");
        assertGt(ns.length, 200);
        for (uint256 i = 0; i < ns.length; ++i) {
            (int32 x, int32 y) = land.spiralCoordinates(ns[i]);
            assertEq(int256(x), xs[i], "x");
            assertEq(int256(y), ys[i], "y");
        }
    }

    function testFuzz_OnlyRegistryMints(address caller) public {
        vm.assume(caller != address(world.registry));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Land.NotRegistry.selector, caller));
        land.mint(caller);
    }

    function test_RevertWhen_RegistryMintsTwiceForOneWallet() public {
        _claim(alice);
        vm.prank(address(world.registry));
        vm.expectRevert(abi.encodeWithSelector(Land.AlreadyHasLand.selector, alice));
        land.mint(alice);
    }

    function test_RevertWhen_Transferred() public {
        _claim(alice);
        vm.startPrank(alice);
        vm.expectRevert(Land.Soulbound.selector);
        land.transferFrom(alice, bob, 1);
        vm.expectRevert(Land.Soulbound.selector);
        land.safeTransferFrom(alice, bob, 1);
        vm.expectRevert(Land.Soulbound.selector);
        land.approve(bob, 1);
        vm.expectRevert(Land.Soulbound.selector);
        land.setApprovalForAll(bob, true);
        vm.stopPrank();
        assertEq(land.ownerOf(1), alice);
    }

    function test_OwnerSetsDesignHash() public {
        _claim(alice);
        vm.prank(alice);
        vm.expectEmit(address(land));
        emit Land.DesignHashSet(1, keccak256("design"));
        land.setDesignHash(1, keccak256("design"));
        assertEq(land.designHashOf(1), keccak256("design"));
    }

    function test_RevertWhen_NonOwnerSetsDesignHash() public {
        _claim(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Land.NotLandOwner.selector, 1, bob));
        land.setDesignHash(1, keccak256("design"));
    }

    function test_RevertWhen_CoordinatesOfUnknownLand() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        land.coordinatesOf(7);
    }

    function test_RegistryIsSetOnce() public {
        vm.expectRevert(Land.RegistryAlreadySet.selector);
        land.setRegistry(bob);
    }

    function test_RevertWhen_NonOwnerUpgrades() public {
        address next = address(new Land());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        land.upgradeToAndCall(next, "");
    }
}
