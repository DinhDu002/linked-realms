import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { WebSocket, WebSocketServer } from "ws";
import { connectHost } from "./agent.ts";
import {
  hostHelloMessage,
  parseControl,
  type ControlMessage,
} from "./protocol.ts";
import { createRelay, type RelayOptions } from "./relay.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}
const closeServer = (server: Server) => () =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/** A fake Hub: GET /directory/<id> answers from `lands` (id -> Mining key); a missing id is 404. */
async function startHub() {
  const lands = new Map<number, Address>();
  const server = createServer((req, res) => {
    const id = Number(/^\/directory\/(\d+)$/.exec(req.url ?? "")?.[1]);
    const miningKey = lands.get(id);
    if (!miningKey) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        landId: id,
        owner: miningKey,
        x: 0,
        y: 0,
        miningKey,
        online: true,
      }),
    );
  });
  const port = await listen(server);
  cleanups.push(closeServer(server));
  return { url: `http://127.0.0.1:${port}`, lands };
}

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake local Map server: HTTP echo with CORS, and a WebSocket echo. */
async function startMapServer() {
  const requests: Seen[] = [];
  const wsUrls: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const cors = {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-headers": "content-type",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
      } else if (req.url?.startsWith("/evil")) {
        res.writeHead(200, {
          "content-type": "text/html",
          location: "https://evil.example/",
          "x-custom": "1",
        });
        res.end("<script>alert(1)</script>");
      } else if (req.url?.startsWith("/cookie")) {
        res.writeHead(200, { "set-cookie": "a=b" }).end("x");
      } else {
        res.writeHead(201, { ...cors, "content-type": "application/json" });
        res.end(JSON.stringify({ echo: body, url: req.url }));
      }
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    wsUrls.push(req.url ?? "");
    ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  const port = await listen(server);
  cleanups.push(() => {
    for (const c of wss.clients) c.terminate();
    return closeServer(server)();
  });
  return { port, requests, wsUrls };
}

async function startRelay(
  hubUrl: string,
  options: Partial<RelayOptions> = {},
  port = 0,
) {
  const relay = createRelay({ hubUrl, ...options });
  const actual = await listen(relay, port);
  cleanups.push(
    () => new Promise<void>((resolve) => relay.close(() => resolve())),
  );
  return { relay, port: actual, url: `http://127.0.0.1:${actual}` };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
function http(
  base: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      base + path,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const online = async (relayUrl: string) =>
  (JSON.parse((await http(relayUrl, "/online")).body) as { lands: number[] })
    .lands;

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}
function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    ),
  );
}
function rejectedStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
  );
}
function nextMessage(
  ws: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once("message", (data, isBinary) =>
      resolve({ data: data as Buffer, isBinary }),
    ),
  );
}

/** A hand-driven host link, for the protocol edge cases the real agent never produces. */
function linkHost(
  relayPort: number,
  landId: number,
  privateKey: Hex,
  wsOptions: { autoPong?: boolean } = {},
) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${relayPort}/host/${landId}`,
    wsOptions,
  );
  const control: ControlMessage[] = [];
  const result = closed(ws);
  const ready = new Promise<boolean>((resolve) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseControl(String(data));
      control.push(message);
      if (message.t === "challenge")
        void privateKeyToAccount(privateKey)
          .signMessage({ message: hostHelloMessage(landId, message.nonce) })
          .then((signature) =>
            ws.send(JSON.stringify({ t: "hello", signature })),
          );
      if (message.t === "ready") resolve(true);
    });
    void result.then(() => resolve(false));
  });
  cleanups.push(() => ws.terminate());
  return { ws, control, ready, closed: result };
}

async function setup(relayOptions: Partial<RelayOptions> = {}) {
  const hub = await startHub();
  const key = generatePrivateKey();
  hub.lands.set(1, privateKeyToAccount(key).address);
  const map = await startMapServer();
  const relay = await startRelay(hub.url, relayOptions);
  const agent = connectHost({
    relayUrl: relay.url,
    landId: 1,
    privateKey: key,
    localPort: map.port,
    log: () => {},
  });
  cleanups.push(() => agent.close());
  await vi.waitFor(async () => expect(await online(relay.url)).toEqual([1]));
  return { hub, key, map, relay, agent };
}

describe("HTTP forwarding", () => {
  it("round-trips method, path, query, body, status, headers and CORS", async () => {
    const { map, relay } = await setup();
    const reply = await http(
      relay.url,
      "/land/1/matchmake/joinOrCreate/land?x=1",
      {
        method: "POST",
        headers: {
          origin: "http://app.test",
          "content-type": "application/json",
          cookie: "secret=1",
        },
        body: '{"a":1}',
      },
    );
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({
      echo: '{"a":1}',
      url: "/matchmake/joinOrCreate/land?x=1",
    });
    expect(reply.headers["access-control-allow-origin"]).toBe(
      "http://app.test",
    );
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    const seen = map.requests[0];
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.origin).toBe("http://app.test");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.headers.cookie).toBeUndefined(); // only selected headers are forwarded
  });

  it("forwards a CORS preflight", async () => {
    const { relay } = await setup();
    const reply = await http(relay.url, "/land/1/matchmake/joinOrCreate/land", {
      method: "OPTIONS",
      headers: {
        origin: "http://app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers["access-control-allow-origin"]).toBe(
      "http://app.test",
    );
  });

  it("does not relay Set-Cookie from a Map server", async () => {
    const { relay } = await setup();
    const reply = await http(relay.url, "/land/1/cookie");
    expect(reply.status).toBe(200);
    expect(reply.headers["set-cookie"]).toBeUndefined();
  });

  it("limits the request body to 64 KiB", async () => {
    const { map, relay } = await setup();
    const ok = await http(relay.url, "/land/1/x", {
      method: "POST",
      body: Buffer.alloc(64 * 1024, 97),
    });
    expect(ok.status).toBe(201);
    const big = await http(relay.url, "/land/1/x", {
      method: "POST",
      body: Buffer.alloc(64 * 1024 + 1, 97),
    });
    expect(big.status).toBe(413);
    expect(map.requests).toHaveLength(1);
  });

  it("answers 503 JSON for an offline Land and 404 for unknown paths", async () => {
    const { relay } = await setup();
    const offline = await http(
      relay.url,
      "/land/9/matchmake/joinOrCreate/land",
      { method: "POST", body: "{}" },
    );
    expect(offline.status).toBe(503);
    expect(JSON.parse(offline.body)).toEqual({ error: "Land is offline" });
    expect((await http(relay.url, "/nothing")).status).toBe(404);
    expect((await http(relay.url, "/land/abc/x")).status).toBe(404);
    expect((await http(relay.url, "/health")).body).toBe("ok");
  });

  it("answers 504 when the Map server does not respond", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { httpTimeoutMs: 100 });
    const key = generatePrivateKey();
    hub.lands.set(2, privateKeyToAccount(key).address);
    const host = linkHost(relay.port, 2, key); // never answers http requests
    expect(await host.ready).toBe(true);
    expect((await http(relay.url, "/land/2/slow")).status).toBe(504);
  });

  it("answers 502 when the host link drops mid-request", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = generatePrivateKey();
    hub.lands.set(2, privateKeyToAccount(key).address);
    const host = linkHost(relay.port, 2, key);
    expect(await host.ready).toBe(true);
    const pending = http(relay.url, "/land/2/slow");
    await vi.waitFor(() =>
      expect(host.control.some((m) => m.t === "http")).toBe(true),
    );
    host.ws.terminate();
    expect((await pending).status).toBe(502);
  });
});

describe("Player WebSockets", () => {
  it("round-trips binary and text frames and forwards path and query", async () => {
    const { map, relay } = await setup();
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/land/1/proc123/room456?sessionId=abc`,
    );
    await opened(ws);
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const bin = await nextMessage(ws);
    expect(bin.isBinary).toBe(true);
    expect([...bin.data]).toEqual([1, 2, 3]);
    ws.send("héllo");
    const text = await nextMessage(ws);
    expect(text.isBinary).toBe(false);
    expect(text.data.toString()).toBe("héllo");
    expect(map.wsUrls).toEqual(["/proc123/room456?sessionId=abc"]);
    ws.terminate();
  });

  it("closes the local socket when the Player leaves, and the Player when it closes", async () => {
    const { relay } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`);
    await opened(ws);
    ws.send("x");
    await nextMessage(ws);
    ws.close(4000);
    await closed(ws);
    const stats = JSON.parse((await http(relay.url, "/stats")).body);
    await vi.waitFor(async () =>
      expect(
        JSON.parse((await http(relay.url, "/stats")).body).lands["1"].players,
      ).toBe(0),
    );
    expect(stats.lands["1"]).toBeDefined();
  });

  it("rejects a Player for an offline Land and for bad paths", async () => {
    const { relay } = await setup();
    expect(
      await rejectedStatus(
        new WebSocket(`ws://127.0.0.1:${relay.port}/land/9/p/r`),
      ),
    ).toBe(503);
    expect(
      await rejectedStatus(
        new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p`),
      ),
    ).toBe(404);
    expect(
      await rejectedStatus(
        new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r/extra`),
      ),
    ).toBe(404);
    expect(
      await rejectedStatus(
        new WebSocket(`ws://127.0.0.1:${relay.port}/elsewhere`),
      ),
    ).toBe(404);
  });

  it("closes a Player that sends a frame over 16 KiB", async () => {
    const { relay } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`);
    await opened(ws);
    const done = closed(ws);
    ws.send(Buffer.alloc(16 * 1024 + 1), { binary: true });
    expect((await done).code).toBe(1009);
    ws.on("error", () => {});
    const ok = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`);
    await opened(ok);
    ok.send(Buffer.alloc(16 * 1024), { binary: true });
    expect((await nextMessage(ok)).data.length).toBe(16 * 1024);
  });

  it("enforces MAX_CLIENTS_PER_LAND", async () => {
    const { relay } = await setup({ maxClientsPerLand: 1 });
    const first = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`);
    await opened(first);
    expect(
      await rejectedStatus(
        new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`),
      ),
    ).toBe(503);
  });

  it("closes Players when the host link drops", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = generatePrivateKey();
    hub.lands.set(2, privateKeyToAccount(key).address);
    const host = linkHost(relay.port, 2, key);
    expect(await host.ready).toBe(true);
    const player = new WebSocket(`ws://127.0.0.1:${relay.port}/land/2/p/r`);
    await opened(player);
    const done = closed(player);
    host.ws.terminate();
    expect((await done).code).toBe(1001);
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([]));
  });
});

describe("host authentication", () => {
  it("accepts the Delegation's Mining key", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = generatePrivateKey();
    hub.lands.set(3, privateKeyToAccount(key).address);
    expect(await linkHost(relay.port, 3, key).ready).toBe(true);
    expect(await online(relay.url)).toEqual([3]);
  });

  it("rejects another key with a clear reason", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    hub.lands.set(3, privateKeyToAccount(generatePrivateKey()).address);
    const host = linkHost(relay.port, 3, generatePrivateKey());
    expect(await host.ready).toBe(false);
    expect(await host.closed).toEqual({
      code: 4403,
      reason: "signer is not the Land's delegated Mining key",
    });
    expect(await online(relay.url)).toEqual([]);
  });

  it("rejects a Land that is not in the Directory (unknown or hidden)", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const host = linkHost(relay.port, 3, generatePrivateKey());
    expect(await host.ready).toBe(false);
    expect((await host.closed).code).toBe(4404);
  });

  it("closes the link with 1013 when the Hub is unreachable", async () => {
    const relay = await startRelay("http://127.0.0.1:1");
    const host = linkHost(relay.port, 3, generatePrivateKey());
    expect((await host.closed).code).toBe(1013);
  });

  it("replaces the first link with a second valid one and closes its Players", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = generatePrivateKey();
    hub.lands.set(3, privateKeyToAccount(key).address);
    const first = linkHost(relay.port, 3, key);
    expect(await first.ready).toBe(true);
    const player = new WebSocket(`ws://127.0.0.1:${relay.port}/land/3/p/r`);
    await opened(player);
    const playerClosed = closed(player);
    const second = linkHost(relay.port, 3, key);
    expect(await second.ready).toBe(true);
    expect((await first.closed).code).toBe(4409);
    expect((await playerClosed).code).toBe(1001);
    expect(await online(relay.url)).toEqual([3]);
  });

  it("drops a host whose Delegation changed or whose Land was hidden", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { recheckIntervalMs: 50 });
    const key = generatePrivateKey();
    hub.lands.set(3, privateKeyToAccount(key).address);
    hub.lands.set(4, privateKeyToAccount(key).address);
    const changed = linkHost(relay.port, 3, key);
    const hidden = linkHost(relay.port, 4, key);
    expect((await changed.ready) && (await hidden.ready)).toBe(true);
    hub.lands.set(3, privateKeyToAccount(generatePrivateKey()).address);
    hub.lands.delete(4);
    expect((await changed.closed).code).toBe(4403);
    expect((await hidden.closed).code).toBe(4403);
    expect(await online(relay.url)).toEqual([]);
  });

  it("closes a link that misses two pings", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { pingIntervalMs: 50 });
    const key = generatePrivateKey();
    hub.lands.set(3, privateKeyToAccount(key).address);
    const host = linkHost(relay.port, 3, key, { autoPong: false });
    expect(await host.ready).toBe(true);
    await host.closed;
    expect(await online(relay.url)).toEqual([]);
  });

  it("keeps a responsive link past several pings", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { pingIntervalMs: 30 });
    const key = generatePrivateKey();
    hub.lands.set(3, privateKeyToAccount(key).address);
    expect(await linkHost(relay.port, 3, key).ready).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(await online(relay.url)).toEqual([3]);
  });
});

describe("agent", () => {
  it("reconnects after the relay restarts", async () => {
    const { hub, relay } = await setup();
    const port = relay.port;
    await new Promise<void>((resolve) => relay.relay.close(() => resolve()));
    const again = await startRelay(hub.url, {}, port);
    await vi.waitFor(async () => expect(await online(again.url)).toEqual([1]), {
      timeout: 10_000,
      interval: 100,
    });
  }, 15_000);

  it("stops reconnecting once closed", async () => {
    const { agent, relay } = await setup();
    await agent.close();
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([]));
  });
});

describe("/online and /stats", () => {
  it("lists online Lands sorted and counts bytes and messages per Land and session", async () => {
    const { hub, map, relay } = await setup();
    const key2 = generatePrivateKey();
    hub.lands.set(2, privateKeyToAccount(key2).address);
    const second = connectHost({
      relayUrl: relay.url,
      landId: 2,
      privateKey: key2,
      localPort: map.port,
      log: () => {},
    });
    cleanups.push(() => second.close());
    await vi.waitFor(async () =>
      expect(await online(relay.url)).toEqual([1, 2]),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`);
    await opened(ws);
    const echoes: unknown[] = [];
    ws.on("message", (d) => echoes.push(d));
    ws.send(Buffer.alloc(10), { binary: true });
    ws.send(Buffer.alloc(5), { binary: true });
    await vi.waitFor(() => expect(echoes).toHaveLength(2));
    const stats = JSON.parse((await http(relay.url, "/stats")).body);
    expect(stats.hosts).toBe(2);
    const land = stats.lands["1"];
    expect(land).toMatchObject({
      online: true,
      players: 1,
      bytesIn: 15,
      bytesOut: 15,
      messagesIn: 2,
      messagesOut: 2,
    });
    expect(land.sessions).toEqual([
      { stream: 1, bytesIn: 15, bytesOut: 15, messagesIn: 2, messagesOut: 2 },
    ]);
    expect(stats.lands["2"]).toMatchObject({
      online: true,
      players: 0,
      bytesIn: 0,
    });
    ws.terminate();
  });
});

describe("untrusted input", () => {
  const stillLinked = async (relayUrl: string) =>
    expect(await online(relayUrl)).toEqual([1]);

  it("answers 405 for a method the host link cannot carry, and keeps the link", async () => {
    const { relay } = await setup();
    expect(
      (await http(relay.url, "/land/1/", { method: "PROPFIND" })).status,
    ).toBe(405);
    await stillLinked(relay.url);
  });

  it("answers 431 for an oversized forwarded header, and keeps the link", async () => {
    const { relay } = await setup();
    const reply = await http(relay.url, "/land/1/matchmake/joinOrCreate/x", {
      headers: { origin: "http://a".padEnd(9000, "a") },
    });
    expect(reply.status).toBe(431);
    await stillLinked(relay.url);
  });

  it("answers 414 for a path the host link cannot carry, and keeps the link", async () => {
    const { relay } = await setup();
    const long = "/land/1/x?" + "a".repeat(3000);
    expect((await http(relay.url, long)).status).toBe(414);
    const ws = new WebSocket(
      `ws://127.0.0.1:${relay.port}/land/1/p/r?${"a".repeat(3000)}`,
    );
    expect(await rejectedStatus(ws)).toBe(414);
    await stillLinked(relay.url);
  });

  it("does not forward Authorization to the Map server", async () => {
    const { map, relay } = await setup();
    await http(relay.url, "/land/1/x", {
      headers: { authorization: "Bearer hub-session-token" },
    });
    expect(map.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("neutralises active content and redirects from a Map server", async () => {
    const { relay } = await setup();
    const reply = await http(relay.url, "/land/1/evil");
    expect(reply.headers.location).toBeUndefined();
    expect(reply.headers["x-custom"]).toBeUndefined();
    expect(reply.headers["content-security-policy"]).toContain("sandbox");
  });

  it("does not alias a Land through leading zeros", async () => {
    const { relay } = await setup();
    expect((await http(relay.url, "/land/01/x")).status).toBe(404);
  });

  it("drops a Player that stops answering pings", async () => {
    const { relay } = await setup({ pingIntervalMs: 50 });
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/land/1/p/r`, {
      autoPong: false,
    });
    await opened(ws);
    await closed(ws);
    const stats = JSON.parse((await http(relay.url, "/stats")).body) as {
      lands: Record<string, { players: number }>;
    };
    expect(stats.lands["1"]?.players).toBe(0);
  });
});
