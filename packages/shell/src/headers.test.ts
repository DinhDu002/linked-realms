import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, shellHeaders } from "./headers.ts";

describe("headers", () => {
  it("has the policy of the plan, with the Hub's and the Public node's origins", () => {
    expect(
      contentSecurityPolicy(
        "https://hub.example.org/",
        "https://rpc.example.org/",
      ),
    ).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://hub.example.org https://rpc.example.org; frame-src https: http://*.localhost:*; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
    );
  });

  it("keeps the strict policy for `vite preview` and relaxes only styles and the WebSocket for `vite`", () => {
    const dev = contentSecurityPolicy(
      "http://localhost:8787",
      "http://localhost:9445",
      true,
    );
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("ws://localhost:*");
    expect(dev).toContain("frame-ancestors 'none'");
    expect(
      contentSecurityPolicy("http://localhost:8787", "http://localhost:9445"),
    ).not.toContain("unsafe-inline");
  });

  it("names the build setting that is not a URL", () => {
    // compose builds the Shell with https://${RPC_DOMAIN}, which is "https://" while it is unset
    expect(() =>
      contentSecurityPolicy("https://hub.example.org", "https://"),
    ).toThrow('VITE_NODE_URL is not a URL: "https://"');
  });

  it("isolates the browsing context group", () => {
    expect(
      shellHeaders("http://localhost:8787", "http://localhost:9445"),
    ).toMatchObject({
      "Cross-Origin-Opener-Policy": "same-origin",
    });
  });
});
