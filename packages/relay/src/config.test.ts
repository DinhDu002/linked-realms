import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({ HUB_URL: "http://hub:8787" })).toEqual({
      port: 8080,
      hubUrl: "http://hub:8787",
      relayHost: "localhost:8080",
      landBaseDomain: "localhost:8080",
      shellOrigins: [],
      maxClientsPerLand: 64,
      maxHosts: 1000,
      playerMaxFrame: 16 * 1024,
    });
  });

  it("reads overrides", () => {
    const c = loadConfig({
      HUB_URL: "https://h",
      PORT: "9000",
      RELAY_HOST: "relay.example",
      LAND_BASE_DOMAIN: "lands.example",
      SHELL_ORIGINS: "https://shell.example, http://localhost:5173",
      MAX_CLIENTS_PER_LAND: "5",
      MAX_HOSTS: "7",
      PLAYER_MAX_FRAME: "1024",
    });
    expect(c).toMatchObject({
      port: 9000,
      relayHost: "relay.example",
      landBaseDomain: "lands.example",
      shellOrigins: ["https://shell.example", "http://localhost:5173"],
      maxClientsPerLand: 5,
      maxHosts: 7,
      playerMaxFrame: 1024,
    });
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({})).toThrow("HUB_URL is required");
    expect(() => loadConfig({ HUB_URL: "nope" })).toThrow("not a valid URL");
    expect(() => loadConfig({ HUB_URL: "ftp://x" })).toThrow("http(s)");
    const bad = (name: string, value: string) =>
      expect(() => loadConfig({ HUB_URL: "http://h", [name]: value })).toThrow(
        name,
      );
    bad("PORT", "99999");
    bad("MAX_HOSTS", "0");
    bad("MAX_CLIENTS_PER_LAND", "x");
    bad("PLAYER_MAX_FRAME", "0");
    bad("RELAY_HOST", "Relay.Example");
    bad("RELAY_HOST", "relay.example/path");
    bad("LAND_BASE_DOMAIN", "https://lands.example");
    bad("SHELL_ORIGINS", "shell.example");
    bad("SHELL_ORIGINS", "https://shell.example/");
    bad("SHELL_ORIGINS", "https://shell.example/app");
    bad("SHELL_ORIGINS", "ftp://shell.example");
    bad("SHELL_ORIGINS", "https://a.example,nope");
  });
});
