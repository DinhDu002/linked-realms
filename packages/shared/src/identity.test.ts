import { readFileSync } from "node:fs";
import { Key } from "@linked-realms/core";
import { describe, expect, it } from "vitest";
import {
  ArrivalRefused,
  StatementError,
  buildStatement,
  fromBase64,
  isHost,
  isName,
  parseStatement,
  signStatement,
  toBase64,
  verifyHandoff,
  verifyStatement,
  type ArrivalCode,
  type SignedStatement,
  type StatementFields,
  type StatementKind,
} from "./identity.ts";

const read = <T>(path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;

const grammar = read<{
  valid: { kind: StatementKind; statement: string; fields: object }[];
  invalid: { reason: string; kind: StatementKind; statement: string }[];
}>("../test-vectors/statements.json");

const identity = read<{
  statements: {
    context: string;
    statement: string;
    publicKey: string;
    address: string;
    signature: string;
  }[];
}>("../../../crates/core/test-vectors/identity.json");

const hexToBase64 = (hex: string) => toBase64(Buffer.from(hex, "hex"));

describe("statement grammar", () => {
  it.each(grammar.valid)(
    "parses and rebuilds $kind",
    ({ kind, statement, fields }) => {
      expect(parseStatement(kind, statement)).toEqual(fields);
      expect(buildStatement(kind, fields as StatementFields<typeof kind>)).toBe(
        statement,
      );
    },
  );

  it.each(grammar.invalid)("refuses $reason", ({ kind, statement }) => {
    expect(() => parseStatement(kind, statement)).toThrow(StatementError);
  });

  it("refuses to build what it would not parse", () => {
    const fields = grammar.valid.find((v) => v.kind === "travel-ticket")!
      .fields as StatementFields<"travel-ticket">;
    expect(() =>
      buildStatement("travel-ticket", { ...fields, name: "Mai\nLand: 8" }),
    ).toThrow(StatementError);
    expect(() =>
      buildStatement("travel-ticket", { ...fields, land: 1.5 }),
    ).toThrow(StatementError);
  });
});

describe("isHost and isName", () => {
  it("follow the grammar's value formats", () => {
    for (const host of ["hub.example.org", "localhost:8787", "a-b.c:65535"])
      expect(isHost(host)).toBe(true);
    for (const host of ["Hub.example", "x.org:0", "x.org:65536", "-a.org", ""])
      expect(isHost(host)).toBe(false);
    for (const name of ["", "Mai Lan", "🌸".repeat(32)])
      expect(isName(name)).toBe(true);
    for (const name of [" Mai", "Mai\n", "a\u200bb", "\ud800", "a".repeat(33)])
      expect(isName(name)).toBe(false);
  });
});

describe("base64", () => {
  it("accepts only the canonical form", () => {
    expect(fromBase64("YWI=")).toEqual(new Uint8Array([0x61, 0x62]));
    expect(fromBase64("YWI")).toBeUndefined();
    expect(fromBase64("YWJ=")).toBeUndefined();
    expect(fromBase64("YW I=")).toBeUndefined();
    expect(fromBase64("YWI=\n")).toBeUndefined();
    expect(fromBase64("YW-_")).toBeUndefined();
  });
});

describe("verifyStatement", () => {
  const wire = (s: (typeof identity.statements)[number]): SignedStatement => ({
    statement: s.statement,
    publicKey: hexToBase64(s.publicKey),
    signature: hexToBase64(s.signature),
  });

  it.each(identity.statements)("verifies the vector under $context", (s) => {
    const kind = s.context.split("/")[1] as StatementKind;
    const verified = verifyStatement(wire(s), kind);
    expect(verified.address).toBe(s.address);
    expect(verified.fields).toEqual(parseStatement(kind, s.statement));
  });

  it("refuses a statement under another context", () => {
    const delegation = identity.statements.find((s) =>
      s.context.includes("/delegation/"),
    )!;
    // The same lines as a Map server statement, but signed for a Delegation.
    const asMapServer = {
      ...wire(delegation),
      statement: delegation.statement.replace("Delegation", "Map server"),
    };
    expect(() => verifyStatement(asMapServer, "map-server")).toThrow(
      "bad signature",
    );
    expect(() => verifyStatement(wire(delegation), "map-server")).toThrow(
      "bad signature",
    );
  });

  it("refuses malformed input before checking anything else", () => {
    const s = wire(identity.statements[0]!);
    for (const bad of [
      null,
      "text",
      { ...s, statement: 1 },
      { ...s, publicKey: s.publicKey.slice(0, -4) },
      { ...s, signature: `${s.signature}\n` },
      { ...s, statement: `${s.statement}\ud800` },
    ])
      expect(() => verifyStatement(bad, "hub-sign-in")).toThrow(StatementError);
  });

  it("refuses a statement whose signer field names another key", () => {
    using key = Key.fromSeed(new Uint8Array(32).fill(9));
    using other = Key.fromSeed(new Uint8Array(32).fill(10));
    const fields = {
      hub: "hub.example.org",
      owner: key.address,
      mapServerKey: other.address,
      issued: 1793232000,
    };
    expect(() =>
      verifyStatement(signStatement("map-server", fields, key), "map-server"),
    ).toThrow("not signed by its mapServerKey");
    const signed = signStatement("delegation", fields, key);
    expect(verifyStatement(signed, "delegation").address).toBe(key.address);
  });
});

describe("verifyHandoff", () => {
  const hub = Key.fromSeed(new Uint8Array(32).fill(0x48));
  const character = Key.fromSeed(new Uint8Array(32).fill(0x43));
  const now = 1793232000;
  const nonce = "00112233445566778899aabbccddeeff";
  const ticketFields: StatementFields<"travel-ticket"> = {
    hub: "hub.example.org",
    character: character.address,
    name: "Mai",
    land: 7,
    gate: 2,
    issued: now,
    expires: now + 60,
    nonce,
  };
  const arrivalFields: StatementFields<"arrival"> = {
    land: 7,
    ticketNonce: nonce,
    drivenByAi: false,
  };
  const land = {
    landId: 7,
    hubTicketSigner: hub.address,
    startedAt: now - 100,
    now: now + 1,
    isUsed: () => false,
  };
  const handoff = (
    ticket: Partial<StatementFields<"travel-ticket">> = {},
    arrival: Partial<StatementFields<"arrival">> = {},
    keys = { ticket: hub, arrival: character },
  ) => ({
    ticket: signStatement(
      "travel-ticket",
      { ...ticketFields, ...ticket },
      keys.ticket,
    ),
    arrival: signStatement(
      "arrival",
      { ...arrivalFields, ...arrival },
      keys.arrival,
    ),
  });
  const refusal = (fn: () => unknown): ArrivalCode | undefined => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ArrivalRefused) return e.code;
      throw e;
    }
    return undefined;
  };

  it("accepts a valid handoff", () => {
    const verified = verifyHandoff(handoff({}, { drivenByAi: true }), land);
    expect(verified.ticket).toEqual(ticketFields);
    expect(verified.arrival.drivenByAi).toBe(true);
  });

  it("refuses each failing check with its code, in order", () => {
    const cases: [ArrivalCode, () => unknown][] = [
      ["bad-ticket", () => verifyHandoff({}, land)],
      [
        "bad-ticket",
        () =>
          verifyHandoff(
            handoff({}, {}, { ticket: character, arrival: character }),
            land,
          ),
      ],
      [
        "bad-ticket",
        () => {
          const h = handoff();
          return verifyHandoff(
            {
              ...h,
              ticket: {
                ...h.ticket,
                statement: h.ticket.statement.replace("Gate: 2", "Gate: 3"),
              },
            },
            land,
          );
        },
      ],
      ["wrong-land", () => verifyHandoff(handoff({ land: 8 }), land)],
      ["expired", () => verifyHandoff(handoff({ expires: now + 1 }), land)],
      [
        "too-far-ahead",
        () => verifyHandoff(handoff({ expires: now + 122 }), land),
      ],
      [
        "before-start",
        () => verifyHandoff(handoff({ issued: now - 101 }), land),
      ],
      [
        "reused",
        () => verifyHandoff(handoff(), { ...land, isUsed: (n) => n === nonce }),
      ],
      [
        "bad-arrival",
        () => verifyHandoff({ ...handoff(), arrival: "x" }, land),
      ],
      [
        "key-mismatch",
        () =>
          verifyHandoff(handoff({}, {}, { ticket: hub, arrival: hub }), land),
      ],
      ["mismatch", () => verifyHandoff(handoff({}, { land: 8 }), land)],
      [
        "mismatch",
        () =>
          verifyHandoff(handoff({}, { ticketNonce: "ff".repeat(16) }), land),
      ],
    ];
    for (const [code, fn] of cases) expect(refusal(fn)).toBe(code);
  });

  it("reports the earliest failing check", () => {
    // Expired and for another Land: wrong-land comes first.
    expect(
      refusal(() => verifyHandoff(handoff({ land: 8, expires: now }), land)),
    ).toBe("wrong-land");
  });
});
