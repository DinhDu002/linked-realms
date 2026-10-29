// Gate edges, pure. The scene reports which Gate the Character stands on every frame; the Shell decides travel.
import type { Direction } from "@linked-realms/shared";

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
