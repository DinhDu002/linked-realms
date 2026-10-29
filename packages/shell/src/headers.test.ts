import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, shellHeaders } from "./headers.ts";

describe("headers", () => {
  it("has the policy of the plan, with the Hub's origin", () => {
    expect(contentSecurityPolicy("https://hub.example.org/")).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://hub.example.org; frame-src https: http://*.localhost:*; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    );
  });

  it("keeps the strict policy for `vite preview` and relaxes only styles and the WebSocket for `vite`", () => {
    const dev = contentSecurityPolicy("http://localhost:8787", true);
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("ws://localhost:*");
    expect(dev).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy("http://localhost:8787")).not.toContain(
      "unsafe-inline",
    );
  });

  it("isolates the browsing context group", () => {
    expect(shellHeaders("http://localhost:8787")).toMatchObject({
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });
});
