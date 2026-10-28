// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

// Proves the toolchain wiring: both OpenZeppelin packages resolve, and the UUPS pattern
// used by the core contracts (PLAN.md section 4) deploys behind a proxy and guards upgrades.
contract ExampleV1 is OwnableUpgradeable, UUPSUpgradeable {
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner) external initializer {
        __Ownable_init(owner);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}

contract ToolchainTest is Test {
    ExampleV1 internal example;
    address internal owner = makeAddr("owner");

    function setUp() public {
        ExampleV1 implementation = new ExampleV1();
        bytes memory init = abi.encodeCall(ExampleV1.initialize, (owner));
        example = ExampleV1(address(new ERC1967Proxy(address(implementation), init)));
    }

    function test_InitializesOwnerThroughProxy() public view {
        assertEq(example.owner(), owner);
    }

    function test_RevertWhen_NonOwnerUpgrades() public {
        address next = address(new ExampleV1());
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this)));
        example.upgradeToAndCall(next, "");
    }

    function test_OwnerCanUpgrade() public {
        address next = address(new ExampleV1());
        vm.prank(owner);
        example.upgradeToAndCall(next, "");
        assertEq(address(uint160(uint256(vm.load(address(example), ERC1967Utils.IMPLEMENTATION_SLOT)))), next);
        assertEq(example.owner(), owner);
    }
}
