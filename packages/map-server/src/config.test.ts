import { describe, expect, it } from "vitest";
import { Key } from "@linked-realms/core";
import { loadConfig } from "./config.ts";

const address = (byte: number) =>
  Key.fromSeed(new Uint8Array(32).fill(byte)).address;
const OWNER = address(1);
const SIGNER = address(0x48);
const base = { LAND_OWNER: OWNER, HUB_TICKET_SIGNER: SIGNER };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      landOwner: OWNER,
      hubUrl: "http://localhost:8787",
      hubDomain: "localhost:8787",
      hubTicketSigner: SIGNER,
      port: 2567,
      host: "127.0.0.1",
      relayUrl: undefined,
    });
    expect(config.mapFile).toMatch(/maps\/empty-land\.json$/);
    expect(config.mapServerKeyFile).toMatch(
      /packages\/map-server\/\.data\/map-server-key$/,
    );
    expect(config.landUiDir).toMatch(/packages\/client\/dist$/);
  });

  it("reads overrides", () => {
    const config = loadConfig({
      ...base,
      HUB_URL: "http://hub:8787",
      HUB_DOMAIN: "hub.example",
      PORT: "2601",
      HOST: "0.0.0.0",
      RELAY_URL: "wss://relay.test",
      MAP_FILE: "/tmp/m.json",
      MAP_SERVER_KEY_FILE: "/tmp/key",
      LAND_UI_DIR: "/tmp/ui",
    });
    expect(config).toEqual({
      landOwner: OWNER,
      hubUrl: "http://hub:8787",
      hubDomain: "hub.example",
      hubTicketSigner: SIGNER,
      mapServerKeyFile: "/tmp/key",
      port: 2601,
      host: "0.0.0.0",
      relayUrl: "wss://relay.test",
      mapFile: "/tmp/m.json",
      landUiDir: "/tmp/ui",
    });
  });

  it("requires LAND_OWNER only, and checks both addresses", () => {
    expect(() => loadConfig({ HUB_TICKET_SIGNER: SIGNER })).toThrow(
      /LAND_OWNER is required/,
    );
    // the ticket signer and the relay then come from the Hub's GET /keys
    expect(loadConfig({ LAND_OWNER: OWNER })).toMatchObject({
      hubTicketSigner: undefined,
      relayUrl: undefined,
    });
    expect(() => loadConfig({ ...base, LAND_OWNER: "0xabc" })).toThrow(
      /LAND_OWNER is not an address/,
    );
    expect(() =>
      loadConfig({ ...base, HUB_TICKET_SIGNER: OWNER.toUpperCase() }),
    ).toThrow(/HUB_TICKET_SIGNER is not an address/);
  });

  it("rejects a bad HUB_URL, HUB_DOMAIN, RELAY_URL or PORT", () => {
    expect(() => loadConfig({ ...base, HUB_URL: "nope" })).toThrow(
      /HUB_URL is not a valid URL/,
    );
    expect(() => loadConfig({ ...base, HUB_URL: "ftp://hub" })).toThrow(
      /http:\/\/ or https:\/\//,
    );
    expect(() => loadConfig({ ...base, HUB_DOMAIN: "Hub Example" })).toThrow(
      /HUB_DOMAIN is not a host/,
    );
    for (const RELAY_URL of [
      "http://relay",
      "wss://relay/host",
      "wss://relay?a",
    ])
      expect(() => loadConfig({ ...base, RELAY_URL })).toThrow(
        /RELAY_URL must be a ws:\/\/ or wss:\/\/ URL with no path/,
      );
    for (const PORT of ["0", "65536", "1.5", "abc"])
      expect(() => loadConfig({ ...base, PORT })).toThrow(/PORT must be/);
  });

  it("treats empty variables as unset", () => {
    expect(
      loadConfig({
        ...base,
        HUB_URL: "",
        HUB_TICKET_SIGNER: "",
        RELAY_URL: "",
        PORT: "",
      }),
    ).toMatchObject({
      hubUrl: "http://localhost:8787",
      hubTicketSigner: undefined,
      relayUrl: undefined,
      port: 2567,
    });
  });
});
