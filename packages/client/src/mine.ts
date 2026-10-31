// The Land's Mine as its Map server reports it (docs/protocols/map-server-node.md). Map servers are
// untrusted (P1): a MineState or MineWon is shown only when it is well-formed, and what it says is
// the Land's statement, not proof; Gold is only what the chain says. formatAmount and the switch
// line's address check need `ready` from @linked-realms/core.
import { formatAmount } from "@linked-realms/core";
import { shortAddress } from "@linked-realms/shared";
import type { MineState, MineWon } from "@linked-realms/shared/land-protocol";
import { buildMineSwitch } from "@linked-realms/shared/mine-switch";
import { characterLabel } from "./players.ts";

export type MineStatus = "off" | "starting" | "on" | "unavailable";

export interface MineView {
  status: MineStatus;
  threads: number;
  maxThreads: number;
  /** Hashes a second over the last 10 seconds. */
  hashRate: number;
  mode: "" | "fast" | "light";
  rewardAddress: string;
  blocksWon: number;
  /** Only in the Land owner's copy: the session's challenge and the Map server's address. */
  challenge: string;
  mapServerKey: string;
}

export interface WinView {
  height: bigint;
  /** Base units: the Block reward at that height plus the Block's fees. */
  reward: bigint;
  rewardAddress: string;
}

const STATUSES: readonly string[] = ["off", "starting", "on", "unavailable"];
const MODES: readonly string[] = ["", "fast", "light"];
const MAX_UNITS = 2n ** 64n - 1n;

export function readMineState(m: MineState): MineView | undefined {
  if (!STATUSES.includes(m.status) || !MODES.includes(m.mode)) return undefined;
  if (!Number.isFinite(m.hashRate) || m.hashRate < 0) return undefined;
  return {
    status: m.status as MineStatus,
    threads: m.threads,
    maxThreads: m.maxThreads,
    hashRate: m.hashRate,
    mode: m.mode as MineView["mode"],
    rewardAddress: m.rewardAddress,
    blocksWon: m.blocksWon,
    challenge: m.challenge,
    mapServerKey: m.mapServerKey,
  };
}

export function readMineWon(m: MineWon): WinView | undefined {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(m.reward) || m.height < 1n)
    return undefined;
  const reward = BigInt(m.reward);
  if (reward > MAX_UNITS) return undefined;
  return { height: m.height, reward, rewardAddress: m.rewardAddress };
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function hashRateText(perSecond: number): string {
  if (perSecond >= 1e6) return `${(perSecond / 1e6).toFixed(1)} MH/s`;
  if (perSecond >= 1e3) return `${(perSecond / 1e3).toFixed(1)} kH/s`;
  return `${Math.round(perSecond)} H/s`;
}

/** Who the rewards go to: the Land owner's name when it is their address, else the short address. */
export function rewardsTo(
  address: string,
  owner: { address: string; name: string },
): string {
  return address === owner.address
    ? characterLabel({ address, name: owner.name })
    : shortAddress(address);
}

/** The always-visible HUD line (P5): accurate in the Land owner's own view, a claim for a visitor. */
export function mineHudText(view: MineView, rewardsLabel: string): string {
  if (view.status === "unavailable")
    return "Mine unavailable: this Land's Node is not running or not synced";
  if (view.status === "off") return "Mine OFF";
  return [
    view.status === "on" ? "Mine ON" : "Mine starting",
    count(view.threads, "thread"),
    ...(view.mode ? [view.mode] : []),
    ...(view.status === "on" ? [hashRateText(view.hashRate)] : []),
    ...(view.rewardAddress ? [`rewards to ${rewardsLabel}`] : []),
    `${count(view.blocksWon, "Block")} won`,
  ].join(" · ");
}

/** "+N GOLD", with N trimmed of trailing zeros: never a constant. */
export function rewardText(win: WinView): string {
  return `+${formatAmount(win.reward)} GOLD`;
}

export function winText(win: WinView): string {
  return `The Mine won Block #${win.height} (${rewardText(win)})`;
}

/** The line the Land owner signs to switch the Mine, or the plain-words reason it cannot be built. */
export function switchLine(
  view: MineView,
  on: boolean,
  threads: number,
): { line: string } | { problem: string } {
  if (view.status === "unavailable")
    return {
      problem: "The Mine cannot be switched while this Land's Node is down.",
    };
  if (!view.challenge)
    return {
      problem:
        "Wait a moment: the Land has not sent a challenge for the switch yet.",
    };
  if (
    on &&
    !(Number.isInteger(threads) && threads >= 1 && threads <= view.maxThreads)
  )
    return { problem: `Choose 1 to ${view.maxThreads} threads.` };
  try {
    const line = buildMineSwitch({
      mapServerKey: view.mapServerKey,
      on,
      threads: on ? threads : 0,
      nonce: view.challenge,
    });
    return { line };
  } catch {
    return {
      problem:
        "The Land sent a Mine state this page cannot use. Reload the Land.",
    };
  }
}

const RESULT_TEXT: Record<string, string> = {
  "not-owner": "Only the Land owner can switch the Mine.",
  "bad-statement":
    "The Land refused the signed switch. Reload the Land and try again.",
  stale:
    "The signed switch was too old. Check this device's clock and try again.",
  "wrong-nonce": "The switch answered an old challenge. Try again.",
  "bad-threads":
    "This Land's machine cannot run that many threads. Choose fewer.",
  unavailable:
    "This Land's Node is not running or not synced. Try again later.",
  "rate-limited": "Wait 2 seconds between switches.",
};

/** What the Land owner reads when the Map server answers their switch. */
export function switchResultText(
  result: { ok: boolean; code: string },
  on: boolean,
): string {
  if (result.ok) return on ? "The Mine is starting." : "The Mine is off.";
  return (
    RESULT_TEXT[result.code] ?? `The Land refused the switch (${result.code}).`
  );
}

export interface MineMotion {
  /** The glow's strongest alpha; dimmer while starting. */
  glow: number;
  /** One pulse, out and back. */
  pulseMs: number;
  spinDegPerSecond: number;
  sparksPerSecond: number;
}

/** How the Mine moves on the map while the Land says it runs; undefined while it does not. */
export function mineMotion(view: MineView | undefined): MineMotion | undefined {
  if (view?.status !== "on" && view?.status !== "starting") return undefined;
  const starting = view.status === "starting";
  const threads = Math.max(1, view.threads);
  // ponytail: caps keep a Land that claims a huge hash rate from flooding the scene.
  return {
    glow: starting ? 0.35 : 0.7,
    pulseMs: starting ? 1600 : 1000,
    spinDegPerSecond: Math.min(720, threads * (starting ? 30 : 60)),
    sparksPerSecond: starting ? 1 : Math.min(12, 1 + view.hashRate / 250),
  };
}
