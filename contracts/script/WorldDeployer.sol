// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Rules} from "../src/generated/Rules.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {GoldToken} from "../src/GoldToken.sol";
import {Land} from "../src/Land.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

/// @dev Shared by the deploy script and the tests so both build the world the same way.
abstract contract WorldDeployer {
    struct World {
        Land land;
        PlayerRegistry registry;
        GoldToken gold;
        GoldMine mine;
    }

    function _defaultMiningParams() internal pure returns (GoldMine.Params memory) {
        return GoldMine.Params({
            initialTarget: Rules.INITIAL_TARGET,
            intendedRoundSeconds: Rules.INTENDED_ROUND_SECONDS,
            retargetIntervalRounds: Rules.RETARGET_INTERVAL_ROUNDS,
            maxRetargetFactor: Rules.MAX_RETARGET_FACTOR,
            initialReward: Rules.INITIAL_ROUND_REWARD,
            halvingIntervalRounds: Rules.HALVING_INTERVAL_ROUNDS
        });
    }

    /// @param admin Owns every contract during setup (must be the caller of the setup transactions).
    function _deployWorld(address admin) internal returns (World memory world) {
        return _deployWorld(admin, _defaultMiningParams(), Rules.MAX_SUPPLY);
    }

    function _deployWorld(address admin, GoldMine.Params memory miningParams, uint256 goldCap)
        internal
        returns (World memory world)
    {
        world.land = Land(_proxy(address(new Land()), abi.encodeCall(Land.initialize, (admin))));
        world.registry = PlayerRegistry(
            _proxy(
                address(new PlayerRegistry()),
                abi.encodeCall(
                    PlayerRegistry.initialize, (admin, world.land, Rules.characterStatKeys(), Rules.INITIAL_STAT_VALUE)
                )
            )
        );
        world.land.setRegistry(address(world.registry));
        world.gold = GoldToken(_proxy(address(new GoldToken()), abi.encodeCall(GoldToken.initialize, (admin, goldCap))));
        world.mine = GoldMine(
            _proxy(
                address(new GoldMine()),
                abi.encodeCall(GoldMine.initialize, (admin, world.gold, world.land, miningParams))
            )
        );
        world.gold.setMinter(address(world.mine));
    }

    function _proxy(address implementation, bytes memory init) private returns (address) {
        return address(new ERC1967Proxy(implementation, init));
    }
}
