// A small typed client for hub-api. The Hub is untrusted input to the client too (P1): every
// response is validated before it is used. Pure parts are tested; fetch and the wallet are injected.
import {
  DelegationTypes,
  HUB_EIP712_DOMAIN,
  parseWireTicket,
  ticketToWire,
  type Directory,
  type DirectoryLand,
  type WireTravelTicket,
} from "@linked-realms/shared";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import type { Wallet } from "./wallet.ts";

export const REPORT_REASON_MAX = 500;
const MAX_LANDS = 10_000;
const MAX_BODY_CHARS = 1_000_000;
const TIMEOUT_MS = 10_000;

export class HubError extends Error {
  override name = "HubError";
}

function bad(what: string): never {
  throw new HubError(`bad response from the Hub: ${what}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return bad(what);
  return value as Record<string, unknown>;
}

function int(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return bad(what);
  return value;
}

function address(value: unknown, what: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false }))
    return bad(what);
  return getAddress(value);
}

export function parseNonce(value: unknown): string {
  const { nonce } = record(value, "nonce");
  // the SIWE nonce rule (EIP-4361): at least 8 alphanumeric characters
  if (typeof nonce !== "string" || !/^[a-zA-Z0-9]{8,128}$/.test(nonce))
    return bad("nonce");
  return nonce;
}

export interface Session {
  token: string;
  address: Address;
  expiresAt: number;
}

export function parseSession(value: unknown): Session {
  const v = record(value, "session");
  if (typeof v.token !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(v.token))
    return bad("session token");
  return {
    token: v.token,
    address: address(v.address, "session address"),
    expiresAt: int(v.expiresAt, "session expiresAt"),
  };
}

function relayUrl(value: unknown): string {
  try {
    if (
      typeof value === "string" &&
      ["http:", "https:", "ws:", "wss:"].includes(new URL(value).protocol)
    )
      return value;
  } catch {
    // falls through
  }
  return bad("relayUrl");
}

export function parseDirectory(value: unknown): Directory {
  const v = record(value, "directory");
  if (!Array.isArray(v.lands) || v.lands.length > MAX_LANDS)
    return bad("directory lands");
  const lands = v.lands.map((raw, i): DirectoryLand => {
    const l = record(raw, `land ${i}`);
    const landId = int(l.landId, `land ${i} landId`);
    if (landId < 1) return bad(`land ${i} landId`);
    if (typeof l.online !== "boolean") return bad(`land ${i} online`);
    return {
      landId,
      owner: address(l.owner, `land ${i} owner`),
      x: int(l.x, `land ${i} x`),
      y: int(l.y, `land ${i} y`),
      miningKey: address(l.miningKey, `land ${i} miningKey`),
      online: l.online,
    };
  });
  return { relayUrl: relayUrl(v.relayUrl), lands };
}

export interface TicketGrant {
  ticket: WireTravelTicket;
  signature: Hex;
}

export function parseTicketGrant(value: unknown): TicketGrant {
  const v = record(value, "ticket");
  if (
    typeof v.signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(v.signature)
  )
    return bad("ticket signature");
  try {
    return {
      ticket: ticketToWire(parseWireTicket(v.ticket)),
      signature: v.signature as Hex,
    };
  } catch {
    return bad("ticket");
  }
}

/** The Hub's `{ error }` text, shown to the user: a string, capped, or nothing. */
function errorText(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e.slice(0, 200) : "";
}

export interface HubOptions {
  baseUrl: string;
  chainId: number;
  /** SIWE domain and uri: window.location.host and window.location.origin. */
  domain: string;
  uri: string;
  fetch?: typeof fetch;
}

export function createHub(options: HubOptions) {
  const { chainId, domain, uri } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  let token: string | undefined;
  let expiresAt = 0;
  // a minute's margin: a sponsored transaction makes several calls with one session
  const signedIn = () =>
    token !== undefined && Date.now() < (expiresAt - 60) * 1000;

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    authed = false,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authed) {
      if (!token) throw new HubError("not signed in to the Hub");
      headers.authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HubError("the Hub is unreachable");
    }
    const text = await res.text();
    let json: unknown;
    if (text.length <= MAX_BODY_CHARS) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      if (res.status === 401) token = undefined;
      throw new HubError(
        `Hub error ${res.status}${errorText(json) ? `: ${errorText(json)}` : ""}`,
      );
    }
    return json;
  }

  return {
    signedIn,

    /** The session header for calls the Hub forwards (sponsored user operations). */
    authorization(): string {
      if (!signedIn()) throw new HubError("sign in to the Hub first");
      return `Bearer ${token}`;
    },

    /** SIWE: the wallet signs a message that names this site; the token stays in memory. */
    async signIn(
      account: Address,
      sign: (message: string) => Promise<Hex>,
    ): Promise<Session> {
      const nonce = parseNonce(await request("GET", "/auth/nonce"));
      const message = createSiweMessage({
        address: account,
        chainId,
        domain,
        uri,
        nonce,
        version: "1",
        statement: "Sign in to the linked-realms Hub.",
      });
      const signature = await sign(message);
      const session = parseSession(
        await request("POST", "/auth/verify", { message, signature }),
      );
      token = session.token;
      expiresAt = session.expiresAt;
      return session;
    },

    async directory(): Promise<Directory> {
      return parseDirectory(await request("GET", "/directory"));
    },

    /** `from` is the Land the Player is leaving through a Gate; omit it to enter directly. */
    async ticket(landId: number, from?: number): Promise<TicketGrant> {
      const body = from === undefined ? { landId } : { landId, from };
      return parseTicketGrant(await request("POST", "/tickets", body, true));
    },

    async delegate(
      landId: number,
      body: { miningKey: Address; issuedAt: number; signature: Hex },
    ): Promise<void> {
      await request("POST", `/lands/${landId}/delegation`, body);
    },

    async report(landId: number, reason: string): Promise<void> {
      const text = reason.trim();
      if (text === "" || text.length > REPORT_REASON_MAX)
        throw new HubError(
          `a reason of 1 to ${REPORT_REASON_MAX} characters is required`,
        );
      await request("POST", "/reports", { landId, reason: text }, true);
    },
  };
}

export type Hub = ReturnType<typeof createHub>;

/** The Land owner's EIP-712 Delegation: this Mining key may host the Land. */
export function signDelegation(
  wallet: Wallet,
  chainId: number,
  landId: number,
  miningKey: Address,
  issuedAt: number,
): Promise<Hex> {
  return wallet.client.signTypedData({
    account: wallet.account,
    domain: HUB_EIP712_DOMAIN(chainId),
    types: DelegationTypes,
    primaryType: "Delegation",
    message: {
      landId: BigInt(landId),
      miningKey,
      issuedAt: BigInt(issuedAt),
    },
  });
}
