import { createServer } from "node:http";
import { computeDashboard, renderDashboard } from "./dashboard.ts";
import type { Config } from "./config.ts";
import { readInput } from "./read.ts";

/** How long one page is served before the Public node and the Hub are read again. */
export const CACHE_MS = 10_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The dashboard at `/`. Each viewer's page refreshes every 30 seconds; they all share one read. */
export function createDashboardServer(config: Config, now = Date.now) {
  // ponytail: one cached page for everyone; per-viewer pages if the dashboard ever takes options.
  let page: Promise<{ status: number; html: string }> | undefined;
  let readAt = 0;
  const read = async () => {
    try {
      const at = nowSeconds();
      const input = await readInput(config.nodeUrl, config.hubUrl, at);
      return {
        status: 200,
        html: renderDashboard(computeDashboard(input), at),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`dashboard: ${message}`);
      return {
        status: 502,
        html: `<!doctype html><title>Linked Realms dashboard</title><p>The Public node did not answer, so there is nothing to show. Try again shortly.</p>`,
      };
    }
  };
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://dashboard").pathname;
    if (
      path !== "/" ||
      (request.method !== "GET" && request.method !== "HEAD")
    ) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("Not found");
      return;
    }
    if (!page || now() - readAt >= CACHE_MS) {
      readAt = now();
      page = read();
    }
    const { status, html } = await page;
    response
      .writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(request.method === "HEAD" ? undefined : html);
  });
}
