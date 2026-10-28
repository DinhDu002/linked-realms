import { describe, expect, it } from "vitest";
import { formatGold, shortAddress, statRows } from "./format.ts";

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

describe("formatGold", () => {
  it("formats gold without float errors", () => {
    expect(formatGold(50n * 10n ** 18n)).toBe("50 GOLD");
    expect(formatGold(125n * 10n ** 17n)).toBe("12.5 GOLD");
    expect(formatGold(1n)).toBe("0.000000000000000001 GOLD");
    expect(formatGold(0n)).toBe("0 GOLD");
    expect(formatGold(21_000_000n * 10n ** 18n + 1n)).toBe(
      "21000000.000000000000000001 GOLD",
    );
  });
});
