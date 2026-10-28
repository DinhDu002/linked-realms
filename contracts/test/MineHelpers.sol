// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {WorldDeployer} from "../script/WorldDeployer.sol";

abstract contract MineHelpers is Test, WorldDeployer {
    /// About one hash in four is a Solution, so tests can search nonces cheaply.
    uint256 internal constant EASY_TARGET = type(uint256).max / 4;

    function _easyParams() internal pure returns (GoldMine.Params memory p) {
        p = _defaultMiningParams();
        p.initialTarget = EASY_TARGET;
    }

    function _solve(GoldMine mine, address rewardWallet) internal view returns (uint256 nonce) {
        (, bytes32 challenge, uint256 target,) = mine.currentRound();
        while (uint256(keccak256(abi.encode(challenge, rewardWallet, nonce))) >= target) ++nonce;
    }

    function _notSolution(GoldMine mine, address rewardWallet) internal view returns (uint256 nonce) {
        (, bytes32 challenge, uint256 target,) = mine.currentRound();
        while (uint256(keccak256(abi.encode(challenge, rewardWallet, nonce))) < target) ++nonce;
    }

    function _claimLand(World memory world, address player) internal {
        vm.prank(player);
        world.registry.createCharacter();
    }

    /// Wins the current Round for `rewardWallet` in a fresh block.
    function _win(World memory world, address rewardWallet) internal returns (uint256 nonce) {
        vm.roll(block.number + 1);
        nonce = _solve(world.mine, rewardWallet);
        world.mine.submit(world.mine.round(), nonce, rewardWallet);
    }
}
