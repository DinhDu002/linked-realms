// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Rules} from "../src/generated/Rules.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {MineHelpers} from "./MineHelpers.sol";

/// @notice A simulated total hash rate mines real Solutions; a Round takes `nonces tried / H` seconds, which is what
/// a miner of rate `H` would need. Run with `forge test --match-contract Simulation -vv` to see the convergence.
contract GoldMineSimulationTest is MineHelpers {
    uint256 internal constant WINDOWS_PER_PHASE = 6;
    uint256 internal constant PHASES = 3;
    uint256 internal constant INTERVAL = 60; // default RETARGET_INTERVAL_ROUNDS, checked in the test
    uint256 internal constant INTENDED = 60; // default INTENDED_ROUND_SECONDS, checked in the test
    uint256 internal constant H0_MILLI = 1000; // 1 hash/s, in milli-hashes/s so H0 / 2 is exact

    // Tolerance 55% = 3 sigma, derived in test_RoundTimeConvergesWhenHashRateChanges.
    uint256 internal constant TOLERANCE_PERCENT = 55;

    function _hashRateMilli(uint256 phase) internal pure returns (uint256) {
        return phase == 0 ? H0_MILLI : phase == 1 ? 4 * H0_MILLI : H0_MILLI / 2;
    }

    /// Real search with a fixed scratch buffer, so memory does not grow per hash. Returns the first Solution at or
    /// after `start`; the number of nonces tried is `nonce - start + 1`.
    function _search(bytes32 challenge, address wallet, uint256 target, uint256 start)
        internal
        pure
        returns (uint256 nonce)
    {
        nonce = start;
        assembly ("memory-safe") {
            let buf := mload(0x40) // 96 bytes past the free pointer, never reserved: same layout as abi.encode
            mstore(buf, challenge)
            mstore(add(buf, 0x20), wallet)
            for {} 1 { nonce := add(nonce, 1) } {
                mstore(add(buf, 0x40), nonce)
                if lt(keccak256(buf, 0x60), target) { break }
            }
        }
    }

    /// Milli-hash units not yet turned into whole seconds, so nothing is lost to rounding.
    uint256 internal _remainder;

    function _mineWindow(GoldMine mine, address miner, uint256 hashRate) internal {
        for (uint256 i; i < INTERVAL; ++i) {
            (uint256 round, bytes32 challenge, uint256 target,) = mine.currentRound();
            uint256 start = uint256(keccak256(abi.encode("start", round)));
            uint256 nonce = _search(challenge, miner, target, start);
            uint256 acc = _remainder + (nonce - start + 1) * 1000;
            vm.warp(block.timestamp + acc / hashRate);
            _remainder = acc % hashRate;
            vm.roll(block.number + 1);
            mine.submit(round, nonce, miner);
        }
    }

    function _fmt(uint256 x100) internal pure returns (string memory) {
        uint256 frac = x100 % 100;
        return string.concat(vm.toString(x100 / 100), ".", frac < 10 ? "0" : "", vm.toString(frac));
    }

    /// Round times are exponential (a Round is a geometric number of hashes, divided by H), so a window of
    /// N = 60 Rounds has a mean with relative sigma 1/sqrt(N) = 12.9%. The Retarget sets the next window's true mean to
    /// 60 / X where X (mean 1, same 12.9% sigma) is the noise of the window just finished, so each observed window
    /// mean is 60 * Y_k / Y_(k-1): relative sigma sqrt(2/N) = 18.3%. Over windows 3..6 the averaged ratios telescope
    /// to Y_6 / Y_2, so the mean of the four windows keeps sigma 18.3% (averaging helps nothing). 3 sigma = 55%, so
    /// each phase mean must be within 60 s +/- 55% (27..93 s); a failure to converge would sit at 15 s, 120 s or beyond.
    /// The first window after the 4x rise has the same sigma around 15 s (target unchanged, rate 4x), so the same
    /// 55% bound applies: it must be 15 s +/- 55%, far from 60 s.
    function test_RoundTimeConvergesWhenHashRateChanges() public {
        assertEq(Rules.INTENDED_ROUND_SECONDS, INTENDED);
        assertEq(Rules.RETARGET_INTERVAL_ROUNDS, INTERVAL);
        assertEq(Rules.MAX_RETARGET_FACTOR, 4);

        // H0 = 1 hash/s and 60 s Rounds: one Solution per 60 hashes.
        GoldMine.Params memory p = _defaultMiningParams();
        p.initialTarget = type(uint256).max / INTENDED;
        World memory world = _deployWorld(address(this), p, Rules.MAX_SUPPLY);
        GoldMine mine = world.mine;
        address miner = makeAddr("miner");
        _claimLand(world, miner);

        uint256 windows = WINDOWS_PER_PHASE * PHASES;
        uint256[] memory actual = new uint256[](windows); // seconds each window took
        uint256[] memory oldTarget = new uint256[](windows);
        uint256[] memory newTarget = new uint256[](windows);

        for (uint256 w; w < windows; ++w) {
            uint256 hashRate = _hashRateMilli(w / WINDOWS_PER_PHASE);
            uint256 windowStart = mine.retargetWindowStartedAt();
            oldTarget[w] = mine.target();
            _mineWindow(mine, miner, hashRate);
            actual[w] = mine.retargetWindowStartedAt() - windowStart;
            newTarget[w] = mine.target();
            console.log(
                string.concat(
                    "phase ",
                    vm.toString(w / WINDOWS_PER_PHASE),
                    " window ",
                    vm.toString(w % WINDOWS_PER_PHASE + 1),
                    " | H = ",
                    _fmt(hashRate / 10),
                    " hash/s | mean Round = ",
                    _fmt(actual[w] * 100 / INTERVAL),
                    " s | hashes/Solution = ",
                    vm.toString(type(uint256).max / newTarget[w])
                )
            );
        }

        // Windows 3..6 of each phase have converged: mean Round time within 60 s +/- 55%.
        for (uint256 phase; phase < PHASES; ++phase) {
            uint256 sum;
            for (uint256 k = 2; k < WINDOWS_PER_PHASE; ++k) {
                sum += actual[phase * WINDOWS_PER_PHASE + k];
            }
            uint256 mean = sum / ((WINDOWS_PER_PHASE - 2) * INTERVAL);
            assertGe(mean * 100, INTENDED * (100 - TOLERANCE_PERCENT), "phase mean too fast");
            assertLe(mean * 100, INTENDED * (100 + TOLERANCE_PERCENT), "phase mean too slow");
        }

        // The rise is real: with the old target and 4x the hash rate the first window runs near 15 s (not 60 s).
        uint256 rise = WINDOWS_PER_PHASE;
        uint256 firstMean = actual[rise] / INTERVAL;
        assertGe(firstMean * 100, (INTENDED / 4) * (100 - TOLERANCE_PERCENT), "rise window too fast");
        assertLe(firstMean * 100, (INTENDED / 4) * (100 + TOLERANCE_PERCENT), "rise window too slow");

        // That window's Retarget cannot cut the target by more than 4x; it hits the clamp exactly when the window
        // took at most expected / 4 = 900 s, which is roughly half the time (actual = 900 * Y_k / Y_(k-1)).
        // Either way it must cut by far more than 2x (window under 900 * 1.55 s).
        uint256 expected = INTENDED * INTERVAL;
        assertEq(newTarget[rise], mine.nextTarget(oldTarget[rise], actual[rise]));
        assertGe(newTarget[rise], oldTarget[rise] / 4, "cut beyond the clamp");
        assertLt(newTarget[rise], oldTarget[rise] / 2, "target barely moved");
        if (actual[rise] <= expected / 4) {
            assertEq(newTarget[rise], oldTarget[rise] / 4, "4x clamp not applied");
        }
        console.log("rise window took", actual[rise], "s; clamp at", expected / 4);

        // The fall (4H0 to H0 / 2) is 8x slower with the old target, so the window takes about 8 * 3600 s, twice the
        // 4 * 3600 s clamp (more than 5 sigma away): this Retarget must hit the upward 4x clamp.
        uint256 fall = 2 * WINDOWS_PER_PHASE;
        assertEq(newTarget[fall], oldTarget[fall] * 4, "4x upward clamp not applied");
    }
}
