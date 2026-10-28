import { describe, expect, it } from "vitest";
import { formatHashRate } from "./format.ts";

describe("formatHashRate", () => {
  it("formats hash rates", () => {
    expect(formatHashRate(850)).toBe("850 H/s");
    expect(formatHashRate(3_340_000)).toBe("3.34 MH/s");
    expect(formatHashRate(2_000_000)).toBe("2 MH/s");
    expect(formatHashRate(1500)).toBe("1.5 kH/s");
    expect(formatHashRate(0)).toBe("0 H/s");
  });
});
