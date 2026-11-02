import { describe, expect, it } from "vitest";
import { landCommand, networkIdOf } from "./config.ts";

describe("landCommand", () => {
  it("is one line with nothing a shell would expand or need quoted", () => {
    const command = landCommand(
      "tlr1qqqmkrz7wdckqgrm76sjdmyhslmd8r33gf4s3y4d7qqwwrrpgscdmrcgw5jya",
      "https://hub.example.org",
      "ghcr.io/example/linked-realms-node:latest",
    );
    expect(command).toBe(
      "docker run -d --name linked-realms-land --restart unless-stopped -v linked-realms-land:/data" +
        " -e LAND_OWNER=tlr1qqqmkrz7wdckqgrm76sjdmyhslmd8r33gf4s3y4d7qqwwrrpgscdmrcgw5jya" +
        " -e HUB_URL=https://hub.example.org ghcr.io/example/linked-realms-node:latest",
    );
    // no quotes, $, backticks, ;, &, |, < >, globs or line breaks (sh and PowerShell alike)
    expect(command).toMatch(/^[\w .:/=-]+$/);
  });
});

describe("networkIdOf", () => {
  it("knows each network by its lr-node name, with core's id", () => {
    // LR's ids (DinhDu002/lr, crates/core/test-vectors/chain.json at v0.1.0).
    expect(networkIdOf("test")).toBe(3);
    expect(networkIdOf("dev")).toBe(2);
    expect(() => networkIdOf("main")).toThrow(/unknown network/);
    expect(() => networkIdOf("constructor")).toThrow(/unknown network/);
  });
});
