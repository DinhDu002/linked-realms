// Phase 1A entry check: the Player signs a short-lived message naming the Land (EIP-191).
// Phase 1C replaces it with a Travel ticket signed by the Hub.
import { recoverMessageAddress, type Address, type Hex } from "viem";

export const JOIN_TTL_SECONDS = 300;
const PATTERN = /^linked-realms: enter Land (\d{1,10})\nExpires: (\d{1,12})$/;

export function joinMessage(landId: number, expiresAt: number): string {
  return `linked-realms: enter Land ${landId}\nExpires: ${expiresAt}`;
}

export class JoinRejected extends Error {
  override name = "JoinRejected";
}

/** Returns the signer when `message` names `landId` and has not expired. */
export async function verifyJoinRequest(args: {
  message: unknown;
  signature: unknown;
  landId: number;
  nowSeconds: number;
}): Promise<Address> {
  const { message, signature, landId, nowSeconds } = args;
  if (
    typeof message !== "string" ||
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature)
  ) {
    throw new JoinRejected("malformed join request");
  }
  const match = PATTERN.exec(message);
  if (!match) throw new JoinRejected("malformed join message");
  if (Number(match[1]) !== landId)
    throw new JoinRejected("join message is for another Land");
  const expiresAt = Number(match[2]);
  if (expiresAt < nowSeconds) throw new JoinRejected("join message expired");
  if (expiresAt > nowSeconds + JOIN_TTL_SECONDS)
    throw new JoinRejected("join message expires too far ahead");
  return recoverMessageAddress({ message, signature: signature as Hex });
}
