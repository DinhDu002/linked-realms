// SPDX-License-Identifier: MIT
// GENERATED from packages/shared/src/rules by `pnpm --filter @linked-realms/shared generate`. Do not edit.
pragma solidity ^0.8.24;

library Rules {
    uint256 internal constant LAND_SIZE_TILES = 64;
    uint256 internal constant INITIAL_STAT_VALUE = 1;
    uint256 internal constant INTENDED_ROUND_SECONDS = 60;
    uint256 internal constant RETARGET_INTERVAL_ROUNDS = 60;
    uint256 internal constant MAX_RETARGET_FACTOR = 4;
    uint256 internal constant INITIAL_ROUND_REWARD = 50000000000000000000;
    uint256 internal constant HALVING_INTERVAL_ROUNDS = 210000;
    uint256 internal constant MAX_SUPPLY = 21000000000000000000000000;

    function characterStatKeys() internal pure returns (bytes32[] memory keys) {
        keys = new bytes32[](4);
        keys[0] = "strength";
        keys[1] = "agility";
        keys[2] = "intelligence";
        keys[3] = "stamina";
    }
}
