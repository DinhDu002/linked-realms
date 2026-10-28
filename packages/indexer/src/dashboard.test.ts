import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_SECONDS,
  TOP_WINNERS,
  computeDashboard,
  countOnline,
  renderDashboard,
  type DashboardInput,
} from "./dashboard.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const NOW = 1_000_000n;

function input(over: Partial<DashboardInput>): DashboardInput {
  return {
    nowSeconds: NOW,
    target: 2n ** 200n,
    wins: [],
    lands: [],
    landsOnline: 3,
    ...over,
  };
}

describe("computeDashboard", () => {
  it("counts wallets that won in the last 24 hours, case-insensitively", () => {
    const d = computeDashboard(
      input({
        wins: [
          { rewardWallet: A, timestamp: NOW },
          {
            rewardWallet: A.toUpperCase().replace("0X", "0x"),
            timestamp: NOW - 10n,
          },
          { rewardWallet: B, timestamp: NOW - ACTIVE_WINDOW_SECONDS - 1n },
        ],
      }),
    );
    expect(d.minesMining).toBe(1);
  });

  it("takes Round time as the mean gap between won Rounds, and the hash rate from the target", () => {
    const wins = [0n, 60n, 120n, 180n].map((t) => ({
      rewardWallet: A,
      timestamp: NOW - t,
    }));
    const d = computeDashboard(input({ wins, target: 2n ** 196n }));
    expect(d.roundSeconds).toBe(60);
    // 2^60 expected hashes per Solution, one Solution per 60 s
    expect(d.hashRate).toBeCloseTo(2 ** 60 / 60);
  });

  it("leaves Round time and hash rate unknown with fewer than two wins", () => {
    const d = computeDashboard(
      input({ wins: [{ rewardWallet: A, timestamp: NOW }] }),
    );
    expect(d.roundSeconds).toBeUndefined();
    expect(d.hashRate).toBeUndefined();
  });

  it("ranks winners by Land with their share", () => {
    const wins = [A, B, A, A].map((rewardWallet, i) => ({
      rewardWallet,
      timestamp: NOW - BigInt(i),
    }));
    const d = computeDashboard(
      input({
        wins,
        lands: [
          { id: 7n, owner: A },
          { id: 9n, owner: B },
        ],
      }),
    );
    expect(d.winners).toEqual([
      { landId: 7n, wallet: A, rounds: 3, share: 0.75 },
      { landId: 9n, wallet: B, rounds: 1, share: 0.25 },
    ]);
    expect(d.roundsSampled).toBe(4);
  });

  it("folds winners past the top 20 into one row", () => {
    const wallets = Array.from(
      { length: TOP_WINNERS + 2 },
      (_, i) => `0x${i.toString(16).padStart(40, "0")}`,
    );
    const d = computeDashboard(
      input({
        wins: wallets.map((rewardWallet) => ({ rewardWallet, timestamp: NOW })),
      }),
    );
    expect(d.winners).toHaveLength(TOP_WINNERS + 1);
    expect(d.winners.at(-1)).toMatchObject({ landId: undefined, rounds: 2 });
  });
});

describe("countOnline", () => {
  it("counts online Lands in a Directory and rejects anything else", () => {
    expect(
      countOnline({
        lands: [{ online: true }, { online: false }, { online: true }],
      }),
    ).toBe(2);
    expect(countOnline({ lands: "x" })).toBeUndefined();
    expect(countOnline(null)).toBeUndefined();
  });
});

describe("renderDashboard", () => {
  const meta = { chainId: 84532, nowSeconds: NOW };

  it("shows every figure and the distribution", () => {
    const wins = [0n, 60n].map((t) => ({
      rewardWallet: A,
      timestamp: NOW - t,
    }));
    const html = renderDashboard(
      computeDashboard(input({ wins, lands: [{ id: 7n, owner: A }] })),
      meta,
    );
    expect(html).toContain("Lands online");
    expect(html).toContain(">3<");
    expect(html).toContain("60.0 s");
    expect(html).toContain("Land 7");
    expect(html).toContain("100.0%");
    expect(html).not.toContain("<script");
  });

  it("says unknown and no wins when there is nothing to show", () => {
    const html = renderDashboard(
      computeDashboard(input({ landsOnline: undefined })),
      meta,
    );
    expect(html).toContain("unknown");
    expect(html).toContain("No Round won yet.");
  });

  it("escapes text", () => {
    const html = renderDashboard(
      computeDashboard(
        input({ wins: [{ rewardWallet: "<b>&", timestamp: NOW }] }),
      ),
      meta,
    );
    expect(html).not.toContain("<b>&");
    expect(html).toContain("&#60;b&#62;&#38;");
  });
});
