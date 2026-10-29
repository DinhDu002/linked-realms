import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import { isAddress, type Key } from "@linked-realms/core";
import {
  DIRECTIONS,
  GATE_NONE,
  TRAVEL_TICKET_TTL_SECONDS,
  arrivalGate,
  gateNumber,
  neighbourOf,
  spiralCoordinates,
  type LandDirectory,
  type LandInfo,
} from "@linked-realms/shared";
import {
  NAME_MAX_CODE_POINTS,
  StatementError,
  isName,
  signStatement,
  toBase64,
  verifyStatement,
  type StatementKind,
} from "@linked-realms/shared/identity";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { networkOf } from "./network.ts";

export interface Deps {
  config: Pick<
    Config,
    | "hubDomain"
    | "sessionSecret"
    | "admins"
    | "allowedOrigins"
    | "landBaseDomain"
    | "landUrlScheme"
  >;
  db: Db;
  /** Ids of Lands whose Map server link to the relay is open; rejects when the relay is unreachable. */
  online(): Promise<number[]>;
  /** Signs Travel tickets. */
  ticketKey: Key;
  /** The address the request comes from. Production: the socket's peer, behind HUB_TRUSTED_PROXIES. */
  clientAddress(c: Context): string;
  /** Milliseconds since the epoch. */
  now(): number;
  log(message: string): void;
}

const SESSION_SECONDS = 3600;
// a sign-in is accepted while Issued is this close to the Hub's clock (whole seconds), so a
// statement is usable for just under 2 × skew + 1 seconds; its nonce is kept that long, after
// which the statement is refused for its time anyway
const SIGN_IN_SKEW_SECONDS = 60;
const SIGN_IN_NONCE_TTL_MS = (2 * SIGN_IN_SKEW_SECONDS + 1) * 1000;
const MAX_SIGN_IN_NONCES = 100_000;
// Map server statements and Delegations (docs/protocols/map-server-hub-relay.md)
const STATEMENT_SKEW_SECONDS = 5 * 60;
const NEW_LANDS_PER_NETWORK_PER_DAY = 3;
const ONLINE_CACHE_MS = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_BODY_BYTES = 16 * 1024;
const DAY_MS = 86_400_000;

class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 429;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function landIdOf(value: unknown): number {
  const n =
    typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(n) || (n as number) < 1)
    throw new HttpError(400, "invalid landId");
  return n as number;
}

async function jsonBody(req: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError(400, "body must be a JSON object");
  return body as Record<string, unknown>;
}

/** Verifies a signed statement (identity.md); a refusal answers `status`. */
function statementOf<K extends StatementKind>(
  body: unknown,
  kind: K,
  status: 400 | 401,
) {
  try {
    return verifyStatement(body, kind);
  } catch (err) {
    if (err instanceof StatementError) throw new HttpError(status, err.message);
    throw err;
  }
}

/** A unique index refused the write: someone else holds that owner, key or cell. */
async function unique<T>(write: () => Promise<T>, message: string) {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: unknown }).code === "23505")
      throw new HttpError(409, message);
    throw err;
  }
}

/** Sliding window per key, in memory: one process only (ponytail: Redis counters with several nodes). */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number): boolean => {
    // keys are free for callers to mint (addresses, networks): drop idle ones so the map stays bounded
    if (hits.size > 10_000)
      for (const [k, times] of hits)
        if (now - (times.at(-1) ?? 0) >= windowMs) hits.delete(k);
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

interface LandRow {
  id: number | string;
  owner: string;
  map_server_key: string;
  cell: number | null;
  name: string | null;
}

const LAND_COLUMNS =
  "SELECT l.id, l.owner, l.map_server_key, l.cell, c.name FROM land l LEFT JOIN character c ON c.address = l.owner";

export function createApp(deps: Deps) {
  const { config, db } = deps;
  const app = new Hono<{ Variables: { address: string } }>();

  // nonce -> expiry of verified sign-ins, in memory: one process only (ponytail: shared store with several nodes)
  const usedNonces = new Map<string, number>();
  const signInLimit = rateLimiter(30, 60_000);
  const mapServerLimit = rateLimiter(10, 60_000);
  const landLimit = rateLimiter(10, 60_000);
  const ticketLimit = rateLimiter(30, 60_000);
  const reportLimit = rateLimiter(5, 3_600_000);
  const ticketKey = {
    address: deps.ticketKey.address,
    publicKey: toBase64(deps.ticketKey.publicKey),
  };

  // Relay presence, cached 2 s. A failure counts as "all offline" and is logged once per burst.
  let presence: { at: number; lands: Promise<Set<number>> } | undefined;
  let relayFailing = false;
  function onlineLands(): Promise<Set<number>> {
    const now = deps.now();
    if (!presence || now - presence.at >= ONLINE_CACHE_MS)
      presence = {
        at: now,
        lands: deps.online().then(
          (lands) => {
            relayFailing = false;
            return new Set(lands);
          },
          (err: unknown) => {
            if (!relayFailing)
              deps.log(
                `relay presence unavailable, showing all Lands offline: ${err instanceof Error ? err.message : String(err)}`,
              );
            relayFailing = true;
            return new Set<number>();
          },
        ),
      };
    return presence.lands;
  }

  const network = (c: Context) => networkOf(deps.clientAddress(c));
  const seconds = () => Math.floor(deps.now() / 1000);

  function landInfo(row: LandRow, online: Set<number>): LandInfo {
    const landId = Number(row.id);
    const cell = row.cell === null ? null : spiralCoordinates(row.cell);
    return {
      landId,
      owner: row.owner,
      ownerName: row.name ?? "",
      x: cell?.x ?? null,
      y: cell?.y ?? null,
      url: `${config.landUrlScheme}://${landId}.${config.landBaseDomain}`,
      mapServerKey: row.map_server_key,
      online: online.has(landId),
    };
  }

  /** The visible Land matching `where` (on alias `l`, one parameter $1). */
  async function landWhere(where: string, value: unknown) {
    return (
      await db.query<LandRow>(
        `${LAND_COLUMNS} WHERE NOT l.hidden AND ${where}`,
        [value],
      )
    ).rows[0];
  }

  /** Throws unless the statement names this Hub and its time is close to the Hub's clock. */
  function checkHubAndTime(fields: { hub: string; issued: number }) {
    if (fields.hub !== config.hubDomain)
      throw new HttpError(400, "the statement names another Hub");
    if (Math.abs(fields.issued - seconds()) > STATEMENT_SKEW_SECONDS)
      throw new HttpError(
        400,
        "Issued is more than 5 minutes off the Hub's clock",
      );
  }

  app.use(
    cors({
      origin: (origin) =>
        config.allowedOrigins.includes(origin) ? origin : null,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    }),
  );
  app.use(
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "request too large" }, 413),
    }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: err.message }, err.status);
    deps.log(
      `unhandled error: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`,
    );
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/health", (c) => c.text("ok"));

  app.get("/keys", (c) => c.json({ ticket: ticketKey }));

  // --- Sign-in (docs/plans/phase-2b-world-without-chain.md, flow 2) ---

  app.post("/auth/verify", async (c) => {
    if (!signInLimit(network(c), deps.now()))
      throw new HttpError(429, "too many sign-ins");
    const { fields, address } = statementOf(
      await jsonBody(c.req),
      "hub-sign-in",
      401,
    );
    if (fields.hub !== config.hubDomain)
      throw new HttpError(401, "the statement names another Hub");
    const now = deps.now();
    const iat = Math.floor(now / 1000);
    if (Math.abs(fields.issued - iat) > SIGN_IN_SKEW_SECONDS)
      throw new HttpError(
        401,
        `Issued is more than ${SIGN_IN_SKEW_SECONDS} seconds off the Hub's clock`,
      );
    // same TTL for all, so insertion order is expiry order
    for (const [n, expires] of usedNonces) {
      if (expires > now) break;
      usedNonces.delete(n);
    }
    if (usedNonces.has(fields.nonce))
      throw new HttpError(401, "this sign-in statement was already used");
    if (usedNonces.size >= MAX_SIGN_IN_NONCES)
      throw new HttpError(429, "too many sign-ins, try again shortly");
    usedNonces.set(fields.nonce, now + SIGN_IN_NONCE_TTL_MS);
    const expiresAt = iat + SESSION_SECONDS;
    const token = await sign(
      { sub: address, iat, exp: expiresAt },
      config.sessionSecret,
      "HS256",
    );
    const name = (
      await db.query<{ name: string }>(
        "SELECT name FROM character WHERE address = $1",
        [address],
      )
    ).rows[0]?.name;
    return c.json({ token, address, name: name ?? "", expiresAt });
  });

  const session = createMiddleware<{ Variables: { address: string } }>(
    async (c, next) => {
      const header = c.req.header("Authorization") ?? "";
      const token = /^Bearer (\S+)$/.exec(header)?.[1];
      if (!token) throw new HttpError(401, "sign-in required");
      let sub: unknown;
      try {
        sub = (await verify(token, config.sessionSecret, "HS256")).sub;
      } catch {
        throw new HttpError(401, "invalid or expired session");
      }
      if (typeof sub !== "string" || !isAddress(sub))
        throw new HttpError(401, "invalid or expired session");
      c.set("address", sub);
      await next();
    },
  );
  const admin = createMiddleware<{ Variables: { address: string } }>(
    async (c, next) => {
      if (!config.admins.includes(c.get("address")))
        throw new HttpError(403, "admin only");
      await next();
    },
  );
  app.use("/admin/*", session, admin);

  app.put("/me/name", session, async (c) => {
    const body = await jsonBody(c.req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || !isName(name))
      throw new HttpError(
        400,
        `name must be 1 to ${NAME_MAX_CODE_POINTS} characters, without control or format characters`,
      );
    await db.query(
      `INSERT INTO character (address, name, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at`,
      [c.get("address"), name, seconds()],
    );
    return c.json({ name });
  });

  // --- Registering a Land (docs/protocols/map-server-hub-relay.md) ---

  app.post("/map-servers", async (c) => {
    if (!mapServerLimit(network(c), deps.now()))
      throw new HttpError(429, "too many Map server statements");
    const body = await jsonBody(c.req);
    const { fields } = statementOf(body, "map-server", 400);
    checkHubAndTime(fields);
    // the newest statement per key wins; sending the same one again is fine
    const saved = await db.query(
      `INSERT INTO map_server (key, owner, statement, public_key, signature, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, statement = EXCLUDED.statement,
         public_key = EXCLUDED.public_key, signature = EXCLUDED.signature, issued_at = EXCLUDED.issued_at
       WHERE map_server.issued_at < EXCLUDED.issued_at OR map_server.statement = EXCLUDED.statement
       RETURNING key`,
      [
        fields.mapServerKey,
        fields.owner,
        body.statement,
        body.publicKey,
        body.signature,
        fields.issued,
      ],
    );
    if (saved.rows.length === 0)
      throw new HttpError(409, "a newer statement from this key exists");
    return c.body(null, 204);
  });

  app.get("/map-servers", session, async (c) => {
    if (c.req.query("owner") !== c.get("address"))
      throw new HttpError(
        403,
        "you can list only the Map servers that named you",
      );
    const rows = (
      await db.query<{ key: string; issued_at: number | string }>(
        `SELECT key, issued_at FROM map_server m
         WHERE owner = $1 AND NOT EXISTS (SELECT 1 FROM land WHERE map_server_key = m.key)
         ORDER BY issued_at DESC`,
        [c.get("address")],
      )
    ).rows;
    return c.json({
      mapServers: rows.map((r) => ({
        mapServerKey: r.key,
        issued: Number(r.issued_at),
      })),
    });
  });

  /** Adds one to the network's count of new Lands today unless it is at the limit. */
  async function countLand(network: string, day: number) {
    const { rows } = await db.query(
      `INSERT INTO land_quota (network, day, count) VALUES ($1, $2, 1)
       ON CONFLICT (network, day) DO UPDATE SET count = land_quota.count + 1
       WHERE land_quota.count < $3
       RETURNING count`,
      [network, day, NEW_LANDS_PER_NETWORK_PER_DAY],
    );
    return rows.length > 0;
  }

  app.post("/lands", async (c) => {
    const net = network(c);
    if (!landLimit(net, deps.now()))
      throw new HttpError(429, "too many Delegations");
    const body = await jsonBody(c.req);
    const { fields } = statementOf(body, "delegation", 400);
    checkHubAndTime(fields);
    const named = (
      await db.query<{ owner: string }>(
        "SELECT owner FROM map_server WHERE key = $1",
        [fields.mapServerKey],
      )
    ).rows[0];
    // the key's holder must have named this owner, so nobody can claim another's Map server
    if (named?.owner !== fields.owner)
      throw new HttpError(
        403,
        "this Map server key has not named this owner (POST /map-servers)",
      );
    const serving = (
      await db.query<{ owner: string }>(
        "SELECT owner FROM land WHERE map_server_key = $1",
        [fields.mapServerKey],
      )
    ).rows[0];
    if (serving && serving.owner !== fields.owner)
      throw new HttpError(409, "this Map server key serves another Land");
    const values = [
      fields.owner,
      fields.mapServerKey,
      body.statement,
      body.publicKey,
      body.signature,
      fields.issued,
      seconds(),
    ];
    const conflict = "this owner or Map server key already has a Land";

    const existing = (
      await db.query("SELECT 1 FROM land WHERE owner = $1", [fields.owner])
    ).rows.length;
    if (existing) {
      // A newer Delegation from the same owner replaces the key; it is not a new Land.
      // The registered one sent again is answered the same way, so a retry is safe.
      const { rows } = await unique(
        () =>
          db.query<{ id: number | string }>(
            `UPDATE land SET map_server_key = $2, statement = $3, public_key = $4, signature = $5,
               issued_at = $6, updated_at = $7
             WHERE owner = $1 AND (issued_at < $6 OR statement = $3) RETURNING id`,
            values,
          ),
        conflict,
      );
      if (rows.length === 0)
        throw new HttpError(409, "a newer Delegation is already registered");
      return c.json({ landId: Number(rows[0]!.id) });
    }
    const day = Math.floor(deps.now() / DAY_MS);
    if (!(await countLand(net, day)))
      throw new HttpError(
        429,
        `at most ${NEW_LANDS_PER_NETWORK_PER_DAY} new Lands per network address per day`,
      );
    try {
      const { rows } = await unique(
        () =>
          db.query<{ id: number | string }>(
            `INSERT INTO land (owner, map_server_key, statement, public_key, signature, issued_at,
               created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
            values,
          ),
        conflict,
      );
      return c.json({ landId: Number(rows[0]!.id) }, 201);
    } catch (err) {
      // no Land was made: give the count back
      await db.query(
        "UPDATE land_quota SET count = count - 1 WHERE network = $1 AND day = $2",
        [net, day],
      );
      throw err;
    }
  });

  // --- Lands and the Directory ---

  app.get("/lands/:landId", async (c) => {
    const row = await landWhere("l.id = $1", landIdOf(c.req.param("landId")));
    if (!row) throw new HttpError(404, "Land not found");
    return c.json(landInfo(row, await onlineLands()));
  });

  app.get("/lands", async (c) => {
    const { owner, mapServerKey } = c.req.query();
    if ((owner === undefined) === (mapServerKey === undefined))
      throw new HttpError(400, "give exactly one of owner and mapServerKey");
    const address = owner ?? mapServerKey ?? "";
    if (!isAddress(address)) throw new HttpError(400, "invalid address");
    const row = await landWhere(
      owner === undefined ? "l.map_server_key = $1" : "l.owner = $1",
      address,
    );
    if (!row) throw new HttpError(404, "Land not found");
    return c.json(landInfo(row, await onlineLands()));
  });

  app.get("/directory", async (c) => {
    const rows = (
      await db.query<LandRow>(
        `${LAND_COLUMNS} WHERE NOT l.hidden AND l.cell IS NOT NULL ORDER BY l.id`,
      )
    ).rows;
    const online = await onlineLands();
    const directory = {
      lands: rows.map((r) => landInfo(r, online)),
    } as LandDirectory;
    c.header("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
    return c.json(directory);
  });

  // --- Travel tickets (docs/protocols/gate-travel.md) ---

  app.post("/tickets", session, async (c) => {
    const address = c.get("address");
    if (!ticketLimit(address, deps.now()))
      throw new HttpError(429, "too many ticket requests");
    const body = await jsonBody(c.req);
    const landId = landIdOf(body.landId);
    const from = body.from === undefined ? undefined : landIdOf(body.from);
    if (from === landId)
      throw new HttpError(400, "from must differ from landId");

    const target = await landWhere("l.id = $1", landId);
    if (!target) throw new HttpError(404, "Land not found");
    if (target.cell === null) throw new HttpError(409, "Land has no cell yet");
    if (!(await onlineLands()).has(landId))
      throw new HttpError(409, "Land is offline");

    let gate = GATE_NONE;
    if (from !== undefined) {
      const origin = (
        await db.query<{ cell: number | null }>(
          "SELECT cell FROM land WHERE id = $1",
          [from],
        )
      ).rows[0];
      if (!origin) throw new HttpError(404, "origin Land not found");
      const there = spiralCoordinates(target.cell);
      const here = origin.cell === null ? null : spiralCoordinates(origin.cell);
      const direction =
        here &&
        DIRECTIONS.find((d) => {
          const n = neighbourOf(here.x, here.y, d);
          return n.x === there.x && n.y === there.y;
        });
      if (!direction) throw new HttpError(409, "Lands are not adjacent");
      gate = gateNumber(arrivalGate(direction));
    }

    const name = (
      await db.query<{ name: string }>(
        "SELECT name FROM character WHERE address = $1",
        [address],
      )
    ).rows[0]?.name;
    const issued = seconds();
    const ticket = signStatement(
      "travel-ticket",
      {
        hub: config.hubDomain,
        character: address,
        name: name ?? "",
        land: landId,
        gate,
        issued,
        expires: issued + TRAVEL_TICKET_TTL_SECONDS,
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          "hex",
        ),
      },
      deps.ticketKey,
    );
    return c.json(ticket);
  });

  // --- Reports and moderation ---

  app.post("/reports", session, async (c) => {
    const address = c.get("address");
    if (!reportLimit(address, deps.now()))
      throw new HttpError(429, "too many reports");
    const body = await jsonBody(c.req);
    const landId = landIdOf(body.landId);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 1 || reason.length > MAX_REASON_LENGTH)
      throw new HttpError(
        400,
        `reason must be 1 to ${MAX_REASON_LENGTH} characters`,
      );
    const exists = (
      await db.query("SELECT 1 FROM land WHERE id = $1", [landId])
    ).rows.length;
    if (!exists) throw new HttpError(404, "Land not found");
    await db.query(
      "INSERT INTO report (land_id, reporter, reason, created_at) VALUES ($1, $2, $3, $4)",
      [landId, address, reason, seconds()],
    );
    return c.json({ ok: true }, 201);
  });

  app.get("/admin/reports", async (c) => {
    const rows = (
      await db.query<{
        id: number;
        land_id: string;
        reporter: string;
        reason: string;
        created_at: string;
      }>(
        "SELECT id, land_id, reporter, reason, created_at FROM report WHERE NOT resolved ORDER BY id",
      )
    ).rows;
    return c.json({
      reports: rows.map((r) => ({
        id: r.id,
        landId: Number(r.land_id),
        reporter: r.reporter,
        reason: r.reason,
        createdAt: Number(r.created_at),
      })),
    });
  });

  app.post("/admin/lands/:landId/hidden", async (c) => {
    const landId = landIdOf(c.req.param("landId"));
    const body = await jsonBody(c.req);
    if (typeof body.hidden !== "boolean")
      throw new HttpError(400, "hidden must be a boolean");
    const updated = await db.query(
      "UPDATE land SET hidden = $2, updated_at = $3 WHERE id = $1 RETURNING id",
      [landId, body.hidden, seconds()],
    );
    if (updated.rows.length === 0) throw new HttpError(404, "Land not found");
    deps.log(
      `Land ${landId} ${body.hidden ? "hidden" : "unhidden"} by ${c.get("address")}`,
    );
    return c.json({ landId, hidden: body.hidden });
  });

  return app;
}
