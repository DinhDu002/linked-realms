// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Rules} from "../src/generated/Rules.sol";
import {Land} from "../src/Land.sol";
import {PlayerRegistry} from "../src/PlayerRegistry.sol";

/// @dev Shared by the deploy script and the tests so both build the world the same way.
abstract contract WorldDeployer {
    struct World {
        Land land;
        PlayerRegistry registry;
    }

    /// @param admin Owns every contract during setup (must be the caller of the setup transactions).
    function _deployWorld(address admin) internal returns (World memory world) {
        world.land = Land(address(new ERC1967Proxy(address(new Land()), abi.encodeCall(Land.initialize, (admin)))));
        world.registry = PlayerRegistry(
            address(
                new ERC1967Proxy(
                    address(new PlayerRegistry()),
                    abi.encodeCall(
                        PlayerRegistry.initialize,
                        (admin, world.land, Rules.characterStatKeys(), Rules.INITIAL_STAT_VALUE)
                    )
                )
            )
        );
        world.land.setRegistry(address(world.registry));
    }
}
