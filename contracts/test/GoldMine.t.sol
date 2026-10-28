// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Rules} from "../src/generated/Rules.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {GoldToken} from "../src/GoldToken.sol";
import {MineHelpers} from "./MineHelpers.sol";

contract GoldMineTest is MineHelpers {
    World internal world;
    GoldMine internal mine;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal miningKey = makeAddr("miningKey");

    function setUp() public {
        world = _deployWorld(address(this), _easyParams(), Rules.MAX_SUPPLY);
        mine = world.mine;
        _claimLand(world, alice);
        _claimLand(world, bob);
        vm.roll(block.number + 1);
    }

    function test_PaysTheRewardWalletNotTheSubmitter() public {
        uint256 nonce = _solve(mine, alice);
        vm.expectEmit(address(mine));
        emit GoldMine.RoundWon(0, alice, miningKey, nonce, Rules.INITIAL_ROUND_REWARD);
        vm.prank(miningKey);
        mine.submit(0, nonce, alice);
        assertEq(world.gold.balanceOf(alice), Rules.INITIAL_ROUND_REWARD);
        assertEq(world.gold.balanceOf(miningKey), 0);
        assertEq(mine.round(), 1);
    }

    function test_RevertWhen_SolutionIsWrong() public {
        uint256 nonce = _notSolution(mine, alice);
        vm.expectRevert(GoldMine.InvalidSolution.selector);
        mine.submit(0, nonce, alice);
        assertEq(world.gold.totalSupply(), 0);
    }

    function test_RevertWhen_SolutionIsForAnOldRound() public {
        uint256 oldNonce = _solve(mine, alice);
        _win(world, bob);
        vm.roll(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(GoldMine.StaleRound.selector, 0, 1));
        mine.submit(0, oldNonce, alice);
    }

    function test_ChallengeChangesEveryRound() public {
        (, bytes32 before,,) = mine.currentRound();
        uint256 nonce = _solve(mine, alice);
        mine.submit(0, nonce, alice);
        (, bytes32 next,,) = mine.currentRound();
        assertTrue(before != next);
        // Re-sending the winning nonce for the new Round is not automatically valid.
        assertTrue(
            uint256(keccak256(abi.encode(next, alice, nonce))) != uint256(keccak256(abi.encode(before, alice, nonce)))
        );
    }

    function test_ChangingTheRewardWalletInvalidatesTheSolution() public {
        // Find a nonce that solves for alice but not for bob: copying a Solution does not pay the copier.
        (, bytes32 challenge, uint256 target,) = mine.currentRound();
        uint256 nonce;
        while (
            uint256(keccak256(abi.encode(challenge, alice, nonce))) >= target
                || uint256(keccak256(abi.encode(challenge, bob, nonce))) < target
        ) ++nonce;
        vm.expectRevert(GoldMine.InvalidSolution.selector);
        mine.submit(0, nonce, bob);
        mine.submit(0, nonce, alice);
        assertEq(world.gold.balanceOf(alice), Rules.INITIAL_ROUND_REWARD);
    }

    function test_RevertWhen_RewardWalletOwnsNoLand() public {
        address stranger = makeAddr("stranger");
        uint256 nonce = _solve(mine, stranger);
        vm.expectRevert(abi.encodeWithSelector(GoldMine.NoLand.selector, stranger));
        mine.submit(0, nonce, stranger);
        assertEq(world.gold.balanceOf(stranger), 0);
    }

    function test_RevertWhen_SecondWinInTheSameBlock() public {
        mine.submit(0, _solve(mine, alice), alice);
        uint256 nonce = _solve(mine, bob);
        vm.expectRevert(GoldMine.RoundAlreadyWonInThisBlock.selector);
        mine.submit(1, nonce, bob);
    }

    function testFuzz_NobodyElseMints(address caller) public {
        vm.assume(caller != address(mine));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(GoldToken.NotMinter.selector, caller));
        world.gold.mint(caller, 1);
    }

    function test_MinterIsSetOnce() public {
        vm.expectRevert(GoldToken.MinterAlreadySet.selector);
        world.gold.setMinter(alice);
    }

    function test_RetargetsEveryIntervalFollowingTheFormula() public {
        uint256 start = block.timestamp;
        uint256 interval = Rules.RETARGET_INTERVAL_ROUNDS;
        for (uint256 i = 0; i < interval - 1; ++i) {
            vm.warp(block.timestamp + 30);
            _win(world, alice);
        }
        assertEq(mine.target(), EASY_TARGET, "no Retarget before the interval");
        vm.warp(block.timestamp + 30);
        uint256 actual = block.timestamp - start;
        _win(world, alice);
        uint256 expected = Math.mulDiv(EASY_TARGET, actual, Rules.INTENDED_ROUND_SECONDS * interval);
        assertEq(expected, EASY_TARGET / 2, "30-second Rounds halve the Target");
        assertEq(mine.target(), expected);
        assertEq(mine.target(), mine.nextTarget(EASY_TARGET, actual));
        assertEq(mine.retargetWindowStartedAt(), block.timestamp);
    }

    function testFuzz_RetargetNeverExceedsFourTimes(uint256 current, uint256 actualSeconds) public view {
        current = bound(current, 1, type(uint256).max);
        uint256 next = mine.nextTarget(current, actualSeconds);
        assertGe(next, current / 4 == 0 ? 1 : current / 4);
        if (current <= type(uint256).max / 4) assertLe(next, current * 4);
        assertGt(next, 0);
    }

    function test_RetargetMatchesSharedRules() public {
        World memory real = _deployWorld(address(this));
        string memory json = _vectors();
        uint256[] memory current = vm.parseJsonUintArray(json, ".retarget.current");
        uint256[] memory actual = vm.parseJsonUintArray(json, ".retarget.actual");
        uint256[] memory next = vm.parseJsonUintArray(json, ".retarget.next");
        assertGt(current.length, 50);
        for (uint256 i = 0; i < current.length; ++i) {
            assertEq(real.mine.nextTarget(current[i], actual[i]), next[i]);
        }
    }

    function test_RewardMatchesSharedRules() public {
        World memory real = _deployWorld(address(this));
        string memory json = _vectors();
        uint256[] memory rounds = vm.parseJsonUintArray(json, ".reward.round");
        uint256[] memory rewards = vm.parseJsonUintArray(json, ".reward.reward");
        for (uint256 i = 0; i < rounds.length; ++i) {
            assertEq(real.mine.rewardForRound(rounds[i]), rewards[i]);
        }
    }

    function test_SolutionHashMatchesSharedRules() public view {
        string memory json = _vectors();
        bytes32[] memory challenge = vm.parseJsonBytes32Array(json, ".solution.challenge");
        address[] memory wallet = vm.parseJsonAddressArray(json, ".solution.wallet");
        uint256[] memory nonce = vm.parseJsonUintArray(json, ".solution.nonce");
        bytes32[] memory hash = vm.parseJsonBytes32Array(json, ".solution.hash");
        for (uint256 i = 0; i < challenge.length; ++i) {
            assertEq(keccak256(abi.encode(challenge[i], wallet[i], nonce[i])), hash[i]);
        }
    }

    function test_HalvesAtTheRightRound() public {
        GoldMine.Params memory p = _easyParams();
        p.halvingIntervalRounds = 3;
        World memory w = _deployWorld(address(this), p, Rules.MAX_SUPPLY);
        _claimLand(w, alice);
        uint256 reward = Rules.INITIAL_ROUND_REWARD;
        uint256[7] memory expected = [reward, reward, reward, reward / 2, reward / 2, reward / 2, reward / 4];
        for (uint256 i = 0; i < expected.length; ++i) {
            uint256 before = w.gold.balanceOf(alice);
            _win(w, alice);
            assertEq(w.gold.balanceOf(alice) - before, expected[i]);
        }
    }

    function test_SupplyStopsAtTheCapAndRoundsGoOn() public {
        World memory w = _deployWorld(address(this), _easyParams(), 120 ether);
        _claimLand(w, alice);
        _win(w, alice);
        _win(w, alice);
        _win(w, alice);
        _win(w, alice);
        assertEq(w.gold.totalSupply(), 120 ether);
        assertEq(w.mine.round(), 4);
    }

    function test_DeploysAtBlockZero() public {
        vm.roll(0);
        World memory w = _deployWorld(address(this));
        assertEq(w.mine.round(), 0);
        assertTrue(w.mine.challenge() != bytes32(0));
    }

    function test_RevertWhen_NonOwnerUpgrades() public {
        address next = address(new GoldMine());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, alice));
        mine.upgradeToAndCall(next, "");
    }

    function test_RevertWhen_ParamsAreInvalid() public {
        GoldMine.Params memory p = _easyParams();
        p.initialTarget = 0;
        address impl = address(new GoldMine());
        vm.expectRevert(GoldMine.InvalidParams.selector);
        new ERC1967ProxyHarness(impl, abi.encodeCall(GoldMine.initialize, (address(this), world.gold, world.land, p)));
    }

    function _vectors() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../packages/shared/test-vectors/mining.json"));
    }
}

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract ERC1967ProxyHarness is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
