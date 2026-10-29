import { describe, expect, it } from "vitest";
import { createGateEdge } from "./gate.ts";

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
