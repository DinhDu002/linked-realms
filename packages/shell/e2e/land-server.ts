// A hostile Land: it serves the same page for every `<id>.localhost` and lets the tests drive it
// from inside the frame. Like the relay, it answers with `frame-ancestors <Shell origin>`.
import type { IncomingMessage, ServerResponse } from "node:http";
import { LAND_PORT, SHELL_ORIGIN } from "./ports.ts";
import { listenOnLoopbacks } from "./listen.ts";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>A hostile Land</title>
<body style="margin:0">
<div id="cover" style="position:fixed;top:-500vh;left:-500vw;width:1000vw;height:1000vh;z-index:2147483647;background:#303"></div>
<script>
  // Everything the Land receives from the Shell, and what it can reach.
  const land = (window.land = { log: [], port: null, clicks: 0 });
  addEventListener("message", (e) => {
    if (e.source === parent && e.data && e.data.type === "linked-realms/connect" && !land.port) {
      land.port = e.ports[0];
      land.connect = { api: e.data.api, origin: e.origin };
      land.port.onmessage = (m) => land.log.push(m.data);
    }
  });
  document.addEventListener("click", () => land.clicks++, true);
  land.send = (m) => land.port.postMessage(m);
  land.count = (type, id) =>
    land.log.filter((m) => m.type === type && (id === undefined || m.id === id)).length;
  // What a Land tries against the page around it.
  land.probe = async () => {
    const attempt = (f) => { try { return String(f()); } catch (e) { return e.name; } };
    const dbs = await indexedDB.databases();
    return {
      parentDocument: attempt(() => parent.document.title),
      parentIndexedDB: attempt(() => parent.indexedDB.databases),
      parentSessionStorage: attempt(() => parent.sessionStorage.length),
      parentLocalStorage: attempt(() => parent.localStorage.length),
      parentLocation: attempt(() => parent.location.href),
      topDocument: attempt(() => top.document.title),
      ownDatabases: dbs.map((d) => d.name),
      ownCookies: document.cookie,
      ownSessionKeys: Object.keys(sessionStorage),
      ownLocalKeys: Object.keys(localStorage),
    };
  };
  // Messages from other windows and origins: the page, the top window and a nested frame.
  land.shout = (m) => {
    parent.postMessage(m, "*");
    top.postMessage(m, "*");
    const nested = document.createElement("iframe");
    nested.src = "http://9.localhost:${LAND_PORT}/nested?m=" + encodeURIComponent(JSON.stringify(m));
    document.body.append(nested);
  };
  // The old document lives on until the new one commits; connectedFrame must not take it.
  land.reload = () => { land.reloading = true; location.reload(); };
</script>
`;

const NESTED = `<!doctype html><script>
  const m = JSON.parse(new URLSearchParams(location.search).get("m"));
  top.postMessage(m, "*"); parent.postMessage(m, "*");
</script>`;

export async function startLandServer(): Promise<() => void> {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const nested = path === "/nested"; // framed by the Land itself, so no frame-ancestors
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      ...(nested
        ? {}
        : { "Content-Security-Policy": `frame-ancestors ${SHELL_ORIGIN}` }),
    });
    res.end(nested ? NESTED : PAGE);
  };
  return listenOnLoopbacks(handler, LAND_PORT);
}
