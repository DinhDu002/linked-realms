// The host link protocol shared by the relay and the agent. Control messages are JSON text
// frames; data frames are binary: 4-byte big-endian stream id, 1 byte kind, payload.
import type { RawData } from "ws";

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

/** Largest frame on a host link (control or data). */
export const HOST_MAX_PAYLOAD = 1024 * 1024;
/** Frame header: stream id (4 bytes) and kind (1 byte). */
const FRAME_HEADER = 5;
/** Largest data payload that still fits one host link frame. */
export const MAX_DATA_PAYLOAD = HOST_MAX_PAYLOAD - FRAME_HEADER;

export const KIND_BINARY = 0;
export const KIND_TEXT = 1;

export type HttpHeaders = Record<string, string | string[]>;

export type ControlMessage =
  | { t: "challenge"; nonce: string }
  | { t: "hello"; signature: string }
  | { t: "ready" }
  | {
      t: "http";
      id: number;
      method: string;
      path: string;
      headers: HttpHeaders;
      body: string;
    }
  | {
      t: "http-response";
      id: number;
      status: number;
      headers: HttpHeaders;
      body: string;
    }
  | { t: "open"; stream: number; path: string }
  | { t: "close"; stream: number; code: number };

/** The message a Map server signs (EIP-191) with its Mining key to prove which Land it hosts. */
export function hostHelloMessage(landId: number, nonce: string): string {
  return `linked-realms relay: host Land ${landId}\nNonce: ${nonce}`;
}

/** Path and query of a forwarded request: printable ASCII, no spaces, starts with "/". */
export function isForwardPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 2048 &&
    /^\/[\x21-\x7e]*$/.test(path)
  );
}

const METHOD = /^[A-Z]{3,7}$/;
/** The longest header value the other end of a host link accepts. */
export const MAX_HEADER_VALUE = 8192;

/** Whether `parseControl` accepts this method; the relay checks before forwarding Player input. */
export function isForwardMethod(method: unknown): method is string {
  return typeof method === "string" && METHOD.test(method);
}

/** A close code that may be sent on the wire (RFC 6455); anything else becomes 1011. */
export function sendableCloseCode(code: number): number {
  const ok =
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999);
  return ok ? code : 1011;
}

export function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export function encodeFrame(
  stream: number,
  kind: number,
  payload: Uint8Array,
): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER + payload.length);
  frame.writeUInt32BE(stream, 0);
  frame.writeUInt8(kind, 4);
  frame.set(payload, FRAME_HEADER);
  return frame;
}

export function decodeFrame(frame: Buffer): {
  stream: number;
  kind: number;
  payload: Buffer;
} {
  if (frame.length < FRAME_HEADER) throw new ProtocolError("short frame");
  const kind = frame.readUInt8(4);
  if (kind !== KIND_BINARY && kind !== KIND_TEXT)
    throw new ProtocolError("bad frame kind");
  return {
    stream: frame.readUInt32BE(0),
    kind,
    payload: frame.subarray(FRAME_HEADER),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolError("expected an object");
  return value as Record<string, unknown>;
}

function uint(value: unknown, what: string, max = 0xffffffff): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  )
    throw new ProtocolError(`bad ${what}`);
  return value as number;
}

// 1xx is interim and cannot end a response.
function status(value: unknown): number {
  const n = uint(value, "status", 599);
  if (n < 200) throw new ProtocolError("bad status");
  return n;
}

function text(value: unknown, what: string, pattern: RegExp, max: number) {
  if (typeof value !== "string" || value.length > max || !pattern.test(value))
    throw new ProtocolError(`bad ${what}`);
  return value;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;

function headers(value: unknown): HttpHeaders {
  const entries = Object.entries(record(value));
  if (entries.length > 100) throw new ProtocolError("too many headers");
  // Null prototype: a header called "__proto__" is then plain data.
  const result: HttpHeaders = Object.create(null) as HttpHeaders;
  for (const [name, raw] of entries) {
    if (name.length > 100 || !HEADER_NAME.test(name))
      throw new ProtocolError("bad header name");
    const values = Array.isArray(raw) ? raw : [raw];
    if (
      values.length > 50 ||
      !values.every(
        (v) => typeof v === "string" && v.length <= MAX_HEADER_VALUE,
      )
    )
      throw new ProtocolError("bad header value");
    result[name] = raw as string | string[];
  }
  return result;
}

/** Parses and validates a control frame from the other end of a host link. */
export function parseControl(raw: string): ControlMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProtocolError("not JSON");
  }
  const m = record(json);
  switch (m.t) {
    case "challenge":
      return {
        t: "challenge",
        nonce: text(m.nonce, "nonce", /^[0-9a-f]+$/, 64),
      };
    case "hello":
      return {
        t: "hello",
        signature: text(m.signature, "signature", /^0x[0-9a-fA-F]{130}$/, 132),
      };
    case "ready":
      return { t: "ready" };
    case "http":
      if (!isForwardPath(m.path)) throw new ProtocolError("bad path");
      return {
        t: "http",
        id: uint(m.id, "id"),
        method: text(m.method, "method", METHOD, 7),
        path: m.path,
        headers: headers(m.headers),
        body: text(m.body, "body", BASE64, HOST_MAX_PAYLOAD),
      };
    case "http-response":
      return {
        t: "http-response",
        id: uint(m.id, "id"),
        status: status(m.status),
        headers: headers(m.headers),
        body: text(m.body, "body", BASE64, HOST_MAX_PAYLOAD),
      };
    case "open":
      if (!isForwardPath(m.path)) throw new ProtocolError("bad path");
      return { t: "open", stream: uint(m.stream, "stream"), path: m.path };
    case "close":
      return {
        t: "close",
        stream: uint(m.stream, "stream"),
        code: uint(m.code, "code", 4999),
      };
    default:
      throw new ProtocolError("unknown message");
  }
}
