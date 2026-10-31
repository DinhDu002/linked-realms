// The Land's real-time server: the Land UI's static files over HTTP and the game WebSocket at
// /play (packages/shared/proto/linked_realms/land/v1/land.proto). It is authoritative for
// movement inside this Land only (P1).
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { extname, resolve, sep } from "node:path";
import {
  create,
  fromBinary,
  toBinary,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import {
  gateDirection,
  gateSpawn,
  SERVER_TICK_HZ,
  spawnPosition,
  step,
  type LandMap,
} from "@linked-realms/shared";
import { ArrivalRefused, verifyHandoff } from "@linked-realms/shared/identity";
import {
  ClientMessageSchema,
  ServerMessageSchema,
} from "@linked-realms/shared/land-protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  checkSwitch,
  expired,
  mineState,
  newChallenge,
  SWITCH_EVERY_MS,
  type Challenge,
} from "./mine.ts";
import { NodeRefused, type NodeLink } from "./node.ts";

export const MAX_CHARACTERS = 64;
export const MAX_INPUTS_PER_SECOND = 30;
const HELLO_TIMEOUT_MS = 10_000;
// A hello carries two signed statements with ML-DSA-44 keys and signatures (about 11 KB).
const MAX_FRAME_BYTES = 32 * 1024;
// Connections that have not sent a hello yet also count: a cap on what an anonymous client can hold.
const MAX_CONNECTIONS = 256;
const CLOSE_POLICY = 1008;
// A Character whose connection stops reading is dropped before its queued frames pass this.
const MAX_BUFFERED_BYTES = 1024 * 1024;

export interface LandServerOptions {
  /** The validated map and the text it was parsed from (sent to Land UIs as is). */
  map: LandMap;
  mapText: string;
  /** The address of the Hub's ticket key (HUB_TICKET_SIGNER). */
  hubTicketSigner: string;
  /** Directory of the built Land UI. */
  landUiDir: string;
  /** Milliseconds; tests replace it. */
  now?: () => number;
  /** Tick length; tests shorten it. Movement always steps by the nominal 1/SERVER_TICK_HZ. */
  tickMs?: number;
  /** Unix seconds; tickets issued before it are refused. Defaults to when the server was made. */
  startedAt?: number;
  /** How long a connection may stay silent before its hello; tests shorten it. */
  helloTimeoutMs?: number;
  /** This Map server's own address, which the Land owner's switch must name. */
  mapServerKey: string;
  /** The Land's Node; without one the Mine is unavailable (NODE_ENABLED=false). */
  node?: NodeLink;
}

/** The Land this server serves, as the Hub reports it. Known only after the Hub has created it. */
export interface ServedLand {
  landId: number;
  owner: string;
  ownerName: string;
}

interface CharacterState {
  id: number;
  address: string;
  name: string;
  x: number;
  y: number;
  isOwner: boolean;
  drivenByAi: boolean;
}

type Outgoing = MessageInitShape<typeof ServerMessageSchema>["message"];

interface Session {
  id: number;
  socket: WebSocket;
  character: CharacterState;
  dx: number;
  dy: number;
  /** The newest Input seq received, and the newest one a Moved has told the Character about. */
  seq: number;
  ackedSeq: number;
  windowStart: number;
  windowCount: number;
  /** The Land owner's sessions only: the challenge their next switch must carry. */
  challenge?: Challenge;
  /** When the last switch was taken (milliseconds), and whether it is still with the Node. */
  switchedAt: number;
  switching: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};

const serialize = (message: Outgoing): Uint8Array =>
  toBinary(ServerMessageSchema, create(ServerMessageSchema, { message }));

export function createLandServer(options: LandServerOptions) {
  const { map, mapText, hubTicketSigner, mapServerKey, node } = options;
  const now = options.now ?? Date.now;
  const tickMs = options.tickMs ?? 1000 / SERVER_TICK_HZ;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const startedAt = options.startedAt ?? Math.floor(now() / 1000);
  const uiRoot = resolve(options.landUiDir);

  let land: ServedLand | undefined;
  let nextId = 1;
  const sessions = new Map<WebSocket, Session>();
  const byAddress = new Set<string>();
  const timers = new Map<WebSocket, NodeJS.Timeout>();
  // Ticket nonces already accepted, with their expiry (Unix seconds): an expired ticket is
  // refused anyway, so a nonce can be forgotten then.
  const usedNonces = new Map<string, number>();

  const send = (socket: WebSocket, message: Outgoing) => {
    // ponytail: untested, a stalled reader cannot be built reliably on loopback (the kernel
    // buffers several MB); behind the relay its pings drop dead links anyway
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return socket.terminate();
    socket.send(serialize(message));
  };
  const refuse = (socket: WebSocket, code: string, message: string) => {
    if (socket.readyState !== socket.OPEN) return;
    send(socket, { case: "error", value: { code, message } });
    socket.close(CLOSE_POLICY, code);
  };

  const sendMine = (session: Session) =>
    send(session.socket, {
      case: "mineState",
      value: mineState(
        node,
        session.challenge && {
          challenge: session.challenge.nonce,
          mapServerKey,
        },
      ),
    });
  node?.onChange(() => {
    for (const session of sessions.values()) sendMine(session);
  });
  node?.onWon((found) => {
    for (const session of sessions.values())
      send(session.socket, {
        case: "mineWon",
        value: {
          height: BigInt(found.height),
          reward: found.reward,
          rewardAddress: found.rewardAddress,
        },
      });
  });

  function isUsed(nonce: string, nowSeconds: number): boolean {
    for (const [used, expires] of usedNonces)
      if (expires <= nowSeconds) usedNonces.delete(used);
    return usedNonces.has(nonce);
  }

  function onHello(
    socket: WebSocket,
    hello: { ticket?: unknown; arrival?: unknown },
  ) {
    if (!land) return refuse(socket, "unavailable", "this Land is not ready");
    const nowSeconds = Math.floor(now() / 1000);
    let verified;
    try {
      verified = verifyHandoff(
        { ticket: hello.ticket, arrival: hello.arrival },
        {
          landId: land.landId,
          hubTicketSigner,
          startedAt,
          now: nowSeconds,
          isUsed: (nonce) => isUsed(nonce, nowSeconds),
        },
      );
    } catch (error) {
      if (error instanceof ArrivalRefused)
        return refuse(socket, error.code, error.message);
      console.error("arrival check failed:", error);
      return refuse(socket, "bad-ticket", "could not verify the arrival");
    }
    // Everything below is synchronous, so two hellos with one ticket cannot both pass.
    const { ticket, arrival } = verified;
    if (byAddress.has(ticket.character))
      return refuse(socket, "duplicate", "already in this Land");
    if (sessions.size >= MAX_CHARACTERS)
      return refuse(socket, "full", "this Land is full");
    usedNonces.set(ticket.nonce, ticket.expires);

    const direction = gateDirection(ticket.gate);
    const spawn = direction ? gateSpawn(map, direction) : spawnPosition(map);
    const character: CharacterState = {
      id: nextId++,
      address: ticket.character,
      name: ticket.name,
      x: spawn.x,
      y: spawn.y,
      isOwner: ticket.character === land.owner,
      drivenByAi: arrival.drivenByAi,
    };
    const session: Session = {
      id: character.id,
      socket,
      character,
      dx: 0,
      dy: 0,
      seq: 0,
      ackedSeq: 0,
      windowStart: 0,
      windowCount: 0,
      challenge: character.isOwner ? newChallenge(nowSeconds) : undefined,
      switchedAt: -Infinity,
      switching: false,
    };
    for (const other of sessions.values())
      send(other.socket, { case: "joined", value: character });
    sessions.set(socket, session);
    byAddress.add(ticket.character);
    send(socket, {
      case: "welcome",
      value: {
        you: character.id,
        land: {
          landId: BigInt(land.landId),
          owner: land.owner,
          ownerName: land.ownerName,
        },
        map: mapText,
        characters: [...sessions.values()].map((s) => s.character),
      },
    });
    sendMine(session);
  }

  /** "Checks, in order" (map-server-node.md) on a switch, answered with a MineSwitchResult. */
  async function onMineSwitch(session: Session, signed: unknown) {
    const answer = (ok: boolean, code = "") =>
      send(session.socket, { case: "mineSwitchResult", value: { ok, code } });
    const nowMs = now();
    if (session.switching || nowMs - session.switchedAt < SWITCH_EVERY_MS)
      return answer(false, "rate-limited");
    session.switchedAt = nowMs;
    if (!session.character.isOwner || !land) return answer(false, "not-owner");
    const nowSeconds = Math.floor(nowMs / 1000);
    const checked = checkSwitch(signed, {
      landId: land.landId,
      owner: land.owner,
      mapServerKey,
      nowSeconds,
      challenge: session.challenge,
    });
    if ("refused" in checked) return answer(false, checked.refused);
    // Spent: a fresh challenge at once.
    session.challenge = newChallenge(nowSeconds);
    sendMine(session);
    const { on, threads } = checked.switch;
    const info = node?.info();
    if (!node || !info) return answer(false, "unavailable");
    if (on && threads > info.maxThreads) return answer(false, "bad-threads");
    session.switching = true;
    try {
      await (on ? node.start(land.owner, threads) : node.stop());
      answer(true);
    } catch (error) {
      const refused = error instanceof NodeRefused && error.message;
      answer(false, refused === "bad-threads" ? refused : "unavailable");
    } finally {
      session.switching = false;
    }
  }

  function onInput(
    socket: WebSocket,
    session: Session,
    input: { dx: number; dy: number; seq: number },
  ) {
    const nowMs = now();
    if (nowMs - session.windowStart >= 1000) {
      session.windowStart = nowMs;
      session.windowCount = 0;
    }
    if (++session.windowCount > MAX_INPUTS_PER_SECOND)
      return refuse(socket, "rate-limited", "too many inputs");
    if (![-1, 0, 1].includes(input.dx) || ![-1, 0, 1].includes(input.dy))
      return refuse(socket, "bad-message", "dx and dy must be -1, 0 or 1");
    session.dx = input.dx;
    session.dy = input.dy;
    session.seq = input.seq;
  }

  function onMessage(socket: WebSocket, data: RawData, isBinary: boolean) {
    if (socket.readyState !== socket.OPEN) return;
    let message;
    try {
      if (!isBinary) throw new Error("text frame");
      message = fromBinary(ClientMessageSchema, data as Buffer).message;
    } catch {
      return refuse(
        socket,
        "bad-message",
        "frames are binary protobuf messages",
      );
    }
    const session = sessions.get(socket);
    if (message.case === "hello" && !session) {
      clearTimeout(timers.get(socket));
      return onHello(socket, message.value);
    }
    if (message.case === "input" && session)
      return onInput(socket, session, message.value);
    if (message.case === "mineSwitch" && session)
      return void onMineSwitch(session, message.value.signed).catch(
        (error: unknown) => console.error("Mine switch failed:", error),
      );
    refuse(socket, "bad-message", "unexpected message");
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
  });
  wss.on("connection", (socket) => {
    timers.set(
      socket,
      setTimeout(
        () => refuse(socket, "bad-message", "no hello within 10 seconds"),
        helloTimeoutMs,
      ),
    );
    socket.on("message", (data, isBinary) => onMessage(socket, data, isBinary));
    socket.on("error", () => {}); // 'close' follows
    socket.on("close", () => {
      clearTimeout(timers.get(socket));
      timers.delete(socket);
      const session = sessions.get(socket);
      if (!session) return;
      sessions.delete(socket);
      byAddress.delete(session.character.address);
      for (const other of sessions.values())
        send(other.socket, { case: "left", value: { id: session.id } });
    });
  });

  function tick() {
    const nowSeconds = Math.floor(now() / 1000);
    for (const session of sessions.values())
      if (session.challenge && expired(session.challenge, nowSeconds)) {
        session.challenge = newChallenge(nowSeconds);
        sendMine(session);
      }
    const moved = new Set<Session>();
    for (const session of sessions.values()) {
      if (session.dx === 0 && session.dy === 0) continue;
      const { character } = session;
      const next = step(
        map,
        { x: character.x, y: character.y },
        {
          up: session.dy < 0,
          down: session.dy > 0,
          left: session.dx < 0,
          right: session.dx > 0,
        },
        1000 / SERVER_TICK_HZ,
      );
      if (next.x !== character.x || next.y !== character.y) {
        character.x = next.x;
        character.y = next.y;
        moved.add(session);
      }
    }
    const positions = [...moved].map((s) => ({
      id: s.id,
      x: s.character.x,
      y: s.character.y,
    }));
    for (const session of sessions.values()) {
      // A Character that is blocked still learns that its Input was applied.
      if (positions.length === 0 && session.seq === session.ackedSeq) continue;
      session.ackedSeq = session.seq;
      send(session.socket, {
        case: "moved",
        value: { positions, seq: session.seq },
      });
    }
  }
  const ticker = setInterval(tick, tickMs);

  async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const plain = (status: number, text: string, headers = {}) => {
      response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        ...headers,
      });
      response.end(text);
    };
    if (request.method !== "GET" && request.method !== "HEAD")
      return plain(405, "method not allowed", { allow: "GET, HEAD" });
    let pathname: string;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://x").pathname,
      );
    } catch {
      return plain(404, "not found");
    }
    if (pathname === "/") pathname = "/index.html";
    // No dotfiles, no NUL, no backslashes; then the resolved path must stay inside the root.
    const file = resolve(uiRoot, `.${pathname}`);
    if (
      pathname.includes("\0") ||
      pathname.includes("\\") ||
      pathname.split("/").some((part) => part.startsWith(".")) ||
      !file.startsWith(uiRoot + sep)
    )
      return plain(404, "not found");
    // ponytail: symlinks inside LAND_UI_DIR are followed; the directory is the operator's own.
    let info;
    try {
      info = await stat(file);
    } catch {
      const rootExists = await stat(uiRoot).then(
        () => true,
        () => false,
      );
      return rootExists
        ? plain(404, "not found")
        : plain(503, "the Land UI is not built");
    }
    if (!info.isFile()) return plain(404, "not found");
    const etag = `W/"${createHash("sha1").update(`${info.size}-${info.mtimeMs}`).digest("hex").slice(0, 16)}"`;
    const immutable = pathname.startsWith("/assets/");
    const headers = {
      "content-type":
        CONTENT_TYPES[extname(file).toLowerCase()] ??
        "application/octet-stream",
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      etag,
      "x-content-type-options": "nosniff",
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      return void response.end();
    }
    response.writeHead(200, { ...headers, "content-length": info.size });
    if (request.method === "HEAD") return void response.end();
    // pipeline, not pipe: a browser that goes away mid-file must close the file too
    pipeline(createReadStream(file), response, () => {});
  }

  const http = createHttpServer((request, response) => {
    serveStatic(request, response).catch((error: unknown) => {
      console.error("static file failed:", error);
      response.destroy();
    });
  });
  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head) => {
    const reject = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://x").pathname;
    } catch {
      return reject("400 Bad Request");
    }
    if (pathname !== "/play") return reject("404 Not Found");
    if (wss.clients.size >= MAX_CONNECTIONS)
      return reject("503 Service Unavailable");
    wss.handleUpgrade(request, socket, head, (ws) =>
      wss.emit("connection", ws, request),
    );
  });

  return {
    /** Sets the Land to serve; until then every hello is refused. */
    setLand(served: ServedLand): void {
      land = served;
    },
    listen(port: number, host: string): Promise<number> {
      return new Promise((resolveListen, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolveListen((http.address() as AddressInfo).port);
        });
      });
    },
    async close(): Promise<void> {
      clearInterval(ticker);
      for (const timer of timers.values()) clearTimeout(timer);
      for (const client of wss.clients) client.close(1001, "shutting down");
      wss.close();
      await new Promise<void>((resolveClose) => {
        http.close(() => resolveClose());
        http.closeAllConnections();
      });
    },
  };
}

export type LandServer = ReturnType<typeof createLandServer>;
