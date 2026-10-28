// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Rules} from "../src/generated/Rules.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";
import {WorldDeployer} from "../script/WorldDeployer.sol";

contract PlayerRegistryTest is Test, WorldDeployer {
    World internal world;
    PlayerRegistry internal registry;
    address internal alice = makeAddr("alice");

    function setUp() public {
        world = _deployWorld(address(this));
        registry = world.registry;
    }

    function test_CreatesCharacterWithEveryStatAtOne() public {
        bytes32[] memory keys = registry.statKeys();
        assertEq(keys.length, 4);
        assertEq(keys[0], bytes32("strength"));
        assertEq(keys[1], bytes32("agility"));
        assertEq(keys[2], bytes32("intelligence"));
        assertEq(keys[3], bytes32("stamina"));

        vm.expectEmit(address(registry));
        emit PlayerRegistry.StatChanged(alice, "strength", 1);
        vm.prank(alice);
        uint256 landId = registry.createCharacter();

        assertTrue(registry.hasCharacter(alice));
        for (uint256 i = 0; i < keys.length; ++i) {
            assertEq(registry.statOf(alice, keys[i]), Rules.INITIAL_STAT_VALUE);
        }
        assertEq(registry.statOf(alice, "charisma"), 0, "unknown stat");
        assertEq(world.land.ownerOf(landId), alice, "Land minted with the Character");
    }

    function test_EmitsCharacterCreated() public {
        vm.expectEmit(address(registry));
        emit PlayerRegistry.CharacterCreated(alice, 1);
        vm.prank(alice);
        registry.createCharacter();
    }

    function testFuzz_OneCharacterPerWallet(address player) public {
        vm.assume(player != address(0));
        vm.startPrank(player);
        registry.createCharacter();
        vm.expectRevert(abi.encodeWithSelector(PlayerRegistry.CharacterExists.selector, player));
        registry.createCharacter();
        vm.stopPrank();
        assertEq(world.land.balanceOf(player), 1);
    }

    function test_RevertWhen_InitialisedTwice() public {
        vm.expectRevert();
        registry.initialize(address(this), world.land, Rules.characterStatKeys(), 1);
    }

    function test_RevertWhen_NonOwnerUpgrades() public {
        address next = address(new PlayerRegistry());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        registry.upgradeToAndCall(next, "");
    }
}
