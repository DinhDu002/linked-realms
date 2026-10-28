import { describe, expect, it } from "vitest";
import { defaultMaxThreads } from "@linked-realms/miner";
import { loadConfig } from "./config.ts";

const SIGNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const base = { HUB_TICKET_SIGNER: SIGNER };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({ ...base, LAND_ID: "3" });
    expect(config).toMatchObject({
      landId: 3,
      port: 2567,
      host: "127.0.0.1",
      relayUrl: undefined,
      hubTicketSigner: SIGNER,
      rpcUrl: "http://127.0.0.1:8545",
      chainId: 31337,
    });
    expect(config.mapFile).toMatch(/maps\/empty-land\.json$/);
    expect(config.miningKeyFile).toMatch(
      /packages\/map-server\/\.data\/mining-key$/,
    );
    expect(config.miningMaxThreads).toBe(defaultMaxThreads());
  });

  it("reads overrides", () => {
    const config = loadConfig({
      LAND_ID: "9",
      PORT: "2601",
      HOST: "0.0.0.0",
      RELAY_URL: "wss://relay.test",
      HUB_TICKET_SIGNER: SIGNER,
      RPC_URL: "http://rpc.test",
      CHAIN_ID: "84532",
      MAP_FILE: "/tmp/m.json",
      MINING_KEY_FILE: "/tmp/key",
      MINING_MAX_THREADS: "3",
    });
    expect(config).toEqual({
      landId: 9,
      port: 2601,
      host: "0.0.0.0",
      relayUrl: "wss://relay.test",
      hubTicketSigner: SIGNER,
      rpcUrl: "http://rpc.test",
      chainId: 84532,
      mapFile: "/tmp/m.json",
      miningKeyFile: "/tmp/key",
      miningMaxThreads: 3,
    });
  });

  it.each([
    [base, /LAND_ID is required/],
    [{ LAND_ID: "1" }, /HUB_TICKET_SIGNER is required/],
    [
      { ...base, LAND_ID: "1", HUB_TICKET_SIGNER: "0x12" },
      /HUB_TICKET_SIGNER is not/,
    ],
    [{ ...base, LAND_ID: "1", RELAY_URL: "nope" }, /RELAY_URL must be/],
    [{ ...base, LAND_ID: "1", RELAY_URL: "http://r" }, /RELAY_URL must be/],
    [{ ...base, LAND_ID: "0" }, /LAND_ID must be/],
    [{ ...base, LAND_ID: "-1" }, /LAND_ID must be/],
    [{ ...base, LAND_ID: "1.5" }, /LAND_ID must be/],
    [{ ...base, LAND_ID: "abc" }, /LAND_ID must be/],
    [{ ...base, LAND_ID: "4294967296" }, /LAND_ID must be/],
    [{ ...base, LAND_ID: "1", PORT: "70000" }, /PORT must be/],
    [{ ...base, LAND_ID: "1", CHAIN_ID: "x" }, /CHAIN_ID must be/],
    [
      { ...base, LAND_ID: "1", MINING_MAX_THREADS: "0" },
      /MINING_MAX_THREADS must be/,
    ],
    [
      { ...base, LAND_ID: "1", MINING_MAX_THREADS: "x" },
      /MINING_MAX_THREADS must be/,
    ],
    [{ ...base, LAND_ID: "1", RPC_URL: "nope" }, /RPC_URL is not a valid URL/],
  ])("rejects %j", (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });
});
