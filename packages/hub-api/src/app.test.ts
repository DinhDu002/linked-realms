import { PGlite } from "@electric-sql/pglite";
import { Key } from "@linked-realms/core";
import { sign } from "hono/jwt";
import {
  signStatement,
  verifyHandoff,
  verifyStatement,
  type SignedStatement,
} from "@linked-realms/shared/identity";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, type Deps } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate, type Db } from "./db.ts";
import { clientAddressOf, trustedProxies } from "./network.ts";
import { CELL_KEPT_OFFLINE_SECONDS, sweep } from "./sweep.ts";

const HUB = "hub.test";
const SECRET = "test-session-secret-0123456789-abcdef";
const DAY_MS = 86_400_000;
const PROXY = "10.0.0.1";

const key = (n: number) => Key.fromSeed(new Uint8Array(32).fill(n));
const hubKey = key(0x48);
const admin = key(0xad);
const owners = [key(1), key(2), key(3), key(4), key(5)];
const mapServers = [key(11), key(12), key(13), key(14), key(15)];
const [owner1, owner2] = owners as [Key, Key];
const [ms1, ms2] = mapServers as [Key, Key];

let db: Db;
let nowMs: number;
let online: number[];
let relayDown: boolean;
let logs: string[];
let onlineCalls: number;
let peer: string;
let deps: Deps;
let app: ReturnType<typeof createApp>;

function pglite(): Db {
  const pg = new PGlite();
  return {
    async query<T>(sql: string, params?: unknown[]) {
      return { rows: (await pg.query<T>(sql, params)).rows };
    },
  };
}

beforeEach(async () => {
  db = pglite();
  await migrate(db);
  // hono/jwt checks a token's expiry against the real clock
  nowMs = Date.now();
  online = [];
  relayDown = false;
  logs = [];
  onlineCalls = 0;
  peer = "203.0.113.5";
  const trusted = trustedProxies([PROXY]);
  deps = {
    config: {
      hubDomain: HUB,
      sessionSecret: SECRET,
      admins: [admin.address],
      allowedOrigins: ["https://shell.test"],
      landBaseDomain: "lands.test",
      landUrlScheme: "https",
    },
    db,
    async online() {
      onlineCalls++;
      if (relayDown) throw new Error("relay down");
      return online;
    },
    ticketKey: hubKey,
    clientAddress: (c) =>
      clientAddressOf(trusted, peer, c.req.header("X-Forwarded-For")),
    now: () => nowMs,
    log: (m) => logs.push(m),
  };
  app = createApp(deps);
});

const seconds = () => Math.floor(nowMs / 1000);
const nonce = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

async function req(
  method: string,
  path: string,
  opts: {
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await app.request(path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads arbitrary JSON
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

const signInStatement = (k: Key, fields = {}) =>
  signStatement(
    "hub-sign-in",
    { hub: HUB, nonce: nonce(), issued: seconds(), ...fields },
    k,
  );

async function signIn(k: Key): Promise<string> {
  const res = await req("POST", "/auth/verify", { body: signInStatement(k) });
  expect(res.status).toBe(200);
  return res.json.token;
}

const mapServerStatement = (ms: Key, owner: Key, fields = {}) =>
  signStatement(
    "map-server",
    {
      hub: HUB,
      owner: owner.address,
      mapServerKey: ms.address,
      issued: seconds(),
      ...fields,
    },
    ms,
  );

const delegation = (owner: Key, ms: Key, fields = {}) =>
  signStatement(
    "delegation",
    {
      hub: HUB,
      owner: owner.address,
      mapServerKey: ms.address,
      issued: seconds(),
      ...fields,
    },
    owner,
  );

/** The Map server names its owner, then the owner signs a Delegation. Returns the Land id. */
async function register(owner: Key, ms: Key): Promise<number> {
  expect(
    (await req("POST", "/map-servers", { body: mapServerStatement(ms, owner) }))
      .status,
  ).toBe(204);
  const res = await req("POST", "/lands", { body: delegation(owner, ms) });
  expect(res.status).toBe(201);
  return res.json.landId;
}

/** Registers Lands, brings them online and gives them cells (in id order: 0, 1, 2, ...). */
async function world(n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    // one network each, so the daily limit does not apply
    peer = `198.51.100.${i + 1}`;
    ids.push(await register(owners[i]!, mapServers[i]!));
  }
  peer = "203.0.113.5";
  online = ids;
  await sweep(deps);
  return ids;
}

const cells = async () =>
  Object.fromEntries(
    (
      await db.query<{ id: number; cell: number | null }>(
        "SELECT id, cell FROM land ORDER BY id",
      )
    ).rows.map((r) => [Number(r.id), r.cell]),
  );

describe("migrations", () => {
  it("are idempotent", async () => {
    await migrate(db);
    await migrate(db);
    const { rows } = await db.query("SELECT id FROM migration");
    expect(rows).toHaveLength(5);
  });
});

describe("config", () => {
  const good = {
    DATABASE_URL: "postgres://x",
    HUB_TICKET_KEY: "ab".repeat(32),
    HUB_SESSION_SECRET: SECRET,
    HUB_ADMINS: admin.address,
  };
  it("loads with development defaults", () => {
    const c = loadConfig(good);
    expect(c.port).toBe(8787);
    expect(c.admins).toEqual([admin.address]);
    expect(c.hubDomain).toBe("localhost:8787");
    expect(c.landBaseDomain).toBe("localhost:8080");
    expect(c.landUrlScheme).toBe("http");
    expect(c.ticketSeed).toEqual(new Uint8Array(32).fill(0xab));
  });
  it("rejects bad input with clear messages", () => {
    const bad = (env: object, message: RegExp) =>
      expect(() => loadConfig({ ...good, ...env })).toThrow(message);
    bad({ HUB_TICKET_KEY: `0x${"ab".repeat(32)}` }, /HUB_TICKET_KEY/);
    bad({ HUB_SESSION_SECRET: "short" }, /HUB_SESSION_SECRET/);
    bad({ DATABASE_URL: "" }, /DATABASE_URL is required/);
    bad({ HUB_ADMINS: admin.address.toUpperCase() }, /HUB_ADMINS/);
    bad({ PORT: "99999" }, /PORT/);
    bad({ HUB_DOMAIN: "Hub.Example" }, /HUB_DOMAIN/);
    bad({ LAND_BASE_DOMAIN: "lands.test/x" }, /LAND_BASE_DOMAIN/);
    bad({ LAND_URL_SCHEME: "ftp" }, /LAND_URL_SCHEME/);
    bad({ HUB_TRUSTED_PROXIES: "10.0.0.0/33" }, /HUB_TRUSTED_PROXIES/);
    bad({ RELAY_INTERNAL_URL: "not a url" }, /RELAY_INTERNAL_URL/);
  });
  it("never echoes the ticket key", () => {
    const secret = "secret".repeat(10);
    expect(() => loadConfig({ ...good, HUB_TICKET_KEY: secret })).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(secret) as string,
      }),
    );
  });
});

describe("health and errors", () => {
  it("answers ok", async () => {
    const r = await req("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toBe("ok");
  });
  it("returns JSON for unknown routes and malformed bodies", async () => {
    expect((await req("GET", "/nope")).json).toEqual({ error: "not found" });
    const res = await app.request("/auth/verify", {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "body must be JSON" });
  });
  it("rejects oversized bodies", async () => {
    const r = await req("POST", "/auth/verify", {
      body: { statement: "x".repeat(20_000) },
    });
    expect(r.status).toBe(413);
  });
  it("answers CORS only for allowed origins, varying by Origin", async () => {
    const ok = await req("GET", "/directory", {
      headers: { Origin: "https://shell.test" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://shell.test",
    );
    expect(ok.headers.get("vary")).toContain("Origin");
    const bad = await req("GET", "/health", {
      headers: { Origin: "https://evil.test" },
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("logs unexpected errors and hides them from the client", async () => {
    deps.db = {
      query: () => Promise.reject(new Error("database is down")),
    };
    app = createApp(deps);
    const r = await req("GET", "/directory");
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "internal error" });
    expect(logs.join()).toContain("database is down");
  });
});

describe("GET /keys", () => {
  it("publishes the Hub's ticket key", async () => {
    const r = await req("GET", "/keys");
    expect(r.json.ticket.address).toBe(hubKey.address);
    expect(Buffer.from(r.json.ticket.publicKey, "base64")).toEqual(
      Buffer.from(hubKey.publicKey),
    );
  });
});

describe("sign-in", () => {
  it("issues a one-hour token for the signer, with its name", async () => {
    const r = await req("POST", "/auth/verify", {
      body: signInStatement(owner1),
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      address: owner1.address,
      name: "",
      expiresAt: seconds() + 3600,
    });
    await req("PUT", "/me/name", {
      token: r.json.token,
      body: { name: "Mai" },
    });
    const again = await req("POST", "/auth/verify", {
      body: signInStatement(owner1),
    });
    expect(again.json.name).toBe("Mai");
  });

  it("cannot be replayed", async () => {
    const signed = signInStatement(owner1);
    expect((await req("POST", "/auth/verify", { body: signed })).status).toBe(
      200,
    );
    nowMs += 59_000;
    const replay = await req("POST", "/auth/verify", { body: signed });
    expect(replay.status).toBe(401);
    expect(replay.json.error).toMatch(/already used/);
    // once the nonce is forgotten, the time check refuses it
    nowMs += 62_000;
    expect((await req("POST", "/auth/verify", { body: signed })).status).toBe(
      401,
    );
  });

  it("keeps the nonce for as long as Issued passes the time check", async () => {
    // first used at the earliest moment Issued passes, replayed at the latest
    nowMs = Math.floor(nowMs / 1000) * 1000;
    const signed = signInStatement(owner1, { issued: seconds() + 60 });
    expect((await req("POST", "/auth/verify", { body: signed })).status).toBe(
      200,
    );
    nowMs += 120_999;
    const replay = await req("POST", "/auth/verify", { body: signed });
    expect(replay.json.error).toMatch(/already used/);
  });

  it("is refused when Issued is more than 60 seconds off", async () => {
    for (const [offset, status] of [
      [-61, 401],
      [61, 401],
      [-60, 200],
      [60, 200],
    ] as const) {
      const body = signInStatement(owner1, { issued: seconds() + offset });
      expect((await req("POST", "/auth/verify", { body })).status).toBe(status);
    }
  });

  it("is refused for another Hub, a bad signature or another statement", async () => {
    const other = await req("POST", "/auth/verify", {
      body: signInStatement(owner1, { hub: "other.test" }),
    });
    expect(other.status).toBe(401);
    const signed = signInStatement(owner1);
    const forged = {
      ...signed,
      publicKey: signInStatement(owner2).publicKey,
    };
    expect((await req("POST", "/auth/verify", { body: forged })).json).toEqual({
      error: "bad signature",
    });
    // a Map server statement is signed under another context
    const wrongKind = await req("POST", "/auth/verify", {
      body: mapServerStatement(ms1, owner1),
    });
    expect(wrongKind.status).toBe(401);
    for (const body of [{}, { statement: 1 }, { ...signed, signature: "x" }])
      expect((await req("POST", "/auth/verify", { body })).status).toBe(401);
  });

  it("is rate-limited per network address", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (
        await req("POST", "/auth/verify", { body: signInStatement(owner1) })
      ).status;
    expect(last).toBe(429);
    peer = "198.51.100.7";
    expect(
      (await req("POST", "/auth/verify", { body: signInStatement(owner1) }))
        .status,
    ).toBe(200);
  });
});

describe("sessions", () => {
  it("reject a missing, forged, expired or unsigned token", async () => {
    const valid = await signIn(owner1);
    for (const token of [undefined, "nope", `${valid}x`])
      expect(
        (await req("PUT", "/me/name", { token, body: { name: "x" } })).status,
      ).toBe(401);
    const expired = await sign(
      { sub: owner1.address, exp: Math.floor(Date.now() / 1000) - 1 },
      SECRET,
      "HS256",
    );
    expect(
      (await req("PUT", "/me/name", { token: expired, body: { name: "x" } }))
        .status,
    ).toBe(401);
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: admin.address, exp: seconds() + 99 })}.`;
    expect((await req("GET", "/admin/reports", { token: none })).status).toBe(
      401,
    );
  });

  it("protect routes whatever the path spelling", async () => {
    for (const path of ["/tickets/", "/reports/", "/admin/reports/"])
      expect([401, 404]).toContain((await req("POST", path)).status);
    expect((await req("GET", "/admin/reports/")).status).toBe(401);
    expect((await req("GET", "/%61dmin/reports")).status).toBe(401);
  });
});

describe("names", () => {
  it("are trimmed and stored", async () => {
    const token = await signIn(owner1);
    const r = await req("PUT", "/me/name", {
      token,
      body: { name: "  Mai Lan  " },
    });
    expect(r.json).toEqual({ name: "Mai Lan" });
    const emoji = "🌸".repeat(32);
    expect(
      (await req("PUT", "/me/name", { token, body: { name: emoji } })).status,
    ).toBe(200);
  });

  it("refuse what a statement could not carry", async () => {
    const token = await signIn(owner1);
    for (const name of [
      "",
      "   ",
      "a".repeat(33),
      "Mai\nLand: 8",
      "Mai\u0007",
      "Mai​Lan",
      "\ud800",
      7,
    ])
      expect(
        (await req("PUT", "/me/name", { token, body: { name } })).status,
      ).toBe(400);
  });
});

describe("registering a Land", () => {
  it("keeps the newest Map server statement per key", async () => {
    const post = (body: SignedStatement) =>
      req("POST", "/map-servers", { body });
    const first = mapServerStatement(ms1, owner1);
    expect((await post(first)).status).toBe(204);
    expect((await post(first)).status).toBe(204);
    const older = mapServerStatement(ms1, owner2, { issued: seconds() - 10 });
    expect((await post(older)).status).toBe(409);
    const newer = mapServerStatement(ms1, owner2, { issued: seconds() + 10 });
    expect((await post(newer)).status).toBe(204);
    // owner2 is now the named owner, so owner1 cannot register it
    expect(
      (await req("POST", "/lands", { body: delegation(owner1, ms1) })).status,
    ).toBe(403);
  });

  it("refuses a Map server statement for another Hub, at another time or naming another key", async () => {
    const post = (body: SignedStatement) =>
      req("POST", "/map-servers", { body });
    expect(
      (await post(mapServerStatement(ms1, owner1, { hub: "other.test" })))
        .status,
    ).toBe(400);
    expect(
      (await post(mapServerStatement(ms1, owner1, { issued: seconds() - 301 })))
        .status,
    ).toBe(400);
    const lying = signStatement(
      "map-server",
      {
        hub: HUB,
        owner: owner1.address,
        mapServerKey: ms2.address,
        issued: seconds(),
      },
      ms1,
    );
    expect((await post(lying)).json.error).toMatch(/mapServerKey/);
  });

  it("lists the Map servers that named a Character and serve no Land", async () => {
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms1, owner1),
    });
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms2, owner1),
    });
    const token = await signIn(owner1);
    const list = await req("GET", `/map-servers?owner=${owner1.address}`, {
      token,
    });
    expect(
      list.json.mapServers.map((m: { mapServerKey: string }) => m.mapServerKey),
    ).toEqual(expect.arrayContaining([ms1.address, ms2.address]));
    await req("POST", "/lands", { body: delegation(owner1, ms1) });
    const after = await req("GET", `/map-servers?owner=${owner1.address}`, {
      token,
    });
    expect(after.json.mapServers).toEqual([
      { mapServerKey: ms2.address, issued: seconds() },
    ]);
    expect(
      (await req("GET", `/map-servers?owner=${owner2.address}`, { token }))
        .status,
    ).toBe(403);
    expect(
      (await req("GET", `/map-servers?owner=${owner1.address}`)).status,
    ).toBe(401);
  });

  it("creates a Land with no cell", async () => {
    const landId = await register(owner1, ms1);
    expect(landId).toBe(1);
    const r = await req("GET", `/lands/${landId}`);
    expect(r.json).toEqual({
      landId: 1,
      owner: owner1.address,
      ownerName: "",
      x: null,
      y: null,
      url: "https://1.lands.test",
      mapServerKey: ms1.address,
      online: false,
    });
  });

  it("is refused without the Map server's statement, so nobody claims another's Map server", async () => {
    expect(
      (await req("POST", "/lands", { body: delegation(owner1, ms1) })).status,
    ).toBe(403);
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms1, owner1),
    });
    const claim = await req("POST", "/lands", {
      body: delegation(owner2, ms1),
    });
    expect(claim.status).toBe(403);
  });

  it("refuses a Delegation signed by someone else, for another Hub or at another time", async () => {
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms1, owner1),
    });
    const forged = signStatement(
      "delegation",
      {
        hub: HUB,
        owner: owner1.address,
        mapServerKey: ms1.address,
        issued: seconds(),
      },
      owner2,
    );
    expect((await req("POST", "/lands", { body: forged })).status).toBe(400);
    for (const fields of [{ hub: "other.test" }, { issued: seconds() + 301 }])
      expect(
        (await req("POST", "/lands", { body: delegation(owner1, ms1, fields) }))
          .status,
      ).toBe(400);
  });

  it("gives one Land per Character; a newer Delegation replaces the Map server key", async () => {
    const landId = await register(owner1, ms1);
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms2, owner1),
    });
    nowMs += 1000;
    const newer = delegation(owner1, ms2);
    const moved = await req("POST", "/lands", { body: newer });
    expect(moved).toMatchObject({ status: 200, json: { landId } });
    expect((await req("GET", `/lands/${landId}`)).json.mapServerKey).toBe(
      ms2.address,
    );
    // the same Delegation sent again (a retry) gets the same answer
    expect(await req("POST", "/lands", { body: newer })).toMatchObject({
      status: 200,
      json: { landId },
    });
    const stale = await req("POST", "/lands", {
      body: delegation(owner1, ms1, { issued: seconds() - 1 }),
    });
    expect(stale.status).toBe(409);
    const { rows } = await db.query("SELECT id FROM land");
    expect(rows).toHaveLength(1);
  });

  it("refuses a key that serves another Land", async () => {
    await register(owner1, ms1);
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms1, owner2, { issued: seconds() + 1 }),
    });
    const r = await req("POST", "/lands", { body: delegation(owner2, ms1) });
    expect(r.status).toBe(409);
  });

  it("allows 3 new Lands per network address per day, whatever X-Forwarded-For says", async () => {
    // behind the trusted proxy, the client is the rightmost untrusted entry
    peer = PROXY;
    const as = (i: number, xff: string) =>
      req("POST", "/map-servers", {
        body: mapServerStatement(mapServers[i]!, owners[i]!),
      }).then(() =>
        req("POST", "/lands", {
          body: delegation(owners[i]!, mapServers[i]!),
          headers: { "X-Forwarded-For": xff },
        }),
      );
    expect((await as(0, "198.51.100.7")).status).toBe(201);
    expect((await as(1, "1.1.1.1, 198.51.100.7")).status).toBe(201);
    expect((await as(2, `2.2.2.2, 198.51.100.7, ${PROXY}`)).status).toBe(201);
    const fourth = await as(3, "3.3.3.3, 198.51.100.7");
    expect(fourth.status).toBe(429);
    // the refusal did not use up anything; another network still can
    expect((await as(3, "198.51.100.8")).status).toBe(201);
    // the next UTC day starts afresh
    nowMs += DAY_MS;
    expect((await as(4, "198.51.100.7")).status).toBe(201);
  });

  it("counts an IPv6 /64 as one network, and replacing a key does not count", async () => {
    const as = async (i: number, ip: string) => {
      peer = ip;
      await req("POST", "/map-servers", {
        body: mapServerStatement(mapServers[i]!, owners[i]!),
      });
      return req("POST", "/lands", {
        body: delegation(owners[i]!, mapServers[i]!),
      });
    };
    expect((await as(0, "2001:db8:1:2::1")).status).toBe(201);
    expect((await as(1, "2001:db8:1:2:ffff::9")).status).toBe(201);
    // a newer Delegation for the same Land replaces its key and is not a new Land
    nowMs += 1000;
    expect((await as(0, "2001:db8:1:2::1")).status).toBe(200);
    expect((await as(2, "2001:db8:1:2::3")).status).toBe(201);
    expect((await as(3, "2001:db8:1:2::4")).status).toBe(429);
    expect((await as(3, "2001:db8:1:3::4")).status).toBe(201);
  });
});

describe("Land lookups", () => {
  it("find a visible Land by owner or Map server key", async () => {
    const landId = await register(owner1, ms1);
    for (const query of [
      `owner=${owner1.address}`,
      `mapServerKey=${ms1.address}`,
    ])
      expect((await req("GET", `/lands?${query}`)).json.landId).toBe(landId);
    expect((await req("GET", `/lands?owner=${owner2.address}`)).status).toBe(
      404,
    );
  });

  it("refuse bad queries", async () => {
    for (const query of [
      "",
      `owner=${owner1.address}&mapServerKey=${ms1.address}`,
      "owner=nope",
      `owner=${owner1.address.toUpperCase()}`,
    ])
      expect((await req("GET", `/lands?${query}`)).status).toBe(400);
    for (const id of ["0", "x", "9007199254740992", "%E0%A4%A"])
      expect((await req("GET", `/lands/${id}`)).status).toBe(400);
    expect((await req("GET", "/lands/7")).status).toBe(404);
  });
});

describe("cells and the sweep", () => {
  it("gives a cell only to a Land whose Map server is online", async () => {
    const a = await register(owner1, ms1);
    const b = await register(owner2, ms2);
    online = [a];
    await sweep(deps);
    expect(await cells()).toEqual({ [a]: 0, [b]: null });
    const dir = await req("GET", "/directory");
    expect(dir.json.lands).toEqual([
      expect.objectContaining({ landId: a, x: 0, y: 0, online: true }),
    ]);
    expect(dir.headers.get("cache-control")).toBe(
      "public, s-maxage=5, stale-while-revalidate=30",
    );
    // a Land without a cell is still found, so its Map server can link
    expect((await req("GET", `/lands/${b}`)).json).toMatchObject({
      x: null,
      y: null,
    });
  });

  it("fills the spiral from the centre, never twice the same cell", async () => {
    const ids = await world(4);
    await sweep(deps);
    expect(await cells()).toEqual({
      [ids[0]!]: 0,
      [ids[1]!]: 1,
      [ids[2]!]: 2,
      [ids[3]!]: 3,
    });
    await expect(
      db.query("UPDATE land SET cell = 0 WHERE id = $1", [ids[1]]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("takes the cell of a Land offline for 30 days, which returns at the edge", async () => {
    const [a, b] = await world(2);
    online = [b!];
    nowMs += (CELL_KEPT_OFFLINE_SECONDS - 15) * 1000;
    await sweep(deps);
    expect((await cells())[a!]).toBe(0);
    nowMs += 15_000;
    await sweep(deps);
    expect(await cells()).toEqual({ [a!]: null, [b!]: 1 });
    // a new Land fills the hole, the returning one goes to the edge
    const c = await register(owners[2]!, mapServers[2]!);
    online = [a!, b!, c];
    await sweep(deps);
    expect(await cells()).toEqual({ [a!]: 2, [b!]: 1, [c]: 0 });
  });

  it("gives no cell to a hidden Land and keeps going when the relay is down", async () => {
    const a = await register(owner1, ms1);
    await db.query("UPDATE land SET hidden = true WHERE id = $1", [a]);
    online = [a];
    await sweep(deps);
    expect((await cells())[a]).toBeNull();
    relayDown = true;
    await expect(sweep(deps)).resolves.toBeUndefined();
    expect(logs.join()).toContain("relay presence unavailable");
  });

  it("forgets old quota rows and Map server statements that serve no Land", async () => {
    await register(owner1, ms1);
    await req("POST", "/map-servers", {
      body: mapServerStatement(ms2, owner2),
    });
    nowMs += 7 * DAY_MS + 1000;
    await sweep(deps);
    const keys = (await db.query<{ key: string }>("SELECT key FROM map_server"))
      .rows;
    expect(keys).toEqual([{ key: ms1.address }]);
    expect((await db.query("SELECT * FROM land_quota")).rows).toEqual([]);
  });
});

describe("online status", () => {
  it("is cached for 2 seconds", async () => {
    await world(1);
    onlineCalls = 0;
    await req("GET", "/directory");
    await req("GET", "/directory");
    nowMs += 1999;
    await req("GET", "/directory");
    expect(onlineCalls).toBe(1);
    nowMs += 1;
    await req("GET", "/directory");
    expect(onlineCalls).toBe(2);
  });

  it("shows every Land offline when the relay is down, logging once per burst", async () => {
    await world(1);
    relayDown = true;
    for (let i = 0; i < 3; i++) {
      nowMs += 2000;
      const dir = await req("GET", "/directory");
      expect(dir.json.lands[0].online).toBe(false);
    }
    expect(
      logs.filter((l) => l.includes("relay presence unavailable")),
    ).toHaveLength(1);
  });
});

describe("Travel tickets", () => {
  // one session per Character: hono/jwt refuses a token whose iat is ahead of the real clock,
  // and these tests move the Hub's clock forward
  const tokens = new Map<Key, Promise<string>>();
  beforeEach(() => tokens.clear());
  async function ticket(body: object, k: Key = owner1) {
    if (!tokens.has(k)) tokens.set(k, signIn(k));
    return req("POST", "/tickets", { token: await tokens.get(k), body });
  }

  it("issues a ticket the Land accepts offline (Gate 0 without from)", async () => {
    const [a] = await world(1);
    const token = await signIn(owner2);
    await req("PUT", "/me/name", { token, body: { name: "Lan" } });
    const r = await req("POST", "/tickets", { token, body: { landId: a } });
    expect(r.status).toBe(200);
    const arrival = signStatement(
      "arrival",
      {
        land: a!,
        ticketNonce: verifyStatement(r.json, "travel-ticket").fields.nonce,
        drivenByAi: false,
      },
      owner2,
    );
    const verified = verifyHandoff(
      { ticket: r.json, arrival },
      {
        landId: a!,
        hubTicketSigner: hubKey.address,
        startedAt: seconds() - 1,
        now: seconds(),
        isUsed: () => false,
      },
    );
    expect(verified.ticket).toMatchObject({
      hub: HUB,
      character: owner2.address,
      name: "Lan",
      land: a,
      gate: 0,
      issued: seconds(),
      expires: seconds() + 60,
    });
  });

  it("uses a fresh nonce each time", async () => {
    const [a] = await world(1);
    const nonces = new Set<string>();
    for (let i = 0; i < 3; i++)
      nonces.add(
        verifyStatement((await ticket({ landId: a })).json, "travel-ticket")
          .fields.nonce,
      );
    expect(nonces.size).toBe(3);
  });

  it("sets the arrival Gate from an adjacent cell", async () => {
    // cells 0 (0,0), 1 (1,0), 2 (1,1), 3 (0,1)
    const [a, b, c, d] = await world(4);
    const gate = async (from: number, to: number) =>
      verifyStatement(
        (await ticket({ landId: to, from })).json,
        "travel-ticket",
      ).fields.gate;
    expect(await gate(a!, b!)).toBe(4); // walked east, arrives at the west Gate
    expect(await gate(b!, a!)).toBe(2);
    expect(await gate(b!, c!)).toBe(1); // walked south, arrives at the north Gate
    expect(await gate(d!, a!)).toBe(3);
    const far = await ticket({ landId: c, from: a });
    expect(far).toMatchObject({
      status: 409,
      json: { error: "Lands are not adjacent" },
    });
  });

  it("refuses unknown, hidden, cell-less and offline Lands", async () => {
    const [a, b] = await world(2);
    expect((await ticket({ landId: 99 })).status).toBe(404);
    expect((await ticket({ landId: b, from: 99 })).status).toBe(404);
    const c = await register(owners[2]!, mapServers[2]!);
    online = [a!, b!, c];
    expect((await ticket({ landId: c })).status).toBe(409);
    // an origin without a cell is not adjacent to anything
    expect((await ticket({ landId: a, from: c })).status).toBe(409);
    await db.query("UPDATE land SET hidden = true WHERE id = $1", [b]);
    expect((await ticket({ landId: b })).status).toBe(404);
    online = [];
    nowMs += 2000;
    expect((await ticket({ landId: a })).json.error).toBe("Land is offline");
    relayDown = true;
    nowMs += 2000;
    expect((await ticket({ landId: a })).status).toBe(409);
  });

  it("validates the body and needs a session", async () => {
    const [a] = await world(1);
    for (const body of [
      {},
      { landId: "x" },
      { landId: 0 },
      { landId: a, from: a },
    ])
      expect((await ticket(body)).status).toBe(400);
    expect(
      (await req("POST", "/tickets", { body: { landId: a } })).status,
    ).toBe(401);
  });

  it("allows 30 per minute per Character", async () => {
    const [a] = await world(1);
    const token = await signIn(owner1);
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await req("POST", "/tickets", { token, body: { landId: a } }))
        .status;
    expect(last).toBe(429);
  });
});

describe("reports and moderation", () => {
  it("stores a report and lists it for admins", async () => {
    const [a] = await world(1);
    const token = await signIn(owner2);
    const r = await req("POST", "/reports", {
      token,
      body: { landId: a, reason: "  spam  " },
    });
    expect(r.status).toBe(201);
    const list = await req("GET", "/admin/reports", {
      token: await signIn(admin),
    });
    expect(list.json.reports).toEqual([
      {
        id: 1,
        landId: a,
        reporter: owner2.address,
        reason: "spam",
        createdAt: seconds(),
      },
    ]);
  });

  it("validates reports and limits them to 5 per hour", async () => {
    const [a] = await world(1);
    const token = await signIn(owner2);
    expect(
      (await req("POST", "/reports", { body: { landId: a, reason: "x" } }))
        .status,
    ).toBe(401);
    for (const reason of ["", "   ", "x".repeat(501), 5])
      expect(
        (await req("POST", "/reports", { token, body: { landId: a, reason } }))
          .status,
      ).toBe(400);
    expect(
      (
        await req("POST", "/reports", {
          token,
          body: { landId: 99, reason: "x" },
        })
      ).status,
    ).toBe(404);
    let last = 0;
    for (let i = 0; i < 6; i++)
      last = (
        await req("POST", "/reports", {
          token,
          body: { landId: a, reason: "x" },
        })
      ).status;
    expect(last).toBe(429);
  });

  it("keeps admin routes for admins", async () => {
    const token = await signIn(owner1);
    expect((await req("GET", "/admin/reports", { token })).status).toBe(403);
    expect(
      (
        await req("POST", "/admin/lands/1/hidden", {
          token,
          body: { hidden: true },
        })
      ).status,
    ).toBe(403);
  });

  it("hides and unhides a Land", async () => {
    const [a] = await world(1);
    const token = await signIn(admin);
    const hide = (hidden: unknown) =>
      req("POST", `/admin/lands/${a}/hidden`, { token, body: { hidden } });
    expect((await hide("yes")).status).toBe(400);
    expect((await hide(true)).json).toEqual({ landId: a, hidden: true });
    expect((await req("GET", "/directory")).json.lands).toEqual([]);
    // the relay reads this route, so it drops the Land's link
    expect((await req("GET", `/lands/${a}`)).status).toBe(404);
    expect(logs.join()).toContain(`Land ${a} hidden by ${admin.address}`);
    // re-registering keeps it hidden
    nowMs += 1000;
    await req("POST", "/lands", { body: delegation(owner1, ms1) });
    expect((await req("GET", `/lands/${a}`)).status).toBe(404);
    await hide(false);
    expect((await req("GET", `/lands/${a}`)).status).toBe(200);
    expect(
      (
        await req("POST", "/admin/lands/99/hidden", {
          token,
          body: { hidden: true },
        })
      ).status,
    ).toBe(404);
  });
});
