// The dashboard's figures (docs/plans/phase-2-open-testing.md). Pure: the API route queries, this
// computes, and renderDashboard turns it into HTML.

import { formatHashRate } from "@linked-realms/shared";

export const ACTIVE_WINDOW_SECONDS = 24n * 60n * 60n;
export const ROUND_TIME_SAMPLE = 100;
export const TOP_WINNERS = 20;

export interface WinRow {
  rewardWallet: string;
  timestamp: bigint;
}

export interface LandRow {
  id: bigint;
  owner: string;
}

export interface DashboardInput {
  nowSeconds: bigint;
  /** GoldMine.target() now */
  target: bigint;
  /** The most recent won Rounds, newest first */
  wins: WinRow[];
  lands: LandRow[];
  /** From the Hub's Directory; undefined when unknown */
  landsOnline: number | undefined;
}

export interface Winner {
  /** undefined for the "others" row */
  landId: bigint | undefined;
  wallet: string | undefined;
  rounds: number;
  share: number;
}

export interface Dashboard {
  landsOnline: number | undefined;
  /** Distinct reward wallets that won a Round in the last 24 hours */
  minesMining: number;
  /** Mean seconds between the last ROUND_TIME_SAMPLE won Rounds */
  roundSeconds: number | undefined;
  /** Hashes per second: expected hashes per Solution over seconds per Solution */
  hashRate: number | undefined;
  /** Over `wins.length` Rounds, most wins first */
  winners: Winner[];
  roundsSampled: number;
}

export function computeDashboard(input: DashboardInput): Dashboard {
  const { wins } = input;
  const since = input.nowSeconds - ACTIVE_WINDOW_SECONDS;
  const active = new Set(
    wins
      .filter((w) => w.timestamp >= since)
      .map((w) => w.rewardWallet.toLowerCase()),
  );

  const sample = wins.slice(0, ROUND_TIME_SAMPLE);
  const roundSeconds =
    sample.length >= 2
      ? Number(sample[0]!.timestamp - sample[sample.length - 1]!.timestamp) /
        (sample.length - 1)
      : undefined;
  const hashRate =
    roundSeconds && input.target > 0n
      ? Number(2n ** 256n / input.target) / roundSeconds
      : undefined;

  const landOf = new Map(input.lands.map((l) => [l.owner.toLowerCase(), l.id]));
  const counts = new Map<string, number>();
  for (const w of wins) {
    const wallet = w.rewardWallet.toLowerCase();
    counts.set(wallet, (counts.get(wallet) ?? 0) + 1);
  }
  const ranked = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([wallet, rounds]) => ({
      landId: landOf.get(wallet),
      wallet,
      rounds,
      share: rounds / wins.length,
    }));
  const winners: Winner[] = ranked.slice(0, TOP_WINNERS);
  const rest = ranked.slice(TOP_WINNERS).reduce((n, w) => n + w.rounds, 0);
  if (rest > 0)
    winners.push({
      landId: undefined,
      wallet: undefined,
      rounds: rest,
      share: rest / wins.length,
    });

  return {
    landsOnline: input.landsOnline,
    minesMining: active.size,
    roundSeconds,
    hashRate,
    winners,
    roundsSampled: wins.length,
  };
}

/** Counts online Lands in a Directory response; undefined if it is not one. */
export function countOnline(directory: unknown): number | undefined {
  const lands = (directory as { lands?: unknown } | null)?.lands;
  if (!Array.isArray(lands)) return undefined;
  return lands.filter((l) => (l as { online?: unknown })?.online === true)
    .length;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;

function tile(label: string, value: string, note: string): string {
  return `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="note">${escapeHtml(note)}</div></div>`;
}

/** The whole page: server-rendered HTML, no script. */
export function renderDashboard(
  d: Dashboard,
  meta: { chainId: number; nowSeconds: bigint },
): string {
  const updated = new Date(Number(meta.nowSeconds) * 1000).toISOString();
  const tiles = [
    tile(
      "Lands online",
      d.landsOnline === undefined ? "unknown" : String(d.landsOnline),
      "linked to the relay now",
    ),
    tile(
      "Mines mining",
      String(d.minesMining),
      "won a Round in the last 24 hours",
    ),
    tile(
      "Round time",
      d.roundSeconds === undefined ? "–" : `${d.roundSeconds.toFixed(1)} s`,
      `mean of the last ${Math.min(d.roundsSampled, ROUND_TIME_SAMPLE)} won Rounds`,
    ),
    tile(
      "Estimated hash rate",
      d.hashRate === undefined ? "–" : formatHashRate(d.hashRate),
      "from the current target and Round time",
    ),
  ].join("");
  const top = Math.max(0, ...d.winners.map((w) => w.share));
  const rows = d.winners
    .map((w) => {
      const land = w.landId === undefined ? "Others" : `Land ${w.landId}`;
      const wallet =
        w.wallet === undefined
          ? ""
          : `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`;
      const title = `${land}: ${w.rounds} Round${w.rounds === 1 ? "" : "s"} (${percent(w.share)})`;
      const width = top > 0 ? (w.share / top) * 100 : 0;
      return `<tr><td>${escapeHtml(land)}</td><td>${escapeHtml(wallet)}</td><td class="num">${w.rounds}</td><td class="num">${percent(w.share)}</td><td class="track"><div class="bar" style="width:${width.toFixed(2)}%" title="${escapeHtml(title)}"></div></td></tr>`;
    })
    .join("");
  const winners =
    d.winners.length === 0
      ? "<p>No Round won yet.</p>"
      : `<table><thead><tr><th>Land</th><th>Owner</th><th class="num">Rounds</th><th class="num">Share</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>linked-realms dashboard</title>
<style>
.viz-root { color-scheme: light; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --grid: #e4e3df; --series-1: #2a78d6; }
@media (prefers-color-scheme: dark) {
  .viz-root { color-scheme: dark; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --grid: #33332f; --series-1: #3987e5; }
}
body { margin: 0; }
.viz-root { min-height: 100vh; box-sizing: border-box; padding: 24px; background: var(--surface-1); color: var(--text-primary); font: 15px/1.4 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 4px; }
.meta, .note, .label, th, .caption { color: var(--text-secondary); }
.meta, .caption { font-size: 13px; margin: 4px 0 12px; }
.tiles { display: flex; flex-wrap: wrap; gap: 32px; margin: 20px 0 32px; }
.label, .note { font-size: 13px; }
.value { font-size: 32px; font-weight: 600; font-variant-numeric: tabular-nums; }
table { border-collapse: collapse; }
th, td { padding: 4px 16px 4px 0; border-bottom: 1px solid var(--grid); text-align: left; }
th { font-size: 13px; font-weight: 500; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.track { width: 240px; }
.bar { height: 12px; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--series-1); }
</style>
</head>
<body>
<main class="viz-root">
<h1>linked-realms: the world</h1>
<p class="meta">Chain ${meta.chainId} · updated ${escapeHtml(updated)} · refreshes every 30 s</p>
<section class="tiles">${tiles}</section>
<section>
<h2>Winner distribution</h2>
<p class="caption">Rounds won per Land over the last ${d.roundsSampled} won Rounds</p>
${winners}
</section>
</main>
</body>
</html>
`;
}
