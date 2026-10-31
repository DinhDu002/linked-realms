// The Land's Mine as the reference Land kit runs it (docs/protocols/map-server-node.md, "The
// switch"): the Land owner's per-session challenge, checks 3 to 5 of "Checks, in order" on a signed
// switch, and the MineState each session is sent. Checks 1, 2 and 6 need the session and the Node
// (land.ts).
import { randomBytes } from "node:crypto";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  StatementError,
  verifyStatement,
} from "@linked-realms/shared/identity";
import type { MineStateSchema } from "@linked-realms/shared/land-protocol";
import {
  parseMineSwitch,
  type MineSwitch,
} from "@linked-realms/shared/mine-switch";
import type { MineStatus, NodeLink } from "./node.ts";

export const SWITCH_EVERY_MS = 2000;
/** How long a challenge lasts, and how far `Issued` may be from this server's clock. */
export const WINDOW_SECONDS = 300;

export interface Challenge {
  nonce: string;
  /** Unix seconds. */
  issued: number;
}

export const newChallenge = (nowSeconds: number): Challenge => ({
  nonce: randomBytes(16).toString("hex"),
  issued: nowSeconds,
});

export const expired = (challenge: Challenge, nowSeconds: number) =>
  nowSeconds >= challenge.issued + WINDOW_SECONDS;

export type SwitchRefusal =
  "bad-statement" | "not-owner" | "stale" | "wrong-nonce";

/**
 * Checks 3 to 5 on an untrusted signed switch: the signature first (identity.md's order), then the
 * Land owner, the Land and the time, then the line, the Map server key and the challenge. A
 * `switch` back means the challenge is spent.
 */
export function checkSwitch(
  signed: unknown,
  served: {
    landId: number;
    owner: string;
    mapServerKey: string;
    nowSeconds: number;
    challenge: Challenge | undefined;
  },
): { refused: SwitchRefusal } | { switch: MineSwitch } {
  let fields;
  try {
    fields = verifyStatement(signed, "land-message").fields;
  } catch (error) {
    if (error instanceof StatementError) return { refused: "bad-statement" };
    throw error;
  }
  if (fields.character !== served.owner) return { refused: "not-owner" };
  if (fields.land !== served.landId) return { refused: "bad-statement" };
  if (Math.abs(served.nowSeconds - fields.issued) > WINDOW_SECONDS)
    return { refused: "stale" };
  let line;
  try {
    line = parseMineSwitch(fields.message);
  } catch (error) {
    if (error instanceof StatementError) return { refused: "bad-statement" };
    throw error;
  }
  if (line.mapServerKey !== served.mapServerKey)
    return { refused: "bad-statement" };
  const { challenge } = served;
  if (
    !challenge ||
    line.nonce !== challenge.nonce ||
    expired(challenge, served.nowSeconds)
  )
    return { refused: "wrong-nonce" };
  return { switch: line };
}

/**
 * The MineState for one session; `owner` only in a Land owner's session. `unavailable` while the
 * Node cannot be reached, or while its Mine is off and it has no other Node or is not synced: a
 * Mine that runs is reported as running, whatever the Node's sync (P5).
 */
export function mineState(
  node: NodeLink | undefined,
  owner?: { challenge: string; mapServerKey: string },
): MessageInitShape<typeof MineStateSchema> {
  const info = node?.info();
  const status = node?.status();
  const ready =
    info !== undefined &&
    status !== undefined &&
    (status.state !== "off" || (info.synced && info.connections > 0));
  return {
    status: ready ? status.state : "unavailable",
    threads: status?.threads ?? 0,
    maxThreads: info?.maxThreads ?? 0,
    hashRate: status?.hashRate ?? 0,
    mode: status?.mode ?? "",
    rewardAddress: status?.rewardAddress ?? "",
    blocksWon: status?.blocksWon ?? 0,
    challenge: owner?.challenge ?? "",
    mapServerKey: owner?.mapServerKey ?? "",
  };
}

/** The console line for each change of what the Mine really runs (P5), or undefined. */
export function mineLine(
  before: MineStatus | undefined,
  now: MineStatus | undefined,
): string | undefined {
  const on = now?.state === "on";
  if (on && before?.state !== "on")
    return `Mine ON: ${now.threads} thread${now.threads === 1 ? "" : "s"}, ${now.mode} mode, rewards to ${now.rewardAddress}`;
  // A Node out of reach says nothing here: the control link and the supervisor log that.
  if (now?.state === "off" && before !== undefined && before.state !== "off")
    return "Mine OFF";
  return undefined;
}
