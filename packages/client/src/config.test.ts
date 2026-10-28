import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("uses the local defaults", () => {
    expect(parseConfig({})).toEqual({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      mapServerUrl: "ws://127.0.0.1:2567",
      landId: 1,
    });
  });

  it("reads overrides and treats empty values as unset", () => {
    const config = parseConfig({
      VITE_RPC_URL: "https://sepolia.base.org",
      VITE_CHAIN_ID: "84532",
      VITE_MAP_SERVER_URL: "wss://land.example",
      VITE_LAND_ID: "7",
    });
    expect(config).toMatchObject({ chainId: 84532, landId: 7 });
    expect(parseConfig({ VITE_LAND_ID: "" }).landId).toBe(1);
  });

  it.each([
    { VITE_CHAIN_ID: "abc" },
    { VITE_LAND_ID: "0" },
    { VITE_LAND_ID: "-1" },
    { VITE_RPC_URL: "not a url" },
    { VITE_RPC_URL: "ws://127.0.0.1:8545" },
    { VITE_MAP_SERVER_URL: "http://127.0.0.1:2567" },
  ])("rejects %j", (env) => {
    expect(() => parseConfig(env)).toThrow();
  });
});
