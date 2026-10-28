import { describe, expect, it } from "vitest";
import { parseInputMessage } from "./protocol.ts";

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
