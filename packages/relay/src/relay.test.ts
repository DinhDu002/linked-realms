import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Key } from "@linked-realms/core";
import { signStatement } from "@linked-realms/shared/identity";
import { WebSocket, WebSocketServer } from "ws";
import { connectHost } from "./agent.ts";
import {
  KIND_BINARY,
  MAX_DATA_PAYLOAD,
  encodeFrame,
  parseControl,
  type ControlMessage,
} from "./protocol.ts";
import { createRelay, type RelayOptions } from "./relay.ts";

const LAND_BASE = "lands.test";
const SHELL = "https://shell.test";
const CSP = `frame-ancestors ${SHELL}`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const newKey = () => Key.fromSeed(crypto.getRandomValues(new Uint8Array(32)));

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

/** A port that was free a moment ago: the relay must know its own host before it listens. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await closeServer(probe)();
  return port;
}

/** A fake Hub: GET /lands/<id> answers from `lands` (id -> Map server key); a missing id is 404. */
async function startHub() {
  const lands = new Map<number, string>();
  const state = { down: false };
  const server = createServer((req, res) => {
    if (state.down) {
      res.writeHead(500).end();
      return;
    }
    const id = Number(/^\/lands\/(\d+)$/.exec(req.url ?? "")?.[1]);
    const mapServerKey = lands.get(id);
    if (!mapServerKey) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        landId: id,
        owner: mapServerKey,
        ownerName: "",
        x: 0,
        y: 0,
        url: `http://${id}.${LAND_BASE}`,
        mapServerKey,
        online: true,
      }),
    );
  });
  const port = await listen(server);
  cleanups.push(closeServer(server));
  return { url: `http://127.0.0.1:${port}`, lands, state };
}

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake local Map server: HTTP routes for the cases below, and a WebSocket echo. */
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
          "set-cookie": "a=b",
          "content-security-policy": "default-src 'self'",
          etag: '"v1"',
          "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT",
          "cache-control": "no-cache",
        });
        res.end("<p>hi</p>");
      } else if (req.url?.startsWith("/chunks")) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        void (async () => {
          for (const letter of "abc") {
            res.write(letter.repeat(100_000));
            await sleep(10);
          }
          res.end();
        })();
      } else if (req.url?.startsWith("/abort")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("partial");
        setTimeout(() => req.socket.destroy(), 20);
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
  port?: number,
) {
  const actual = port ?? (await freePort());
  const relayHost = `127.0.0.1:${actual}`;
  const relay = createRelay({
    hubUrl,
    relayHost,
    landBaseDomain: LAND_BASE,
    shellOrigins: [SHELL],
    ...options,
  });
  await listen(relay, actual);
  cleanups.push(
    () => new Promise<void>((resolve) => relay.close(() => resolve())),
  );
  return {
    relay,
    port: actual,
    relayHost,
    url: `http://${relayHost}`,
    wsUrl: `ws://${relayHost}`,
  };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  body: string;
  /** False when the connection was cut before the response ended. */
  complete: boolean;
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
        res.on("error", () => {});
        res.on("close", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks).toString(),
            complete: res.complete,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** A request on a Land's host (Host header), sent to the relay's socket. */
const landHost = (id: number | string) => `${id}.${LAND_BASE}`;
const land = (
  relay: { url: string },
  id: number | string,
  path: string,
  init: Parameters<typeof http>[2] = {},
) =>
  http(relay.url, path, {
    ...init,
    headers: { host: landHost(id), ...init.headers },
  });

/** Every response on a Land host carries the framing policy and nosniff. */
function expectLandHeaders(reply: Reply) {
  const csp = reply.rawHeaders.flatMap((h, i, all) =>
    all[i - 1]?.toLowerCase() === "content-security-policy" && i % 2 === 1
      ? [h]
      : [],
  );
  expect(csp[0]).toBe(CSP);
  expect(reply.headers["x-content-type-options"]).toBe("nosniff");
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
function rejectedResponse(ws: WebSocket) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders }>(
    (resolve) =>
      ws.once("unexpected-response", (_req, res) =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers }),
      ),
  );
}
const rejectedStatus = async (ws: WebSocket) =>
  (await rejectedResponse(ws)).status;
function nextMessage(
  ws: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once("message", (data, isBinary) =>
      resolve({ data: data as Buffer, isBinary }),
    ),
  );
}

/** A Player WebSocket to a Land's host at any path. */
const player = (
  relay: { wsUrl: string },
  id: number | string,
  path = "/play",
  options: { autoPong?: boolean } = {},
) =>
  new WebSocket(`${relay.wsUrl}${path}`, {
    headers: { host: landHost(id) },
    ...options,
  });

interface LinkOptions {
  key?: Key;
  relay?: string;
  land?: number;
  nonce?: string;
  tamper?: boolean;
  autoPong?: boolean;
}

/** A hand-driven host link, for the protocol edge cases the real agent never produces. */
function linkHost(
  relay: { port: number; relayHost: string },
  landId: number,
  key: Key,
  options: LinkOptions = {},
) {
  const ws = new WebSocket(
    `ws://${relay.relayHost}/host/${landId}`,
    options.autoPong === undefined ? {} : { autoPong: options.autoPong },
  );
  const control: ControlMessage[] = [];
  const data: Array<{ id: number; payload: Buffer }> = [];
  const result = closed(ws);
  const ready = new Promise<boolean>((resolve) => {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const message = parseControl(String(raw));
      control.push(message);
      if (message.t === "challenge") {
        const signed = signStatement(
          "relay-host",
          {
            relay: options.relay ?? relay.relayHost,
            land: options.land ?? landId,
            nonce: options.nonce ?? message.nonce,
          },
          options.key ?? key,
        );
        if (options.tamper)
          signed.signature =
            (signed.signature[0] === "A" ? "B" : "A") +
            signed.signature.slice(1);
        ws.send(JSON.stringify({ t: "hello", ...signed }));
      }
      if (message.t === "ready") resolve(true);
    });
    void result.then(() => resolve(false));
  });
  cleanups.push(() => ws.terminate());
  const reply = (message: ControlMessage) => ws.send(JSON.stringify(message));
  const send = (id: number, payload: Buffer) =>
    ws.send(encodeFrame(id, KIND_BINARY, payload));
  const requestId = async () => {
    await vi.waitFor(() =>
      expect(control.some((m) => m.t === "http")).toBe(true),
    );
    return (control.find((m) => m.t === "http") as { id: number }).id;
  };
  return { ws, control, data, ready, closed: result, reply, send, requestId };
}

async function setup(relayOptions: Partial<RelayOptions> = {}) {
  const hub = await startHub();
  const key = newKey();
  hub.lands.set(1, key.address);
  const map = await startMapServer();
  const relay = await startRelay(hub.url, relayOptions);
  const agent = connectHost({
    relayUrl: relay.wsUrl,
    landId: 1,
    mapServerKey: key,
    localPort: map.port,
    log: () => {},
  });
  cleanups.push(() => agent.close());
  await vi.waitFor(async () => expect(await online(relay.url)).toEqual([1]));
  return { hub, key, map, relay, agent };
}

/** A relay with a hand-driven link for Land 2 and nothing else. */
async function setupManual(relayOptions: Partial<RelayOptions> = {}) {
  const hub = await startHub();
  const relay = await startRelay(hub.url, relayOptions);
  const key = newKey();
  hub.lands.set(2, key.address);
  const host = linkHost(relay, 2, key);
  expect(await host.ready).toBe(true);
  return { hub, relay, key, host };
}

describe("routing by Host", () => {
  it("serves a Land on <landId>.<LAND_BASE_DOMAIN>, in any letter case", async () => {
    const { map, relay } = await setup();
    const reply = await land(relay, 1, "/matchmake?x=1");
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({ echo: "", url: "/matchmake?x=1" });
    expect(
      (await http(relay.url, "/y", { headers: { host: "1.LANDS.Test" } }))
        .status,
    ).toBe(201);
    expect(map.requests.map((r) => r.url)).toEqual(["/matchmake?x=1", "/y"]);
  });

  it("gives every other host the relay's own routes only", async () => {
    const { map, relay } = await setup();
    expect((await http(relay.url, "/health")).body).toBe("ok");
    expect(await online(relay.url)).toEqual([1]);
    expect((await http(relay.url, "/matchmake")).status).toBe(404);
    expect((await http(relay.url, "/land/1/x")).status).toBe(404);
    const other = { headers: { host: "other.example" } };
    expect((await http(relay.url, "/x", other)).status).toBe(404);
    expect((await http(relay.url, "/online", other)).status).toBe(200);
    // Not shadowed by the Land: a Land host forwards /online, /stats and /health to the Land.
    for (const path of ["/online", "/stats", "/health"])
      expect((await land(relay, 1, path)).status).toBe(201);
    expect(map.requests.map((r) => r.url)).toEqual([
      "/online",
      "/stats",
      "/health",
    ]);
  });

  it("does not alias a Land through leading zeros or a bad id", async () => {
    const { map, relay } = await setup();
    for (const id of ["01", "0", "1x", "-1", "1.1", "99999999999999999999"])
      expect((await land(relay, id, "/x")).status, id).toBe(404);
    expect(map.requests).toHaveLength(0);
  });

  it("answers 503 for a Land id with no live link, without naming it", async () => {
    const { relay } = await setup();
    const reply = await land(relay, 9, "/");
    expect(reply.status).toBe(503);
    expect(reply.headers["content-type"]).toContain("text/html");
    expect(reply.body).not.toMatch(/\b9\b/);
    expectLandHeaders(reply);
  });

  it("turns a WebSocket upgrade on any path of a Land host into a Player stream", async () => {
    const { map, relay } = await setup();
    const ws = player(relay, 1, "/some/where/else?q=1");
    await opened(ws);
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
    const bin = await nextMessage(ws);
    expect(bin.isBinary).toBe(true);
    expect([...bin.data]).toEqual([1, 2, 3]);
    ws.send("héllo");
    const text = await nextMessage(ws);
    expect(text.isBinary).toBe(false);
    expect(text.data.toString()).toBe("héllo");
    // /host/<id> is just a path on a Land host.
    const odd = player(relay, 1, "/host/1");
    await opened(odd);
    await vi.waitFor(() => expect(map.wsUrls).toHaveLength(2));
    expect(map.wsUrls).toEqual(["/some/where/else?q=1", "/host/1"]);
    ws.terminate();
    odd.terminate();
  });

  it("refuses a WebSocket upgrade on the relay host except /host/<landId>", async () => {
    const { relay } = await setup();
    for (const path of [
      "/play",
      "/host",
      "/host/01",
      "/host/1/x",
      "/land/1/p/r",
    ])
      expect(
        await rejectedStatus(new WebSocket(`${relay.wsUrl}${path}`)),
        path,
      ).toBe(404);
  });
});

describe("HTTP forwarding", () => {
  it("round-trips method, path, query, body, status, headers and CORS", async () => {
    const { map, relay } = await setup();
    const reply = await land(relay, 1, "/matchmake/joinOrCreate/land?x=1", {
      method: "POST",
      headers: {
        origin: "http://app.test",
        "content-type": "application/json",
        cookie: "secret=1",
      },
      body: '{"a":1}',
    });
    expect(reply.status).toBe(201);
    expect(JSON.parse(reply.body)).toEqual({
      echo: '{"a":1}',
      url: "/matchmake/joinOrCreate/land?x=1",
    });
    expect(reply.headers["access-control-allow-origin"]).toBe(
      "http://app.test",
    );
    expectLandHeaders(reply);
    const seen = map.requests[0];
    expect(seen?.method).toBe("POST");
    expect(seen?.headers.origin).toBe("http://app.test");
    expect(seen?.headers["content-type"]).toBe("application/json");
    expect(seen?.headers.cookie).toBeUndefined();
  });

  it("forwards a CORS preflight", async () => {
    const { relay } = await setup();
    const reply = await land(relay, 1, "/x", {
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
    expectLandHeaders(reply);
  });

  it("forwards exactly the listed request headers", async () => {
    const { map, relay } = await setup();
    await land(relay, 1, "/x", {
      headers: {
        accept: "text/html",
        "accept-encoding": "gzip",
        "if-none-match": '"v1"',
        "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
        authorization: "Bearer hub-session-token",
        cookie: "a=b",
        "x-custom": "1",
        "user-agent": "t",
      },
    });
    const seen = map.requests[0]?.headers ?? {};
    expect(seen.accept).toBe("text/html");
    expect(seen["accept-encoding"]).toBe("gzip");
    expect(seen["if-none-match"]).toBe('"v1"');
    expect(seen["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    for (const name of ["authorization", "cookie", "x-custom", "user-agent"])
      expect(seen[name], name).toBeUndefined();
  });

  it("forwards the listed response headers, drops the rest, and sets two CSP headers", async () => {
    const { relay } = await setup();
    const reply = await land(relay, 1, "/evil");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/html");
    expect(reply.headers.etag).toBe('"v1"');
    expect(reply.headers["last-modified"]).toBe(
      "Wed, 21 Oct 2015 07:28:00 GMT",
    );
    expect(reply.headers["cache-control"]).toBe("no-cache");
    expect(reply.headers.location).toBeUndefined();
    expect(reply.headers["x-custom"]).toBeUndefined();
    expect(reply.headers["set-cookie"]).toBeUndefined();
    const csp = reply.rawHeaders.filter(
      (_h, i, all) => all[i - 1]?.toLowerCase() === "content-security-policy",
    );
    expect(csp).toEqual([CSP, "default-src 'self'"]);
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(reply.body).toBe("<p>hi</p>");
  });

  it("limits the request body to 64 KiB", async () => {
    const { map, relay } = await setup();
    const ok = await land(relay, 1, "/x", {
      method: "POST",
      body: Buffer.alloc(64 * 1024, 97),
    });
    expect(ok.status).toBe(201);
    const big = await land(relay, 1, "/x", {
      method: "POST",
      body: Buffer.alloc(64 * 1024 + 1, 97),
    });
    expect(big.status).toBe(413);
    expectLandHeaders(big);
    expect(map.requests).toHaveLength(1);
  });

  it("streams a body that arrives in several chunks", async () => {
    const { relay } = await setup();
    const reply = await land(relay, 1, "/chunks");
    expect(reply.complete).toBe(true);
    expect(reply.body).toBe(
      "a".repeat(100_000) + "b".repeat(100_000) + "c".repeat(100_000),
    );
    expectLandHeaders(reply);
  });

  it("cuts the response when the local body fails (aborted)", async () => {
    const { relay } = await setup();
    const reply = await land(relay, 1, "/abort");
    expect(reply.status).toBe(200);
    expect(reply.complete).toBe(false);
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([1]));
  });

  it("answers 502 from the agent when the local Map server is unreachable", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = newKey();
    hub.lands.set(1, key.address);
    const agent = connectHost({
      relayUrl: relay.wsUrl,
      landId: 1,
      mapServerKey: key,
      localPort: await freePort(),
      log: () => {},
    });
    cleanups.push(() => agent.close());
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([1]));
    const reply = await land(relay, 1, "/");
    expect(reply.status).toBe(502);
    expectLandHeaders(reply);
  });

  it("passes on the Map server's response in 64 KiB-bounded data frames", async () => {
    const { host, relay } = await setupManual();
    const pending = land(relay, 2, "/file");
    const id = await host.requestId();
    host.reply({ t: "http-response", id, status: 200, headers: {} });
    host.send(id, Buffer.from("one,"));
    host.send(id, Buffer.from("two"));
    host.reply({ t: "http-end", id });
    const reply = await pending;
    expect(reply.body).toBe("one,two");
    expect(reply.complete).toBe(true);
    expect(reply.headers["content-length"]).toBeUndefined();
  });

  it("cuts the response at http-end with aborted", async () => {
    const { host, relay } = await setupManual();
    const pending = land(relay, 2, "/file");
    const id = await host.requestId();
    host.reply({ t: "http-response", id, status: 200, headers: {} });
    host.send(id, Buffer.from("part"));
    host.reply({ t: "http-end", id, aborted: true });
    // The cut may come before the headers are flushed: then the browser sees a reset.
    const reply = await pending.catch(() => undefined);
    expect(reply?.complete ?? false).toBe(false);
    expect(await online(relay.url)).toEqual([2]);
  });

  it("drops a response over 32 MiB", async () => {
    const { host, relay } = await setupManual();
    const pending = land(relay, 2, "/file");
    const id = await host.requestId();
    host.reply({ t: "http-response", id, status: 200, headers: {} });
    const chunk = Buffer.alloc(MAX_DATA_PAYLOAD);
    for (let sent = 0; sent <= 32 * 1024 * 1024; sent += chunk.length)
      host.send(id, chunk);
    host.reply({ t: "http-end", id });
    const reply = await pending;
    expect(reply.complete).toBe(false);
    expect(reply.body.length).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(await online(relay.url)).toEqual([2]);
  });

  it("answers 504 when the Map server does not respond", async () => {
    const { relay } = await setupManual({ httpTimeoutMs: 100 });
    const reply = await land(relay, 2, "/slow");
    expect(reply.status).toBe(504);
    expectLandHeaders(reply);
  });

  it("answers 502 when the host link drops mid-request", async () => {
    const { host, relay } = await setupManual();
    const pending = land(relay, 2, "/slow");
    await host.requestId();
    host.ws.terminate();
    const reply = await pending;
    expect(reply.status).toBe(502);
    expectLandHeaders(reply);
  });

  it("uses one id counter for HTTP requests and Player streams", async () => {
    const { host, relay } = await setupManual();
    const ws = player(relay, 2);
    await opened(ws);
    const pending = land(relay, 2, "/x");
    const id = await host.requestId();
    const open = host.control.find((m) => m.t === "open");
    expect(open?.t === "open" && open.stream).not.toBe(id);
    host.reply({ t: "http-response", id, status: 204, headers: {} });
    host.reply({ t: "http-end", id });
    await pending;
    ws.terminate();
  });

  it("answers 405, 414 and 431 for what the host link cannot carry, and keeps the link", async () => {
    const { relay } = await setup();
    const method = await land(relay, 1, "/", { method: "PROPFIND" });
    expect(method.status).toBe(405);
    expectLandHeaders(method);
    const path = await land(relay, 1, "/x?" + "a".repeat(3000));
    expect(path.status).toBe(414);
    expectLandHeaders(path);
    const header = await land(relay, 1, "/x", {
      headers: { origin: "http://a".padEnd(9000, "a") },
    });
    expect(header.status).toBe(431);
    expectLandHeaders(header);
    const ws = player(relay, 1, "/p?" + "a".repeat(3000));
    expect(await rejectedStatus(ws)).toBe(414);
    expect(await online(relay.url)).toEqual([1]);
  });

  it("puts the framing policy and nosniff on the offline page, and 'none' without Shell origins", async () => {
    const { relay } = await setup({ shellOrigins: [] });
    const offline = await land(relay, 9, "/");
    expect(offline.status).toBe(503);
    expect(offline.headers["content-security-policy"]).toBe(
      "frame-ancestors 'none'",
    );
    expect(offline.headers["x-content-type-options"]).toBe("nosniff");
    const served = await land(relay, 1, "/");
    expect(served.headers["content-security-policy"]).toBe(
      "frame-ancestors 'none'",
    );
  });
});

describe("Player WebSockets", () => {
  it("closes the local socket when the Player leaves, and the Player when it closes", async () => {
    const { relay } = await setup();
    const ws = player(relay, 1);
    await opened(ws);
    ws.send("x");
    await nextMessage(ws);
    ws.close(4000);
    await closed(ws);
    await vi.waitFor(async () =>
      expect(
        JSON.parse((await http(relay.url, "/stats")).body).lands["1"].players,
      ).toBe(0),
    );
  });

  it("refuses a Player for an offline Land, with the framing policy", async () => {
    const { relay } = await setup();
    const refused = await rejectedResponse(player(relay, 9));
    expect(refused.status).toBe(503);
    expect(refused.headers["content-security-policy"]).toBe(CSP);
    expect(refused.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("closes a Player that sends a frame over PLAYER_MAX_FRAME", async () => {
    const { relay } = await setup({ playerMaxFrame: 1024 });
    const ws = player(relay, 1);
    await opened(ws);
    const done = closed(ws);
    ws.send(Buffer.alloc(1025), { binary: true });
    expect((await done).code).toBe(1009);
    ws.on("error", () => {});
    const ok = player(relay, 1);
    await opened(ok);
    ok.send(Buffer.alloc(1024), { binary: true });
    expect((await nextMessage(ok)).data.length).toBe(1024);
  });

  it("enforces MAX_CLIENTS_PER_LAND", async () => {
    const { relay } = await setup({ maxClientsPerLand: 1 });
    const first = player(relay, 1);
    await opened(first);
    expect(await rejectedStatus(player(relay, 1))).toBe(503);
  });

  it("closes Players when the host link drops", async () => {
    const { host, relay } = await setupManual();
    const ws = player(relay, 2);
    await opened(ws);
    const done = closed(ws);
    host.ws.terminate();
    expect((await done).code).toBe(1001);
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([]));
  });

  it("drops a Player that stops answering pings", async () => {
    const { relay } = await setup({ pingIntervalMs: 50 });
    const ws = player(relay, 1, "/play", { autoPong: false });
    await opened(ws);
    await closed(ws);
    const stats = JSON.parse((await http(relay.url, "/stats")).body) as {
      lands: Record<string, { players: number }>;
    };
    expect(stats.lands["1"]?.players).toBe(0);
  });
});

describe("host authentication", () => {
  async function refused(options: LinkOptions, landKey = newKey()) {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    hub.lands.set(3, landKey.address);
    const host = linkHost(relay, 3, landKey, options);
    expect(await host.ready).toBe(false);
    expect((await host.closed).code).toBe(4401);
    expect(await online(relay.url)).toEqual([]);
  }

  it("accepts the Land's Map server key", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = newKey();
    hub.lands.set(3, key.address);
    expect(await linkHost(relay, 3, key).ready).toBe(true);
    expect(await online(relay.url)).toEqual([3]);
  });

  it("refuses a bad signature", () => refused({ tamper: true }));
  it("refuses a statement naming another relay", () =>
    refused({ relay: "other.example" }));
  it("refuses a statement naming another Land", () => refused({ land: 4 }));
  it("refuses a statement that does not answer the challenge", () =>
    refused({ nonce: "0".repeat(32) }));
  it("refuses a key that is not the Land's", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    hub.lands.set(3, newKey().address);
    const host = linkHost(relay, 3, newKey());
    expect(await host.ready).toBe(false);
    expect(await host.closed).toEqual({
      code: 4401,
      reason: "signer is not the Land's Map server key",
    });
  });

  it("refuses a Land the Hub does not know or hides (404)", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const host = linkHost(relay, 3, newKey());
    expect(await host.ready).toBe(false);
    expect((await host.closed).code).toBe(4401);
  });

  it("refuses a hello over 16 KiB and anything but a hello first", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    for (const frame of [
      JSON.stringify({ t: "hello", statement: "x".repeat(20_000) }),
      JSON.stringify({ t: "ready" }),
      Buffer.from([0, 0, 0, 1, 0, 1]),
    ]) {
      const ws = new WebSocket(`ws://${relay.relayHost}/host/3`);
      cleanups.push(() => ws.terminate());
      await opened(ws);
      const done = closed(ws);
      ws.send(frame);
      expect((await done).code).toBe(4401);
    }
  });

  it("closes the link with 4408 when no hello comes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const hub = await startHub();
      const relay = await startRelay(hub.url);
      const ws = new WebSocket(`ws://${relay.relayHost}/host/3`);
      cleanups.push(() => ws.terminate());
      await opened(ws);
      const done = closed(ws);
      await vi.advanceTimersByTimeAsync(10_001);
      expect((await done).code).toBe(4408);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the link with 1013 when the Hub is unreachable", async () => {
    const relay = await startRelay("http://127.0.0.1:1");
    const host = linkHost(relay, 3, newKey());
    expect((await host.closed).code).toBe(1013);
  });

  it("replaces the first link with a second valid one and closes its Players", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url);
    const key = newKey();
    hub.lands.set(3, key.address);
    const first = linkHost(relay, 3, key);
    expect(await first.ready).toBe(true);
    const ws = player(relay, 3);
    await opened(ws);
    const playerClosed = closed(ws);
    const second = linkHost(relay, 3, key);
    expect(await second.ready).toBe(true);
    expect((await first.closed).code).toBe(4409);
    expect((await playerClosed).code).toBe(1001);
    expect(await online(relay.url)).toEqual([3]);
  });

  it("closes a link with 4403 when the Land is hidden or its key changed", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { recheckIntervalMs: 50 });
    const key = newKey();
    hub.lands.set(3, key.address);
    hub.lands.set(4, key.address);
    const changed = linkHost(relay, 3, key);
    const hidden = linkHost(relay, 4, key);
    expect((await changed.ready) && (await hidden.ready)).toBe(true);
    hub.lands.set(3, newKey().address);
    hub.lands.delete(4);
    expect((await changed.closed).code).toBe(4403);
    expect((await hidden.closed).code).toBe(4403);
    expect(await online(relay.url)).toEqual([]);
  });

  it("keeps links up through a Hub outage", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { recheckIntervalMs: 50 });
    const key = newKey();
    hub.lands.set(3, key.address);
    expect(await linkHost(relay, 3, key).ready).toBe(true);
    hub.state.down = true;
    await sleep(300);
    expect(await online(relay.url)).toEqual([3]);
  });

  it("closes a link that misses two pings", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { pingIntervalMs: 50 });
    const key = newKey();
    hub.lands.set(3, key.address);
    const host = linkHost(relay, 3, key, { autoPong: false });
    expect(await host.ready).toBe(true);
    await host.closed;
    expect(await online(relay.url)).toEqual([]);
  });

  it("keeps a responsive link past several pings", async () => {
    const hub = await startHub();
    const relay = await startRelay(hub.url, { pingIntervalMs: 30 });
    const key = newKey();
    hub.lands.set(3, key.address);
    expect(await linkHost(relay, 3, key).ready).toBe(true);
    await sleep(250);
    expect(await online(relay.url)).toEqual([3]);
  });
});

describe("agent", () => {
  it("reconnects after the relay restarts", async () => {
    const { hub, relay } = await setup();
    await new Promise<void>((resolve) => relay.relay.close(() => resolve()));
    const again = await startRelay(hub.url, {}, relay.port);
    await vi.waitFor(async () => expect(await online(again.url)).toEqual([1]), {
      timeout: 10_000,
      interval: 100,
    });
  }, 15_000);

  it("starts its backoff again at 1 s after every link that got ready", async () => {
    // a stand-in relay that accepts any hello, says ready, then drops the link
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(
      () => new Promise<void>((resolve) => wss.close(() => resolve())),
    );
    await new Promise((resolve) => wss.once("listening", resolve));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ t: "challenge", nonce: "0".repeat(32) }));
      ws.once("message", () => {
        ws.send(JSON.stringify({ t: "ready" }));
        ws.close(1001);
      });
    });
    const retries: string[] = [];
    const agent = connectHost({
      relayUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      landId: 1,
      mapServerKey: newKey(),
      localPort: 1,
      log: (line) => {
        const delay = /retrying in (\S+ s)/.exec(line)?.[1];
        if (delay) retries.push(delay);
      },
    });
    cleanups.push(() => agent.close());
    await vi.waitFor(() => expect(retries.length).toBeGreaterThanOrEqual(3), {
      timeout: 10_000,
      interval: 50,
    });
    expect(retries.slice(0, 3)).toEqual(["1 s", "1 s", "1 s"]);
  }, 15_000);

  it("stops reconnecting once closed", async () => {
    const { agent, relay } = await setup();
    await agent.close();
    await vi.waitFor(async () => expect(await online(relay.url)).toEqual([]));
  });

  it("refuses a relay URL that is not a ws(s) base URL", () => {
    for (const relayUrl of [
      "http://127.0.0.1:1",
      "ws://127.0.0.1:1/path",
      "ws://127.0.0.1:1/?a=1",
      "nope",
    ])
      expect(() =>
        connectHost({
          relayUrl,
          landId: 1,
          mapServerKey: newKey(),
          localPort: 1,
          log: () => {},
        }),
      ).toThrow();
  });
});

describe("/online and /stats", () => {
  it("lists online Lands sorted and counts bytes and messages per Land and session", async () => {
    const { hub, map, relay } = await setup();
    const key2 = newKey();
    hub.lands.set(2, key2.address);
    const second = connectHost({
      relayUrl: relay.wsUrl,
      landId: 2,
      mapServerKey: key2,
      localPort: map.port,
      log: () => {},
    });
    cleanups.push(() => second.close());
    await vi.waitFor(async () =>
      expect(await online(relay.url)).toEqual([1, 2]),
    );

    const ws = player(relay, 1);
    await opened(ws);
    const echoes: unknown[] = [];
    ws.on("message", (d) => echoes.push(d));
    ws.send(Buffer.alloc(10), { binary: true });
    ws.send(Buffer.alloc(5), { binary: true });
    await vi.waitFor(() => expect(echoes).toHaveLength(2));
    const stats = JSON.parse((await http(relay.url, "/stats")).body);
    expect(stats.hosts).toBe(2);
    const stat = stats.lands["1"];
    expect(stat).toMatchObject({
      online: true,
      players: 1,
      bytesIn: 15,
      bytesOut: 15,
      messagesIn: 2,
      messagesOut: 2,
    });
    expect(stat.sessions).toEqual([
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
