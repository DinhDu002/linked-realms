import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Key } from "@linked-realms/core";
import type { LandInfo } from "@linked-realms/shared";
import { verifyStatement } from "@linked-realms/shared/identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitLand,
  fetchWorld,
  findLand,
  postStatement,
  retry,
} from "./hub.ts";

const key = Key.fromSeed(new Uint8Array(32).fill(3));
const owner = Key.fromSeed(new Uint8Array(32).fill(1)).address;
const stranger = Key.fromSeed(new Uint8Array(32).fill(2)).address;

const land = (over: Partial<LandInfo> = {}): LandInfo => ({
  landId: 7,
  owner,
  ownerName: "Mai",
  x: null,
  y: null,
  url: "https://7.lands.test",
  mapServerKey: key.address,
  online: false,
  domain: null,
  ...over,
});

/** A stub Hub: `handler` answers every request. */
async function stubHub(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
) {
  const requests: { method?: string; url?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise((r) => server.close(() => r(undefined))));
  return { hubUrl, requests };
}
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

describe("postStatement", () => {
  it("posts a signed Map server statement naming the Hub, the owner and the key", async () => {
    const hub = await stubHub((_req, res) => void res.writeHead(204).end());
    const config = {
      hubUrl: hub.hubUrl,
      hubDomain: "hub.test",
      landOwner: owner,
    };
    await postStatement(
      config,
      key,
      () => {},
      () => 1_800_000_000_000,
    );
    const [request] = hub.requests;
    expect(request).toMatchObject({ method: "POST", url: "/map-servers" });
    const { fields, address } = verifyStatement(
      JSON.parse(request!.body),
      "map-server",
    );
    expect(address).toBe(key.address);
    expect(fields).toEqual({
      hub: "hub.test",
      owner,
      mapServerKey: key.address,
      issued: 1_800_000_000,
    });
  });

  it("logs a 409 and treats it as done; fails on other errors", async () => {
    let status = 409;
    const hub = await stubHub((_req, res) => void res.writeHead(status).end());
    const config = {
      hubUrl: hub.hubUrl,
      hubDomain: "hub.test",
      landOwner: owner,
    };
    const log = vi.fn();
    await postStatement(config, key, log);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/newer statement/));
    status = 400;
    await expect(postStatement(config, key, log)).rejects.toThrow(/400/);
  });
});

describe("retry", () => {
  it("retries with a growing backoff until the task works", async () => {
    vi.useFakeTimers();
    const post = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    const done = retry(
      post,
      "register with the Hub",
      log,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(post).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      "could not register with the Hub (down); retrying in 2 s",
    );
  });

  it("returns the task's result, or undefined when aborted", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    await expect(
      retry(
        async () => 5,
        "count",
        () => {},
        signal,
      ),
    ).resolves.toBe(5);
    const stop = new AbortController();
    const post = vi.fn().mockRejectedValue(new Error("down"));
    const done = retry(post, "register with the Hub", () => {}, stop.signal);
    await vi.advanceTimersByTimeAsync(0);
    stop.abort();
    await expect(done).resolves.toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWorld", () => {
  const ticket = { address: owner, publicKey: "AAAA" };

  it("reads the ticket signer and the relay from GET /keys", async () => {
    let reply: unknown = { ticket, relayUrl: "wss://relay.test" };
    const { hubUrl, requests } = await stubHub((_req, res) =>
      res.end(JSON.stringify(reply)),
    );
    await expect(fetchWorld({ hubUrl })).resolves.toEqual({
      ticketSigner: owner,
      relayUrl: "wss://relay.test",
    });
    expect(requests[0]).toMatchObject({ method: "GET", url: "/keys" });
    reply = { ticket, relayUrl: null };
    await expect(fetchWorld({ hubUrl })).resolves.toEqual({
      ticketSigner: owner,
      relayUrl: undefined,
    });
  });

  it("rejects a malformed answer or a server error", async () => {
    let reply: [number, unknown] = [200, { ticket: { address: "nope" } }];
    const { hubUrl } = await stubHub((_req, res) => {
      res.statusCode = reply[0];
      res.end(JSON.stringify(reply[1]));
    });
    await expect(fetchWorld({ hubUrl })).rejects.toThrow(/malformed keys/);
    for (const relayUrl of ["https://relay.test", "wss://relay.test/host"]) {
      reply = [200, { ticket, relayUrl }];
      await expect(fetchWorld({ hubUrl })).rejects.toThrow(/malformed keys/);
    }
    reply = [200, null];
    await expect(fetchWorld({ hubUrl })).rejects.toThrow(/malformed keys/);
    reply = [404, { error: "not found" }];
    await expect(fetchWorld({ hubUrl })).rejects.toThrow(/404 to GET \/keys/);
  });
});

describe("findLand", () => {
  it("asks for the Land of this key; 404 means none yet", async () => {
    let reply: [number, unknown] = [404, { error: "not found" }];
    const hub = await stubHub((_req, res) => {
      res.writeHead(reply[0], { "content-type": "application/json" });
      res.end(JSON.stringify(reply[1]));
    });
    expect(await findLand(hub, key.address)).toBeUndefined();
    expect(hub.requests[0]?.url).toBe(`/lands?mapServerKey=${key.address}`);
    reply = [200, land()];
    expect(await findLand(hub, key.address)).toEqual(land());
  });

  it("rejects a malformed answer or a server error", async () => {
    let reply: [number, unknown] = [200, { landId: 0, owner, ownerName: "" }];
    const hub = await stubHub((_req, res) => {
      res.writeHead(reply[0]);
      res.end(JSON.stringify(reply[1]));
    });
    await expect(findLand(hub, key.address)).rejects.toThrow(/malformed/);
    reply = [200, null];
    await expect(findLand(hub, key.address)).rejects.toThrow(/malformed/);
    reply = [500, {}];
    await expect(findLand(hub, key.address)).rejects.toThrow(/500/);
  });
});

describe("awaitLand", () => {
  const run = (over: Partial<Parameters<typeof awaitLand>[0]>) =>
    awaitLand({
      find: async () => undefined,
      repost: async () => {},
      owner,
      log: () => {},
      signal: new AbortController().signal,
      ...over,
    });

  it("keeps polling every 10 seconds until a Land exists", async () => {
    vi.useFakeTimers();
    const find = vi
      .fn<() => Promise<LandInfo | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("hub down"))
      .mockResolvedValue(land());
    const log = vi.fn();
    const result = run({ find, log });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(find).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(find).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(land());
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/hub down/));
  });

  it("does not serve a Land owned by someone other than LAND_OWNER", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const find = vi.fn(async () => land({ owner: stranger }));
    const log = vi.fn();
    const result = run({ find, log, signal: stop.signal });
    await vi.advanceTimersByTimeAsync(35_000);
    stop.abort();
    expect(await result).toBeUndefined();
    expect(find.mock.calls.length).toBeGreaterThan(3);
    // Said once, not every 10 seconds.
    expect(
      log.mock.calls.filter(([m]) => /not by LAND_OWNER/.test(m)),
    ).toHaveLength(1);
  });

  it("posts a fresh statement every 24 hours while it waits", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const repost = vi.fn(async () => {});
    const result = run({ repost, signal: stop.signal, pollMs: 3_600_000 });
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect(repost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(repost).toHaveBeenCalledTimes(1);
    stop.abort();
    await result;
  });

  it("logs a failed repost and keeps waiting", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const log = vi.fn();
    const result = run({
      repost: async () => {
        throw new Error("hub down");
      },
      log,
      signal: stop.signal,
      pollMs: 10,
      repostMs: 5,
    });
    await vi.advanceTimersByTimeAsync(30);
    stop.abort();
    expect(await result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/refresh.*hub down/),
    );
  });
});
