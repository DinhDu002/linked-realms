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
import {
  isAddress,
  isAddressEqual,
  recoverMessageAddress,
  type Address,
} from "viem";
import { WebSocket, WebSocketServer } from "ws";
import {
  HOST_MAX_PAYLOAD,
  KIND_BINARY,
  MAX_HEADER_VALUE,
  KIND_TEXT,
  decodeFrame,
  encodeFrame,
  hostHelloMessage,
  isForwardMethod,
  isForwardPath,
  parseControl,
  rawToBuffer,
  sendableCloseCode,
  type ControlMessage,
  type HttpHeaders,
} from "./protocol.ts";

export interface RelayOptions {
  /** hub-api base URL; the relay reads Delegations from `<hubUrl>/directory/<landId>`. */
  hubUrl: string;
  maxClientsPerLand?: number;
  maxHosts?: number;
  /** Timings, overridable for tests. */
  pingIntervalMs?: number;
  recheckIntervalMs?: number;
  httpTimeoutMs?: number;
}

// Frames from a Player are capped above Colyseus's 4,096-byte maxPayload (PLAN.md 3.5 rule 7).
const PLAYER_MAX_PAYLOAD = 16 * 1024;
const CLIENT_BUFFER_LIMIT = 1024 * 1024;
const HOST_BUFFER_LIMIT = 4 * 1024 * 1024;
const HTTP_BODY_LIMIT = 64 * 1024;
const HELLO_TIMEOUT_MS = 10_000;
const HUB_TIMEOUT_MS = 5_000;
/** Host links that have connected but not yet authenticated. */
const MAX_UNAUTHENTICATED_HOSTS = 100;
const MAX_PENDING_REQUESTS = 256;

// Only these Map server response headers are relayed. A Map server is not trusted: no cookies,
// redirects or framing headers. Colyseus needs the content type and its CORS headers.
const RELAYED_RESPONSE_HEADERS =
  /^(?:content-type|cache-control|vary|retry-after|access-control-[a-z-]+)$/;

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

type HttpOutcome =
  Extract<ControlMessage, { t: "http-response" }> | "timeout" | "dropped";

interface Host {
  landId: number;
  miningKey: Address;
  ws: WebSocket;
  counters: Counters;
  streams: Map<number, Session>;
  requests: Map<number, (outcome: HttpOutcome) => void>;
  nextStream: number;
  nextRequest: number;
  unanswered: number;
}

type Auth =
  | { ok: true; miningKey: Address }
  | { ok: false; code: number; reason: string };

const LAND_ID = /^(?:0|[1-9]\d{0,14})$/;
const ROOM_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function splitTarget(url: string): { pathname: string; search: string } {
  const q = url.indexOf("?");
  return q < 0
    ? { pathname: url, search: "" }
    : { pathname: url.slice(0, q), search: url.slice(q) };
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\n` +
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

/** The request headers a Map server may see; undefined when one is too large for the host link. Authorization is never forwarded: it would hand a Hub session to a Map server. */
function forwardedHeaders(req: IncomingMessage): HttpHeaders | undefined {
  const out: HttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (
      name === "content-type" ||
      name === "accept" ||
      name === "origin" ||
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
  const maxClientsPerLand = options.maxClientsPerLand ?? 64;
  const maxHosts = options.maxHosts ?? 1000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;

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
    maxPayload: PLAYER_MAX_PAYLOAD,
  });

  /** The Delegation's Mining key; null when the Land is not in the Directory (unknown or hidden); undefined when the Hub cannot be reached. */
  async function lookupMiningKey(
    landId: number,
  ): Promise<Address | null | undefined> {
    try {
      const res = await fetch(`${hubUrl}/directory/${landId}`, {
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      });
      if (res.status === 404) return null;
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        landId?: unknown;
        miningKey?: unknown;
      };
      if (
        body.landId !== landId ||
        typeof body.miningKey !== "string" ||
        !isAddress(body.miningKey, { strict: false })
      )
        return undefined;
      return body.miningKey;
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

  /** Forgets a host link and closes everything riding on it. Safe to call twice. */
  function dropHost(host: Host): void {
    if (hosts.get(host.landId) === host) hosts.delete(host.landId);
    for (const session of [...host.streams.values()])
      closeSession(host, session, 1001, false);
    for (const settle of [...host.requests.values()]) settle("dropped");
  }

  function closeHost(host: Host, code: number, reason: string): void {
    dropHost(host);
    host.ws.close(code, reason);
  }

  async function authenticate(
    landId: number,
    nonce: string,
    signature: `0x${string}`,
  ): Promise<Auth> {
    let signer: Address;
    try {
      signer = await recoverMessageAddress({
        message: hostHelloMessage(landId, nonce),
        signature,
      });
    } catch {
      return { ok: false, code: 4401, reason: "bad signature" };
    }
    const key = await lookupMiningKey(landId);
    if (key === undefined)
      return { ok: false, code: 1013, reason: "Hub unavailable, retry later" };
    if (key === null)
      return {
        ok: false,
        code: 4404,
        reason: "Land is not in the Directory (unknown or hidden)",
      };
    if (!isAddressEqual(signer, key))
      return {
        ok: false,
        code: 4403,
        reason: "signer is not the Land's delegated Mining key",
      };
    return { ok: true, miningKey: key };
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
      try {
        if (state === "hello") {
          const hello = isBinary
            ? undefined
            : parseControl(rawToBuffer(data).toString("utf8"));
          if (hello?.t !== "hello") throw new Error("expected hello");
          state = "verifying";
          clearTimeout(helloTimer);
          void authenticate(
            landId,
            nonce,
            hello.signature as `0x${string}`,
          ).then((auth) => {
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
              miningKey: auth.miningKey,
              ws,
              counters,
              streams: new Map(),
              requests: new Map(),
              nextStream: 1,
              nextRequest: 1,
              unanswered: 0,
            };
            hosts.set(landId, host);
            release();
            state = "ready";
            sendControl(host, { t: "ready" });
          });
        } else if (host) {
          onHostMessage(host, rawToBuffer(data), isBinary);
        } else throw new Error("not authenticated yet");
      } catch {
        refuse(1008, "protocol error");
      }
    });
    ws.send(JSON.stringify({ t: "challenge", nonce }));
  }

  function onHostMessage(host: Host, data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      const frame = decodeFrame(data);
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
    if (message.t === "http-response") host.requests.get(message.id)?.(message);
    else if (message.t === "close") {
      const session = host.streams.get(message.stream);
      if (session) closeSession(host, session, message.code, false);
    } else throw new Error("unexpected message");
  }

  function acceptPlayer(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    landId: number,
    path: string,
  ): void {
    if (!isForwardPath(path))
      return rejectUpgrade(socket, 414, "path not allowed");
    const host = hosts.get(landId);
    if (!host) return rejectUpgrade(socket, 503, "Land is offline");
    if (host.streams.size >= maxClientsPerLand)
      return rejectUpgrade(socket, 503, "Land is full");
    playerWss.handleUpgrade(req, socket, head, (client) => {
      client.on("error", () => {}); // "close" follows
      if (hosts.get(landId) !== host)
        return client.close(1001, "Land went offline");
      // ponytail: 32-bit ids wrap after 4 billion streams on one link; a collision needs one that old to be alive
      const session: Session = {
        id: host.nextStream,
        client,
        unanswered: 0,
        ...newCounters(),
      };
      host.nextStream = (host.nextStream + 1) >>> 0;
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
    path: string,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (!isForwardMethod(method))
      return sendJson(res, 405, { error: "method not allowed" });
    if (!isForwardPath(path))
      return sendJson(res, 414, { error: "path not allowed" });
    const headers = forwardedHeaders(req);
    if (!headers)
      return sendJson(res, 431, { error: "request header too large" });
    const host = hosts.get(landId);
    if (!host) return sendJson(res, 503, { error: "Land is offline" });
    if (host.requests.size >= MAX_PENDING_REQUESTS)
      return sendJson(res, 503, { error: "Land is busy" });
    const declared = Number(req.headers["content-length"] ?? 0);
    const body =
      declared > HTTP_BODY_LIMIT
        ? undefined
        : await readBody(req, HTTP_BODY_LIMIT);
    if (!body) {
      res.setHeader("connection", "close");
      return sendJson(res, 413, { error: "request body too large" });
    }
    if (hosts.get(landId) !== host)
      return sendJson(res, 503, { error: "Land is offline" });

    const id = host.nextRequest++;
    const outcome = await new Promise<HttpOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), httpTimeoutMs);
      const settle = (result: HttpOutcome) => {
        clearTimeout(timer);
        host.requests.delete(id);
        resolve(result);
      };
      host.requests.set(id, settle);
      sendControl(host, {
        t: "http",
        id,
        method,
        path,
        headers,
        body: body.toString("base64"),
      });
    });
    if (outcome === "timeout")
      return sendJson(res, 504, { error: "Map server timed out" });
    if (outcome === "dropped")
      return sendJson(res, 502, { error: "Land went offline" });

    const payload = Buffer.from(outcome.body, "base64");
    host.counters.bytesIn += body.length;
    host.counters.messagesIn++;
    host.counters.bytesOut += payload.length;
    host.counters.messagesOut++;
    try {
      for (const [name, value] of Object.entries(outcome.headers))
        if (RELAYED_RESPONSE_HEADERS.test(name.toLowerCase()))
          res.setHeader(name, value);
      res.setHeader("x-content-type-options", "nosniff");
      // Whatever a Map server returns must never run as a page on the relay's origin.
      res.setHeader("content-security-policy", "sandbox; default-src 'none'");
      res.setHeader("content-length", payload.length);
      res.writeHead(outcome.status);
    } catch {
      // Invalid status or header values from the Map server.
      for (const name of res.getHeaderNames()) res.removeHeader(name);
      return sendJson(res, 502, {
        error: "invalid response from the Map server",
      });
    }
    res.end(payload);
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
    const { pathname, search } = splitTarget(req.url ?? "/");
    const land = /^\/land\/((?:0|[1-9]\d{0,14}))(\/.*)?$/.exec(pathname);
    let work: Promise<void> | undefined;
    if (land)
      work = forward(req, res, Number(land[1]), (land[2] ?? "/") + search);
    else if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    } else if (req.method === "GET" && pathname === "/online")
      sendJson(res, 200, { lands: [...hosts.keys()].sort((a, b) => a - b) });
    else if (req.method === "GET" && pathname === "/stats")
      sendJson(res, 200, stats());
    else sendJson(res, 404, { error: "not found" });
    Promise.resolve(work).catch(() => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: "internal error" });
    });
  });

  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const { pathname, search } = splitTarget(req.url ?? "/");
    const parts = pathname.split("/"); // ["", "host", "<id>"] or ["", "land", "<id>", process, room]
    if (
      parts[1] === "host" &&
      parts.length === 3 &&
      LAND_ID.test(parts[2] ?? "")
    )
      return acceptHost(req, socket, head, Number(parts[2]));
    if (
      parts[1] === "land" &&
      parts.length === 5 &&
      LAND_ID.test(parts[2] ?? "") &&
      ROOM_SEGMENT.test(parts[3] ?? "") &&
      ROOM_SEGMENT.test(parts[4] ?? "")
    )
      return acceptPlayer(
        req,
        socket,
        head,
        Number(parts[2]),
        `/${parts[3]}/${parts[4]}${search}`,
      );
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

  // A Delegation can change or a Land can be hidden while its link is up. A Hub outage keeps links.
  const rechecker = setInterval(() => {
    for (const host of [...hosts.values()])
      void lookupMiningKey(host.landId).then((key) => {
        if (key === undefined || hosts.get(host.landId) !== host) return;
        if (key === null || !isAddressEqual(key, host.miningKey))
          closeHost(host, 4403, "Delegation changed or Land hidden");
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
