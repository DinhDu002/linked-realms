import { describe, expect, it } from "vitest";
import type { DirectoryLand } from "@linked-realms/shared";
import { createGateEdge, decideGate } from "./gate.ts";

const addr = "0x0000000000000000000000000000000000000001" as const;
const land = (landId: number, x: number, y: number, online = true) =>
  ({ landId, owner: addr, x, y, miningKey: addr, online }) as DirectoryLand;
const here = { landId: 1, x: 0, y: 0 };

describe("decideGate", () => {
  it("travels to an online neighbour, from the current Land", () => {
    expect(decideGate("east", here, [land(1, 0, 0), land(2, 1, 0)])).toEqual({
      kind: "travel",
      landId: 2,
      from: 1,
    });
    expect(decideGate("south", here, [land(4, 0, 1)])).toMatchObject({
      landId: 4,
    });
  });

  it("says when there is no Land or it is offline", () => {
    expect(decideGate("east", here, [land(1, 0, 0)])).toEqual({
      kind: "notice",
      text: "No Land to the east",
    });
    expect(decideGate("north", here, [land(7, 0, -1, false)])).toEqual({
      kind: "notice",
      text: "Land 7 is offline",
    });
  });
});

describe("createGateEdge", () => {
  it("fires once per step onto a Gate until the Character steps off", () => {
    const edge = createGateEdge();
    expect(edge(undefined)).toBeUndefined();
    expect(edge("east")).toBe("east");
    expect(edge("east")).toBeUndefined();
    expect(edge(undefined)).toBeUndefined();
    expect(edge("east")).toBe("east");
  });

  it("fires again when moving straight onto another Gate", () => {
    const edge = createGateEdge();
    edge("north");
    expect(edge("west")).toBe("west");
  });
});
