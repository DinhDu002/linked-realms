import { describe, expect, it } from "vitest";
import { parseInputMessage, parseMiningMessage } from "./protocol.ts";

describe("parseInputMessage", () => {
  it("accepts four booleans and drops extra fields", () => {
    expect(
      parseInputMessage({
        up: true,
        down: false,
        left: false,
        right: true,
        speed: 999,
      }),
    ).toEqual({
      up: true,
      down: false,
      left: false,
      right: true,
    });
  });

  it.each([
    null,
    1,
    "up",
    {},
    { up: 1, down: false, left: false, right: false },
  ])("rejects %j", (value) => {
    expect(parseInputMessage(value)).toBeUndefined();
  });
});

describe("parseMiningMessage", () => {
  it("accepts a switch with a thread count", () => {
    expect(parseMiningMessage({ on: true, threads: 2, extra: 1 })).toEqual({
      on: true,
      threads: 2,
    });
  });

  it.each([
    null,
    {},
    { on: "yes", threads: 1 },
    { on: true, threads: 0 },
    { on: true, threads: 1.5 },
    { on: true, threads: 999 },
  ])("rejects %j", (value) => {
    expect(parseMiningMessage(value)).toBeUndefined();
  });
});
