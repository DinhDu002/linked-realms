// Hub definitions shared by hub-api, the relay, the Map server, the Land UI and the Shell: Gate
// numbers in Travel tickets, and the Land and Directory shapes (docs/protocols/).
import type { Direction } from "./rules/world.ts";

/** `gate` in a ticket: the arrival Gate. GATE_NONE spawns at the Land's own spawn point. */
export const GATE_NONE = 0;
export const GATE_NORTH = 1;
export const GATE_EAST = 2;
export const GATE_SOUTH = 3;
export const GATE_WEST = 4;

const GATE_NUMBERS: Record<Direction, number> = {
  north: GATE_NORTH,
  east: GATE_EAST,
  south: GATE_SOUTH,
  west: GATE_WEST,
};

export function gateNumber(direction: Direction): number {
  return GATE_NUMBERS[direction];
}

/** The Gate direction for a ticket's `gate`, or undefined for GATE_NONE. */
export function gateDirection(gate: number): Direction | undefined {
  return (Object.keys(GATE_NUMBERS) as Direction[]).find(
    (d) => GATE_NUMBERS[d] === gate,
  );
}

export const TRAVEL_TICKET_TTL_SECONDS = 60;

/** A registered Land as the Hub returns it (docs/protocols/map-server-hub-relay.md). */
export interface LandInfo {
  landId: number;
  owner: string;
  ownerName: string;
  /** The Land's cell; null while it has none. */
  x: number | null;
  y: number | null;
  url: string;
  mapServerKey: string;
  online: boolean;
}

/**
 * An address as Players see it next to a name: `tlr1`, then the first 6 and the last 6 of the
 * characters that differ between addresses (every address starts `tlr1qqq`). Payments show the
 * full address.
 */
export function shortAddress(address: string): string {
  return `tlr1${address.slice(7, 13)}…${address.slice(-6)}`;
}

/** `GET /directory`: the Lands that have a cell. */
export interface LandDirectory {
  lands: (LandInfo & { x: number; y: number })[];
}
