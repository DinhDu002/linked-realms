// Messages between a Map server and the client (Colyseus). State is synchronised by
// Colyseus schema reflection: LandState { landId, players: Map<sessionId, PlayerState>, mining: MiningState }.
import type { Address, Hex } from "viem";
import type { WireTravelTicket } from "./hub.ts";
import type { MoveInput } from "./movement.ts";

export const LAND_ROOM = "land";

/** Options passed to `joinOrCreate(LAND_ROOM, options)`. */
export interface JoinOptions {
  /** Signed by the Hub; the Map server verifies it offline (verifyTravelTicket). */
  ticket: WireTravelTicket;
  signature: Hex;
}

/** Fields of each `players` entry in the room state. */
export interface PlayerStateShape {
  address: Address;
  x: number;
  y: number;
  isOwner: boolean;
}

/** Fields of the room state's `mining` entry. Everyone on the Land sees it, so mining is never covert (P5). */
export interface MiningStateShape {
  on: boolean;
  threads: number;
  /** Hashes per second over the last few seconds. */
  hashRate: number;
  /** The GoldMine Round the miner is working on (as a number; Rounds stay far below 2^53). */
  round: number;
  /** Solutions this Map server has submitted and won since it started. */
  submitted: number;
  won: number;
}

export const Messages = {
  /** Server → client, once after joining: the Land's Tiled JSON text. The client must run parseLandMap on it (P6). */
  map: "map",
  /** Server → client, once after joining. */
  land: "land",
  /** Client → server, whenever the pressed keys change. */
  input: "input",
  /** Client → server, Land owner only: turn mining on or off (P5). */
  mining: "mining",
} as const;

export interface MiningMessage {
  on: boolean;
  /** Worker threads; the Map server clamps it to its configured maximum. */
  threads: number;
}

/** Accepts only a well-formed mining switch from an untrusted client. */
export function parseMiningMessage(value: unknown): MiningMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.on !== "boolean" ||
    !Number.isInteger(v.threads) ||
    (v.threads as number) < 1 ||
    (v.threads as number) > 256
  ) {
    return undefined;
  }
  return { on: v.on, threads: v.threads as number };
}

export interface MapMessage {
  tiled: string;
}

export interface LandMessage {
  landId: number;
  owner: Address;
  x: number;
  y: number;
  /** The Map server's Mining key, which the Land owner signs a Delegation for. */
  miningKey: Address;
}

export type InputMessage = MoveInput;

/** Accepts only a well-formed input message from an untrusted client. */
export function parseInputMessage(value: unknown): InputMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const keys = ["up", "down", "left", "right"] as const;
  if (!keys.every((k) => typeof v[k] === "boolean")) return undefined;
  return {
    up: v.up as boolean,
    down: v.down as boolean,
    left: v.left as boolean,
    right: v.right as boolean,
  };
}
