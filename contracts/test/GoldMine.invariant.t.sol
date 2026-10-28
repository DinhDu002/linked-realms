// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Rules} from "../src/generated/Rules.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {MineHelpers} from "./MineHelpers.sol";

/// Drives the Mine with valid wins, invalid attempts and time jumps.
contract MineHandler is MineHelpers {
    World internal world;
    address[3] internal owners;
    uint256 public wins;
    uint256 public paid;

    constructor(World memory world_) {
        world = world_;
        for (uint256 i = 0; i < owners.length; ++i) {
            owners[i] = address(uint160(0xA11CE + i));
            _claimLand(world, owners[i]);
        }
    }

    function win(uint256 who, uint256 secondsLater) external {
        vm.warp(block.timestamp + bound(secondsLater, 0, 1 days));
        address wallet = owners[who % owners.length];
        uint256 before = world.gold.balanceOf(wallet);
        _win(world, wallet);
        paid += world.gold.balanceOf(wallet) - before;
        ++wins;
    }

    /// A modified Map server reporting a nonce that is not a Solution never gets Gold (P3).
    function cheat(uint256 who, uint256 nonce) external {
        address wallet = owners[who % owners.length];
        (, bytes32 challenge, uint256 target,) = world.mine.currentRound();
        if (uint256(keccak256(abi.encode(challenge, wallet, nonce))) < target) return;
        uint256 round = world.mine.round();
        vm.roll(block.number + 1);
        try world.mine.submit(round, nonce, wallet) {
            revert("invalid Solution accepted");
        } catch {}
    }
}

contract GoldMineInvariantTest is MineHelpers {
    World internal world;
    MineHandler internal handler;

    function setUp() public {
        GoldMine.Params memory p = _easyParams();
        p.retargetIntervalRounds = 5;
        p.halvingIntervalRounds = 7;
        world = _deployWorld(address(this), p, 400 ether);
        handler = new MineHandler(world);
        targetContract(address(handler));
    }

    function invariant_SupplyNeverExceedsTheCap() public view {
        assertLe(world.gold.totalSupply(), world.gold.cap());
    }

    function invariant_GoldOnlyComesFromWins() public view {
        assertEq(world.gold.totalSupply(), handler.paid());
        assertEq(world.mine.round(), handler.wins());
    }

    function invariant_TargetStaysPositive() public view {
        assertGt(world.mine.target(), 0);
    }

    function test_RealCapMatchesRules() public {
        World memory real = _deployWorld(address(this));
        assertEq(real.gold.cap(), Rules.MAX_SUPPLY);
        assertEq(real.gold.decimals(), 18);
    }
}
