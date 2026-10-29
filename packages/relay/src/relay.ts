// The relay: Map servers dial in once (/host/<landId>); Player HTTP and WebSockets for a Land
// are carried over that link as numbered streams, so a home Map server needs no open port.
import { randomBytes } from "node:crypto";
import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { isAddress } from "@linked-realms/core";
import { verifyStatement } from "@linked-realms/shared/identity";
import type { LandInfo } from "@linked-realms/shared";
import { WebSocket, WebSocketServer } from "ws";
import {
  HOST_MAX_PAYLOAD,
  HTTP_RESPONSE_LIMIT,
  KIND_BINARY,
  MAX_HEADER_VALUE,
  MAX_UNAUTHENTICATED_FRAME,
  KIND_TEXT,
  decodeFrame,
  encodeFrame,
  isForwardMethod,
  isForwardPath,
  isRelayedResponseHeader,
  parseControl,
  rawToBuffer,
  sendableCloseCode,
  type ControlMessage,
  type HttpHeaders,
} from "./protocol.ts";

export interface RelayOptions {
  /** hub-api base URL; the relay reads Lands from `<hubUrl>/lands/<landId>`. */
  hubUrl: string;
  /** This relay's host as Map servers dial it; default "localhost:8080". */
  relayHost?: string;
  /** Lands are served at `<landId>.<landBaseDomain>`; default "localhost:8080". */
  landBaseDomain?: string;
  /** Origins that may frame a Land. */
  shellOrigins?: string[];
  /** Largest frame a Player may send; default 16 KiB. */
  playerMaxFrame?: number;
  maxClientsPerLand?: number;
  maxHosts?: number;
  /** Timings, overridable for tests. */
  pingIntervalMs?: number;
  recheckIntervalMs?: number;
  httpTimeoutMs?: number;
}

const CLIENT_BUFFER_LIMIT = 1024 * 1024;
/** A browser this far behind on a response loses it. */
const RESPONSE_BACKLOG_LIMIT = 4 * 1024 * 1024;
const HOST_BUFFER_LIMIT = 4 * 1024 * 1024;
const HTTP_BODY_LIMIT = 64 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const HUB_TIMEOUT_MS = 5_000;
/** Host links that have connected but not yet authenticated. */
const MAX_UNAUTHENTICATED_HOSTS = 100;
const MAX_PENDING_REQUESTS = 256;

interface Counters {
  bytesIn: number; // Player -> Land
  bytesOut: number; // Land -> Player
  messagesIn: number;
  messagesOut: number;
}

const newCounters = (): Counters => ({
  bytesIn: 0,
  bytesOut: 0,
  messagesIn: 0,
  messagesOut: 0,
});

interface Session extends Counters {
  id: number;
  client: WebSocket;
  /** Pings sent since the last pong. */
  unanswered: number;
}

/** A Player HTTP request waiting for, or receiving, its response from the Map server. */
interface Exchange {
  res: ServerResponse;
  /** The 504 timer until the response starts, then an idle timer between body chunks. */
  timer: NodeJS.Timeout;
  received: number;
  responding: boolean;
}

interface Host {
  landId: number;
  mapServerKey: string;
  ws: WebSocket;
  counters: Counters;
  streams: Map<number, Session>;
  requests: Map<number, Exchange>;
  /** One counter for HTTP ids and stream ids, so they never collide. */
  nextId: number;
  unanswered: number;
}

type Auth =
  | { ok: true; mapServerKey: string }
  | { ok: false; code: number; reason: string };

const LAND_ID = /^[1-9]\d{0,14}$/;

function splitTarget(url: string): { pathname: string; search: string } {
  const q = url.indexOf("?");
  return q < 0
    ? { pathname: url, search: "" }
    : { pathname: url.slice(0, q), search: url.slice(q) };
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  extraHeaders = "",
): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n${extraHeaders}` +
      `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Reads up to `limit` bytes; resolves undefined as soon as the body is larger. */
function readBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop at once; the caller answers 413 and closes, so the rest is never buffered.
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
        resolve(undefined);
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The request headers a Map server may see; undefined when one is too large for the host link. Authorization and cookies are never forwarded: they would hand a Hub session to a Map server. */
function forwardedHeaders(req: IncomingMessage): HttpHeaders | undefined {
  const out: HttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (
      name === "content-type" ||
      name === "accept" ||
      name === "accept-encoding" ||
      name === "origin" ||
      name === "if-none-match" ||
      name === "if-modified-since" ||
      name.startsWith("access-control-request-")
    ) {
      const values = Array.isArray(value) ? value : [value];
      if (values.some((v) => v.length > MAX_HEADER_VALUE)) return undefined;
      out[name] = value;
    }
  }
  return out;
}

export function createRelay(options: RelayOptions): Server {
  const hubUrl = options.hubUrl.replace(/\/+$/, "");
  const relayHost = options.relayHost ?? "localhost:8080";
  const landSuffix = `.${options.landBaseDomain ?? "localhost:8080"}`;
  const maxClientsPerLand = options.maxClientsPerLand ?? 64;
  const maxHosts = options.maxHosts ?? 1000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  // Sent with every response on a Land host: Lands load only inside the operator's Shells.
  const frameAncestors = `frame-ancestors ${options.shellOrigins?.length ? options.shellOrigins.join(" ") : "'none'"}`;
  const landHeaders = `Content-Security-Policy: ${frameAncestors}\r\nX-Content-Type-Options: nosniff\r\n`;

  const hosts = new Map<number, Host>();
  const landCounters = new Map<number, Counters>();
  let unauthenticated = 0;

  const hostWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: HOST_MAX_PAYLOAD,
  });
  const playerWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: options.playerMaxFrame ?? 16 * 1024,
  });

  /** The Land the request's Host names: `<landId>.<landBaseDomain>`, decimal without leading zeros. */
  function landOf(req: IncomingMessage): number | undefined {
    const host = req.headers.host?.toLowerCase();
    if (!host?.endsWith(landSuffix)) return undefined;
    const label = host.slice(0, -landSuffix.length);
    if (!LAND_ID.test(label)) return undefined;
    const id = Number(label);
    return Number.isSafeInteger(id) ? id : undefined;
  }

  /** A short page for the relay's own answers on a Land host; it names nothing about the Land. */
  function landPage(res: ServerResponse, status: number, message: string) {
    const body = `<!doctype html><meta charset="utf-8"><title>${status}</title><h1>${status} ${STATUS_CODES[status]}</h1><p>${message}</p>`;
    res.writeHead(status, {
      "content-security-policy": frameAncestors,
      "x-content-type-options": "nosniff",
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  /** The Land from the Hub; null when unknown or hidden; undefined when the Hub cannot be reached. */
  async function lookupLand(
    landId: number,
  ): Promise<LandInfo | null | undefined> {
    try {
      const res = await fetch(`${hubUrl}/lands/${landId}`, {
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) return undefined;
      const body = (await res.json()) as Partial<LandInfo>;
      if (body.landId !== landId || !isAddress(String(body.mapServerKey)))
        return undefined;
      return body as LandInfo;
    } catch {
      return undefined;
    }
  }

  function sendControl(host: Host, message: ControlMessage): void {
    host.ws.send(JSON.stringify(message));
  }

  /** Closes a Player connection; `notifyHost` tells the Map server when the relay ends it. */
  function closeSession(
    host: Host,
    session: Session,
    code: number,
    notifyHost: boolean,
  ): void {
    if (!host.streams.delete(session.id)) return;
    if (notifyHost) sendControl(host, { t: "close", stream: session.id, code });
    // A client that cannot drain its buffer will not finish a close handshake either.
    if (session.client.bufferedAmount > CLIENT_BUFFER_LIMIT)
      session.client.terminate();
    else session.client.close(sendableCloseCode(code));
  }

  /** Ends a Player HTTP request early: an error page before the response starts, a cut connection after. */
  function failExchange(
    host: Host,
    id: number,
    exchange: Exchange,
    status: number,
    message: string,
  ): void {
    if (host.requests.get(id) !== exchange) return;
    host.requests.delete(id);
    clearTimeout(exchange.timer);
    if (exchange.responding) exchange.res.destroy();
    else landPage(exchange.res, status, message);
  }

  /** Forgets a host link and closes everything riding on it. Safe to call twice. */
  function dropHost(host: Host): void {
    if (hosts.get(host.landId) === host) hosts.delete(host.landId);
    for (const session of [...host.streams.values()])
      closeSession(host, session, 1001, false);
    for (const [id, exchange] of [...host.requests])
      failExchange(host, id, exchange, 502, "The Land went offline.");
  }

  function closeHost(host: Host, code: number, reason: string): void {
    dropHost(host);
    host.ws.close(code, reason);
  }

  /** Checks a hello (docs/protocols/map-server-hub-relay.md): the statement, then the Land's key at the Hub. */
  async function authenticate(
    landId: number,
    nonce: string,
    hello: unknown,
  ): Promise<Auth> {
    const refused = (reason: string): Auth => ({
      ok: false,
      code: 4401,
      reason,
    });
    let verified;
    try {
      verified = verifyStatement(hello, "relay-host");
    } catch {
      return refused("bad hello statement");
    }
    const { fields, address } = verified;
    if (fields.relay !== relayHost) return refused("hello names another relay");
    if (fields.land !== landId) return refused("hello names another Land");
    if (fields.nonce !== nonce)
      return refused("hello does not answer the challenge");
    const land = await lookupLand(landId);
    if (land === undefined)
      return { ok: false, code: 1013, reason: "Hub unavailable, retry later" };
    if (land === null) return refused("unknown or hidden Land");
    if (address !== land.mapServerKey)
      return refused("signer is not the Land's Map server key");
    return { ok: true, mapServerKey: land.mapServerKey };
  }

  function acceptHost(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    landId: number,
  ): void {
    if (
      unauthenticated >= MAX_UNAUTHENTICATED_HOSTS ||
      (hosts.size >= maxHosts && !hosts.has(landId))
    )
      return rejectUpgrade(socket, 503, "relay is full");
    hostWss.handleUpgrade(req, socket, head, (ws) => onHostLink(ws, landId));
  }

  function onHostLink(ws: WebSocket, landId: number): void {
    const nonce = randomBytes(16).toString("hex");
    let state: "hello" | "verifying" | "ready" = "hello";
    let host: Host | undefined;
    let counted = true;
    unauthenticated++;
    const release = () => {
      if (counted) {
        counted = false;
        unauthenticated--;
      }
    };
    // Refusing a link frees its unauthenticated slot at once; a peer that ignores the close
    // handshake is cut off shortly after instead of holding a socket for 30 s.
    const refuse = (code: number, reason: string) => {
      release();
      ws.close(code, reason);
      setTimeout(() => ws.terminate(), 2_000).unref();
    };
    const helloTimer = setTimeout(
      () => refuse(4408, "hello timeout"),
      HELLO_TIMEOUT_MS,
    );

    ws.on("error", () => {}); // "close" follows
    ws.on("pong", () => {
      if (host) host.unanswered = 0;
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      release();
      if (host) dropHost(host);
    });
    ws.on("message", (data, isBinary) => {
      const frame = rawToBuffer(data);
      if (state !== "ready") {
        // Before ready: one hello, at most 16 KiB, nothing else.
        let hello: ControlMessage | undefined;
        try {
          if (
            state === "hello" &&
            !isBinary &&
            frame.length <= MAX_UNAUTHENTICATED_FRAME
          )
            hello = parseControl(frame.toString("utf8"));
        } catch {
          // refused below
        }
        if (hello?.t !== "hello") return refuse(4401, "expected a hello");
        state = "verifying";
        clearTimeout(helloTimer);
        void authenticate(landId, nonce, hello).then((auth) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!auth.ok) return refuse(auth.code, auth.reason);
          const old = hosts.get(landId);
          if (!old && hosts.size >= maxHosts)
            return refuse(1013, "relay is full");
          if (old) closeHost(old, 4409, "replaced by a newer link");
          let counters = landCounters.get(landId);
          if (!counters) landCounters.set(landId, (counters = newCounters()));
          host = {
            landId,
            mapServerKey: auth.mapServerKey,
            ws,
            counters,
            streams: new Map(),
            requests: new Map(),
            nextId: 1,
            unanswered: 0,
          };
          hosts.set(landId, host);
          release();
          state = "ready";
          sendControl(host, { t: "ready" });
        });
        return;
      }
      try {
        onHostMessage(host!, frame, isBinary);
      } catch {
        refuse(1008, "protocol error");
      }
    });
    ws.send(JSON.stringify({ t: "challenge", nonce }));
  }

  function onHostMessage(host: Host, data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const frame = decodeFrame(data);
      const exchange = host.requests.get(frame.stream);
      if (exchange)
        return onBodyChunk(host, frame.stream, exchange, frame.payload);
      const session = host.streams.get(frame.stream);
      if (!session) return; // closed on our side meanwhile
      if (session.client.bufferedAmount > CLIENT_BUFFER_LIMIT)
        return closeSession(host, session, 1013, true);
      for (const c of [session, host.counters]) {
        c.bytesOut += frame.payload.length;
        c.messagesOut++;
      }
      session.client.send(frame.payload, {
        binary: frame.kind === KIND_BINARY,
      });
      return;
    }
    const message = parseControl(data.toString("utf8"));
    if (message.t === "http-response") onHttpResponse(host, message);
    else if (message.t === "http-end") onHttpEnd(host, message);
    else if (message.t === "close") {
      const session = host.streams.get(message.stream);
      if (session) closeSession(host, session, message.code, false);
    } else throw new Error("unexpected message");
  }

  // An answer for an id that timed out or was dropped meanwhile is ignored, as is a second answer.
  function onHttpResponse(
    host: Host,
    message: Extract<ControlMessage, { t: "http-response" }>,
  ): void {
    const exchange = host.requests.get(message.id);
    if (!exchange || exchange.responding) return;
    const { res } = exchange;
    try {
      const landCsp: string[] = [];
      for (const [name, value] of Object.entries(message.headers)) {
        const lower = name.toLowerCase();
        if (lower === "content-security-policy")
          landCsp.push(...[value].flat());
        else if (isRelayedResponseHeader(lower)) res.setHeader(lower, value);
      }
      // Two headers: browsers enforce both, so a Land can only tighten the policy.
      res.setHeader("content-security-policy", [frameAncestors, ...landCsp]);
      res.setHeader("x-content-type-options", "nosniff");
      res.writeHead(message.status);
    } catch {
      // Invalid status or header values from the Map server.
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      return failExchange(
        host,
        message.id,
        exchange,
        502,
        "Invalid response from the Land.",
      );
    }
    exchange.responding = true;
    exchange.timer.refresh();
  }

  function onBodyChunk(
    host: Host,
    id: number,
    exchange: Exchange,
    payload: Buffer,
  ): void {
    if (!exchange.responding) return; // data before http-response: ignored
    exchange.received += payload.length;
    if (
      exchange.received > HTTP_RESPONSE_LIMIT ||
      exchange.res.writableLength > RESPONSE_BACKLOG_LIMIT
    )
      return failExchange(host, id, exchange, 502, "");
    host.counters.bytesOut += payload.length;
    host.counters.messagesOut++;
    exchange.res.write(payload);
    exchange.timer.refresh();
  }

  function onHttpEnd(
    host: Host,
    message: Extract<ControlMessage, { t: "http-end" }>,
  ): void {
    const exchange = host.requests.get(message.id);
    if (!exchange) return;
    if (!exchange.responding || message.aborted)
      return failExchange(
        host,
        message.id,
        exchange,
        502,
        "Invalid response from the Land.",
      );
    host.requests.delete(message.id);
    clearTimeout(exchange.timer);
    // The exchange no longer counts towards MAX_PENDING_REQUESTS, but up to the backlog limit
    // may still wait for the browser: a browser that reads nothing for this long loses it.
    // ponytail: untested, like the backlog limit: on loopback the kernel buffers several MB, so
    // a test cannot hold a response in the relay; an end-to-end test with a throttled reader can.
    exchange.res.setTimeout(httpTimeoutMs, () => exchange.res.destroy());
    exchange.res.end();
  }

  function acceptPlayer(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    landId: number,
  ): void {
    const path = req.url ?? "/";
    if (!isForwardPath(path))
      return rejectUpgrade(socket, 414, "path not allowed", landHeaders);
    const host = hosts.get(landId);
    if (!host)
      return rejectUpgrade(socket, 503, "Land is offline", landHeaders);
    if (host.streams.size >= maxClientsPerLand)
      return rejectUpgrade(socket, 503, "Land is full", landHeaders);
    playerWss.handleUpgrade(req, socket, head, (client) => {
      client.on("error", () => {}); // "close" follows
      if (hosts.get(landId) !== host)
        return client.close(1001, "Land went offline");
      // ponytail: 32-bit ids wrap after 4 billion ids on one link; a collision needs one that old to be alive
      const session: Session = {
        id: host.nextId,
        client,
        unanswered: 0,
        ...newCounters(),
      };
      host.nextId = (host.nextId + 1) >>> 0;
      host.streams.set(session.id, session);
      sendControl(host, { t: "open", stream: session.id, path });
      client.on("message", (data, isBinary) => {
        const payload = rawToBuffer(data);
        // Bounded buffering towards the Map server: a flood closes the Player, not the link.
        if (host.ws.bufferedAmount > HOST_BUFFER_LIMIT)
          return closeSession(host, session, 1013, true);
        for (const c of [session, host.counters]) {
          c.bytesIn += payload.length;
          c.messagesIn++;
        }
        host.ws.send(
          encodeFrame(session.id, isBinary ? KIND_BINARY : KIND_TEXT, payload),
        );
      });
      client.on("pong", () => (session.unanswered = 0));
      client.on("close", (code) => closeSession(host, session, code, true));
    });
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    landId: number,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    if (!isForwardMethod(method))
      return landPage(res, 405, "Method not allowed.");
    if (!isForwardPath(path)) return landPage(res, 414, "Path not allowed.");
    const headers = forwardedHeaders(req);
    if (!headers) return landPage(res, 431, "Request header too large.");
    const host = hosts.get(landId);
    if (!host) return landPage(res, 503, "This Land is offline.");
    if (host.requests.size >= MAX_PENDING_REQUESTS)
      return landPage(res, 503, "This Land is busy.");
    const declared = Number(req.headers["content-length"] ?? 0);
    const body =
      declared > HTTP_BODY_LIMIT
        ? undefined
        : await readBody(req, HTTP_BODY_LIMIT);
    if (!body) {
      res.setHeader("connection", "close");
      return landPage(res, 413, "Request body too large.");
    }
    if (hosts.get(landId) !== host)
      return landPage(res, 503, "This Land is offline.");
    // again: other requests may have started while this body was read
    if (host.requests.size >= MAX_PENDING_REQUESTS)
      return landPage(res, 503, "This Land is busy.");

    const id = host.nextId;
    host.nextId = (host.nextId + 1) >>> 0;
    const exchange: Exchange = {
      res,
      timer: setTimeout(
        () =>
          failExchange(
            host,
            id,
            exchange,
            504,
            "The Land did not answer in time.",
          ),
        httpTimeoutMs,
      ),
      received: 0,
      responding: false,
    };
    host.requests.set(id, exchange);
    // The browser went away: stop waiting.
    res.on("close", () => {
      if (host.requests.get(id) !== exchange) return;
      host.requests.delete(id);
      clearTimeout(exchange.timer);
    });
    host.counters.bytesIn += body.length;
    host.counters.messagesIn++;
    sendControl(host, {
      t: "http",
      id,
      method,
      path,
      headers,
      body: body.toString("base64"),
    });
  }

  function stats() {
    const lands: Record<string, unknown> = {};
    for (const [landId, counters] of landCounters) {
      const host = hosts.get(landId);
      lands[landId] = {
        online: host !== undefined,
        players: host?.streams.size ?? 0,
        ...counters,
        sessions: [...(host?.streams.values() ?? [])].map(
          ({ id, bytesIn, bytesOut, messagesIn, messagesOut }) => ({
            stream: id,
            bytesIn,
            bytesOut,
            messagesIn,
            messagesOut,
          }),
        ),
      };
    }
    return { hosts: hosts.size, lands };
  }

  const server = createServer((req, res) => {
    const landId = landOf(req);
    let work: Promise<void> | undefined;
    if (landId !== undefined) work = forward(req, res, landId);
    else {
      const { pathname } = splitTarget(req.url ?? "/");
      if (req.method === "GET" && pathname === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      } else if (req.method === "GET" && pathname === "/online")
        sendJson(res, 200, { lands: [...hosts.keys()].sort((a, b) => a - b) });
      else if (req.method === "GET" && pathname === "/stats")
        sendJson(res, 200, stats());
      else sendJson(res, 404, { error: "not found" });
    }
    Promise.resolve(work).catch(() => {
      if (res.headersSent) res.destroy();
      else if (landId !== undefined) landPage(res, 500, "Internal error.");
      else sendJson(res, 500, { error: "internal error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const landId = landOf(req);
    if (landId !== undefined) return acceptPlayer(req, socket, head, landId);
    const parts = splitTarget(req.url ?? "/").pathname.split("/"); // ["", "host", "<id>"]
    if (
      parts[1] === "host" &&
      parts.length === 3 &&
      LAND_ID.test(parts[2] ?? "")
    )
      return acceptHost(req, socket, head, Number(parts[2]));
    rejectUpgrade(socket, 404, "not found");
  });

  // Pings every host link and every Player; two unanswered pings close it.
  const pinger = setInterval(() => {
    for (const host of [...hosts.values()]) {
      if (host.unanswered >= 2) {
        dropHost(host);
        host.ws.terminate();
      } else {
        host.unanswered++;
        host.ws.ping();
      }
      // A Player that vanished without a close frame would otherwise hold its stream forever.
      for (const session of [...host.streams.values()]) {
        if (session.unanswered >= 2) session.client.terminate();
        else {
          session.unanswered++;
          session.client.ping();
        }
      }
    }
  }, options.pingIntervalMs ?? 15_000);

  // The Map server key can change or a Land can be hidden while its link is up. A Hub outage keeps links.
  const rechecker = setInterval(() => {
    for (const host of [...hosts.values()])
      void lookupLand(host.landId).then((land) => {
        if (land === undefined || hosts.get(host.landId) !== host) return;
        if (land === null || land.mapServerKey !== host.mapServerKey)
          closeHost(host, 4403, "Map server key changed or Land hidden");
      });
  }, options.recheckIntervalMs ?? 30_000);

  // Upgraded sockets are not tracked by http.Server, so close() has to end them itself.
  const close = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(pinger);
    clearInterval(rechecker);
    for (const ws of [...hostWss.clients, ...playerWss.clients]) ws.terminate();
    hosts.clear();
    const result = close(callback);
    server.closeAllConnections();
    return result;
  };
  return server;
}
