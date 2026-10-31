import { readFileSync } from "node:fs";
import { Key } from "@linked-realms/core";
import { toBinary, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ClientMessageSchema } from "./gen/linked_realms/land/v1/land_pb.ts";
import {
  StatementError,
  buildStatement,
  encodeMessage,
  parseStatement,
  signStatement,
} from "./identity.ts";
import {
  buildMineSwitch,
  parseMineSwitch,
  type MineSwitch,
} from "./mine-switch.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("../test-vectors/mine-switch.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: { text: string; fields: MineSwitch }[];
  invalid: { reason: string; text: string }[];
};

describe("the Mine switch line", () => {
  it.each(vectors.valid)(
    "parses $text and builds it back",
    ({ text, fields }) => {
      expect(parseMineSwitch(text)).toEqual(fields);
      expect(buildMineSwitch(fields)).toBe(text);
    },
  );

  it.each(vectors.invalid)("refuses $reason", ({ text }) => {
    expect(() => parseMineSwitch(text)).toThrow(StatementError);
  });

  it("refuses to build fields that break the grammar", () => {
    const fields = vectors.valid[0]!.fields;
    for (const bad of [
      { ...fields, threads: 0 },
      { ...fields, threads: 1.5 },
      { ...fields, on: false },
      { ...fields, nonce: "x" },
      { ...fields, mapServerKey: "tlr1x" },
    ])
      expect(() => buildMineSwitch(bad)).toThrow(StatementError);
  });

  it("travels in a Land message as written, and a signed switch fits the relay's frame", () => {
    const key = Key.fromEntropy(new Uint8Array(32).fill(9), 0);
    const line = vectors.valid[0]!.text;
    // Printable ASCII only: the Shell's prompt shows it with no escapes.
    expect(encodeMessage(line)).toBe(`"${line}"`);
    const fields = {
      land: 7,
      landUrl: "https://7.lands.example.org",
      character: key.address,
      issued: 1793232000,
      message: line,
    };
    const parsed = parseStatement(
      "land-message",
      buildStatement("land-message", fields),
    );
    expect(parseMineSwitch(parsed.message)).toEqual(vectors.valid[0]!.fields);
    const signed = signStatement("land-message", fields, key);
    key.free();
    const frame = toBinary(
      ClientMessageSchema,
      create(ClientMessageSchema, {
        message: { case: "mineSwitch", value: { signed } },
      }),
    );
    expect(frame.length).toBeGreaterThan(5000);
    expect(frame.length).toBeLessThan(16_384);
  });
});
