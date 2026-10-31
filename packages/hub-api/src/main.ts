import { Resolver } from "node:dns/promises";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Key } from "@linked-realms/core";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { clientAddressOf } from "./network.ts";
import { sweep } from "./sweep.ts";

const SWEEP_MS = 15_000;

const config = loadConfig();
const log = (message: string) => console.error(`hub-api: ${message}`);
const db = createPool(config.databaseUrl, log);
await migrate(db);

const ticketKey = Key.fromSeed(config.ticketSeed);
config.ticketSeed.fill(0);

async function online(): Promise<number[]> {
  const res = await fetch(`${config.relayInternalUrl}/online`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) throw new Error(`relay /online answered ${res.status}`);
  const body = (await res.json()) as { lands?: unknown };
  if (
    !Array.isArray(body.lands) ||
    !body.lands.every((n) => Number.isSafeInteger(n))
  )
    throw new Error("relay /online returned an unexpected body");
  return body.lands as number[];
}

// Own domains' TXT records (docs/protocols/map-server-hub-relay.md, Land URLs)
const resolver = new Resolver({ timeout: 2000, tries: 2 });
const resolveTxt = (name: string) => resolver.resolveTxt(name);

const app = createApp({
  config,
  db,
  online,
  ticketKey,
  clientAddress: (c) =>
    clientAddressOf(
      config.trustedProxies,
      getConnInfo(c).remote.address ?? "",
      c.req.header("X-Forwarded-For"),
    ),
  now: Date.now,
  log,
  resolveTxt,
});

let sweeping = false;
async function runSweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await sweep({ db, online, now: Date.now, log, resolveTxt });
  } catch (err) {
    log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    sweeping = false;
  }
}
void runSweep();
setInterval(() => void runSweep(), SWEEP_MS);

serve({ fetch: app.fetch, port: config.port }, (info) =>
  console.log(
    `hub-api listening on :${info.port}; Travel tickets signed by ${ticketKey.address}`,
  ),
);
