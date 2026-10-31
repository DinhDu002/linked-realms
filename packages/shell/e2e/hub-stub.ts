// A small stand-in for the Hub (packages/hub-api): the routes the Shell uses, with real checks
// on every signed statement, and a few fixed Lands. `GET /__state` shows what it was asked.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Key } from "@linked-realms/core";
import { signStatement, verifyStatement } from "@linked-realms/shared/identity";
import { HUB_PORT, LAND_PORT, SHELL_ORIGIN } from "./ports.ts";
import { listenOnLoopbacks } from "./listen.ts";

/** A development key, like the one in compose.yaml: it grants entry to nothing. */
const TICKET_KEY_SEED = new Uint8Array(32).fill(0x48);
export const MAP_SERVER_KEY_SEED = new Uint8Array(32).fill(0x4d);
const HUB_HOST = `localhost:${HUB_PORT}`;

interface Land {
  landId: number;
  owner: string;
  ownerName: string;
  x: number;
  y: number;
  online: boolean;
}

/** Land 1 and 2 are neighbours (1 is west of 2); 3 is west of 1 and offline. */
const LANDS: Land[] = [
  {
    landId: 1,
    owner: "tlr1owner1",
    ownerName: "Mai",
    x: 0,
    y: 0,
    online: true,
  },
  {
    landId: 2,
    owner: "tlr1owner2",
    ownerName: "A very long owner name ".repeat(8).trim(),
    x: 1,
    y: 0,
    online: true,
  },
  {
    landId: 3,
    owner: "tlr1owner3",
    ownerName: "Bo",
    x: -1,
    y: 0,
    online: false,
  },
];

const landInfo = (l: Land, mapServerKey: string) => ({
  ...l,
  url: `http://${l.landId}.localhost:${LAND_PORT}`,
  mapServerKey,
  domain: null,
});

export async function startHubStub(): Promise<() => void> {
  const ticketKey = Key.fromSeed(TICKET_KEY_SEED);
  const waiting = Key.fromSeed(MAP_SERVER_KEY_SEED);
  const sessions = new Map<string, string>();
  const usedNonces = new Set<string>();
  const names = new Map<string, string>();
  /** The Land each owner registered (Land 9, which has no cell). */
  const ownLands = new Map<
    string,
    { landId: number; mapServerKey: string; domain: string | null }
  >();
  const state = {
    signIns: {} as Record<string, number>,
    tickets: [] as { landId: number; from?: number; character: string }[],
    reports: [] as { landId: number; reason: string; reporter: string }[],
    delegations: [] as unknown[],
    names: {} as Record<string, string>,
    sessionTokens: [] as string[],
  };

  async function readBody<T = unknown>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return (
      chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    ) as T;
  }

  function sessionOf(req: IncomingMessage): string | undefined {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    return token === undefined ? undefined : sessions.get(token);
  }

  async function route(
    req: IncomingMessage,
    send: (status: number, body: unknown) => void,
  ) {
    const url = new URL(req.url ?? "/", `http://${HUB_HOST}`);
    const path = url.pathname;
    const route = `${req.method} ${path}`;
    if (route === "GET /health") return send(200, { ok: true });
    if (route === "GET /__state")
      return send(200, { ...state, names: Object.fromEntries(names) });
    if (route === "POST /__forget-land") {
      ownLands.delete(url.searchParams.get("owner") ?? "");
      return send(200, { ok: true });
    }
    if (route === "GET /directory")
      return send(200, { lands: LANDS.map((l) => landInfo(l, "tlr1ms")) });

    if (route === "POST /auth/verify") {
      let verified;
      try {
        verified = verifyStatement(await readBody(req), "hub-sign-in");
      } catch (e) {
        return send(401, { error: (e as Error).message });
      }
      const { fields, address } = verified;
      const now = Math.floor(Date.now() / 1000);
      if (fields.hub !== HUB_HOST) return send(401, { error: "another Hub" });
      if (Math.abs(fields.issued - now) > 60)
        return send(401, { error: "Issued is off the Hub's clock" });
      if (usedNonces.has(fields.nonce))
        return send(401, { error: "already used" });
      usedNonces.add(fields.nonce);
      const token = crypto.randomUUID();
      sessions.set(token, address);
      state.signIns[address] = (state.signIns[address] ?? 0) + 1;
      state.sessionTokens.push(token);
      return send(200, {
        token,
        address,
        name: names.get(address) ?? "",
        expiresAt: now + 3600,
      });
    }

    if (route === "GET /lands") {
      const owner = url.searchParams.get("owner");
      const own = owner ? ownLands.get(owner) : undefined;
      if (own)
        return send(200, {
          landId: own.landId,
          owner,
          ownerName: names.get(owner!) ?? "",
          x: null,
          y: null,
          url: own.domain
            ? `https://${own.domain}`
            : `http://${own.landId}.localhost:${LAND_PORT}`,
          mapServerKey: own.mapServerKey,
          online: false,
          domain: own.domain,
        });
      return send(404, { error: "Land not found" });
    }
    if (route === "POST /lands") {
      let verified;
      try {
        verified = verifyStatement(await readBody(req), "delegation");
      } catch (e) {
        return send(400, { error: (e as Error).message });
      }
      if (verified.fields.mapServerKey !== waiting.address)
        return send(403, { error: "not named by that Map server" });
      state.delegations.push(verified.fields);
      ownLands.set(verified.fields.owner, {
        landId: 9,
        mapServerKey: waiting.address,
        domain: null,
      });
      return send(201, { landId: 9 });
    }

    // Everything below needs a session.
    const address = sessionOf(req);
    if (!address) return send(401, { error: "sign-in required" });

    if (route === "PUT /me/name") {
      const { name } = await readBody<{ name?: unknown }>(req);
      if (typeof name !== "string" || name === "")
        return send(400, { error: "bad name" });
      names.set(address, name);
      return send(200, { name });
    }
    const own = ownLands.get(address);
    if (own && route === `PUT /lands/${own.landId}/domain`) {
      // Only play.example has its TXT record here.
      const { domain } = await readBody<{ domain: string | null }>(req);
      const name = domain?.toLowerCase() ?? null;
      if (name !== null && name !== "play.example")
        return send(409, {
          error: `add the DNS TXT record _linked-realms.${name} with the value land=${own.landId}, then try again`,
        });
      own.domain = name;
      return send(200, { domain: name });
    }
    if (route === "GET /map-servers")
      return send(200, {
        mapServers: ownLands.has(address)
          ? []
          : [{ mapServerKey: waiting.address, issued: 1 }],
      });
    if (route === "POST /reports") {
      const { landId, reason } = await readBody<{
        landId: number;
        reason: string;
      }>(req);
      state.reports.push({ landId, reason, reporter: address });
      return send(201, { ok: true });
    }
    if (route === "POST /tickets") {
      const { landId, from } = await readBody<{
        landId: number;
        from?: number;
      }>(req);
      const target = LANDS.find((l) => l.landId === landId);
      if (!target) return send(404, { error: "Land not found" });
      if (!target.online) return send(409, { error: "Land is offline" });
      let gate = 0;
      if (from !== undefined) {
        const origin = LANDS.find((l) => l.landId === from);
        const dx = target.x - (origin?.x ?? 99);
        const dy = target.y - (origin?.y ?? 99);
        gate =
          (
            { "1,0": 4, "-1,0": 2, "0,1": 1, "0,-1": 3 } as Record<
              string,
              number
            >
          )[`${dx},${dy}`] ?? -1;
        if (gate < 0) return send(409, { error: "Lands are not adjacent" });
      }
      state.tickets.push({ landId, from, character: address });
      const issued = Math.floor(Date.now() / 1000);
      return send(
        200,
        signStatement(
          "travel-ticket",
          {
            hub: HUB_HOST,
            character: address,
            name: names.get(address) ?? "",
            land: landId,
            gate,
            issued,
            expires: issued + 60,
            nonce: Buffer.from(
              crypto.getRandomValues(new Uint8Array(16)),
            ).toString("hex"),
          },
          ticketKey,
        ),
      );
    }
    return send(404, { error: "not found" });
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const cors = {
      "Access-Control-Allow-Origin": SHELL_ORIGIN,
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    route(req, (status, body) => {
      res
        .writeHead(status, { ...cors, "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    }).catch((e) => {
      res.writeHead(500, cors).end(String(e));
    });
  };
  return listenOnLoopbacks(handler, HUB_PORT);
}
