import { describe, expect, it } from "vitest";
import { bytes32ToStatKey, statKeyToBytes32 } from "./chain.ts";
import { deploymentFor } from "./deployments/index.ts";

describe("stat keys", () => {
  it("match Solidity's bytes32 string literals", () => {
    expect(statKeyToBytes32("strength")).toBe(
      "0x737472656e677468000000000000000000000000000000000000000000000000",
    );
    expect(bytes32ToStatKey(statKeyToBytes32("stamina"))).toBe("stamina");
  });
});

describe("deploymentFor", () => {
  it("knows anvil and rejects unknown chains", () => {
    expect(deploymentFor(31337).Land.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(() => deploymentFor(1)).toThrow();
  });
});
