import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ClientMessageSchema,
  ServerMessageSchema,
} from "@linked-realms/shared/land-protocol";
import { describe, expect, it } from "vitest";
import {
  decodeServerMessage,
  encodeHello,
  encodeInput,
  errorText,
  playUrl,
} from "./connection.ts";

const statement = (statement: string) => ({
  statement,
  publicKey: "k",
  signature: "g",
});

const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

describe("encoding", () => {
  it("encodes hello with the ticket and the arrival", () => {
    const m = fromBinary(
      ClientMessageSchema,
      encodeHello({ ticket: statement("t"), arrival: statement("a") }),
    );
    expect(m.message.case).toBe("hello");
    if (m.message.case !== "hello") return;
    expect(m.message.value.ticket).toMatchObject(statement("t"));
    expect(m.message.value.arrival).toMatchObject(statement("a"));
  });

  it("encodes input with a growing seq", () => {
    for (const [dx, dy, seq] of [
      [1, 0, 1],
      [-1, 1, 2],
      [0, -1, 300],
    ] as const) {
      const m = fromBinary(ClientMessageSchema, encodeInput(dx, dy, seq));
      expect(m.message).toMatchObject({
        case: "input",
        value: { dx, dy, seq },
      });
    }
  });
});

describe("decodeServerMessage", () => {
  it("decodes a moved frame", () => {
    const bytes = toBinary(
      ServerMessageSchema,
      create(ServerMessageSchema, {
        message: {
          case: "moved",
          value: { positions: [{ id: 3, x: 1.5, y: 2 }], seq: 4 },
        },
      }),
    );
    const m = decodeServerMessage(buffer(bytes));
    expect(m?.message).toMatchObject({
      case: "moved",
      value: { positions: [{ id: 3, x: 1.5, y: 2 }], seq: 4 },
    });
  });

  it("ignores text frames and bytes that are not a message", () => {
    expect(decodeServerMessage("hello")).toBeUndefined();
    expect(
      decodeServerMessage(buffer(Uint8Array.of(0xff, 0xff, 0xff))),
    ).toBeUndefined();
  });
});

describe("errorText", () => {
  it("words the Map server's own codes", () => {
    expect(errorText("full")).toBe("This Land is full");
    expect(errorText("duplicate")).toBe(
      "You are already on this Land in another tab",
    );
    expect(errorText("rate-limited")).toMatch(/too much/);
    expect(errorText("bad-message")).toMatch(/Reload/);
  });

  it("names the arrival code in a refused ticket", () => {
    for (const code of ["expired", "reused", "before-start"])
      expect(errorText(code)).toBe(
        `Your Travel ticket was refused (${code}). Go back to the Shell and try again.`,
      );
  });
});

describe("playUrl", () => {
  it("uses wss on https and ws otherwise, on the page's own host", () => {
    expect(playUrl({ protocol: "https:", host: "7.lands.example" })).toBe(
      "wss://7.lands.example/play",
    );
    expect(playUrl({ protocol: "http:", host: "7.localhost:8080" })).toBe(
      "ws://7.localhost:8080/play",
    );
  });
});
