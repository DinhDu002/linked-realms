// The WebSocket to the Map server at /play on the page's own origin. Every frame is one
// binary protobuf message (packages/shared/proto/linked_realms/land/v1/land.proto).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ServerMessage,
} from "@linked-realms/shared/land-protocol";
import type { Handoff } from "@linked-realms/shared/identity";

const FULL_ERROR_TEXT: Record<string, string> = {
  full: "This Land is full",
  duplicate: "You are already on this Land in another tab",
  "rate-limited": "You are sending too much. Slow down and try again.",
  "bad-message": "The Land could not understand this page. Reload it.",
  unavailable: "This Land is not ready yet. Try again shortly.",
};

/** What the Player reads for the `error` the Map server sends before it closes the socket. */
export function errorText(code: string): string {
  return (
    FULL_ERROR_TEXT[code] ??
    `Your Travel ticket was refused (${code}). Go back to the Shell and try again.`
  );
}

/** `ws(s)://<host>/play` for a page at `location` (wss on https). */
export function playUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/play`;
}

export function encodeHello(handoff: Handoff): Uint8Array<ArrayBuffer> {
  // slice: a plain ArrayBuffer-backed copy, which WebSocket.send accepts
  return toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, {
      message: {
        case: "hello",
        value: { ticket: handoff.ticket, arrival: handoff.arrival },
      },
    }),
  ).slice();
}

export function encodeInput(
  dx: number,
  dy: number,
  seq: number,
): Uint8Array<ArrayBuffer> {
  // slice: a plain ArrayBuffer-backed copy, which WebSocket.send accepts
  return toBinary(
    ClientMessageSchema,
    create(ClientMessageSchema, {
      message: { case: "input", value: { dx, dy, seq } },
    }),
  ).slice();
}

/** A decoded frame, or undefined when it is not a binary protobuf ServerMessage (Map servers are untrusted). */
export function decodeServerMessage(data: unknown): ServerMessage | undefined {
  if (!(data instanceof ArrayBuffer)) return undefined;
  try {
    return fromBinary(ServerMessageSchema, new Uint8Array(data));
  } catch {
    return undefined;
  }
}

export interface ConnectionHandlers {
  onMessage(message: ServerMessage): void;
  /** A plain-words problem: a refusal from the Map server, or a lost connection. */
  onProblem(text: string): void;
}

export interface Connection {
  sendInput(dx: number, dy: number, seq: number): void;
  close(): void;
}

/** Opens the socket and sends `hello` with the Shell's handoff as soon as it is open. */
export function connect(
  url: string,
  handoff: Handoff,
  handlers: ConnectionHandlers,
): Connection {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let problem = false;
  ws.onopen = () => ws.send(encodeHello(handoff));
  ws.onmessage = (event) => {
    const message = decodeServerMessage(event.data);
    if (!message) return;
    if (message.message.case === "error") {
      problem = true;
      handlers.onProblem(errorText(message.message.value.code));
      return;
    }
    handlers.onMessage(message);
  };
  ws.onclose = () => {
    if (!problem) handlers.onProblem("Disconnected from the Land.");
  };
  return {
    sendInput(dx, dy, seq) {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeInput(dx, dy, seq));
    },
    close() {
      problem = true; // closing on purpose is not a problem to report
      ws.close();
    },
  };
}
