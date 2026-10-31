import { Key } from "@linked-realms/core";
import { signStatement } from "@linked-realms/shared/identity";
import { buildMineSwitch } from "@linked-realms/shared/mine-switch";
import { describe, expect, it } from "vitest";
import { checkSwitch, mineLine, mineState } from "./mine.ts";
import type { MineStatus, NodeInfo, NodeLink } from "./node.ts";

const ADDRESS =
  "tlr1qqqcfumqdlzsgtqzvz39p459ttpuy9l3krp4y6gtt6pf5svrnjp0kxqsnx73t";
const OFF: MineStatus = {
  state: "off",
  threads: 0,
  mode: null,
  hashRate: 0,
  blocksWon: 0,
  rewardAddress: null,
};
const ON: MineStatus = {
  state: "on",
  threads: 2,
  mode: "fast",
  hashRate: 1180.5,
  blocksWon: 3,
  rewardAddress: ADDRESS,
};
const READY: NodeInfo = { synced: true, connections: 1, maxThreads: 7 };

const node = (info?: NodeInfo, status?: MineStatus) =>
  ({ info: () => info, status: () => status }) as NodeLink;

describe("checkSwitch", () => {
  const owner = Key.fromSeed(new Uint8Array(32).fill(1));
  const nonce = "ab".repeat(16);
  const signed = (issued: number) =>
    signStatement(
      "land-message",
      {
        land: 7,
        landUrl: "https://7.lands.example",
        character: owner.address,
        issued,
        message: buildMineSwitch({
          mapServerKey: ADDRESS,
          on: true,
          threads: 2,
          nonce,
        }),
      },
      owner,
    );
  const served = (nowSeconds: number) => ({
    landId: 7,
    owner: owner.address,
    mapServerKey: ADDRESS,
    nowSeconds,
    challenge: { nonce, issued: 1000 },
  });

  it("takes a challenge until it expires, whatever the switch's own time", () => {
    expect(checkSwitch(signed(1299), served(1299))).toEqual({
      switch: { mapServerKey: ADDRESS, on: true, threads: 2, nonce },
    });
    expect(checkSwitch(signed(1300), served(1300))).toEqual({
      refused: "wrong-nonce",
    });
  });
});

describe("mineState", () => {
  it("reports what the Node runs, with the challenge only in the Land owner's copy", () => {
    const owner = { challenge: "00".repeat(16), mapServerKey: ADDRESS };
    expect(mineState(node(READY, ON), owner)).toEqual({
      status: "on",
      threads: 2,
      maxThreads: 7,
      hashRate: 1180.5,
      mode: "fast",
      rewardAddress: ADDRESS,
      blocksWon: 3,
      ...owner,
    });
    expect(mineState(node(READY, OFF))).toMatchObject({
      status: "off",
      mode: "",
      rewardAddress: "",
      challenge: "",
      mapServerKey: "",
    });
  });

  it("is unavailable without a Node, or while its Mine is off and it is alone or not synced", () => {
    expect(mineState(undefined).status).toBe("unavailable");
    expect(mineState(node(undefined, undefined)).status).toBe("unavailable");
    expect(mineState(node(READY, undefined)).status).toBe("unavailable");
    expect(mineState(node(undefined, OFF)).status).toBe("unavailable");
    expect(mineState(node({ ...READY, synced: false }, OFF)).status).toBe(
      "unavailable",
    );
    expect(mineState(node({ ...READY, connections: 0 }, OFF)).status).toBe(
      "unavailable",
    );
  });

  it("reports a running Mine as running, whatever the Node's sync (P5)", () => {
    const alone = { synced: false, connections: 0, maxThreads: 7 };
    expect(mineState(node(alone, ON)).status).toBe("on");
    // Before the Node's first node_info, too.
    expect(mineState(node(undefined, ON)).status).toBe("on");
    expect(mineState(node(alone, { ...ON, state: "starting" })).status).toBe(
      "starting",
    );
  });
});

describe("mineLine", () => {
  it("logs the Mine going on and off, once each", () => {
    expect(mineLine(OFF, ON)).toBe(
      `Mine ON: 2 threads, fast mode, rewards to ${ADDRESS}`,
    );
    expect(mineLine(undefined, { ...ON, threads: 1 })).toBe(
      `Mine ON: 1 thread, fast mode, rewards to ${ADDRESS}`,
    );
    expect(mineLine(ON, { ...ON, hashRate: 900 })).toBeUndefined();
    expect(mineLine(ON, OFF)).toBe("Mine OFF");
    expect(mineLine({ ...ON, state: "starting" }, OFF)).toBe("Mine OFF");
    // A restart or a new RandomX key passes through starting: not off.
    expect(mineLine(ON, { ...ON, state: "starting" })).toBeUndefined();
    expect(mineLine(OFF, { ...ON, state: "starting" })).toBeUndefined();
    // Out of reach, or just reached: the control link logs those.
    expect(mineLine(ON, undefined)).toBeUndefined();
    expect(mineLine(undefined, OFF)).toBeUndefined();
    expect(mineLine(OFF, OFF)).toBeUndefined();
  });
});
