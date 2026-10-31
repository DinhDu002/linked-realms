import { describe, expect, it } from "vitest";
import {
  ACTIVE_SECONDS,
  BLOCK_TIME_SAMPLE,
  LATEST_BLOCKS,
  TOP_WINNERS,
  computeDashboard,
  renderDashboard,
  work,
  type BlockRow,
  type DashboardInput,
} from "./dashboard.ts";

const NOW = 2_000_000_000;
const addr = (n: number) => {
  const tag = String(n).padStart(6, "0");
  return `tlr1qqq${tag}${"p".repeat(44)}${tag}`;
};
/** A Target whose work is exactly 2^bits. */
const target = (bits: number) =>
  ((1n << BigInt(256 - bits)) - 1n).toString(16).padStart(64, "0");

function block(height: number, fields: Partial<BlockRow> = {}): BlockRow {
  return {
    height,
    id: `id${height}`,
    timestamp: NOW - 1000 + height,
    target: target(10),
    rewardAddress: addr(1),
    newAccounts: 0,
    ...fields,
  };
}

const input = (fields: Partial<DashboardInput>): DashboardInput => ({
  nowSeconds: NOW,
  networkId: 2,
  blocks: [],
  lands: [],
  ...fields,
});

describe("work", () => {
  it("is 2^256 / (Target + 1), as crates/core", () => {
    expect(work((1n << 256n) - 1n)).toBe(1n);
    expect(work(0n)).toBe((1n << 256n) - 1n);
    expect(work(BigInt(`0x${target(10)}`))).toBe(1024n);
    expect(work(2n)).toBe((1n << 256n) / 3n);
  });
});

describe("computeDashboard", () => {
  it("shows an empty chain as no figures, not zeros", () => {
    const d = computeDashboard(input({ lands: undefined }));
    expect(d).toMatchObject({
      tipHeight: undefined,
      landsOnline: undefined,
      minesMining: 0,
      coversDay: false,
      blockSeconds: undefined,
      hashRate: undefined,
      gaps: 0,
      newAccounts: 0,
      blocksRead: 0,
      winners: [],
      latest: [],
    });
    const page = renderDashboard(d, NOW);
    expect(page).toContain("no Block yet");
    expect(page).toContain("No Block won yet.");
    expect(page).toContain(">unknown<");
  });

  it("takes Block time and hash rate over the last gaps only, without the first Block's work", () => {
    // 50 slow Blocks of little work, then 100 Blocks 10 s apart of work 1024.
    const blocks: BlockRow[] = [];
    let at = NOW - 200_000;
    for (let h = 1; h <= 150; h++) {
      at += h <= 50 ? 1000 : 10;
      blocks.push(
        block(h, { timestamp: at, target: h <= 50 ? target(6) : target(10) }),
      );
    }
    const d = computeDashboard(input({ blocks }));
    expect(d.gaps).toBe(BLOCK_TIME_SAMPLE);
    expect(d.blockSeconds).toBe(10);
    // Block 50 starts the sample: its work (64) was done before the 1000 s measured.
    expect(d.hashRate).toBe((100 * 1024) / 1000);
    expect(d.tipHeight).toBe(150);
  });

  it("measures a short chain over the gaps it has, and leaves hash rate out when no time passed", () => {
    const two = computeDashboard(
      input({
        blocks: [
          block(1, { timestamp: NOW - 30 }),
          block(2, { timestamp: NOW }),
        ],
      }),
    );
    expect(two).toMatchObject({
      gaps: 1,
      blockSeconds: 30,
      hashRate: 1024 / 30,
    });
    const one = computeDashboard(input({ blocks: [block(1)] }));
    expect(one).toMatchObject({
      gaps: 0,
      blockSeconds: undefined,
      hashRate: undefined,
    });
    const same = computeDashboard(
      input({
        blocks: [block(1, { timestamp: NOW }), block(2, { timestamp: NOW })],
      }),
    );
    expect(same).toMatchObject({
      gaps: 1,
      blockSeconds: undefined,
      hashRate: undefined,
    });
    // A Block's time need only pass the median of the ones before it, so it can go back.
    const back = computeDashboard(
      input({
        blocks: [
          block(1, { timestamp: NOW }),
          block(2, { timestamp: NOW - 10 }),
        ],
      }),
    );
    expect(back).toMatchObject({
      gaps: 1,
      blockSeconds: undefined,
      hashRate: undefined,
    });
    expect(renderDashboard(back, NOW)).not.toContain("-10");
  });

  it("counts the Mines that won a Block in the last 24 hours, and says when the Blocks read cover less", () => {
    const since = NOW - ACTIVE_SECONDS;
    const blocks = [
      block(1, { timestamp: since - 1, rewardAddress: addr(1) }),
      block(2, { timestamp: since, rewardAddress: addr(2) }),
      block(3, { timestamp: NOW, rewardAddress: addr(3) }),
      block(4, { timestamp: NOW, rewardAddress: addr(3) }),
    ];
    const d = computeDashboard(input({ blocks }));
    expect(d.minesMining).toBe(2);
    expect(d.coversDay).toBe(true);
    expect(renderDashboard(d, NOW)).toContain(
      "won a Block in the last 24 hours",
    );

    const short = computeDashboard(input({ blocks: blocks.slice(2) }));
    expect(short.minesMining).toBe(1);
    expect(short.coversDay).toBe(false);
    expect(renderDashboard(short, NOW)).toContain(
      "won one of the last 2 Blocks, under 24 hours",
    );
    expect(computeDashboard(input({ blocks: blocks.slice(1) })).coversDay).toBe(
      true,
    );
  });

  it("ranks the top winners, folds the rest into Others, and names the Land of each owner", () => {
    // Address n wins n Blocks: 30 addresses, 465 Blocks.
    const blocks: BlockRow[] = [];
    for (let n = 1; n <= 30; n++)
      for (let i = 0; i < n; i++)
        blocks.push(
          block(blocks.length + 1, {
            rewardAddress: addr(n),
            newAccounts: n === 30 && i === 0 ? null : n % 3,
          }),
        );
    const lands = [
      { landId: 7, owner: addr(30), online: true },
      { landId: 8, owner: addr(29), online: false },
      { landId: 9, owner: addr(1), online: true },
    ];
    const d = computeDashboard(input({ blocks, lands }));
    expect(d.landsOnline).toBe(2);
    expect(d.winners).toHaveLength(TOP_WINNERS + 1);
    expect(d.winners[0]).toEqual({
      address: addr(30),
      landId: 7,
      blocks: 30,
      share: 30 / 465,
      newAccounts: 0,
      uncounted: 1,
    });
    expect(d.winners[1]).toMatchObject({
      address: addr(29),
      landId: 8,
      blocks: 29,
      newAccounts: 58,
    });
    expect(d.winners[TOP_WINNERS - 1]).toMatchObject({
      address: addr(11),
      landId: undefined,
    });
    // Others: addresses 1 to 10, 55 Blocks; n % 3 Accounts each Block.
    const othersAccounts = [...Array(10).keys()].reduce(
      (s, i) => s + (i + 1) * ((i + 1) % 3),
      0,
    );
    expect(d.winners[TOP_WINNERS]).toEqual({
      address: undefined,
      landId: undefined,
      blocks: 55,
      share: 55 / 465,
      newAccounts: othersAccounts,
      uncounted: 0,
    });
    const allAccounts = [...Array(30).keys()].reduce(
      (s, i) => s + (i + 1) * ((i + 1) % 3),
      0,
    );
    expect(d.newAccounts).toBe(allAccounts);
    expect(d.uncounted).toBe(1);
    expect(d.winners.reduce((s, w) => s + w.blocks, 0)).toBe(465);

    const page = renderDashboard(d, NOW);
    // Land 7's Mine has 1 uncounted Block of 30: its count shows, not "–".
    expect(page).toContain(
      '<td>Land 7</td><td class="mono">tlr1000030…000030</td><td class="num">30</td><td class="num">6.5%</td><td class="num">0</td>',
    );
    expect(page).toContain("<td>Others</td>");
    expect(page).toContain("could not count the new Accounts of 1 Block.");
    expect(page).toContain("created by the last 464 Blocks counted");
    expect(page).toContain('style="width:100.00%"');
  });

  it("breaks ties by address, and shows no count for a winner none of whose Blocks were counted", () => {
    const blocks = [
      block(1, { rewardAddress: addr(2), newAccounts: null }),
      block(2, { rewardAddress: addr(1), newAccounts: 1 }),
    ];
    const d = computeDashboard(input({ blocks }));
    expect(d.winners.map((w) => w.address)).toEqual([addr(1), addr(2)]);
    expect(d.winners.map((w) => w.share)).toEqual([0.5, 0.5]);
    const page = renderDashboard(d, NOW);
    expect(page).toMatch(/<td class="num">50\.0%<\/td><td class="num">–<\/td>/);
  });

  it("lists the latest Blocks newest first", () => {
    const blocks = Array.from({ length: 15 }, (_, i) =>
      block(i + 1, { newAccounts: i === 14 ? null : i }),
    );
    const d = computeDashboard(
      input({ blocks, lands: [{ landId: 3, owner: addr(1), online: true }] }),
    );
    expect(d.latest).toHaveLength(LATEST_BLOCKS);
    expect(d.latest.map((b) => b.height)).toEqual([
      15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
    ]);
    expect(d.latest[0]).toEqual({
      height: 15,
      timestamp: NOW - 1000 + 15,
      rewardAddress: addr(1),
      landId: 3,
      newAccounts: null,
    });
  });
});

describe("renderDashboard", () => {
  it("escapes what the Public node sends", () => {
    const evil = `tlr1qqq<b>"x"</b>&'<script>alert(1)</script>`;
    const d = computeDashboard(
      input({ blocks: [block(1, { rewardAddress: evil })] }),
    );
    const page = renderDashboard(d, NOW);
    expect(page).not.toMatch(/<b>|<script>|<\/script>/);
    expect(page).toContain("&#60;b&#62;");
  });

  it("writes the figures with their units", () => {
    const blocks = [
      block(1, { timestamp: NOW - 20 }),
      block(2, { timestamp: NOW }),
    ];
    const page = renderDashboard(computeDashboard(input({ blocks })), NOW);
    expect(page).toContain(">20.0 s<");
    expect(page).toContain(">51 H/s<");
    expect(page).toContain("mean of the last 1 gap between Blocks");
    expect(page).toContain(
      "Network 2 · height 2 · updated 2033-05-18T03:33:20Z",
    );
    expect(page).toContain('<meta http-equiv="refresh" content="30">');
  });
});
