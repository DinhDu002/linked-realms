import { formatHashRate, type MiningStateShape } from "@linked-realms/shared";

const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Map servers are untrusted (P1): show mining state only when it is well-formed. */
export function readMining(value: unknown): MiningStateShape | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  if (typeof m.on !== "boolean") return undefined;
  if (typeof m.hashRate !== "number" || !Number.isFinite(m.hashRate))
    return undefined;
  if (m.hashRate < 0) return undefined;
  if (!count(m.threads) || !count(m.round)) return undefined;
  if (!count(m.submitted) || !count(m.won)) return undefined;
  return {
    on: m.on,
    threads: m.threads,
    hashRate: m.hashRate,
    round: m.round,
    submitted: m.submitted,
    won: m.won,
  };
}

/** The HUD line everyone on the Land sees, so mining is never hidden (P5). */
export function miningLabel(state: MiningStateShape | undefined): string {
  if (!state) return "Mine: unavailable";
  if (!state.on) return "Mine: off";
  const threads = `${state.threads} thread${state.threads === 1 ? "" : "s"}`;
  return `Mine: ON, ${threads}, ${formatHashRate(state.hashRate)}, Round ${state.round}, won ${state.won}`;
}
