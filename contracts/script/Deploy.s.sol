// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Rules} from "../src/generated/Rules.sol";
import {GoldMine} from "../src/GoldMine.sol";
import {WorldDeployer} from "./WorldDeployer.sol";

/// Deploys every contract and writes packages/shared/src/deployments/<chainId>.json.
///   anvil:  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key 0>
/// OWNER (optional) receives ownership, and with it the upgrade rights, after setup.
/// On anvil only, DEV_ROUND_SECONDS, DEV_RETARGET_INTERVAL_ROUNDS and DEV_INITIAL_TARGET override the mining rules.
/// P7: testnet only. This script refuses to run on any chain other than anvil and Base Sepolia.
contract Deploy is Script, WorldDeployer {
    error UnsupportedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 31337 && block.chainid != 84532) revert UnsupportedChain(block.chainid);
        uint256 startBlock = block.number;

        GoldMine.Params memory mining = _defaultMiningParams();
        if (block.chainid == 31337) {
            // Local only: shorter Rounds make Retargets observable within minutes (scripts/e2e, simulations).
            mining.intendedRoundSeconds = vm.envOr("DEV_ROUND_SECONDS", mining.intendedRoundSeconds);
            mining.retargetIntervalRounds = vm.envOr("DEV_RETARGET_INTERVAL_ROUNDS", mining.retargetIntervalRounds);
            mining.initialTarget = vm.envOr("DEV_INITIAL_TARGET", mining.initialTarget);
        }

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        World memory world = _deployWorld(deployer, mining, Rules.MAX_SUPPLY);
        address owner = vm.envOr("OWNER", deployer);
        if (owner != deployer) {
            world.land.transferOwnership(owner);
            world.registry.transferOwnership(owner);
            world.gold.transferOwnership(owner);
            world.mine.transferOwnership(owner);
        }
        vm.stopBroadcast();

        _writeDeployment("Land", address(world.land), startBlock);
        _writeDeployment("GoldToken", address(world.gold), startBlock);
        _writeDeployment("GoldMine", address(world.mine), startBlock);
        string memory json = _writeDeployment("PlayerRegistry", address(world.registry), startBlock);
        vm.writeJson(
            json,
            string.concat(vm.projectRoot(), "/../packages/shared/src/deployments/", vm.toString(block.chainid), ".json")
        );
    }

    function _writeDeployment(string memory name, address addr, uint256 startBlock) private returns (string memory) {
        string memory entry = vm.serializeAddress(name, "address", addr);
        entry = vm.serializeUint(name, "startBlock", startBlock);
        return vm.serializeString("deployment", name, entry);
    }
}
