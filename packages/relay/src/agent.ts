// The Map server's side of the host link: one outbound WebSocket to the relay that carries
// Player HTTP requests and WebSockets to the local Map server (node:http + ws) on 127.0.0.1.
import { request as httpRequest, type ClientRequest } from "node:http";
import type { Key } from "@linked-realms/core";
import { signStatement } from "@linked-realms/shared/identity";
import { WebSocket } from "ws";
import {
  HOST_MAX_PAYLOAD,
  HTTP_CHUNK,
  HTTP_RESPONSE_LIMIT,
  KIND_BINARY,
  KIND_TEXT,
  MAX_DATA_PAYLOAD,
  MAX_HEADER_VALUE,
  decodeFrame,
  encodeFrame,
  isRelayedResponseHeader,
  parseControl,
  rawToBuffer,
  sendableCloseCode,
  type ControlMessage,
  type HttpHeaders,
} from "./protocol.ts";

export interface HostOptions {
  /** Relay base URL: ws:// or wss://, no path. */
  relayUrl: string;
  landId: number;
  /** The Map server key: the only key a Map server uses to identify itself (P2). */
  mapServerKey: Key;
  /** Port of the local Map server on 127.0.0.1. */
  localPort: number;
  log: (message: string) => void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// The relay pings every 15 s; a link that hears nothing for three intervals is dead.
const LIVENESS_MS = 45_000;
const HTTP_TIMEOUT_MS = 25_000;
/** Pause reading a local response while this much waits to be sent to the relay. */
const MAX_QUEUED_LINK_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024;
const CLOSE_CODE_REPLACED = 4409;

interface LocalStream {
  ws: WebSocket;
  /** Player frames that arrive before the local socket is open. */
  queue: Array<{ payload: Buffer; binary: boolean }>;
  queued: number;
}

function parseRelayUrl(relayUrl: string): URL {
  const url = new URL(relayUrl);
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`relayUrl must be a ws(s):// base URL, got "${relayUrl}"`);
  return url;
}

/** Links this Map server to the relay and keeps it linked (backoff 1 s doubling to 30 s) until closed. */
export function connectHost(options: HostOptions): {
  close(): Promise<void>;
} {
  const { landId, localPort, log, mapServerKey } = options;
  const relay = parseRelayUrl(options.relayUrl);
  const url = `${relay.origin}/host/${landId}`;
  let closed = false;
  let current: WebSocket | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let backoff = INITIAL_BACKOFF_MS;

  function connect(): void {
    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: HOST_MAX_PAYLOAD,
      handshakeTimeout: 10_000,
    });
    current = ws;
    const streams = new Map<number, LocalStream>();
    const requests = new Set<ClientRequest>();
    let liveness: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(liveness);
      liveness = setTimeout(() => ws.terminate(), LIVENESS_MS);
    };

    const send = (message: ControlMessage) => ws.send(JSON.stringify(message));

    function openStream(id: number, path: string): void {
      const ws2 = new WebSocket(`ws://127.0.0.1:${localPort}${path}`, {
        perMessageDeflate: false,
        maxPayload: MAX_DATA_PAYLOAD,
      });
      const stream: LocalStream = { ws: ws2, queue: [], queued: 0 };
      streams.get(id)?.ws.terminate();
      streams.set(id, stream);
      ws2.on("open", () => {
        for (const { payload, binary } of stream.queue)
          ws2.send(payload, { binary });
        stream.queue = [];
      });
      ws2.on("message", (data, isBinary) =>
        ws.send(
          encodeFrame(
            id,
            isBinary ? KIND_BINARY : KIND_TEXT,
            rawToBuffer(data),
          ),
        ),
      );
      ws2.on("error", () => {}); // "close" follows
      ws2.on("close", (code) => {
        if (streams.get(id) !== stream) return;
        streams.delete(id);
        send({ t: "close", stream: id, code: sendableCloseCode(code) });
      });
    }

    function onFrame(frame: Buffer): void {
      const { stream: id, kind, payload } = decodeFrame(frame);
      const stream = streams.get(id);
      if (!stream) return;
      const binary = kind === KIND_BINARY;
      if (stream.ws.readyState === WebSocket.OPEN)
        stream.ws.send(payload, { binary });
      else if (stream.ws.readyState === WebSocket.CONNECTING) {
        stream.queued += payload.length;
        if (stream.queued > MAX_QUEUED_BYTES) return stream.ws.terminate();
        stream.queue.push({ payload, binary });
      }
    }

    function forward(message: Extract<ControlMessage, { t: "http" }>): void {
      const { id } = message;
      let started = false;
      let done = false;
      const sendData = (payload: Buffer, written?: () => void) =>
        ws.send(encodeFrame(id, KIND_BINARY, payload), () => written?.());
      const end = (aborted = false) => {
        if (done) return;
        done = true;
        if (ws.readyState === WebSocket.OPEN)
          send(
            aborted
              ? { t: "http-end", id, aborted: true }
              : { t: "http-end", id },
          );
      };
      // A failure before the response starts becomes a 502; after it, the body is cut off.
      const fail = (error: string) => {
        if (done || ws.readyState !== WebSocket.OPEN) return;
        if (started) return end(true);
        started = true;
        send({
          t: "http-response",
          id,
          status: 502,
          headers: { "content-type": "application/json" },
        });
        sendData(Buffer.from(JSON.stringify({ error })));
        end();
      };

      const body = Buffer.from(message.body, "base64");
      // The relay already limits headers; the agent still never lets a header redefine the framing.
      const headers: HttpHeaders = {};
      for (const [name, value] of Object.entries(message.headers)) {
        const lower = name.toLowerCase();
        if (
          ![
            "host",
            "content-length",
            "transfer-encoding",
            "connection",
            "upgrade",
          ].includes(lower)
        )
          headers[lower] = value;
      }
      headers["content-length"] = String(body.length);
      let req: ClientRequest;
      try {
        req = httpRequest(
          {
            host: "127.0.0.1",
            port: localPort,
            method: message.method,
            path: message.path,
            headers,
          },
          (res) => {
            const out: HttpHeaders = {};
            for (const [name, value] of Object.entries(res.headers))
              if (
                value !== undefined &&
                (isRelayedResponseHeader(name) ||
                  name === "content-security-policy") &&
                [value].flat().every((v) => v.length <= MAX_HEADER_VALUE)
              )
                out[name] = value;
            started = true;
            send({
              t: "http-response",
              id,
              status: res.statusCode ?? 502,
              headers: out,
            });
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              if (done || ws.readyState !== WebSocket.OPEN) return;
              size += chunk.length;
              if (size > HTTP_RESPONSE_LIMIT) {
                req.destroy();
                return end(true);
              }
              // Do not read faster than the relay link drains: resume once the last slice is written.
              const slow = ws.bufferedAmount > MAX_QUEUED_LINK_BYTES;
              if (slow) res.pause();
              for (let at = 0; at < chunk.length; at += HTTP_CHUNK) {
                const last = at + HTTP_CHUNK >= chunk.length;
                sendData(
                  chunk.subarray(at, at + HTTP_CHUNK),
                  slow && last ? () => res.resume() : undefined,
                );
              }
            });
            res.on("end", () => end());
            res.on("error", () => end(true));
          },
        );
      } catch {
        return fail("bad request for the Map server");
      }
      requests.add(req);
      req.on("close", () => requests.delete(req));
      req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy());
      req.on("error", () => fail("Map server unreachable"));
      req.end(body);
    }

    function onControl(message: ControlMessage): void {
      switch (message.t) {
        case "challenge":
          send({
            t: "hello",
            ...signStatement(
              "relay-host",
              { relay: relay.host, land: landId, nonce: message.nonce },
              mapServerKey,
            ),
          });
          break;
        case "ready":
          backoff = INITIAL_BACKOFF_MS;
          log(`linked to the relay as Land ${landId}`);
          break;
        case "open":
          openStream(message.stream, message.path);
          break;
        case "close":
          streams
            .get(message.stream)
            ?.ws.close(sendableCloseCode(message.code));
          break;
        case "http":
          forward(message);
          break;
        default:
          throw new Error(`unexpected ${message.t}`);
      }
    }

    ws.on("open", arm);
    ws.on("ping", arm);
    ws.on("error", (error) => log(`relay link error: ${error.message}`));
    ws.on("message", (data, isBinary) => {
      try {
        const buffer = rawToBuffer(data);
        if (isBinary) onFrame(buffer);
        else onControl(parseControl(buffer.toString("utf8")));
      } catch (error) {
        log(
          `relay protocol error: ${error instanceof Error ? error.message : error}`,
        );
        ws.close(1008, "protocol error");
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(liveness);
      for (const stream of streams.values()) stream.ws.terminate();
      for (const req of requests) req.destroy();
      if (closed) return;
      // A newer link took the Land: do not fight it at full speed. Otherwise `backoff` is back
      // at its start once a link got `ready`, and doubles only across failed attempts.
      const delay = code === CLOSE_CODE_REPLACED ? MAX_BACKOFF_MS : backoff;
      log(
        `relay link closed (${code} ${reason.toString()}); retrying in ${delay / 1000} s`,
      );
      backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
      // Jitter: every Map server drops at once when the relay restarts; they must not return in lockstep.
      retryTimer = setTimeout(connect, delay * (0.5 + Math.random() / 2));
    });
  }

  connect();

  return {
    async close() {
      closed = true;
      clearTimeout(retryTimer);
      const ws = current;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => ws.terminate(), 2_000);
        ws.once("close", () => {
          clearTimeout(force);
          resolve();
        });
        ws.close(1000);
      });
    },
  };
}
