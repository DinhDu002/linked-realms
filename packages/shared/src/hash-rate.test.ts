import { describe, expect, it } from "vitest";
import { hashRateText } from "./hash-rate.ts";

describe("hashRateText", () => {
  it("writes hash rates in H/s, kH/s and MH/s", () => {
    expect(hashRateText(0)).toBe("0 H/s");
    expect(hashRateText(850.4)).toBe("850 H/s");
    expect(hashRateText(1180.5)).toBe("1.2 kH/s");
    expect(hashRateText(3_400_000)).toBe("3.4 MH/s");
    expect(hashRateText(999)).toBe("999 H/s");
    expect(hashRateText(1000)).toBe("1.0 kH/s");
    expect(hashRateText(1_000_000)).toBe("1.0 MH/s");
  });
});
