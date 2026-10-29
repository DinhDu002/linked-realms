// Response headers for the Shell's pages. Caddy sends the same ones in production (item 9);
// vite.config.ts sets them for `vite` and `vite preview`, so the browser tests run under them.

/**
 * `frame-src` is broad because own domains are not known in advance; what limits frames is that
 * `src` comes only from the Directory. The `http://*.localhost:*` source is for development.
 * `dev` adds what Vite's dev server needs (injected styles and its WebSocket).
 */
export function contentSecurityPolicy(hubUrl: string, dev = false): string {
  const hub = new URL(hubUrl).origin;
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    dev ? "style-src 'self' 'unsafe-inline'" : undefined,
    `connect-src 'self' ${hub}${dev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
    "frame-src https: http://*.localhost:*",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ]
    .filter(Boolean)
    .join("; ");
}

export function shellHeaders(
  hubUrl: string,
  dev = false,
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(hubUrl, dev),
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
