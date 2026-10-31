// The dashboard's figures (docs/plans/phase-2c-the-chain.md, "Dashboard" and item 25). Pure:
// read.ts reads the Public node and the Hub, this computes, and renderDashboard writes the page.
import { hashRateText, shortAddress } from "@linked-realms/shared";

/** The Blocks read: lr_getHeaders' most, so one call. */
export const WINDOW_BLOCKS = 2000;
export const ACTIVE_SECONDS = 24 * 60 * 60;
/** Block time and hash rate are taken over the gaps between the last this many + 1 Blocks. */
export const BLOCK_TIME_SAMPLE = 100;
export const TOP_WINNERS = 20;
export const LATEST_BLOCKS = 10;

export interface BlockRow {
  height: number;
  id: string;
  timestamp: number;
  /** The Target, 64 hex digits. */
  target: string;
  rewardAddress: string;
  /** The Accounts the Block created; null where the Public node cannot count them. */
  newAccounts: number | null;
}

export interface LandRow {
  landId: number;
  owner: string;
  online: boolean;
}

export interface DashboardInput {
  nowSeconds: number;
  networkId: number;
  /** The best chain's last Blocks, lowest first, without the genesis. */
  blocks: BlockRow[];
  /** From the Hub's Directory; undefined when it did not answer. */
  lands: LandRow[] | undefined;
}

export interface Winner {
  /** undefined for the "Others" row */
  address: string | undefined;
  /** The Land whose owner is the reward address (a Land's Mine pays its owner). */
  landId: number | undefined;
  blocks: number;
  share: number;
  newAccounts: number;
  /** Its Blocks whose new Accounts the Public node could not count. */
  uncounted: number;
}

export interface LatestBlock {
  height: number;
  timestamp: number;
  rewardAddress: string;
  landId: number | undefined;
  newAccounts: number | null;
}

export interface Dashboard {
  networkId: number;
  tipHeight: number | undefined;
  landsOnline: number | undefined;
  /** Distinct reward addresses with a Block in the last 24 hours, among the Blocks read. */
  minesMining: number;
  /** Whether the Blocks read go back 24 hours; if not, minesMining covers less. */
  coversDay: boolean;
  /** Mean seconds between the last BLOCK_TIME_SAMPLE + 1 Blocks. */
  blockSeconds: number | undefined;
  /** The work of those Blocks over the time they took, in hashes a second. */
  hashRate: number | undefined;
  /** Gaps the two figures above are taken over. */
  gaps: number;
  newAccounts: number;
  uncounted: number;
  blocksRead: number;
  winners: Winner[];
  latest: LatestBlock[];
}

const TWO_256 = 1n << 256n;

/** The expected hashes for a Block of this Target: 2^256 / (Target + 1), as `crates/core`'s `work`. */
export function work(target: bigint): bigint {
  return TWO_256 / (target + 1n);
}

export function computeDashboard(input: DashboardInput): Dashboard {
  const { blocks } = input;
  const landOf = new Map(
    (input.lands ?? []).map((land) => [land.owner, land.landId]),
  );
  const since = input.nowSeconds - ACTIVE_SECONDS;
  const active = new Set(
    blocks.filter((b) => b.timestamp >= since).map((b) => b.rewardAddress),
  );

  const sample = blocks.slice(-(BLOCK_TIME_SAMPLE + 1));
  const gaps = Math.max(0, sample.length - 1);
  const seconds =
    gaps > 0 ? sample.at(-1)!.timestamp - sample[0]!.timestamp : 0;
  // The first Block's work was done before the time measured.
  const done = sample
    .slice(1)
    .reduce((sum, b) => sum + work(BigInt(`0x${b.target}`)), 0n);

  const mines = new Map<string, Winner>();
  for (const b of blocks) {
    const mine = mines.get(b.rewardAddress) ?? {
      address: b.rewardAddress,
      landId: landOf.get(b.rewardAddress),
      blocks: 0,
      share: 0,
      newAccounts: 0,
      uncounted: 0,
    };
    mine.blocks++;
    if (b.newAccounts === null) mine.uncounted++;
    else mine.newAccounts += b.newAccounts;
    mines.set(b.rewardAddress, mine);
  }
  const ranked = [...mines.values()]
    .map((m) => ({ ...m, share: m.blocks / blocks.length }))
    .sort(
      (a, b) => b.blocks - a.blocks || a.address!.localeCompare(b.address!),
    );
  const winners = ranked.slice(0, TOP_WINNERS);
  const rest = ranked.slice(TOP_WINNERS);
  if (rest.length > 0) {
    const others = (key: "blocks" | "newAccounts" | "uncounted") =>
      rest.reduce((n, m) => n + m[key], 0);
    winners.push({
      address: undefined,
      landId: undefined,
      blocks: others("blocks"),
      share: others("blocks") / blocks.length,
      newAccounts: others("newAccounts"),
      uncounted: others("uncounted"),
    });
  }

  return {
    networkId: input.networkId,
    tipHeight: blocks.at(-1)?.height,
    landsOnline: input.lands?.filter((land) => land.online).length,
    minesMining: active.size,
    coversDay: blocks.length > 0 && blocks[0]!.timestamp <= since,
    blockSeconds: gaps > 0 ? seconds / gaps : undefined,
    hashRate: seconds > 0 ? Number(done) / seconds : undefined,
    gaps,
    newAccounts: ranked.reduce((n, m) => n + m.newAccounts, 0),
    uncounted: ranked.reduce((n, m) => n + m.uncounted, 0),
    blocksRead: blocks.length,
    winners,
    latest: blocks
      .slice(-LATEST_BLOCKS)
      .reverse()
      .map((b) => ({
        height: b.height,
        timestamp: b.timestamp,
        rewardAddress: b.rewardAddress,
        landId: landOf.get(b.rewardAddress),
        newAccounts: b.newAccounts,
      })),
  };
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const plural = (n: number, word: string) =>
  `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const time = (seconds: number) =>
  new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
const landText = (landId: number | undefined) =>
  landId === undefined ? "–" : `Land ${landId}`;
const counted = (n: number | null) => (n === null ? "–" : String(n));

function tile(label: string, value: string, note: string): string {
  return `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="note">${escapeHtml(note)}</div></div>`;
}

function winnersTable(d: Dashboard): string {
  if (d.winners.length === 0) return "<p>No Block won yet.</p>";
  const top = Math.max(...d.winners.map((w) => w.share));
  const rows = d.winners
    .map((w) => {
      const who = w.address === undefined ? "Others" : landText(w.landId);
      const address = w.address === undefined ? "" : shortAddress(w.address);
      const accounts = w.uncounted === w.blocks ? "–" : String(w.newAccounts);
      const title = `${who}: ${plural(w.blocks, "Block")} (${percent(w.share)})`;
      const width = top > 0 ? (w.share / top) * 100 : 0;
      return `<tr><td>${escapeHtml(who)}</td><td class="mono">${escapeHtml(address)}</td><td class="num">${w.blocks}</td><td class="num">${percent(w.share)}</td><td class="num">${accounts}</td><td class="track"><div class="bar" style="width:${width.toFixed(2)}%" title="${escapeHtml(title)}"></div></td></tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>Land</th><th>Reward address</th><th class="num">Blocks</th><th class="num">Share</th><th class="num">New Accounts</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function latestTable(d: Dashboard): string {
  if (d.latest.length === 0) return "<p>No Block yet.</p>";
  const rows = d.latest
    .map(
      (b) =>
        `<tr><td class="num">${b.height}</td><td>${escapeHtml(time(b.timestamp))}</td><td>${escapeHtml(landText(b.landId))}</td><td class="mono">${escapeHtml(shortAddress(b.rewardAddress))}</td><td class="num">${counted(b.newAccounts)}</td></tr>`,
    )
    .join("");
  return `<div class="scroll"><table><thead><tr><th class="num">Height</th><th>Time (UTC)</th><th>Land</th><th>Reward address</th><th class="num">New Accounts</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** The whole page: server-rendered HTML, no script. */
export function renderDashboard(d: Dashboard, nowSeconds: number): string {
  const tiles = [
    tile(
      "Lands online",
      d.landsOnline === undefined ? "unknown" : String(d.landsOnline),
      "linked to the relay now",
    ),
    tile(
      "Mines mining",
      String(d.minesMining),
      d.coversDay
        ? "won a Block in the last 24 hours"
        : `won one of the last ${plural(d.blocksRead, "Block")}, under 24 hours`,
    ),
    tile(
      "Block time",
      d.blockSeconds === undefined ? "–" : `${d.blockSeconds.toFixed(1)} s`,
      `mean of the last ${plural(d.gaps, "gap")} between Blocks`,
    ),
    tile(
      "Estimated hash rate",
      d.hashRate === undefined ? "–" : hashRateText(d.hashRate),
      "from those Blocks' Targets and times",
    ),
    tile(
      "New Accounts",
      String(d.newAccounts),
      `created by the last ${plural(d.blocksRead - d.uncounted, "Block")} counted`,
    ),
  ].join("");
  const uncounted =
    d.uncounted > 0
      ? ` The Public node could not count the new Accounts of ${plural(d.uncounted, "Block")}.`
      : "";
  const tip =
    d.tipHeight === undefined ? "no Block yet" : `height ${d.tipHeight}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Linked Realms dashboard</title>
<link rel="icon" href="data:,">
<style>
.viz-root { color-scheme: light; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --grid: #e4e3df; --series-1: #2a78d6; }
@media (prefers-color-scheme: dark) {
  .viz-root { color-scheme: dark; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --grid: #33332f; --series-1: #3987e5; }
}
body { margin: 0; }
.viz-root { min-height: 100vh; box-sizing: border-box; padding: 24px; background: var(--surface-1); color: var(--text-primary); font: 15px/1.4 system-ui, sans-serif; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 4px; }
section { margin-bottom: 32px; }
.meta, .note, .label, th, .caption { color: var(--text-secondary); }
.meta, .caption { font-size: 13px; margin: 4px 0 12px; }
.tiles { display: flex; flex-wrap: wrap; gap: 32px; margin: 20px 0 32px; }
.label, .note { font-size: 13px; }
.value { font-size: 32px; font-weight: 600; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; }
th, td { padding: 4px 16px 4px 0; border-bottom: 1px solid var(--grid); text-align: left; white-space: nowrap; }
th { font-size: 13px; font-weight: 500; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, monospace; font-size: 13px; }
.track { width: 240px; min-width: 120px; }
.bar { height: 12px; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--series-1); }
</style>
</head>
<body>
<main class="viz-root">
<h1>Linked Realms: the world and LR</h1>
<p class="meta">Network ${d.networkId} · ${escapeHtml(tip)} · updated ${escapeHtml(time(nowSeconds))} · refreshes every 30 s</p>
<section class="tiles">${tiles}</section>
<section>
<h2>Winner distribution</h2>
<p class="caption">Blocks won and Accounts created per reward address over the last ${plural(d.blocksRead, "Block")}.${escapeHtml(uncounted)}</p>
${winnersTable(d)}
</section>
<section>
<h2>Latest Blocks</h2>
${latestTable(d)}
</section>
</main>
</body>
</html>
`;
}
