import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ LAND_ID: "3" });
    expect(config).toMatchObject({
      landId: 3,
      port: 2567,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
    });
    expect(config.mapFile).toMatch(/maps\/empty-land\.json$/);
  });

  it("reads overrides", () => {
    const config = loadConfig({
      LAND_ID: "9",
      PORT: "2601",
      RPC_URL: "http://rpc.test",
      CHAIN_ID: "84532",
      MAP_FILE: "/tmp/m.json",
    });
    expect(config).toEqual({
      landId: 9,
      port: 2601,
      rpcUrl: "http://rpc.test",
      chainId: 84532,
      mapFile: "/tmp/m.json",
    });
  });

  it.each([
    [{}, /LAND_ID is required/],
    [{ LAND_ID: "0" }, /LAND_ID must be/],
    [{ LAND_ID: "-1" }, /LAND_ID must be/],
    [{ LAND_ID: "1.5" }, /LAND_ID must be/],
    [{ LAND_ID: "abc" }, /LAND_ID must be/],
    [{ LAND_ID: "4294967296" }, /LAND_ID must be/],
    [{ LAND_ID: "1", PORT: "70000" }, /PORT must be/],
    [{ LAND_ID: "1", CHAIN_ID: "x" }, /CHAIN_ID must be/],
    [{ LAND_ID: "1", RPC_URL: "nope" }, /RPC_URL is not a valid URL/],
  ])("rejects %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
