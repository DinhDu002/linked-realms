import { readFileSync } from "node:fs";
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
    const chain = JSON.parse(
      readFileSync(
        new URL(
          "../../../crates/core/test-vectors/chain.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { networks: { name: string; networkId: number }[] };
    const id = (name: string) =>
      chain.networks.find((n) => n.name === name)?.networkId;
    expect(networkIdOf("test")).toBe(id("testnet"));
    expect(networkIdOf("dev")).toBe(id("dev"));
    expect(() => networkIdOf("main")).toThrow(/unknown network/);
    expect(() => networkIdOf("constructor")).toThrow(/unknown network/);
  });
});
