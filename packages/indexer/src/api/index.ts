import { db, publicClients } from "ponder:api";
import schema from "ponder:schema";
import { Hono } from "hono";
import { client, desc, graphql } from "ponder";
import { deploymentFor, goldMineAbi } from "@linked-realms/shared";
import {
  computeDashboard,
  countOnline,
  renderDashboard,
} from "../dashboard.ts";

// Same as ponder.config.ts
const chainId = Number(process.env.CHAIN_ID ?? 31337);
const hubUrl = process.env.HUB_URL?.replace(/\/$/, "");
// The winner distribution covers this many of the newest won Rounds.
const WIN_SAMPLE = 1000;

/** From the Hub's Directory; undefined (shown as "unknown") without HUB_URL or an answer in 2 s. */
async function landsOnline(): Promise<number | undefined> {
  if (!hubUrl) return undefined;
  try {
    const res = await fetch(`${hubUrl}/directory`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? countOnline(await res.json()) : undefined;
  } catch {
    return undefined;
  }
}

const app = new Hono();

app.use("/graphql", graphql({ db, schema }));
app.use("/sql/*", client({ db, schema }));

app.get("/dashboard", async (c) => {
  const [wins, lands, target, online] = await Promise.all([
    db
      .select({
        rewardWallet: schema.roundWon.rewardWallet,
        timestamp: schema.roundWon.timestamp,
      })
      .from(schema.roundWon)
      .orderBy(desc(schema.roundWon.round))
      .limit(WIN_SAMPLE),
    // ponytail: reads every Land per request; cache it once Lands number in the thousands
    db
      .select({ id: schema.land.id, owner: schema.land.owner })
      .from(schema.land),
    publicClients.main.readContract({
      address: deploymentFor(chainId).GoldMine.address,
      abi: goldMineAbi,
      functionName: "target",
    }),
    landsOnline(),
  ]);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  return c.html(
    renderDashboard(
      computeDashboard({
        nowSeconds,
        target,
        wins,
        lands,
        landsOnline: online,
      }),
      { chainId, nowSeconds },
    ),
  );
});

export default app;
