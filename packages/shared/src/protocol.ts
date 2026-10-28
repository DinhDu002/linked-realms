// Messages between a Map server and the client (Colyseus). State is synchronised by
// Colyseus schema reflection: LandState { landId, players: Map<sessionId, PlayerState> }.
import type { Address, Hex } from "viem";
import type { MoveInput } from "./movement.ts";

export const LAND_ROOM = "land";

/** Options passed to `joinOrCreate(LAND_ROOM, options)`. */
export interface JoinOptions {
  message: string;
  signature: Hex;
}

/** Fields of each `players` entry in the room state. */
export interface PlayerStateShape {
  address: Address;
  x: number;
  y: number;
  isOwner: boolean;
}

export const Messages = {
  /** Server → client, once after joining: the Land's Tiled JSON text. The client must run parseLandMap on it (P6). */
  map: "map",
  /** Server → client, once after joining. */
  land: "land",
  /** Client → server, whenever the pressed keys change. */
  input: "input",
} as const;

export interface MapMessage {
  tiled: string;
}

export interface LandMessage {
  landId: number;
  owner: Address;
  x: number;
  y: number;
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
