// Response headers for the Shell's pages. Caddy sends the same ones in production (item 9);
// vite.config.ts sets them for `vite` and `vite preview`, so the browser tests run under them.

/**
 * `connect-src` names the Hub and the Public node, the only servers the Shell calls.
 * `frame-src` is broad because own domains are not known in advance; what limits frames is that
 * `src` comes only from the Directory. The `http://*.localhost:*` source is for development.
 * `dev` adds what Vite's dev server needs (injected styles and its WebSocket).
 */
/** The origin of `url`, or an error naming the build setting it came from. */
function originOf(setting: string, url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new Error(`${setting} is not a URL: "${url}"`);
  }
}

export function contentSecurityPolicy(
  hubUrl: string,
  nodeUrl: string,
  dev = false,
): string {
  const hub = originOf("VITE_HUB_URL", hubUrl);
  const node = originOf("VITE_NODE_URL", nodeUrl);
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    dev ? "style-src 'self' 'unsafe-inline'" : undefined,
    `connect-src 'self' ${hub} ${node}${dev ? " ws://localhost:* ws://127.0.0.1:*" : ""}`,
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
  nodeUrl: string,
  dev = false,
): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(hubUrl, nodeUrl, dev),
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}
