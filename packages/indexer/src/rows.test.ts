import { statKeyToBytes32 } from "@linked-realms/shared";
import { describe, expect, it } from "vitest";
import { characterRow, landRow, statRow } from "./rows.ts";

const player = "0x00000000000000000000000000000000000000aa";
const block = { number: 7n, timestamp: 1700n };

describe("rows", () => {
  it("builds a character row", () => {
    expect(characterRow(player, 3n, block)).toEqual({
      player,
      landId: 3n,
      createdAtBlock: 7n,
      createdAtTimestamp: 1700n,
    });
  });

  it("decodes the stat key to text", () => {
    expect(statRow(player, statKeyToBytes32("agility"), 1n)).toEqual({
      player,
      key: "agility",
      value: 1n,
    });
  });

  it("builds a land row without a design hash", () => {
    const row = landRow(1n, player, -2, 5, block);
    expect(row).toEqual({
      id: 1n,
      owner: player,
      x: -2,
      y: 5,
      mintedAtBlock: 7n,
      mintedAtTimestamp: 1700n,
    });
    expect("designHash" in row).toBe(false);
  });
});
