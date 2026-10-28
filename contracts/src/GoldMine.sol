// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GoldToken} from "./GoldToken.sol";
import {Land} from "./Land.sol";

/// @notice The single mining competition shared by every Mine (PLAN.md section 5.2).
/// A Solution is a nonce with keccak256(abi.encode(challenge, rewardWallet, nonce)) < target.
/// The contract checks every Solution itself (P3) and is the only way Gold is created (P4).
contract GoldMine is OwnableUpgradeable, UUPSUpgradeable {
    struct Params {
        uint256 initialTarget;
        uint256 intendedRoundSeconds;
        uint256 retargetIntervalRounds;
        uint256 maxRetargetFactor;
        uint256 initialReward;
        uint256 halvingIntervalRounds;
    }

    GoldToken public token;
    Land public land;
    Params private _params;

    uint256 public round;
    bytes32 public challenge;
    uint256 public target;
    uint256 public roundStartedAt;
    uint256 public retargetWindowStartedAt;
    uint256 public lastWinBlock;

    event RoundStarted(uint256 indexed round, bytes32 challenge, uint256 target);
    event RoundWon(
        uint256 indexed round, address indexed rewardWallet, address indexed submitter, uint256 nonce, uint256 reward
    );
    event Retargeted(uint256 indexed round, uint256 oldTarget, uint256 newTarget, uint256 actualSeconds);

    error StaleRound(uint256 submitted, uint256 current);
    error RoundAlreadyWonInThisBlock();
    error NoLand(address rewardWallet);
    error InvalidSolution();
    error InvalidParams();

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, GoldToken token_, Land land_, Params calldata params_) external initializer {
        if (
            params_.initialTarget == 0 || params_.intendedRoundSeconds == 0 || params_.retargetIntervalRounds == 0
                || params_.maxRetargetFactor < 2 || params_.halvingIntervalRounds == 0
        ) revert InvalidParams();
        __Ownable_init(owner_);
        token = token_;
        land = land_;
        _params = params_;
        target = params_.initialTarget;
        challenge = keccak256(abi.encode(block.chainid, address(this), blockhash(block.number - 1)));
        roundStartedAt = block.timestamp;
        retargetWindowStartedAt = block.timestamp;
        emit RoundStarted(0, challenge, params_.initialTarget);
    }

    function params() external view returns (Params memory) {
        return _params;
    }

    /// @notice Everything a miner needs for the current Round.
    function currentRound() external view returns (uint256, bytes32, uint256, uint256) {
        return (round, challenge, target, roundStartedAt);
    }

    /// @param round_ The Round the Solution was found for; a Solution for an old Round reverts with StaleRound.
    function submit(uint256 round_, uint256 nonce, address rewardWallet) external {
        uint256 current = round;
        if (round_ != current) revert StaleRound(round_, current);
        if (block.number == lastWinBlock) revert RoundAlreadyWonInThisBlock();
        if (land.landOf(rewardWallet) == 0) revert NoLand(rewardWallet);
        bytes32 previousChallenge = challenge;
        if (uint256(keccak256(abi.encode(previousChallenge, rewardWallet, nonce))) >= target) revert InvalidSolution();

        uint256 reward = rewardForRound(current);
        uint256 room = token.cap() - token.totalSupply();
        if (reward > room) reward = room;

        uint256 next = current + 1;
        round = next;
        lastWinBlock = block.number;
        challenge = keccak256(
            abi.encode(
                previousChallenge, rewardWallet, nonce, blockhash(block.number - 1), block.prevrandao, block.timestamp
            )
        );
        if (next % _params.retargetIntervalRounds == 0) {
            uint256 actual = block.timestamp - retargetWindowStartedAt;
            uint256 oldTarget = target;
            target = nextTarget(oldTarget, actual);
            retargetWindowStartedAt = block.timestamp;
            emit Retargeted(next, oldTarget, target, actual);
        }
        roundStartedAt = block.timestamp;

        emit RoundWon(current, rewardWallet, msg.sender, nonce, reward);
        emit RoundStarted(next, challenge, target);
        if (reward > 0) token.mint(rewardWallet, reward);
    }

    /// @notice Reward for winning `round_`: halved every `halvingIntervalRounds` (P4). Matches packages/shared (P9).
    function rewardForRound(uint256 round_) public view returns (uint256) {
        uint256 halvings = round_ / _params.halvingIntervalRounds;
        return halvings >= 256 ? 0 : _params.initialReward >> halvings;
    }

    /// @notice Target after a retarget window that took `actualSeconds`. Matches packages/shared (P9).
    function nextTarget(uint256 current, uint256 actualSeconds) public view returns (uint256) {
        Params memory p = _params;
        uint256 expected = p.intendedRoundSeconds * p.retargetIntervalRounds;
        uint256 actual =
            Math.min(Math.max(actualSeconds, expected / p.maxRetargetFactor), expected * p.maxRetargetFactor);
        if (actual > expected && current > type(uint256).max / p.maxRetargetFactor) return type(uint256).max;
        uint256 result = Math.mulDiv(current, actual, expected);
        return result == 0 ? 1 : result;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
