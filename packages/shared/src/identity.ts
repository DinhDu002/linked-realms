// Signed statements (docs/protocols/identity.md): build, strictly parse and verify the seven
// statements, and check an arrival handoff (docs/protocols/arrival.md). Keys, signatures and
// addresses come from @linked-realms/core. Exported as `@linked-realms/shared/identity`, so a page
// that never verifies anything does not load the WebAssembly module.
import {
  SCHEME_ML_DSA_44,
  addressFromPublicKey,
  isAddress,
  verify,
  type Key,
} from "@linked-realms/core";

export class StatementError extends Error {
  override name = "StatementError";
}

type Format =
  | "host"
  | "address"
  | "name"
  | "land"
  | "gate"
  | "time"
  | "nonce"
  | "yesNo"
  | "origin"
  | "message";

interface FormatTypes {
  host: string;
  address: string;
  name: string;
  land: number;
  gate: number;
  time: number;
  nonce: string;
  yesNo: boolean;
  origin: string;
  message: string;
}

/** Each statement: its title, then [field, key in the text, format] per line, in order. */
const STATEMENTS = {
  "hub-sign-in": {
    title: "linked-realms Hub sign-in",
    lines: [
      ["hub", "Hub", "host"],
      ["nonce", "Nonce", "nonce"],
      ["issued", "Issued", "time"],
    ],
  },
  "map-server": {
    title: "linked-realms Map server",
    lines: [
      ["hub", "Hub", "host"],
      ["owner", "Owner", "address"],
      ["mapServerKey", "Map server key", "address"],
      ["issued", "Issued", "time"],
    ],
  },
  delegation: {
    title: "linked-realms Delegation",
    lines: [
      ["hub", "Hub", "host"],
      ["owner", "Owner", "address"],
      ["mapServerKey", "Map server key", "address"],
      ["issued", "Issued", "time"],
    ],
  },
  "travel-ticket": {
    title: "linked-realms Travel ticket",
    lines: [
      ["hub", "Hub", "host"],
      ["character", "Character", "address"],
      ["name", "Name", "name"],
      ["land", "Land", "land"],
      ["gate", "Gate", "gate"],
      ["issued", "Issued", "time"],
      ["expires", "Expires", "time"],
      ["nonce", "Nonce", "nonce"],
    ],
  },
  arrival: {
    title: "linked-realms arrival",
    lines: [
      ["land", "Land", "land"],
      ["ticketNonce", "Ticket nonce", "nonce"],
      ["drivenByAi", "Driven by AI", "yesNo"],
    ],
  },
  "relay-host": {
    title: "linked-realms relay host",
    lines: [
      ["relay", "Relay", "host"],
      ["land", "Land", "land"],
      ["nonce", "Nonce", "nonce"],
    ],
  },
  "land-message": {
    title: "linked-realms Land message",
    lines: [
      ["land", "Land", "land"],
      ["landUrl", "Land URL", "origin"],
      ["character", "Character", "address"],
      ["issued", "Issued", "time"],
      ["message", "Message", "message"],
    ],
  },
} as const satisfies Record<
  string,
  { title: string; lines: readonly (readonly [string, string, Format])[] }
>;

export type StatementKind = keyof typeof STATEMENTS;
export const STATEMENT_KINDS = Object.keys(STATEMENTS) as StatementKind[];

export type StatementFields<K extends StatementKind> = {
  [L in (typeof STATEMENTS)[K]["lines"][number] as L[0]]: FormatTypes[L[2]];
};

/** The field that names the signer, checked against the signing key's address. */
const SIGNER_FIELD: Partial<Record<StatementKind, string>> = {
  "map-server": "mapServerKey",
  delegation: "owner",
  "land-message": "character",
};

export const statementContext = (kind: StatementKind) =>
  `linked-realms/${kind}/v1`;

export const NAME_MAX_CODE_POINTS = 32;
export const MESSAGE_MAX_CODE_POINTS = 1000;
/** Longer than any valid statement; checked before the signature. */
const STATEMENT_MAX_LENGTH = 16_384;
const PUBLIC_KEY_LENGTH = 1312;
const SIGNATURE_LENGTH = 2420;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::([1-9][0-9]{0,4}))?$`);
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const EDGE_SPACE = /^\p{White_Space}|\p{White_Space}$/u;
const MESSAGE_CHARS =
  /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\]|\\u[0-9a-f]{4})*"$/;

function isHost(value: string): boolean {
  const match = HOST.exec(value);
  return match !== null && Number(match[1] ?? 1) <= 65535;
}

function decimal(value: string, min: number): number | undefined {
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}

/** `Message`: a JSON string with every code unit outside printable ASCII as a lowercase `\uXXXX`. */
export function encodeMessage(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) out += `\\${text[i]}`;
    else if (c >= 0x20 && c <= 0x7e) out += text[i];
    else out += `\\u${c.toString(16).padStart(4, "0")}`;
  }
  return `${out}"`;
}

function parseValue(format: Format, value: string): unknown {
  if (value === "") return format === "name" ? value : undefined;
  switch (format) {
    case "host":
      return isHost(value) ? value : undefined;
    case "address":
      return isAddress(value) ? value : undefined;
    case "name":
      return [...value].length <= NAME_MAX_CODE_POINTS ? value : undefined;
    case "land":
      return decimal(value, 1);
    case "gate":
      return /^[0-4]$/.test(value) ? Number(value) : undefined;
    case "time":
      return decimal(value, 0);
    case "nonce":
      return /^[0-9a-f]{32}$/.test(value) ? value : undefined;
    case "yesNo":
      return value === "yes" ? true : value === "no" ? false : undefined;
    case "origin": {
      const match = /^https?:\/\/(.+)$/.exec(value);
      return match && isHost(match[1]!) ? value : undefined;
    }
    case "message": {
      if (!MESSAGE_CHARS.test(value)) return undefined;
      const text = JSON.parse(value) as string;
      // Only the one encoding encodeMessage writes, and only text other languages can decode.
      if (encodeMessage(text) !== value || !text.isWellFormed())
        return undefined;
      return [...text].length <= MESSAGE_MAX_CODE_POINTS ? text : undefined;
    }
  }
}

/** Parses `text` with the strict grammar of identity.md, or throws StatementError. */
export function parseStatement<K extends StatementKind>(
  kind: K,
  text: string,
): StatementFields<K> {
  const { title, lines } = STATEMENTS[kind];
  const textLines = text.split("\n");
  if (textLines[0] !== title)
    throw new StatementError(`not a "${title}" statement`);
  if (textLines.length !== lines.length + 1)
    throw new StatementError(
      `a "${title}" statement has ${lines.length + 1} lines`,
    );
  const fields: Record<string, unknown> = {};
  lines.forEach(([field, key, format], i) => {
    const line = textLines[i + 1]!;
    if (!line.startsWith(`${key}: `))
      throw new StatementError(`line ${i + 2} must start with "${key}: "`);
    const raw = line.slice(key.length + 2);
    if (FORBIDDEN.test(raw) || EDGE_SPACE.test(raw) || !raw.isWellFormed())
      throw new StatementError(`${key} has a forbidden character`);
    const value = parseValue(format, raw);
    if (value === undefined) throw new StatementError(`${key} is malformed`);
    fields[field] = value;
  });
  return fields as StatementFields<K>;
}

/** The statement's text, or StatementError if any field breaks the grammar. */
export function buildStatement<K extends StatementKind>(
  kind: K,
  fields: StatementFields<K>,
): string {
  const { title, lines } = STATEMENTS[kind];
  const values = fields as Record<string, unknown>;
  const text = [
    title,
    ...lines.map(([field, key, format]) => {
      const value = values[field];
      const written =
        format === "message"
          ? encodeMessage(String(value))
          : format === "yesNo"
            ? value
              ? "yes"
              : "no"
            : String(value);
      return `${key}: ${written}`;
    }),
  ].join("\n");
  parseStatement(kind, text);
  return text;
}

/** A statement on the wire: standard base64 with padding. */
export interface SignedStatement {
  statement: string;
  publicKey: string;
  signature: string;
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** Only canonical base64 (padding, no white space, zero padding bits), or undefined. */
export function fromBase64(text: string): Uint8Array | undefined {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  if (btoa(binary) !== text) return undefined;
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Builds and signs a statement. `key` stays the caller's to free. */
export function signStatement<K extends StatementKind>(
  kind: K,
  fields: StatementFields<K>,
  key: Key,
): SignedStatement {
  const statement = buildStatement(kind, fields);
  const rnd = crypto.getRandomValues(new Uint8Array(32));
  const signature = key.sign(statementContext(kind), utf8(statement), rnd);
  return {
    statement,
    publicKey: toBase64(key.publicKey),
    signature: toBase64(signature),
  };
}

export interface VerifiedStatement<K extends StatementKind> {
  fields: StatementFields<K>;
  /** The address of the key that signed it. */
  address: string;
}

/**
 * Checks a statement from an untrusted source in the order identity.md gives: lengths, the
 * signature under the statement's context, the grammar, then that the field naming the signer
 * (if the statement has one) is the signing key's address. Throws StatementError.
 */
export function verifyStatement<K extends StatementKind>(
  signed: unknown,
  kind: K,
): VerifiedStatement<K> {
  if (typeof signed !== "object" || signed === null)
    throw new StatementError("not a signed statement");
  const { statement, publicKey, signature } = signed as Record<string, unknown>;
  if (
    typeof statement !== "string" ||
    typeof publicKey !== "string" ||
    typeof signature !== "string"
  )
    throw new StatementError("not a signed statement");
  if (statement.length > STATEMENT_MAX_LENGTH || !statement.isWellFormed())
    throw new StatementError("malformed statement");
  const key = fromBase64(publicKey);
  const sig = fromBase64(signature);
  if (key?.length !== PUBLIC_KEY_LENGTH || sig?.length !== SIGNATURE_LENGTH)
    throw new StatementError("malformed key or signature");
  if (
    !verify(SCHEME_ML_DSA_44, key, statementContext(kind), utf8(statement), sig)
  )
    throw new StatementError("bad signature");
  const fields = parseStatement(kind, statement);
  const address = addressFromPublicKey(SCHEME_ML_DSA_44, key);
  const signerField = SIGNER_FIELD[kind];
  if (
    signerField !== undefined &&
    (fields as Record<string, unknown>)[signerField] !== address
  )
    throw new StatementError(`not signed by its ${signerField}`);
  return { fields, address };
}

/** Error codes of arrival.md, in the order the checks run. */
export type ArrivalCode =
  | "bad-ticket"
  | "wrong-land"
  | "expired"
  | "too-far-ahead"
  | "before-start"
  | "reused"
  | "bad-arrival"
  | "key-mismatch"
  | "mismatch";

export class ArrivalRefused extends Error {
  override name = "ArrivalRefused";
  readonly code: ArrivalCode;
  constructor(code: ArrivalCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** A ticket expiring later than this from now is refused (tickets live 60 seconds). */
export const TICKET_MAX_AHEAD_SECONDS = 120;

export interface Handoff {
  ticket: SignedStatement;
  arrival: SignedStatement;
}

export interface VerifiedArrival {
  ticket: StatementFields<"travel-ticket">;
  arrival: StatementFields<"arrival">;
}

/**
 * Checks an arrival as arrival.md says, in its order, throwing ArrivalRefused with the first
 * failing check's code. Times are Unix seconds. The caller records `ticket.nonce` as used, until
 * `ticket.expires`, only after this returns.
 */
export function verifyHandoff(
  handoff: unknown,
  land: {
    landId: number;
    /** The address of the Hub's ticket key (HUB_TICKET_SIGNER). */
    hubTicketSigner: string;
    startedAt: number;
    now: number;
    isUsed: (nonce: string) => boolean;
  },
): VerifiedArrival {
  const h = (typeof handoff === "object" && handoff) || {};
  const refuse = (code: ArrivalCode, message: string): never => {
    throw new ArrivalRefused(code, message);
  };

  let ticket: StatementFields<"travel-ticket">;
  try {
    const verified = verifyStatement((h as Handoff).ticket, "travel-ticket");
    if (verified.address !== land.hubTicketSigner)
      throw new StatementError("not signed by the Hub's ticket key");
    ticket = verified.fields;
  } catch (e) {
    return refuse("bad-ticket", `bad ticket: ${(e as Error).message}`);
  }
  if (ticket.land !== land.landId)
    refuse("wrong-land", "the ticket is for another Land");
  if (ticket.expires <= land.now) refuse("expired", "the ticket has expired");
  if (ticket.expires > land.now + TICKET_MAX_AHEAD_SECONDS)
    refuse("too-far-ahead", "the ticket expires too far ahead");
  if (ticket.issued < land.startedAt)
    refuse("before-start", "the ticket was issued before this Land started");
  if (land.isUsed(ticket.nonce))
    refuse("reused", "the ticket was already used");

  let arrival: VerifiedStatement<"arrival">;
  try {
    arrival = verifyStatement((h as Handoff).arrival, "arrival");
  } catch (e) {
    return refuse("bad-arrival", `bad arrival: ${(e as Error).message}`);
  }
  if (arrival.address !== ticket.character)
    refuse(
      "key-mismatch",
      "the arrival is not signed by the ticket's Character",
    );
  if (
    arrival.fields.land !== ticket.land ||
    arrival.fields.ticketNonce !== ticket.nonce
  )
    refuse("mismatch", "the arrival does not match the ticket");
  return { ticket, arrival: arrival.fields };
}
