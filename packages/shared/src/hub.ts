// Hub definitions shared by hub-api, the Map server and the client: the EIP-712 types of the
// Delegation and the Travel ticket, offline ticket verification, and the Directory shapes.
import {
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import type { Direction } from "./rules/world.ts";

export class JoinRejected extends Error {
  override name = "JoinRejected";
}

export const HUB_EIP712_DOMAIN = (chainId: number) =>
  ({ name: "linked-realms Hub", version: "1", chainId }) as const;

/** Signed by the Land owner: this Mining key may host the Land. */
export const DelegationTypes = {
  Delegation: [
    { name: "landId", type: "uint256" },
    { name: "miningKey", type: "address" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

/** Signed by the Hub: this Player may enter the Land until `expiresAt`. */
export const TravelTicketTypes = {
  TravelTicket: [
    { name: "player", type: "address" },
    { name: "landId", type: "uint256" },
    { name: "gate", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

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
/** Allowed clock difference between the Hub and a Map server. */
const CLOCK_SKEW_SECONDS = 5;

export interface Delegation {
  landId: bigint;
  miningKey: Address;
  issuedAt: bigint;
}

export interface TravelTicket {
  player: Address;
  landId: bigint;
  gate: number;
  expiresAt: bigint;
  nonce: Hex;
}

/**
 * Wire format of a ticket in JSON (join options, hub-api responses): uint256 and uint64 fields
 * are decimal strings, because JSON numbers cannot hold them; everything else is as in TravelTicket.
 */
export interface WireTravelTicket {
  player: Address;
  landId: string;
  gate: number;
  expiresAt: string;
  nonce: Hex;
}

export function ticketToWire(ticket: TravelTicket): WireTravelTicket {
  return {
    ...ticket,
    landId: ticket.landId.toString(),
    expiresAt: ticket.expiresAt.toString(),
  };
}

const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

function decimal(value: unknown, max: bigint, what: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value))
    throw new JoinRejected(`malformed ticket ${what}`);
  const n = BigInt(value);
  if (n > max) throw new JoinRejected(`malformed ticket ${what}`);
  return n;
}

/** Accepts only a well-formed wire ticket from an untrusted source. */
export function parseWireTicket(value: unknown): TravelTicket {
  if (typeof value !== "object" || value === null)
    throw new JoinRejected("malformed ticket");
  const v = value as Record<string, unknown>;
  if (typeof v.player !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v.player))
    throw new JoinRejected("malformed ticket player");
  if (
    !Number.isInteger(v.gate) ||
    (v.gate as number) < 0 ||
    (v.gate as number) > 4
  )
    throw new JoinRejected("malformed ticket gate");
  if (typeof v.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.nonce))
    throw new JoinRejected("malformed ticket nonce");
  return {
    player: v.player as Address,
    landId: decimal(v.landId, UINT256_MAX, "landId"),
    gate: v.gate as number,
    expiresAt: decimal(v.expiresAt, UINT64_MAX, "expiresAt"),
    nonce: v.nonce as Hex,
  };
}

/**
 * Checks a Travel ticket without contacting the Hub: signed by `hubSigner` (under the Hub's
 * EIP-712 domain for `chainId`), for this Land, not expired, and not valid for much longer than
 * the Hub issues. Single use is the caller's job (remember `nonce` until `expiresAt`).
 */
export async function verifyTravelTicket(args: {
  ticket: unknown;
  signature: unknown;
  hubSigner: Address;
  chainId: number;
  landId: number;
  nowSeconds: number;
}): Promise<TravelTicket> {
  const { signature, hubSigner, chainId, landId, nowSeconds } = args;
  const ticket = parseWireTicket(args.ticket);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature))
    throw new JoinRejected("malformed signature");
  if (ticket.landId !== BigInt(landId))
    throw new JoinRejected("ticket is for another Land");
  const now = BigInt(nowSeconds);
  if (ticket.expiresAt <= now) throw new JoinRejected("ticket expired");
  if (
    ticket.expiresAt >
    now + BigInt(TRAVEL_TICKET_TTL_SECONDS + CLOCK_SKEW_SECONDS)
  )
    throw new JoinRejected("ticket expires too far ahead");
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: HUB_EIP712_DOMAIN(chainId),
      types: TravelTicketTypes,
      primaryType: "TravelTicket",
      message: ticket,
      signature: signature as Hex,
    });
  } catch {
    throw new JoinRejected("malformed signature");
  }
  if (!isAddressEqual(signer, hubSigner))
    throw new JoinRejected("ticket not signed by the Hub");
  return ticket;
}

export interface DirectoryLand {
  landId: number;
  owner: Address;
  x: number;
  y: number;
  miningKey: Address;
  online: boolean;
}

export interface Directory {
  relayUrl: string;
  lands: DirectoryLand[];
}

/** The Colyseus endpoint of a Land behind the relay. */
export function relayLandUrl(relayUrl: string, landId: number): string {
  return `${relayUrl.replace(/\/+$/, "")}/land/${landId}`;
}
