import { describe, expect, it } from "vitest";
import { readPlayer } from "./players.ts";

const address = "0x000000000000000000000000000000000000dEaD";

describe("readPlayer", () => {
  it("accepts a well-formed player", () => {
    expect(readPlayer({ address, x: 1, y: 2, isOwner: true })).toEqual({
      address,
      x: 1,
      y: 2,
      isOwner: true,
    });
  });

  it.each([
    null,
    { address: 5, x: 1, y: 2 },
    { address: "0xnope", x: 1, y: 2 },
    { address, x: Number.NaN, y: 2 },
    { address, x: 1, y: Number.POSITIVE_INFINITY },
    { address, x: "1", y: 2 },
  ])("rejects %j", (value) => {
    expect(readPlayer(value)).toBeUndefined();
  });
});
