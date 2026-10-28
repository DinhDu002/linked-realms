import { describe, expect, it } from "vitest";
import { shortAddress, statRows } from "./format.ts";

describe("format", () => {
  it("shortens an address", () => {
    expect(shortAddress("0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9")).toBe(
      "0xCf7E…0Fc9",
    );
  });

  it("renders stat rows in order", () => {
    expect(
      statRows([
        { key: "strength", value: 1n },
        { key: "agility", value: 12n },
      ]),
    ).toEqual([
      ["strength", "1"],
      ["agility", "12"],
    ]);
  });
});
