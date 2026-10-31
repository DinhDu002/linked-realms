import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";
import { computeDashboard, renderDashboard } from "./dashboard.ts";
import recorded from "./dev-chain.json" with { type: "json" };
import { readInput, readLands } from "./read.ts";
import { CACHE_MS, createDashboardServer } from "./server.ts";

// A fake Public node (JSON-RPC over HTTP) and Hub.
type Answer =
  { result: unknown } | { error: { code: number; message: string } };

interface Fake {
  url: string;
  calls: { method: string; params: unknown[] }[];
  close(): Promise<void>;
}

/** Serves `answer(method, params)` as JSON-RPC at `/`, and `routes[path]` as JSON. */
async function fakeServer(
  answer: (method: string, params: unknown[]) => Answer,
  routes: Record<string, { status: number; body: unknown }> = {},
): Promise<Fake> {
  const calls: Fake["calls"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const route = routes[request.url ?? ""];
      if (route) {
        response.writeHead(route.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(route.body));
        return;
      }
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };
      calls.push({ method, params });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id, ...answer(method, params) }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const NOW = 2_000_000_000;
const ADDRESS = `tlr1qqq${"a".repeat(56)}`;
const hex = (n: number) => n.toString(16).padStart(64, "0");

/** A Header as lr_getHeaders writes it (crates/node/src/rpc.rs header_json). */
const header = (height: number) => ({
  id: hex(height),
  height,
  prevId: hex(height - 1),
  timestamp: NOW - 1000 + height,
  target: "000fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  txRoot: hex(0),
  stateRoot: hex(0),
  rewardAddress: ADDRESS,
  nonce: "42",
});

/** A chain of `height` Blocks; counts are 1 at heights that are multiples of 5. */
function chain(
  height: number,
  overrides: Partial<Record<string, (params: unknown[]) => Answer>> = {},
) {
  return (method: string, params: unknown[]): Answer => {
    const override = overrides[method];
    if (override) return override(params);
    const [from, count] = params as [number, number];
    const heights = () =>
      Array.from(
        { length: Math.max(0, Math.min(count, 2000, height - from + 1)) },
        (_, i) => from + i,
      );
    switch (method) {
      case "lr_getInfo":
        return {
          result: { networkId: 2, height, tip: hex(height), genesis: hex(0) },
        };
      case "lr_getHeaders":
        return { result: heights().map(header) };
      case "lr_getNewAccountCounts":
        return {
          result: heights().map((h) => ({
            id: hex(h),
            newAccounts: h % 5 === 0 ? 1 : 0,
          })),
        };
      default:
        return { error: { code: -32601, message: "Method not found" } };
    }
  };
}

const DIRECTORY = {
  lands: [
    { landId: 1, owner: ADDRESS, online: true, name: "One", x: 0, y: 0 },
    {
      landId: 2,
      owner: `tlr1qqq${"b".repeat(56)}`,
      online: false,
      name: "Two",
      x: 1,
      y: 0,
    },
  ],
};

const fakes: Fake[] = [];
async function serve(...args: Parameters<typeof fakeServer>) {
  const fake = await fakeServer(...args);
  fakes.push(fake);
  return fake;
}
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.close();
});

describe("readInput", () => {
  it("reads the last 2000 Blocks after the genesis, with their counts and the Hub's Lands", async () => {
    const node = await serve(chain(2500), {
      "/directory": { status: 200, body: DIRECTORY },
    });
    const input = await readInput(node.url, node.url, NOW);
    expect(node.calls.map((c) => [c.method, c.params])).toEqual([
      ["lr_getInfo", []],
      ["lr_getHeaders", [501, 2000]],
      ["lr_getNewAccountCounts", [501, 2000]],
    ]);
    expect(input.networkId).toBe(2);
    expect(input.nowSeconds).toBe(NOW);
    expect(input.blocks).toHaveLength(2000);
    expect(input.blocks[0]).toEqual({
      height: 501,
      id: hex(501),
      timestamp: NOW - 1000 + 501,
      target: header(1).target,
      rewardAddress: ADDRESS,
      newAccounts: 0,
    });
    expect(input.blocks.at(-1)).toMatchObject({ height: 2500, newAccounts: 1 });
    expect(input.lands).toEqual([
      { landId: 1, owner: ADDRESS, online: true },
      { landId: 2, owner: `tlr1qqq${"b".repeat(56)}`, online: false },
    ]);
  });

  it("starts after the genesis on a short chain, and reads nothing more on the genesis alone", async () => {
    const short = await serve(chain(3));
    const input = await readInput(short.url, undefined, NOW);
    expect(short.calls.map((c) => c.params)).toEqual([[], [1, 3], [1, 3]]);
    expect(input.blocks.map((b) => b.height)).toEqual([1, 2, 3]);
    expect(input.lands).toBeUndefined();

    const genesis = await serve(chain(0));
    expect(await readInput(genesis.url, undefined, NOW)).toEqual({
      nowSeconds: NOW,
      networkId: 2,
      blocks: [],
      lands: undefined,
    });
    expect(genesis.calls.map((c) => c.method)).toEqual(["lr_getInfo"]);
  });

  it("matches counts to Blocks by id, so a chain change between the calls leaves them uncounted", async () => {
    const node = await serve(
      chain(4, {
        lr_getNewAccountCounts: () => ({
          result: [
            { id: hex(4), newAccounts: 3 },
            { id: hex(1), newAccounts: null },
            { id: "f".repeat(64), newAccounts: 9 },
            { id: hex(3), newAccounts: -1 },
            { newAccounts: 5 },
          ],
        }),
      }),
    );
    const input = await readInput(node.url, undefined, NOW);
    expect(input.blocks.map((b) => b.newAccounts)).toEqual([
      null,
      null,
      null,
      3,
    ]);
  });

  it("refuses answers it cannot read", async () => {
    const cases: [string, (params: unknown[]) => Answer, string][] = [
      [
        "lr_getInfo",
        () => ({ result: { networkId: 2 } }),
        "lr_getInfo this page cannot read",
      ],
      [
        "lr_getInfo",
        () => ({ result: null }),
        "lr_getInfo this page cannot read",
      ],
      [
        "lr_getHeaders",
        () => ({ result: { headers: [] } }),
        "a list this page cannot read",
      ],
      [
        "lr_getNewAccountCounts",
        () => ({ result: null }),
        "a list this page cannot read",
      ],
      [
        "lr_getHeaders",
        () => ({ result: [{ ...header(1), target: "zz" }] }),
        "a Header this page",
      ],
      [
        "lr_getHeaders",
        () => ({ result: [{ ...header(1), height: -1 }] }),
        "a Header this page",
      ],
      ["lr_getHeaders", () => ({ result: [null] }), "a Header this page"],
      [
        "lr_getNewAccountCounts",
        () => ({ error: { code: -32601, message: "Method not found" } }),
        "lr_getNewAccountCounts: Method not found",
      ],
    ];
    for (const [method, answer, message] of cases) {
      const node = await serve(chain(3, { [method]: answer }));
      await expect(readInput(node.url, undefined, NOW), method).rejects.toThrow(
        message,
      );
    }
  });

  it("goes on without Lands when the Hub fails", async () => {
    const node = await serve(chain(1), {
      "/bad/directory": {
        status: 200,
        body: { lands: [{ landId: "1", owner: ADDRESS, online: true }] },
      },
      "/down/directory": { status: 503, body: {} },
    });
    for (const hub of [
      `${node.url}/bad`,
      `${node.url}/down`,
      "http://127.0.0.1:1",
    ])
      expect((await readInput(node.url, hub, NOW)).lands, hub).toBeUndefined();
  });
});

describe("a recorded dev chain", () => {
  // Two Mines (Development Characters 1 and 2) and one transfer to a fresh address in Block 13.
  const CHARACTER_1 =
    "tlr1qqqanzv64uheqjxt9vau0el7p0gndh7rmaykuhd3g9h3dyu0fzrr0mqulz55w";
  const CHARACTER_2 =
    "tlr1qqq6mwhq8utpqyv32mfjujhr0tquwgkaek95p2rheewme5q2hcm2zzg40pln3";

  it("reads it and shows its figures", async () => {
    const node = await serve(
      (method, params) => {
        const [from, count] = params as [number, number];
        const slice = <T>(list: T[]) => list.slice(from - 1, from - 1 + count);
        if (method === "lr_getInfo") return { result: recorded.info };
        if (method === "lr_getHeaders")
          return { result: slice(recorded.headers) };
        return { result: slice(recorded.counts) };
      },
      {
        "/directory": {
          status: 200,
          body: {
            lands: [
              { landId: 1, owner: CHARACTER_1, online: true },
              { landId: 2, owner: CHARACTER_2, online: false },
            ],
          },
        },
      },
    );
    const now = recorded.info.time + 60;
    const d = computeDashboard(await readInput(node.url, node.url, now));
    expect(d).toMatchObject({
      networkId: 2,
      tipHeight: 16,
      landsOnline: 1,
      minesMining: 2,
      coversDay: false,
      gaps: 15,
      blocksRead: 16,
      // Blocks 1 and 4 pay a reward address for the first time; Block 13 pays a fresh address.
      newAccounts: 3,
      uncounted: 0,
    });
    // 15 gaps over 397 seconds, each Block of the dev network's work 1024.
    expect(d.blockSeconds).toBeCloseTo(397 / 15, 10);
    expect(d.hashRate).toBeCloseTo((15 * 1024) / 397, 10);
    expect(d.winners).toEqual([
      {
        address: CHARACTER_2,
        landId: 2,
        blocks: 8,
        share: 0.5,
        newAccounts: 2,
        uncounted: 0,
      },
      {
        address: CHARACTER_1,
        landId: 1,
        blocks: 8,
        share: 0.5,
        newAccounts: 1,
        uncounted: 0,
      },
    ]);
    expect(d.latest.map((b) => [b.height, b.landId, b.newAccounts])).toEqual([
      [16, 2, 0],
      [15, 1, 0],
      [14, 2, 0],
      [13, 2, 1],
      [12, 1, 0],
      [11, 1, 0],
      [10, 1, 0],
      [9, 2, 0],
      [8, 2, 0],
      [7, 1, 0],
    ]);
    const page = renderDashboard(d, now);
    expect(page).toContain(">26.5 s<");
    expect(page).toContain(">39 H/s<");
  });
});

describe("readLands", () => {
  it("keeps only a Directory's fields the page uses, and refuses anything else", () => {
    expect(readLands(DIRECTORY)).toEqual([
      { landId: 1, owner: ADDRESS, online: true },
      { landId: 2, owner: `tlr1qqq${"b".repeat(56)}`, online: false },
    ]);
    expect(readLands({ lands: [] })).toEqual([]);
    for (const bad of [
      null,
      {},
      { lands: {} },
      { lands: [null] },
      { lands: [{ landId: 1, owner: ADDRESS }] },
    ])
      expect(readLands(bad), JSON.stringify(bad)).toBeUndefined();
  });
});

describe("createDashboardServer", () => {
  async function dashboard(
    answer: (method: string, params: unknown[]) => Answer,
    now = () => 0,
  ) {
    const node = await serve(answer);
    const server = createDashboardServer(
      { port: 0, nodeUrl: node.url, hubUrl: undefined },
      now,
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    fakes.push({
      url: "",
      calls: [],
      close: () => new Promise((resolve) => server.close(() => resolve())),
    });
    const { port } = server.address() as AddressInfo;
    return { node, url: `http://127.0.0.1:${port}` };
  }

  it("serves the page at / only", async () => {
    const { url } = await dashboard(chain(2));
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("Network 2 · height 2");
    expect((await fetch(`${url}/?x=1`)).status).toBe(200);
    expect((await fetch(`${url}/other`)).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("reads the Public node once for everyone until the page is 10 seconds old", async () => {
    let ms = 0;
    const { node, url } = await dashboard(chain(2), () => ms);
    await Promise.all([fetch(url), fetch(url), fetch(url)]);
    ms = CACHE_MS - 1;
    await fetch(url);
    expect(node.calls.filter((c) => c.method === "lr_getInfo")).toHaveLength(1);
    ms = CACHE_MS;
    await fetch(url);
    expect(node.calls.filter((c) => c.method === "lr_getInfo")).toHaveLength(2);
  });

  it("answers 502 without the Node's message when the Public node fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url } = await dashboard(
      chain(2, {
        lr_getInfo: () => ({
          error: { code: -32000, message: "<secret detail>" },
        }),
      }),
    );
    const page = await fetch(url);
    expect(page.status).toBe(502);
    const text = await page.text();
    expect(text).toContain("The Public node did not answer");
    expect(text).not.toContain("secret");
    expect(error).toHaveBeenCalledWith(
      "dashboard: lr_getInfo: <secret detail>",
    );
    error.mockRestore();
  });
});

describe("loadConfig", () => {
  it("needs the Public node, takes an optional Hub, and never echoes URLs", () => {
    expect(loadConfig({ NODE_RPC_URL: "http://seed:9445/" })).toEqual({
      port: 8790,
      nodeUrl: "http://seed:9445",
      hubUrl: undefined,
    });
    expect(
      loadConfig({
        NODE_RPC_URL: "https://rpc.example",
        HUB_URL: "http://hub-api:8787//",
        PORT: "9000",
      }),
    ).toEqual({
      port: 9000,
      nodeUrl: "https://rpc.example",
      hubUrl: "http://hub-api:8787",
    });
    expect(() => loadConfig({})).toThrow("NODE_RPC_URL is required");
    expect(() => loadConfig({ NODE_RPC_URL: "ftp://user:pw@x" })).toThrow(
      "NODE_RPC_URL is not a valid http or https URL",
    );
    expect(() => loadConfig({ NODE_RPC_URL: "nope" })).toThrow(
      /^NODE_RPC_URL is not/,
    );
    expect(() =>
      loadConfig({ NODE_RPC_URL: "http://x", HUB_URL: "x" }),
    ).toThrow("HUB_URL");
    for (const PORT of ["0", "65536", "80a", "-1"])
      expect(
        () => loadConfig({ NODE_RPC_URL: "http://x", PORT }),
        PORT,
      ).toThrow("PORT must be");
  });
});
