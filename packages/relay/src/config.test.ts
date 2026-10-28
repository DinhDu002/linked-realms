import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({ HUB_URL: "http://hub:8787" })).toEqual({
      port: 8080,
      hubUrl: "http://hub:8787",
      maxClientsPerLand: 64,
      maxHosts: 1000,
    });
  });

  it("reads overrides", () => {
    const c = loadConfig({
      HUB_URL: "https://h",
      PORT: "9000",
      MAX_CLIENTS_PER_LAND: "5",
      MAX_HOSTS: "7",
    });
    expect([c.port, c.maxClientsPerLand, c.maxHosts]).toEqual([9000, 5, 7]);
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({})).toThrow("HUB_URL is required");
    expect(() => loadConfig({ HUB_URL: "nope" })).toThrow("not a valid URL");
    expect(() => loadConfig({ HUB_URL: "ftp://x" })).toThrow("http(s)");
    expect(() => loadConfig({ HUB_URL: "http://h", PORT: "99999" })).toThrow(
      "PORT",
    );
    expect(() => loadConfig({ HUB_URL: "http://h", MAX_HOSTS: "0" })).toThrow(
      "MAX_HOSTS",
    );
    expect(() =>
      loadConfig({ HUB_URL: "http://h", MAX_CLIENTS_PER_LAND: "x" }),
    ).toThrow("MAX_CLIENTS_PER_LAND");
  });
});
