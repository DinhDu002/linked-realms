import { PGlite } from "@electric-sql/pglite";
import { sign } from "hono/jwt";
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  parseAbi,
  recoverTypedDataAddress,
  toHex,
  verifyMessage,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  entryPoint06Address,
  toCoinbaseSmartAccount,
} from "viem/account-abstraction";
import { foundry } from "viem/chains";
import {
  createSiweMessage,
  parseSiweMessage,
  validateSiweMessage,
} from "viem/siwe";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DelegationTypes,
  type DirectoryLand,
  HUB_EIP712_DOMAIN,
  SPONSORED_TRANSACTIONS_PER_DAY,
  SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY,
  TravelTicketTypes,
  deploymentFor,
  goldTokenAbi,
  landAbi,
  playerRegistryAbi,
  parseWireTicket,
  verifyTravelTicket,
} from "@linked-realms/shared";
import { createApp, type Deps } from "./app.ts";
import { loadConfig } from "./config.ts";
import { migrate, type Db } from "./db.ts";

const CHAIN_ID = 31337;
const DOMAIN = "game.test";
const SECRET = "test-session-secret-0123456789-abcdef";

const owner1 = privateKeyToAccount(generatePrivateKey());
const owner2 = privateKeyToAccount(generatePrivateKey());
const owner5 = privateKeyToAccount(generatePrivateKey());
const player = privateKeyToAccount(generatePrivateKey());
const noCharacter = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const hubKey = privateKeyToAccount(generatePrivateKey());
const mining1 = privateKeyToAccount(generatePrivateKey()).address;

// Land 1 at (0,0), 2 at (1,0), 3 at (1,1) (not adjacent to 1), 5 at (0,1)
const LANDS: Record<number, { owner: Address; x: number; y: number }> = {
  1: { owner: owner1.address, x: 0, y: 0 },
  2: { owner: owner2.address, x: 1, y: 0 },
  3: { owner: owner2.address, x: 1, y: 1 },
  5: { owner: owner5.address, x: 0, y: 1 },
};

let db: Db;
let nowMs: number;
let online: number[];
let relayDown: boolean;
let chainDown: boolean;
let logs: string[];
let onlineCalls: number;
let bundled: { method: string; params: unknown[] }[];
let bundlerResult: (method: string) => unknown;
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
  nowMs = Date.now();
  online = [1, 2, 3, 5];
  relayDown = false;
  chainDown = false;
  logs = [];
  onlineCalls = 0;
  bundled = [];
  bundlerResult = () => "0x01";
  deps = {
    config: {
      chainId: CHAIN_ID,
      siweDomain: DOMAIN,
      sessionSecret: SECRET,
      admins: [admin.address],
      allowedOrigins: ["https://game.test"],
      relayPublicUrl: "wss://relay.test",
    },
    db,
    chain: {
      async ownerOf(id) {
        if (chainDown) throw new Error("rpc https://secret-rpc.test down");
        return LANDS[Number(id)]?.owner;
      },
      async coordinatesOf(id) {
        if (chainDown) throw new Error("rpc down");
        const l = LANDS[Number(id)];
        return l && { x: l.x, y: l.y };
      },
      async hasCharacter(a) {
        return a !== noCharacter.address;
      },
    },
    async verifySiwe({ message, signature, domain, nonce, time }) {
      const parsed = parseSiweMessage(message);
      if (!parsed.address) return false;
      return (
        validateSiweMessage({ message: parsed, domain, nonce, time }) &&
        (await verifyMessage({ address: parsed.address, message, signature }))
      );
    },
    verifyTypedData: (args) => verifyTypedData(args as never),
    async online() {
      onlineCalls++;
      if (relayDown) throw new Error("relay down");
      return online;
    },
    ticketSigner: hubKey,
    async bundler({ id, method, params }) {
      bundled.push({ method, params });
      return { jsonrpc: "2.0", id, result: bundlerResult(method) };
    },
    now: () => nowMs,
    log: (m) => logs.push(m),
  };
  app = createApp(deps);
});

type Account = typeof player;

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

async function siweMessage(account: Account, overrides = {}) {
  const { json } = await req("GET", "/auth/nonce");
  return createSiweMessage({
    address: account.address,
    chainId: CHAIN_ID,
    domain: DOMAIN,
    nonce: json.nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
    issuedAt: new Date(nowMs),
    ...overrides,
  });
}

async function signIn(account: Account): Promise<string> {
  const message = await siweMessage(account);
  const signature = await account.signMessage({ message });
  const res = await req("POST", "/auth/verify", {
    body: { message, signature },
  });
  expect(res.status).toBe(200);
  return res.json.token;
}

async function delegationBody(
  landId: number,
  signer: Account,
  miningKey: Address,
  issuedAt = Math.floor(nowMs / 1000),
) {
  const signature = await signer.signTypedData({
    domain: HUB_EIP712_DOMAIN(CHAIN_ID),
    types: DelegationTypes,
    primaryType: "Delegation",
    message: { landId: BigInt(landId), miningKey, issuedAt: BigInt(issuedAt) },
  });
  return { miningKey, issuedAt: String(issuedAt), signature };
}

async function register(landId: number, signer: Account, issuedAt?: number) {
  return req("POST", `/lands/${landId}/delegation`, {
    body: await delegationBody(landId, signer, mining1, issuedAt),
  });
}

describe("migrations", () => {
  it("are idempotent", async () => {
    await migrate(db);
    await migrate(db);
    const { rows } = await db.query("SELECT id FROM migration");
    expect(rows).toHaveLength(2);
  });
});

describe("config", () => {
  const good = {
    DATABASE_URL: "postgres://x",
    HUB_TICKET_KEY: generatePrivateKey(),
    HUB_SESSION_SECRET: SECRET,
    HUB_ADMINS: admin.address.toLowerCase(),
  };
  it("loads and normalises", () => {
    const c = loadConfig(good);
    expect(c.port).toBe(8787);
    expect(c.admins).toEqual([admin.address]);
  });
  it("rejects bad input with clear messages", () => {
    expect(() => loadConfig({ ...good, HUB_TICKET_KEY: "0x12" })).toThrow(
      /HUB_TICKET_KEY/,
    );
    expect(() => loadConfig({ ...good, HUB_SESSION_SECRET: "short" })).toThrow(
      /HUB_SESSION_SECRET/,
    );
    expect(() => loadConfig({ ...good, DATABASE_URL: "" })).toThrow(
      /DATABASE_URL is required/,
    );
    expect(() => loadConfig({ ...good, HUB_ADMINS: "nope" })).toThrow(
      /HUB_ADMINS/,
    );
    expect(() => loadConfig({ ...good, PORT: "99999" })).toThrow(/PORT/);
    expect(() =>
      loadConfig({ ...good, HUB_BUNDLER_URL: "SECRETKEY not a url" }),
    ).toThrow(/^HUB_BUNDLER_URL is not a valid URL$/);
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
      body: { message: "x".repeat(20_000) },
    });
    expect(r.status).toBe(413);
  });
  it("answers CORS only for allowed origins", async () => {
    const ok = await req("GET", "/health", {
      headers: { Origin: "https://game.test" },
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe(
      "https://game.test",
    );
    const bad = await req("GET", "/health", {
      headers: { Origin: "https://evil.test" },
    });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("sign-in", () => {
  it("issues a one-hour token for the signer", async () => {
    const message = await siweMessage(player);
    const signature = await player.signMessage({ message });
    const r = await req("POST", "/auth/verify", {
      body: { message, signature },
    });
    expect(r.status).toBe(200);
    expect(r.json.address).toBe(player.address);
    expect(r.json.expiresAt).toBe(Math.floor(nowMs / 1000) + 3600);
    const reports = await req("GET", "/admin/reports", { token: r.json.token });
    expect(reports.status).toBe(403); // the token is accepted; the address is just not an admin
  });
  it("rejects a bad signature", async () => {
    const message = await siweMessage(player);
    const signature = await stranger.signMessage({ message });
    expect(
      (await req("POST", "/auth/verify", { body: { message, signature } }))
        .status,
    ).toBe(401);
  });
  it("makes nonces single use", async () => {
    const message = await siweMessage(player);
    const signature = await player.signMessage({ message });
    const body = { message, signature };
    expect((await req("POST", "/auth/verify", { body })).status).toBe(200);
    expect((await req("POST", "/auth/verify", { body })).status).toBe(401);
  });
  it("consumes the nonce even when the signature is bad", async () => {
    const message = await siweMessage(player);
    const bad = await stranger.signMessage({ message });
    await req("POST", "/auth/verify", { body: { message, signature: bad } });
    const good = await player.signMessage({ message });
    expect(
      (
        await req("POST", "/auth/verify", {
          body: { message, signature: good },
        })
      ).status,
    ).toBe(401);
  });
  it("rejects an unknown or expired nonce", async () => {
    const forged = createSiweMessage({
      address: player.address,
      chainId: CHAIN_ID,
      domain: DOMAIN,
      nonce: "neverissued1",
      uri: `https://${DOMAIN}`,
      version: "1",
    });
    const signature = await player.signMessage({ message: forged });
    expect(
      (
        await req("POST", "/auth/verify", {
          body: { message: forged, signature },
        })
      ).status,
    ).toBe(401);

    const message = await siweMessage(player);
    const sig = await player.signMessage({ message });
    nowMs += 5 * 60_000 + 1;
    expect(
      (await req("POST", "/auth/verify", { body: { message, signature: sig } }))
        .status,
    ).toBe(401);
  });
  it("rejects the wrong domain and the wrong chain id", async () => {
    for (const overrides of [{ domain: "evil.test" }, { chainId: 1 }]) {
      const message = await siweMessage(player, overrides);
      const signature = await player.signMessage({ message });
      expect(
        (await req("POST", "/auth/verify", { body: { message, signature } }))
          .status,
      ).toBe(401);
    }
  });
  it("rejects an expired SIWE message", async () => {
    const message = await siweMessage(player, {
      expirationTime: new Date(nowMs - 1000),
    });
    const signature = await player.signMessage({ message });
    expect(
      (await req("POST", "/auth/verify", { body: { message, signature } }))
        .status,
    ).toBe(401);
  });
  it("rejects malformed bodies", async () => {
    expect(
      (
        await req("POST", "/auth/verify", {
          body: { message: 1, signature: "0x00" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("POST", "/auth/verify", {
          body: { message: "hi", signature: "zz" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req("POST", "/auth/verify", {
          body: { message: "hi", signature: "0x00" },
        })
      ).status,
    ).toBe(400);
  });
});

describe("bearer auth", () => {
  it("rejects a missing, forged or expired token", async () => {
    const body = { landId: 1 };
    expect((await req("POST", "/tickets", { body })).status).toBe(401);
    expect((await req("POST", "/tickets", { body, token: "abc" })).status).toBe(
      401,
    );
    const now = Math.floor(Date.now() / 1000);
    const forged = await sign(
      { sub: player.address, exp: now + 600 },
      "x".repeat(40),
      "HS256",
    );
    expect(
      (await req("POST", "/tickets", { body, token: forged })).status,
    ).toBe(401);
    const expired = await sign(
      { sub: player.address, exp: now - 10 },
      SECRET,
      "HS256",
    );
    expect(
      (await req("POST", "/tickets", { body, token: expired })).status,
    ).toBe(401);
    const noSub = await sign({ exp: now + 600 }, SECRET, "HS256");
    expect((await req("POST", "/tickets", { body, token: noSub })).status).toBe(
      401,
    );
  });
});

describe("delegation", () => {
  it("registers a Land, with owner and coordinates from the chain", async () => {
    const r = await register(2, owner2);
    expect(r.status).toBe(200);
    const d = await req("GET", "/directory/2");
    expect(d.json).toEqual({
      landId: 2,
      owner: owner2.address,
      x: 1,
      y: 0,
      miningKey: mining1,
      online: true,
    });
  });
  it("accepts issuedAt as a number", async () => {
    const body = await delegationBody(1, owner1, mining1);
    const r = await req("POST", "/lands/1/delegation", {
      body: { ...body, issuedAt: Number(body.issuedAt) },
    });
    expect(r.status).toBe(200);
  });
  it("rejects a signature from someone who does not own the Land", async () => {
    expect((await register(1, stranger)).status).toBe(403);
    expect((await register(1, owner2)).status).toBe(403);
    expect((await req("GET", "/directory/1")).status).toBe(404);
  });
  it("rejects a signature over other fields", async () => {
    const body = await delegationBody(1, owner1, mining1);
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(
      (
        await req("POST", "/lands/1/delegation", {
          body: { ...body, miningKey: other },
        })
      ).status,
    ).toBe(403);
  });
  it("returns 404 for a missing Land", async () => {
    expect((await register(99, owner1)).status).toBe(404);
  });
  it("rejects malformed fields", async () => {
    const good = await delegationBody(1, owner1, mining1);
    const post = (body: unknown, id = "1") =>
      req("POST", `/lands/${id}/delegation`, { body });
    expect((await post({ ...good, miningKey: "0x12" })).status).toBe(400);
    expect((await post({ ...good, issuedAt: "-1" })).status).toBe(400);
    expect((await post({ ...good, issuedAt: "1.5" })).status).toBe(400);
    expect((await post({ ...good, issuedAt: String(2n ** 64n) })).status).toBe(
      400,
    );
    expect((await post({ ...good, signature: "nothex" })).status).toBe(400);
    expect((await post({ ...good, signature: undefined })).status).toBe(400);
    expect((await post(good, "abc")).status).toBe(400);
    expect((await post(good, "0")).status).toBe(400);
    expect((await post(good, String(2 ** 32))).status).toBe(400);
    expect((await post([1])).status).toBe(400);
  });
  it("rejects an issuedAt more than 5 minutes ahead", async () => {
    const t = Math.floor(nowMs / 1000);
    expect((await register(1, owner1, t + 301)).status).toBe(400);
    expect((await register(1, owner1, t + 299)).status).toBe(200);
  });
  it("keeps only the newest Delegation", async () => {
    const t = Math.floor(nowMs / 1000);
    expect((await register(1, owner1, t)).status).toBe(200);
    const newer = privateKeyToAccount(generatePrivateKey()).address;
    const body = await delegationBody(1, owner1, newer, t + 10);
    expect((await req("POST", "/lands/1/delegation", { body })).status).toBe(
      200,
    );
    expect((await req("GET", "/directory/1")).json.miningKey).toBe(newer);
    // stale and equal are refused
    expect((await register(1, owner1, t + 5)).status).toBe(409);
    expect((await register(1, owner1, t + 10)).status).toBe(409);
    expect((await req("GET", "/directory/1")).json.miningKey).toBe(newer);
  });
  it("keeps a Land hidden when it is re-registered", async () => {
    const t = Math.floor(nowMs / 1000);
    await register(1, owner1, t);
    const token = await signIn(admin);
    await req("POST", "/admin/lands/1/hidden", {
      token,
      body: { hidden: true },
    });
    expect((await register(1, owner1, t + 1)).status).toBe(200);
    expect((await req("GET", "/directory/1")).status).toBe(404);
  });
  it("hides chain failures from the client", async () => {
    chainDown = true;
    const r = await register(1, owner1);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.json)).not.toContain("secret-rpc");
    expect(logs.join()).toContain("chain read failed");
  });
});

describe("directory", () => {
  beforeEach(async () => {
    await register(1, owner1);
    await register(2, owner2);
  });
  it("lists registered Lands with online status and cache headers", async () => {
    online = [2];
    const r = await req("GET", "/directory");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe(
      "public, s-maxage=5, stale-while-revalidate=30",
    );
    expect(r.json.relayUrl).toBe("wss://relay.test");
    expect(
      r.json.lands.map((l: DirectoryLand) => [l.landId, l.online]),
    ).toEqual([
      [1, false],
      [2, true],
    ]);
  });
  it("excludes hidden Lands and answers 404 for them", async () => {
    const token = await signIn(admin);
    await req("POST", "/admin/lands/1/hidden", {
      token,
      body: { hidden: true },
    });
    expect(
      (await req("GET", "/directory")).json.lands.map(
        (l: DirectoryLand) => l.landId,
      ),
    ).toEqual([2]);
    expect((await req("GET", "/directory/1")).status).toBe(404);
    expect((await req("GET", "/directory/7")).status).toBe(404);
    expect((await req("GET", "/directory/x")).status).toBe(400);
  });
  it("caches presence for 2 seconds", async () => {
    await req("GET", "/directory");
    await req("GET", "/directory/1");
    expect(onlineCalls).toBe(1);
    nowMs += 2001;
    await req("GET", "/directory");
    expect(onlineCalls).toBe(2);
  });
  it("shows every Land offline and logs once per failure burst", async () => {
    relayDown = true;
    const r = await req("GET", "/directory");
    expect(r.json.lands.every((l: DirectoryLand) => !l.online)).toBe(true);
    nowMs += 3000;
    await req("GET", "/directory");
    nowMs += 3000;
    await req("GET", "/directory");
    expect(logs.filter((l) => l.includes("relay presence"))).toHaveLength(1);
    relayDown = false;
    nowMs += 3000;
    expect((await req("GET", "/directory")).json.lands[0].online).toBe(true);
    relayDown = true;
    nowMs += 3000;
    await req("GET", "/directory");
    expect(logs.filter((l) => l.includes("relay presence"))).toHaveLength(2);
  });
});

describe("tickets", () => {
  let token: string;
  beforeEach(async () => {
    for (const [id, who] of [
      [1, owner1],
      [2, owner2],
      [3, owner2],
      [5, owner5],
    ] as const)
      expect((await register(id, who)).status).toBe(200);
    token = await signIn(player);
  });
  const ask = (body: unknown, t = token) =>
    req("POST", "/tickets", { token: t, body });

  it("issues a ticket the Map server can verify offline (no from: GATE_NONE)", async () => {
    const r = await ask({ landId: 2 });
    expect(r.status).toBe(200);
    expect(r.json.ticket).toMatchObject({
      player: player.address,
      landId: "2",
      gate: 0,
    });
    const nowSeconds = Math.floor(nowMs / 1000);
    expect(r.json.ticket.expiresAt).toBe(String(nowSeconds + 60));
    const t = await verifyTravelTicket({
      ticket: r.json.ticket,
      signature: r.json.signature,
      hubSigner: hubKey.address,
      chainId: CHAIN_ID,
      landId: 2,
      nowSeconds,
    });
    expect(t.player).toBe(player.address);
    expect(
      await recoverTypedDataAddress({
        domain: HUB_EIP712_DOMAIN(CHAIN_ID),
        types: TravelTicketTypes,
        primaryType: "TravelTicket",
        message: parseWireTicket(r.json.ticket),
        signature: r.json.signature as Hex,
      }),
    ).toBe(hubKey.address);
  });
  it("uses random nonces", async () => {
    const a = await ask({ landId: 2 });
    const b = await ask({ landId: 2 });
    expect(a.json.ticket.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.json.ticket.nonce).not.toBe(b.json.ticket.nonce);
  });
  it("sets the arrival Gate for adjacent Lands", async () => {
    // 1 (0,0) -> 2 (1,0): walking east, arriving at the west Gate (4)
    expect((await ask({ landId: 2, from: 1 })).json.ticket.gate).toBe(4);
    // 2 -> 1: walking west, arriving at the east Gate (2)
    expect((await ask({ landId: 1, from: 2 })).json.ticket.gate).toBe(2);
    // 1 (0,0) -> 5 (0,1): walking south, arriving at the north Gate (1)
    expect((await ask({ landId: 5, from: 1 })).json.ticket.gate).toBe(1);
    // 5 -> 1: north, arriving at the south Gate (3)
    expect((await ask({ landId: 1, from: 5 })).json.ticket.gate).toBe(3);
  });
  it("refuses Lands that are not adjacent", async () => {
    expect((await ask({ landId: 3, from: 1 })).status).toBe(403); // diagonal
    expect((await ask({ landId: 5, from: 2 })).status).toBe(403); // diagonal
  });
  it("rejects an unknown origin Land and from equal to landId", async () => {
    expect((await ask({ landId: 2, from: 99 })).status).toBe(404);
    expect((await ask({ landId: 2, from: 2 })).status).toBe(400);
  });
  it("requires a Character", async () => {
    const t = await signIn(noCharacter);
    expect((await ask({ landId: 2 }, t)).status).toBe(403);
  });
  it("refuses unregistered and hidden Lands", async () => {
    expect((await ask({ landId: 4 })).status).toBe(404);
    const adminToken = await signIn(admin);
    await req("POST", "/admin/lands/2/hidden", {
      token: adminToken,
      body: { hidden: true },
    });
    expect((await ask({ landId: 2 })).status).toBe(404);
  });
  it("refuses offline Lands, including when the relay is down", async () => {
    online = [1];
    expect((await ask({ landId: 2 })).status).toBe(409);
    online = [1, 2];
    nowMs += 3000;
    expect((await ask({ landId: 2 })).status).toBe(200);
    relayDown = true;
    nowMs += 3000;
    expect((await ask({ landId: 2 })).status).toBe(409);
  });
  it("validates the body", async () => {
    expect((await ask({})).status).toBe(400);
    expect((await ask({ landId: "x" })).status).toBe(400);
    expect((await ask({ landId: 2, from: -1 })).status).toBe(400);
  });
  it("limits tickets to 30 per minute per address", async () => {
    for (let i = 0; i < 30; i++)
      expect((await ask({ landId: 2 })).status).toBe(200);
    expect((await ask({ landId: 2 })).status).toBe(429);
    // another address is unaffected
    expect((await ask({ landId: 2 }, await signIn(admin))).status).toBe(200);
    nowMs += 61_000;
    expect((await ask({ landId: 2 })).status).toBe(200);
  });
});

describe("reports and moderation", () => {
  let token: string;
  let adminToken: string;
  beforeEach(async () => {
    await register(1, owner1);
    token = await signIn(player);
    adminToken = await signIn(admin);
  });
  const report = (body: unknown, t = token) =>
    req("POST", "/reports", { token: t, body });

  it("stores a report and lists it for admins", async () => {
    expect((await report({ landId: 1, reason: "  spam  " })).status).toBe(201);
    // 500 characters is the limit
    expect((await report({ landId: 1, reason: "y".repeat(500) })).status).toBe(
      201,
    );
    const r = await req("GET", "/admin/reports", { token: adminToken });
    expect(r.status).toBe(200);
    expect(r.json.reports).toHaveLength(2);
    expect(r.json.reports.slice(0, 1)).toEqual([
      {
        id: expect.any(Number),
        landId: 1,
        reporter: player.address,
        reason: "spam",
        createdAt: Math.floor(nowMs / 1000),
      },
    ]);
  });
  it("requires a session", async () => {
    expect(
      (await req("POST", "/reports", { body: { landId: 1, reason: "x" } }))
        .status,
    ).toBe(401);
  });
  it("rejects bad reasons and unknown Lands", async () => {
    expect((await report({ landId: 1, reason: "x".repeat(501) })).status).toBe(
      400,
    );
    expect((await report({ landId: 1, reason: "   " })).status).toBe(400);
    expect((await report({ landId: 1, reason: 5 })).status).toBe(400);
    expect((await report({ landId: 1 })).status).toBe(400);
    expect((await report({ landId: 9, reason: "x" })).status).toBe(404);
  });
  it("limits reports to 5 per hour per address", async () => {
    for (let i = 0; i < 5; i++)
      expect((await report({ landId: 1, reason: `r${i}` })).status).toBe(201);
    expect((await report({ landId: 1, reason: "again" })).status).toBe(429);
    nowMs += 3_600_001;
    expect((await report({ landId: 1, reason: "later" })).status).toBe(201);
  });
  it("keeps admin routes for admins", async () => {
    expect((await req("GET", "/admin/reports")).status).toBe(401);
    expect((await req("GET", "/admin/reports", { token })).status).toBe(403);
    expect(
      (
        await req("POST", "/admin/lands/1/hidden", {
          token,
          body: { hidden: true },
        })
      ).status,
    ).toBe(403);
    expect((await req("GET", "/directory/1")).status).toBe(200);
  });
  it("hides and unhides a Land", async () => {
    const hide = (hidden: unknown) =>
      req("POST", "/admin/lands/1/hidden", {
        token: adminToken,
        body: { hidden },
      });
    expect((await hide(true)).json).toEqual({ landId: 1, hidden: true });
    expect((await req("GET", "/directory/1")).status).toBe(404);
    expect((await hide(false)).status).toBe(200);
    expect((await req("GET", "/directory/1")).status).toBe(200);
    expect((await hide("yes")).status).toBe(400);
    expect(
      (
        await req("POST", "/admin/lands/9/hidden", {
          token: adminToken,
          body: { hidden: true },
        })
      ).status,
    ).toBe(404);
  });
});

describe("hardening", () => {
  it("does not log RPC details (they can carry URLs and API keys)", async () => {
    chainDown = true;
    await register(1, owner1);
    expect(logs.join()).toContain("chain read failed");
    expect(logs.join()).not.toContain("secret-rpc");
  });

  it("keeps the nonce store bounded, dropping the oldest", async () => {
    const first = (await req("GET", "/auth/nonce")).json.nonce;
    for (let i = 0; i < 10_000; i++) await req("GET", "/auth/nonce");
    const message = await siweMessage(player, { nonce: first });
    const signature = await player.signMessage({ message });
    const r = await req("POST", "/auth/verify", {
      body: { message, signature },
    });
    expect(r.status).toBe(401);
  }, 30_000);

  it("rejects oversized sign-in messages before parsing", async () => {
    const r = await req("POST", "/auth/verify", {
      body: { message: "x".repeat(5000), signature: "0x00" },
    });
    expect(r.status).toBe(400);
  });

  it("rate-limits Delegation attempts per Land before any chain read", async () => {
    const body = await delegationBody(1, stranger, mining1);
    let last = 0;
    for (let i = 0; i < 11; i++)
      last = (await req("POST", "/lands/1/delegation", { body })).status;
    expect(last).toBe(429);
    // another Land is not affected
    expect((await register(2, owner2)).status).toBe(200);
  });

  it("protects routes whatever the path spelling", async () => {
    for (const path of ["/tickets/", "/reports/", "/admin/reports/"])
      expect([401, 404]).toContain((await req("POST", path)).status);
    expect((await req("GET", "/admin/reports/")).status).toBe(401);
    expect((await req("GET", "/%61dmin/reports")).status).toBe(401);
  });

  it("rejects an unsigned (alg none) token", async () => {
    const b64 = (o: object) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: admin.address, exp: Math.floor(nowMs / 1000) + 99 })}.`;
    expect((await req("GET", "/admin/reports", { token })).status).toBe(401);
  });

  it("answers malformed percent-encoding with 400, not 500", async () => {
    expect((await req("GET", "/directory/%E0%A4%A")).status).toBe(400);
  });

  it("varies cached CORS answers by Origin", async () => {
    const r = await req("GET", "/directory", {
      headers: { Origin: "https://game.test" },
    });
    expect(r.headers.get("vary")).toContain("Origin");
  });
});

describe("sponsored user operations", () => {
  const { PlayerRegistry, Land, GoldToken } = deploymentFor(CHAIN_ID);
  const PER_PLAYER = SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY;
  // every account below is given its address; eth_getCode answers "not deployed yet"
  const reader = createPublicClient({
    chain: foundry,
    transport: custom({ request: async () => "0x" }),
  });
  const createCall = {
    to: PlayerRegistry.address,
    data: encodeFunctionData({
      abi: playerRegistryAbi,
      functionName: "createCharacter",
    }),
  };
  const designCall = {
    to: Land.address,
    data: encodeFunctionData({
      abi: landAbi,
      functionName: "setDesignHash",
      args: [1n, toHex(1, { size: 32 })],
    }),
  };
  const transferCall = {
    to: GoldToken.address,
    data: encodeFunctionData({
      abi: goldTokenAbi,
      functionName: "transfer",
      args: [stranger.address, 1n],
    }),
  };
  const addOwnerData = encodeFunctionData({
    abi: parseAbi(["function addOwnerPublicKey(bytes32 x, bytes32 y)"]),
    functionName: "addOwnerPublicKey",
    args: [toHex(1, { size: 32 }), toHex(2, { size: 32 })],
  });

  /** A v0.6 user operation as viem's bundler client sends it, from a Coinbase account at `sender`'s address (the session's). */
  async function userOp(
    sender: Account,
    calls: { to: Address; data: Hex; value?: bigint }[],
    deployed = true,
  ) {
    const account = await toCoinbaseSmartAccount({
      client: reader,
      owners: [sender],
      version: "1.1",
      address: sender.address,
    });
    const { factory, factoryData } = await account.getFactoryArgs();
    return {
      sender: sender.address,
      nonce: "0x0",
      initCode: deployed ? "0x" : `${factory}${factoryData?.slice(2)}`,
      callData: await account.encodeCalls(calls),
      callGasLimit: "0x1",
      verificationGasLimit: "0x1",
      preVerificationGas: "0x1",
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1",
      paymasterAndData: "0x",
      signature: "0x",
    };
  }

  function rpc(token: string, method: string, params: unknown) {
    return req("POST", "/aa", {
      token,
      body: { jsonrpc: "2.0", id: 7, method, params },
    });
  }
  const pmData = (token: string, op: unknown) =>
    rpc(token, "pm_getPaymasterData", [
      op,
      entryPoint06Address,
      toHex(CHAIN_ID),
      {},
    ]);
  async function counts() {
    return (
      await db.query<{ identity: string; count: number }>(
        "SELECT identity, count FROM sponsorship ORDER BY identity",
      )
    ).rows;
  }

  it("forwards a new Player's createCharacter() through every step and counts one sponsorship", async () => {
    const token = await signIn(noCharacter);
    const op = await userOp(noCharacter, [createCall], false);
    const steps: [string, unknown[]][] = [
      ["pm_getPaymasterStubData", [op, entryPoint06Address, toHex(CHAIN_ID)]],
      ["eth_estimateUserOperationGas", [op, entryPoint06Address]],
      ["pm_getPaymasterData", [op, entryPoint06Address, toHex(CHAIN_ID)]],
      ["eth_sendUserOperation", [op, entryPoint06Address]],
      ["eth_getUserOperationReceipt", [toHex(1, { size: 32 })]],
    ];
    for (const [method, params] of steps) {
      const res = await rpc(token, method, params);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ jsonrpc: "2.0", id: 7, result: "0x01" });
    }
    expect(bundled).toEqual(
      steps.map(([method, params]) => ({ method, params })),
    );
    expect(await counts()).toEqual([
      { identity: "*", count: 1 },
      { identity: noCharacter.address.toLowerCase(), count: 1 },
    ]);
  });

  it("sponsors Land.setDesignHash and a backup passkey on the Player's own account, batched", async () => {
    const token = await signIn(player);
    const op = await userOp(player, [
      designCall,
      { to: player.address, data: addOwnerData },
    ]);
    expect((await pmData(token, op)).status).toBe(200);
  });

  it("refuses calls that are not sponsored, before reaching the bundler", async () => {
    const token = await signIn(player);
    const refused = [
      [transferCall],
      [designCall, transferCall],
      [{ ...designCall, value: 1n }],
      [],
      // a backup owner for someone else's account
      [{ to: stranger.address, data: addOwnerData }],
      [{ to: Land.address, data: "0x" as Hex }],
    ];
    for (const calls of refused) {
      const res = await pmData(token, await userOp(player, calls));
      expect(res.status).toBe(403);
      expect(res.json.error).toBe("only game calls are sponsored");
    }
    const op = await userOp(player, [designCall]);
    expect(
      (await pmData(token, { ...op, callData: "0xdeadbeef" })).status,
    ).toBe(403);
    expect(bundled).toEqual([]);
  });

  it("refuses another sender, factory, EntryPoint or chain, other methods and malformed params", async () => {
    const token = await signIn(player);
    const op = await userOp(player, [designCall]);
    const statuses = [
      await pmData(token, { ...op, sender: stranger.address }),
      await pmData(token, { ...op, initCode: `0x${"ab".repeat(20)}00` }),
      await rpc(token, "pm_getPaymasterData", [
        op,
        stranger.address,
        toHex(CHAIN_ID),
      ]),
      await rpc(token, "pm_getPaymasterData", [
        op,
        entryPoint06Address,
        toHex(1),
      ]),
      await rpc(token, "eth_sendRawTransaction", ["0x00"]),
      await rpc(token, "eth_getUserOperationReceipt", "0x00"),
      await pmData(token, "not an object"),
    ].map((r) => r.status);
    expect(statuses).toEqual([403, 403, 400, 400, 400, 400, 400]);
    expect(bundled).toEqual([]);
  });

  it("refuses a second Character, so a reverting operation is never paid for", async () => {
    const token = await signIn(player);
    const res = await pmData(token, await userOp(player, [createCall]));
    expect(res.status).toBe(409);
    expect(bundled).toEqual([]);
  });

  it("requires a session and a configured bundler", async () => {
    expect((await req("POST", "/aa", { body: {} })).status).toBe(401);
    app = createApp({ ...deps, bundler: undefined });
    const res = await rpc(await signIn(player), "eth_getUserOperationReceipt", [
      toHex(1, { size: 32 }),
    ]);
    expect(res.status).toBe(503);
  });

  it(`allows ${PER_PLAYER} sponsored operations per Player per UTC day`, async () => {
    const op = await userOp(player, [designCall]);
    const token = await signIn(player);
    for (let i = 0; i < PER_PLAYER; i++)
      expect((await pmData(token, op)).status).toBe(200);
    const refused = await pmData(token, op);
    expect(refused.status).toBe(429);
    expect(refused.json.error).toMatch(/limit reached/);
    // another Player is not affected
    const other = await signIn(owner1);
    expect(
      (await pmData(other, await userOp(owner1, [designCall]))).status,
    ).toBe(200);
    // the next UTC day (the session token is checked against the real clock, so it stays valid)
    nowMs += 86_400_000;
    expect((await pmData(token, op)).status).toBe(200);
  });

  it("stops at the world's daily budget, gives the Player's count back and logs once", async () => {
    const day = Math.floor(nowMs / 86_400_000);
    await db.query(
      "INSERT INTO sponsorship (identity, day, count) VALUES ('*', $1, $2)",
      [day, SPONSORED_TRANSACTIONS_PER_DAY],
    );
    const token = await signIn(player);
    const op = await userOp(player, [designCall]);
    for (let i = 0; i < 2; i++) {
      const res = await pmData(token, op);
      expect(res.status).toBe(429);
      expect(res.json.error).toMatch(/budget/);
    }
    expect(await counts()).toContainEqual({
      identity: player.address.toLowerCase(),
      count: 0,
    });
    expect(logs.filter((l) => l.includes("budget"))).toHaveLength(1);
    expect(bundled).toEqual([]);
  });

  it("counts a paymaster stub only when it is marked final (ERC-7677)", async () => {
    const token = await signIn(player);
    const op = await userOp(player, [designCall]);
    const stub = () =>
      rpc(token, "pm_getPaymasterStubData", [
        op,
        entryPoint06Address,
        toHex(CHAIN_ID),
      ]);
    bundlerResult = () => ({ paymasterAndData: "0x01" });
    await stub();
    expect(await counts()).toEqual([]);
    bundlerResult = () => ({ paymasterAndData: "0x01", isFinal: true });
    await stub();
    expect(await counts()).toContainEqual({
      identity: player.address.toLowerCase(),
      count: 1,
    });
  });

  it("passes bundler errors through and hides transport failures", async () => {
    const token = await signIn(player);
    const receipt = () =>
      rpc(token, "eth_getUserOperationReceipt", [toHex(1, { size: 32 })]);
    deps.bundler = async ({ id }) => ({
      jsonrpc: "2.0",
      id,
      error: { code: -32500, message: "AA21 didn't pay prefund" },
    });
    expect((await receipt()).json.error.message).toBe(
      "AA21 didn't pay prefund",
    );
    deps.bundler = async () => {
      throw new Error("fetch https://api.test/rpc/v1/base-sepolia/SECRETKEY");
    };
    const res = await receipt();
    expect(res.status).toBe(502);
    expect(logs.join("\n")).not.toContain("SECRETKEY");
  });
});
