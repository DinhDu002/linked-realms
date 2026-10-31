import { create } from "@bufbuild/protobuf";
import {
  MineStateSchema,
  MineWonSchema,
} from "@linked-realms/shared/land-protocol";
import { shortAddress } from "@linked-realms/shared";
import { buildMineSwitch } from "@linked-realms/shared/mine-switch";
import { describe, expect, it } from "vitest";
import {
  hashRateText,
  mineHudText,
  mineMotion,
  readMineState,
  readMineWon,
  rewardsTo,
  rewardText,
  switchLine,
  switchResultText,
  winText,
  type MineView,
} from "./mine.ts";

const KEY = "tlr1qqq5l2qgmd2kt3pxwjvul8vpgjnugt2r9q30qklrfy35au3pwcgqu6gvcf94j";
const OWNER =
  "tlr1qqqcfumqdlzsgtqzvz39p459ttpuy9l3krp4y6gtt6pf5svrnjp0kxqsnx73t";
const NONCE = "00112233445566778899aabbccddeeff";

const state = (fields: object = {}) =>
  create(MineStateSchema, {
    status: "on",
    threads: 2,
    maxThreads: 7,
    hashRate: 1180.5,
    mode: "fast",
    rewardAddress: OWNER,
    blocksWon: 3,
    challenge: NONCE,
    mapServerKey: KEY,
    ...fields,
  });

const view = (fields: object = {}): MineView => readMineState(state(fields))!;

describe("readMineState", () => {
  it("reads a well-formed state", () => {
    expect(view()).toEqual({
      status: "on",
      threads: 2,
      maxThreads: 7,
      hashRate: 1180.5,
      mode: "fast",
      rewardAddress: OWNER,
      blocksWon: 3,
      challenge: NONCE,
      mapServerKey: KEY,
    });
    expect(view({ status: "off", mode: "" }).status).toBe("off");
  });

  it.each([
    ["an unknown status", { status: "ON" }],
    ["an empty status", { status: "" }],
    ["an unknown mode", { mode: "turbo" }],
    ["a hash rate that is not a number", { hashRate: Number.NaN }],
    ["an infinite hash rate", { hashRate: Number.POSITIVE_INFINITY }],
    ["a negative hash rate", { hashRate: -1 }],
  ])("refuses %s", (_, fields) => {
    expect(readMineState(state(fields))).toBeUndefined();
  });
});

describe("readMineWon", () => {
  const won = (fields: object) =>
    create(MineWonSchema, {
      height: 1240n,
      reward: "500004000",
      rewardAddress: OWNER,
      ...fields,
    });

  it("reads the height, the reward in base units and the address", () => {
    expect(readMineWon(won({}))).toEqual({
      height: 1240n,
      reward: 500004000n,
      rewardAddress: OWNER,
    });
    expect(readMineWon(won({ reward: "18446744073709551615" }))?.reward).toBe(
      2n ** 64n - 1n,
    );
  });

  it.each([
    ["an exponent", { reward: "5e8" }],
    ["a sign", { reward: "-1" }],
    ["a leading zero", { reward: "05" }],
    ["a decimal point", { reward: "5.0" }],
    ["a space", { reward: " 5" }],
    ["no digits", { reward: "" }],
    ["more than 2^64 - 1", { reward: "18446744073709551616" }],
    ["the genesis height", { height: 0n }],
  ])("refuses %s", (_, fields) => {
    expect(readMineWon(won(fields))).toBeUndefined();
  });
});

describe("texts", () => {
  it("writes hash rates in H/s, kH/s and MH/s", () => {
    expect(hashRateText(0)).toBe("0 H/s");
    expect(hashRateText(850.4)).toBe("850 H/s");
    expect(hashRateText(1180.5)).toBe("1.2 kH/s");
    expect(hashRateText(3_400_000)).toBe("3.4 MH/s");
    expect(hashRateText(999)).toBe("999 H/s");
    expect(hashRateText(1000)).toBe("1.0 kH/s");
    expect(hashRateText(1_000_000)).toBe("1.0 MH/s");
  });

  it("names the Land owner, else shows the short address", () => {
    const owner = { address: OWNER, name: "Mai" };
    expect(rewardsTo(OWNER, owner)).toBe("Mai");
    expect(rewardsTo(OWNER, { address: OWNER, name: " \u200b" })).toBe(
      shortAddress(OWNER),
    );
    expect(rewardsTo(KEY, owner)).toBe(shortAddress(KEY));
  });

  it("writes the HUD line for each status", () => {
    expect(mineHudText(view(), "Mai")).toBe(
      "Mine ON · 2 threads · fast · 1.2 kH/s · rewards to Mai · 3 Blocks won",
    );
    expect(
      mineHudText(
        view({ status: "starting", mode: "", threads: 1, blocksWon: 1 }),
        "Mai",
      ),
    ).toBe("Mine starting · 1 thread · rewards to Mai · 1 Block won");
    expect(mineHudText(view({ status: "off", mode: "" }), "Mai")).toBe(
      "Mine OFF",
    );
    expect(mineHudText(view({ status: "unavailable" }), "Mai")).toBe(
      "Mine unavailable: this Land's Node is not running or not synced",
    );
    expect(mineHudText(view({ rewardAddress: "" }), "")).not.toContain(
      "rewards",
    );
  });

  it("writes the reward with trailing zeros trimmed, never a constant", () => {
    const win = (reward: bigint) => ({
      height: 1240n,
      reward,
      rewardAddress: OWNER,
    });
    expect(rewardText(win(500_000_000n))).toBe("+5 GOLD");
    expect(rewardText(win(250_012_000n))).toBe("+2.50012 GOLD");
    expect(winText(win(500_004_000n))).toBe(
      "The Mine won Block #1240 (+5.00004 GOLD)",
    );
  });
});

describe("switchLine", () => {
  it("builds the line the Map server expects", () => {
    expect(switchLine(view(), true, 3)).toEqual({
      line: buildMineSwitch({
        mapServerKey: KEY,
        on: true,
        threads: 3,
        nonce: NONCE,
      }),
    });
    // Off is always 0 threads, whatever the form holds.
    expect(switchLine(view(), false, Number.NaN)).toEqual({
      line: buildMineSwitch({
        mapServerKey: KEY,
        on: false,
        threads: 0,
        nonce: NONCE,
      }),
    });
    expect(switchLine(view(), true, 7)).toHaveProperty("line");
  });

  it.each([
    ["the Node is down", { status: "unavailable" }, true, 1, "Node is down"],
    ["no challenge yet", { challenge: "" }, true, 1, "challenge"],
    ["0 threads", {}, true, 0, "Choose 1 to 7 threads."],
    [
      "more threads than the Node allows",
      {},
      true,
      8,
      "Choose 1 to 7 threads.",
    ],
    ["a fraction of a thread", {}, true, 1.5, "Choose 1 to 7 threads."],
    [
      "a key that is not an address",
      { mapServerKey: "tlr1x" },
      true,
      1,
      "Reload",
    ],
    ["a challenge of another form", { challenge: "00" }, false, 0, "Reload"],
  ])("refuses to build with %s", (_, fields, on, threads, problem) => {
    const built = switchLine(view(fields), on, threads);
    expect(built).toHaveProperty("problem");
    expect((built as { problem: string }).problem).toContain(problem);
  });
});

describe("switchResultText", () => {
  it("says what the Mine does after an accepted switch", () => {
    expect(switchResultText({ ok: true, code: "" }, true)).toBe(
      "The Mine is starting.",
    );
    expect(switchResultText({ ok: true, code: "" }, false)).toBe(
      "The Mine is off.",
    );
  });

  it("gives each refusal its own words", () => {
    const codes = [
      "not-owner",
      "bad-statement",
      "stale",
      "wrong-nonce",
      "bad-threads",
      "unavailable",
      "rate-limited",
    ];
    const texts = codes.map((code) =>
      switchResultText({ ok: false, code }, true),
    );
    expect(new Set(texts).size).toBe(codes.length);
    for (const text of texts) expect(text).not.toContain("(");
    // A refusal is a refusal, whatever its code.
    expect(switchResultText({ ok: false, code: "" }, true)).toBe(
      "The Land refused the switch ().",
    );
    expect(switchResultText({ ok: false, code: "odd" }, true)).toBe(
      "The Land refused the switch (odd).",
    );
  });
});

describe("mineMotion", () => {
  it("is still while the Mine is off, unavailable or unknown", () => {
    expect(mineMotion(undefined)).toBeUndefined();
    expect(mineMotion(view({ status: "off" }))).toBeUndefined();
    expect(mineMotion(view({ status: "unavailable" }))).toBeUndefined();
  });

  it("is dimmer and slower while starting", () => {
    const on = mineMotion(view())!;
    const starting = mineMotion(view({ status: "starting", hashRate: 0 }))!;
    expect(starting.glow).toBeLessThan(on.glow);
    expect(starting.pulseMs).toBeGreaterThan(on.pulseMs);
    expect(starting.spinDegPerSecond).toBeLessThan(on.spinDegPerSecond);
    expect(starting.sparksPerSecond).toBeLessThan(on.sparksPerSecond);
  });

  it("spins faster with more threads and sparks more with more hashes, up to caps", () => {
    const spin = (threads: number) =>
      mineMotion(view({ threads }))!.spinDegPerSecond;
    const sparks = (hashRate: number) =>
      mineMotion(view({ hashRate }))!.sparksPerSecond;
    expect(spin(4)).toBeGreaterThan(spin(2));
    expect(spin(0)).toBe(spin(1));
    expect(spin(1_000_000)).toBe(720);
    expect(sparks(2000)).toBeGreaterThan(sparks(500));
    expect(sparks(0)).toBe(1);
    expect(sparks(1e12)).toBe(12);
  });
});
