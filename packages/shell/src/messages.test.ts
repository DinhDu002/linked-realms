import { describe, expect, it } from "vitest";
import { HubError } from "./hub.ts";
import { registerErrorText } from "./messages.ts";
import { LockedError } from "./vault.ts";

describe("registerErrorText", () => {
  it("explains each refusal of POST /lands", () => {
    expect(registerErrorText(new HubError(403, "x"))).toMatch(/LAND_OWNER/);
    expect(registerErrorText(new HubError(409, "x"))).toMatch(/already serves/);
    expect(registerErrorText(new HubError(429, "x"))).toMatch(/3 at most/);
  });

  it("passes other Hub messages on, and knows a locked Shell", () => {
    expect(registerErrorText(new HubError(400, "bad Delegation"))).toBe(
      "bad Delegation",
    );
    expect(registerErrorText(new LockedError())).toMatch(/locked/);
  });
});
