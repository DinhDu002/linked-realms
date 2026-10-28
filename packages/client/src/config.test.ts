import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";

describe("parseConfig", () => {
  it("uses the local defaults", () => {
    expect(parseConfig({})).toEqual({
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
      hubUrl: "http://127.0.0.1:8787",
    });
  });

  it("reads overrides and treats empty values as unset", () => {
    const config = parseConfig({
      VITE_RPC_URL: "https://sepolia.base.org",
      VITE_CHAIN_ID: "84532",
      VITE_HUB_URL: "https://hub.example",
    });
    expect(config).toMatchObject({
      chainId: 84532,
      hubUrl: "https://hub.example",
    });
    expect(parseConfig({ VITE_HUB_URL: "" }).hubUrl).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it.each([
    { VITE_CHAIN_ID: "abc" },
    { VITE_RPC_URL: "not a url" },
    { VITE_RPC_URL: "ws://127.0.0.1:8545" },
    { VITE_HUB_URL: "ws://127.0.0.1:8787" },
  ])("rejects %j", (env) => {
    expect(() => parseConfig(env)).toThrow();
  });
});
