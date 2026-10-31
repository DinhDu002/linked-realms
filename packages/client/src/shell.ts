// The Shell side of the Land UI API (docs/protocols/shell-land-ui.md, api 1).
// The parsing and wording are pure; startShell is the only part that touches the window.
import { DIRECTIONS, type Direction } from "@linked-realms/shared";
import type { Handoff, SignedStatement } from "@linked-realms/shared/identity";

export interface InitMessage {
  land: { landId: number; url: string; ownerName: string };
  character: { address: string; name: string };
  handoff: Handoff;
}

export type TravelRefusedReason =
  "no-land" | "offline" | "locked" | "busy" | "rate-limited" | "error";

export interface TravelRefusedMessage {
  direction: Direction;
  reason: TravelRefusedReason;
  landId?: number;
}

export type SignError =
  "denied" | "busy" | "blocked" | "invalid" | "failed" | "locked";

/** The Shell's answer to `signMessage`: the signed Land message, or why there is none. */
export type SignAnswer = { signed: SignedStatement } | { error: SignError };

export type ShellMessage =
  | ({ type: "init" } & InitMessage)
  | ({ type: "travelRefused" } & TravelRefusedMessage)
  | ({ type: "signResult"; id: string } & SignAnswer);

const REASONS: readonly string[] = [
  "no-land",
  "offline",
  "locked",
  "busy",
  "rate-limited",
  "error",
];

const SIGN_ERRORS: readonly string[] = [
  "denied",
  "busy",
  "blocked",
  "invalid",
  "failed",
  "locked",
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** True when the page is not inside a frame, so there is no Shell to talk to. */
export function isOutsideFrame(win: { parent: unknown }): boolean {
  return win.parent === win;
}

/** The port of a valid connect message, or undefined: only the parent window may connect. */
export function acceptConnect(
  event: { source: unknown; data: unknown; ports: readonly MessagePort[] },
  parent: unknown,
): MessagePort | undefined {
  if (event.source !== parent || !isObject(event.data)) return undefined;
  if (event.data.type !== "linked-realms/connect" || event.data.api !== 1)
    return undefined;
  return event.ports[0];
}

function readStatement(value: unknown): SignedStatement | undefined {
  if (!isObject(value)) return undefined;
  const { statement, publicKey, signature } = value;
  if (
    typeof statement !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string"
  )
    return undefined;
  return { statement, publicKey, signature };
}

function readInit(m: Record<string, unknown>): InitMessage | undefined {
  const { land, character, handoff } = m;
  if (!isObject(land) || !isObject(character) || !isObject(handoff))
    return undefined;
  if (!Number.isSafeInteger(land.landId) || (land.landId as number) < 1)
    return undefined;
  if (typeof land.url !== "string" || typeof land.ownerName !== "string")
    return undefined;
  if (
    typeof character.address !== "string" ||
    typeof character.name !== "string"
  )
    return undefined;
  const ticket = readStatement(handoff.ticket);
  const arrival = readStatement(handoff.arrival);
  if (!ticket || !arrival) return undefined;
  return {
    land: {
      landId: land.landId as number,
      url: land.url,
      ownerName: land.ownerName,
    },
    character: { address: character.address, name: character.name },
    handoff: { ticket, arrival },
  };
}

/** A message from the Shell, or undefined when it is malformed or of an unknown type. */
export function parseShellMessage(data: unknown): ShellMessage | undefined {
  if (!isObject(data)) return undefined;
  if (data.type === "init") {
    const init = readInit(data);
    return init && { type: "init", ...init };
  }
  if (data.type === "travelRefused") {
    const { direction, reason, landId } = data;
    if (!DIRECTIONS.includes(direction as Direction)) return undefined;
    if (typeof reason !== "string" || !REASONS.includes(reason))
      return undefined;
    return {
      type: "travelRefused",
      direction: direction as Direction,
      reason: reason as TravelRefusedReason,
      ...(Number.isSafeInteger(landId) ? { landId: landId as number } : {}),
    };
  }
  if (data.type === "signResult") {
    // This page asks only signMessage, so a txId is no answer to it.
    const { id, signed, error } = data;
    if (typeof id !== "string") return undefined;
    if (signed !== undefined && error !== undefined) return undefined;
    const statement = readStatement(signed);
    if (statement) return { type: "signResult", id, signed: statement };
    if (typeof error === "string" && SIGN_ERRORS.includes(error))
      return { type: "signResult", id, error: error as SignError };
  }
  return undefined;
}

/** What the Player reads when the Shell could not carry out a travel. */
export function travelRefusedText(m: TravelRefusedMessage): string {
  switch (m.reason) {
    case "no-land":
      return `No Land to the ${m.direction}`;
    case "offline":
      return m.landId === undefined
        ? `The Land to the ${m.direction} is offline`
        : `Land ${m.landId} is offline`;
    case "locked":
      return "The Shell is locked. Unlock it to travel.";
    case "busy":
      return "Another trip is in progress.";
    case "rate-limited":
      return "You are travelling too fast. Wait a moment.";
    case "error":
      return "The trip failed. Try again.";
  }
}

/** What the Player reads when the Shell signed nothing. */
export function signErrorText(error: SignError): string {
  switch (error) {
    case "denied":
      return "You did not sign, so nothing changed.";
    case "busy":
      return "The Shell is busy or you said no a moment ago. Wait 10 seconds and try again.";
    case "blocked":
      return "You said no 3 times, so the Shell refuses this Land's requests until you reload it.";
    case "locked":
      return "The Shell is locked. Unlock it and try again.";
    case "invalid":
      return "The Shell could not read this page's request. Reload the Land.";
    case "failed":
      return "The Shell could not sign. Try again.";
  }
}

export interface ShellHandlers {
  onInit(init: InitMessage): void;
  onTravelRefused(m: TravelRefusedMessage): void;
}

export interface ShellLink {
  travel(direction: Direction): void;
  /** Asks the Player to sign `text` as a Land message in the Shell's own prompt. */
  signMessage(text: string): Promise<SignAnswer>;
}

/**
 * Waits for the Shell's connect message (only the first counts), then relays init and
 * travelRefused, and settles each signMessage with the signResult of its id.
 */
export function startShell(win: Window, handlers: ShellHandlers): ShellLink {
  let port: MessagePort | undefined;
  let lastId = 0;
  const waiting = new Map<string, (answer: SignAnswer) => void>();
  win.addEventListener("message", (event) => {
    if (port) return;
    const accepted = acceptConnect(event, win.parent);
    if (!accepted) return;
    port = accepted;
    port.onmessage = (e) => {
      const m = parseShellMessage(e.data);
      if (m?.type === "init") handlers.onInit(m);
      else if (m?.type === "travelRefused") handlers.onTravelRefused(m);
      else if (m?.type === "signResult") {
        const settle = waiting.get(m.id);
        waiting.delete(m.id);
        settle?.("signed" in m ? { signed: m.signed } : { error: m.error });
      }
    };
  });
  return {
    travel(direction) {
      port?.postMessage({ type: "travel", direction });
    },
    signMessage(text) {
      // Init comes through the port, so a page that has its Land always has one.
      if (!port) return Promise.resolve({ error: "failed" });
      const id = String(++lastId);
      port.postMessage({ type: "signMessage", id, text });
      return new Promise((resolve) => waiting.set(id, resolve));
    },
  };
}
