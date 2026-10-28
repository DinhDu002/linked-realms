// Gate decisions, pure. The scene reports which Gate the Character stands on every frame.
import {
  neighbourOf,
  type Direction,
  type DirectoryLand,
} from "@linked-realms/shared";

/** Fires once per step onto a Gate; steps off re-arm it. */
export function createGateEdge(): (
  gate: Direction | undefined,
) => Direction | undefined {
  let last: Direction | undefined;
  return (gate) => {
    const fired = gate !== undefined && gate !== last ? gate : undefined;
    last = gate;
    return fired;
  };
}

export type GateDecision =
  | { kind: "notice"; text: string }
  | { kind: "travel"; landId: number; from: number };

/** What to do when the Character steps onto the `gate` of `here`, given a fresh Directory. */
export function decideGate(
  gate: Direction,
  here: { landId: number; x: number; y: number },
  lands: readonly DirectoryLand[],
): GateDecision {
  const next = neighbourOf(here.x, here.y, gate);
  const land = lands.find((l) => l.x === next.x && l.y === next.y);
  if (!land) return { kind: "notice", text: `No Land to the ${gate}` };
  if (!land.online)
    return { kind: "notice", text: `Land ${land.landId} is offline` };
  return { kind: "travel", landId: land.landId, from: here.landId };
}
