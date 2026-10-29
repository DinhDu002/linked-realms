import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import {
  BaseError,
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type TypedDataDefinition,
} from "viem";
import { entryPoint06Address } from "viem/account-abstraction";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import {
  DIRECTIONS,
  DelegationTypes,
  HUB_EIP712_DOMAIN,
  SPONSORED_CALLS,
  SPONSORED_TRANSACTIONS_PER_DAY,
  SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY,
  TRAVEL_TICKET_TTL_SECONDS,
  TravelTicketTypes,
  arrivalGate,
  deploymentFor,
  gateNumber,
  neighbourOf,
  ticketToWire,
  type Directory,
  type DirectoryLand,
  type TravelTicket,
} from "@linked-realms/shared";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";

export interface ChainReads {
  /** undefined when the Land does not exist. */
  ownerOf(landId: bigint): Promise<Address | undefined>;
  /** undefined when the Land does not exist. */
  coordinatesOf(landId: bigint): Promise<{ x: number; y: number } | undefined>;
  hasCharacter(player: Address): Promise<boolean>;
}

export interface Deps {
  config: Pick<
    Config,
    | "chainId"
    | "siweDomain"
    | "sessionSecret"
    | "admins"
    | "allowedOrigins"
    | "relayPublicUrl"
  >;
  db: Db;
  chain: ChainReads;
  /** Production: the public client's verifySiweMessage (accepts smart-contract wallets). */
  verifySiwe(args: {
    message: string;
    signature: Hex;
    domain: string;
    nonce: string;
    time: Date;
  }): Promise<boolean>;
  /** Production: the public client's verifyTypedData (accepts smart-contract wallets). */
  verifyTypedData(
    args: TypedDataDefinition & { address: Address; signature: Hex },
  ): Promise<boolean>;
  /** Ids of Lands whose Map server link to the relay is open; rejects when the relay is unreachable. */
  online(): Promise<number[]>;
  ticketSigner: Pick<LocalAccount, "address" | "signTypedData">;
  /** Forwards one JSON-RPC request to the bundler and paymaster (CDP); undefined turns sponsorship off. */
  bundler?: (request: {
    jsonrpc: "2.0";
    id: unknown;
    method: string;
    params: unknown[];
  }) => Promise<unknown>;
  /** Milliseconds since the epoch. */
  now(): number;
  log(message: string): void;
}

const SESSION_SECONDS = 3600;
const NONCE_TTL_MS = 5 * 60_000;
const MAX_FUTURE_ISSUED_AT_SECONDS = 5 * 60;
const ONLINE_CACHE_MS = 2000;
const MAX_REASON_LENGTH = 500;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SIGNATURE_LENGTH = 8192;
const MAX_SIWE_MESSAGE_LENGTH = 4096;
// anyone can ask for a nonce: past this many the oldest are dropped
const MAX_NONCES = 10_000;
const DELEGATION_PER_LAND_PER_MINUTE = 10;
const DELEGATION_PER_MINUTE = 200;
// uint32 is the room state type of landId in the Map server
const MAX_LAND_ID = 2 ** 32 - 1;
const UINT64_MAX = 2n ** 64n - 1n;
const DAY_MS = 86_400_000;
// sponsored or not, each request is a call on the bundler's quota; receipt polling needs the headroom
const AA_PER_MINUTE = 120;
// Coinbase Smart Wallet v1.1: the version the client passes to viem's toCoinbaseSmartAccount
const ACCOUNT_FACTORY = "0xba5ed110efdba3d005bfc882d75358acbbb85842";
const accountAbi = parseAbi([
  "function execute(address target, uint256 value, bytes data)",
  "function executeBatch((address target, uint256 value, bytes data)[] calls)",
]);
// What the client's viem bundler client calls: ERC-4337 bundler and ERC-7677 paymaster methods
const USER_OPERATION_METHODS = new Set([
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
]);
const AA_METHODS = new Set([
  ...USER_OPERATION_METHODS,
  "eth_getUserOperationReceipt",
]);

class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 429 | 502 | 503;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function landIdOf(value: unknown): number {
  const n =
    typeof value === "string" && /^[1-9]\d{0,9}$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_LAND_ID)
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

function signatureOf(value: unknown): Hex {
  if (
    typeof value !== "string" ||
    !isHex(value, { strict: true }) ||
    value.length > MAX_SIGNATURE_LENGTH
  )
    throw new HttpError(400, "invalid signature");
  return value;
}

/** Error text that is safe to log: viem's full message carries the RPC URL (often with an API key). */
function logSafe(err: unknown): string {
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.name : "unknown error";
}

/** Sliding window per key, in memory: one process only (ponytail: Redis counters with several nodes). */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now: number): boolean => {
    // keys are free for callers to mint (addresses, Land ids): drop idle ones so the map stays bounded
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

interface DelegationRow {
  land_id: string;
  owner: Address;
  x: number;
  y: number;
  mining_key: Address;
  hidden: boolean;
}

function toDirectoryLand(row: DelegationRow, online: Set<number>) {
  const landId = Number(row.land_id);
  return {
    landId,
    owner: row.owner,
    x: row.x,
    y: row.y,
    miningKey: row.mining_key,
    online: online.has(landId),
  } satisfies DirectoryLand;
}

export function createApp(deps: Deps) {
  const { config, db, chain } = deps;
  const app = new Hono<{ Variables: { address: Address } }>();

  // SIWE nonces live in memory and are single use: one process only (ponytail: shared store with several nodes)
  const nonces = new Map<string, number>();
  const ticketLimit = rateLimiter(30, 60_000);
  const reportLimit = rateLimiter(5, 3_600_000);
  // unauthenticated and costs chain reads: limited per Land and overall
  const delegationLimit = rateLimiter(DELEGATION_PER_LAND_PER_MINUTE, 60_000);
  const delegationAllLimit = rateLimiter(DELEGATION_PER_MINUTE, 60_000);
  const aaLimit = rateLimiter(AA_PER_MINUTE, 60_000);

  // "<to>:<selector>" for each sponsored call; to is a lowercase address, or "account" for the sender itself
  const deployment = deploymentFor(config.chainId);
  const callKey = (to: string, signature: string) =>
    `${to}:${toFunctionSelector(signature)}`;
  const sponsoredCalls = new Set(
    SPONSORED_CALLS.map(({ to, signature }) =>
      callKey(
        to === "account" ? to : deployment[to].address.toLowerCase(),
        signature,
      ),
    ),
  );
  const createCharacterCall = callKey(
    deployment.PlayerRegistry.address.toLowerCase(),
    "createCharacter()",
  );
  let budgetLoggedDay: number | undefined;

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

  async function chainRead<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      deps.log(`chain read failed: ${logSafe(err)}`);
      throw new HttpError(502, "chain unavailable");
    }
  }

  app.use(
    cors({
      origin: (origin) =>
        config.allowedOrigins.includes(origin) ? origin : null,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
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
    // details stay in the log: they can contain RPC URLs
    deps.log(`unhandled error: ${logSafe(err)}`);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.get("/health", (c) => c.text("ok"));

  // --- Sign-in (SIWE) ---

  app.get("/auth/nonce", (c) => {
    const now = deps.now();
    // same TTL for all, so insertion order is expiry order
    for (const [n, expires] of nonces) {
      if (expires > now && nonces.size < MAX_NONCES) break;
      nonces.delete(n);
    }
    const nonce = generateSiweNonce();
    nonces.set(nonce, now + NONCE_TTL_MS);
    return c.json({
      nonce,
      expiresAt: Math.floor((now + NONCE_TTL_MS) / 1000),
    });
  });

  app.post("/auth/verify", async (c) => {
    const body = await jsonBody(c.req);
    const { message } = body;
    const signature = signatureOf(body.signature);
    if (typeof message !== "string" || message.length > MAX_SIWE_MESSAGE_LENGTH)
      throw new HttpError(400, "invalid message");
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce)
      throw new HttpError(400, "invalid message");
    const now = deps.now();
    // consume first, so a failed attempt cannot be retried with the same nonce
    const expires = nonces.get(parsed.nonce);
    nonces.delete(parsed.nonce);
    if (expires === undefined || expires <= now)
      throw new HttpError(401, "unknown or expired nonce");
    if (parsed.chainId !== config.chainId)
      throw new HttpError(401, "wrong chain id");
    const valid = await chainRead(() =>
      deps.verifySiwe({
        message,
        signature,
        domain: config.siweDomain,
        nonce: parsed.nonce as string,
        time: new Date(now),
      }),
    );
    if (!valid)
      throw new HttpError(401, "invalid sign-in message or signature");
    const address = getAddress(parsed.address);
    const iat = Math.floor(now / 1000);
    const expiresAt = iat + SESSION_SECONDS;
    const token = await sign(
      { sub: address, iat, exp: expiresAt },
      config.sessionSecret,
      "HS256",
    );
    return c.json({ token, address, expiresAt });
  });

  const session = createMiddleware<{ Variables: { address: Address } }>(
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
      c.set("address", getAddress(sub));
      await next();
    },
  );
  const admin = createMiddleware<{ Variables: { address: Address } }>(
    async (c, next) => {
      const address = c.get("address");
      if (!config.admins.some((a) => isAddressEqual(a, address)))
        throw new HttpError(403, "admin only");
      await next();
    },
  );
  app.use("/tickets", session);
  app.use("/reports", session);
  app.use("/aa", session);
  app.use("/admin/*", session, admin);

  // --- Directory ---

  async function landRow(landId: number): Promise<DelegationRow | undefined> {
    return (
      await db.query<DelegationRow>(
        "SELECT land_id, owner, x, y, mining_key, hidden FROM delegation WHERE land_id = $1",
        [landId],
      )
    ).rows[0];
  }

  app.get("/directory", async (c) => {
    const rows = (
      await db.query<DelegationRow>(
        "SELECT land_id, owner, x, y, mining_key, hidden FROM delegation WHERE NOT hidden ORDER BY land_id",
      )
    ).rows;
    const online = await onlineLands();
    const directory: Directory = {
      relayUrl: config.relayPublicUrl,
      lands: rows.map((r) => toDirectoryLand(r, online)),
    };
    c.header("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
    return c.json(directory);
  });

  app.get("/directory/:landId", async (c) => {
    const row = await landRow(landIdOf(c.req.param("landId")));
    if (!row || row.hidden) throw new HttpError(404, "Land not found");
    return c.json(toDirectoryLand(row, await onlineLands()));
  });

  // --- Delegation ---

  app.post("/lands/:landId/delegation", async (c) => {
    const landId = landIdOf(c.req.param("landId"));
    const nowMs = deps.now();
    if (
      !delegationLimit(String(landId), nowMs) ||
      !delegationAllLimit("*", nowMs)
    )
      throw new HttpError(429, "too many Delegation attempts");
    const body = await jsonBody(c.req);
    if (
      typeof body.miningKey !== "string" ||
      !isAddress(body.miningKey, { strict: false })
    )
      throw new HttpError(400, "invalid miningKey");
    const miningKey = getAddress(body.miningKey);
    const issuedRaw = body.issuedAt;
    const issuedAt =
      typeof issuedRaw === "string" && /^\d{1,20}$/.test(issuedRaw)
        ? BigInt(issuedRaw)
        : typeof issuedRaw === "number" &&
            Number.isSafeInteger(issuedRaw) &&
            issuedRaw >= 0
          ? BigInt(issuedRaw)
          : undefined;
    if (issuedAt === undefined || issuedAt > UINT64_MAX)
      throw new HttpError(400, "invalid issuedAt");
    const signature = signatureOf(body.signature);
    const nowSeconds = Math.floor(deps.now() / 1000);
    if (issuedAt > BigInt(nowSeconds + MAX_FUTURE_ISSUED_AT_SECONDS))
      throw new HttpError(400, "issuedAt is in the future");

    const owner = await chainRead(() => chain.ownerOf(BigInt(landId)));
    if (!owner) throw new HttpError(404, "Land not found");
    const valid = await chainRead(() =>
      deps.verifyTypedData({
        address: owner,
        domain: HUB_EIP712_DOMAIN(config.chainId),
        types: DelegationTypes,
        primaryType: "Delegation",
        message: { landId: BigInt(landId), miningKey, issuedAt },
        signature,
      }),
    );
    if (!valid)
      throw new HttpError(403, "signature is not from the Land owner");
    const coordinates = await chainRead(() =>
      chain.coordinatesOf(BigInt(landId)),
    );
    if (!coordinates) throw new HttpError(404, "Land not found");

    // The newest Delegation wins; the WHERE makes the comparison atomic. `hidden` is kept.
    const saved = await db.query(
      `INSERT INTO delegation (land_id, owner, x, y, mining_key, issued_at, signature, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (land_id) DO UPDATE SET owner = EXCLUDED.owner, x = EXCLUDED.x, y = EXCLUDED.y,
         mining_key = EXCLUDED.mining_key, issued_at = EXCLUDED.issued_at,
         signature = EXCLUDED.signature, updated_at = EXCLUDED.updated_at
       WHERE delegation.issued_at < EXCLUDED.issued_at
       RETURNING land_id`,
      [
        landId,
        owner,
        coordinates.x,
        coordinates.y,
        miningKey,
        issuedAt.toString(),
        signature,
        nowSeconds,
      ],
    );
    if (saved.rows.length === 0)
      throw new HttpError(409, "a newer Delegation is already registered");
    return c.json({ landId, miningKey, issuedAt: issuedAt.toString() });
  });

  // --- Travel tickets ---

  app.post("/tickets", async (c) => {
    const address = c.get("address");
    if (!ticketLimit(address.toLowerCase(), deps.now()))
      throw new HttpError(429, "too many ticket requests");
    const body = await jsonBody(c.req);
    const landId = landIdOf(body.landId);
    const from = body.from === undefined ? undefined : landIdOf(body.from);
    if (from === landId)
      throw new HttpError(400, "from must differ from landId");

    if (!(await chainRead(() => chain.hasCharacter(address))))
      throw new HttpError(403, "create a Character first");
    const row = await landRow(landId);
    if (!row || row.hidden) throw new HttpError(404, "Land not found");
    if (!(await onlineLands()).has(landId))
      throw new HttpError(409, "Land is offline");

    let gate = 0; // GATE_NONE: spawn at the Land's own spawn point
    if (from !== undefined) {
      const [here, there] = await chainRead(() =>
        Promise.all([
          chain.coordinatesOf(BigInt(from)),
          chain.coordinatesOf(BigInt(landId)),
        ]),
      );
      if (!here) throw new HttpError(404, "origin Land not found");
      if (!there) throw new HttpError(404, "Land not found");
      const direction = DIRECTIONS.find((d) => {
        const n = neighbourOf(here.x, here.y, d);
        return n.x === there.x && n.y === there.y;
      });
      if (!direction) throw new HttpError(403, "Lands are not adjacent");
      gate = gateNumber(arrivalGate(direction));
    }

    const ticket: TravelTicket = {
      player: address,
      landId: BigInt(landId),
      gate,
      expiresAt: BigInt(
        Math.floor(deps.now() / 1000) + TRAVEL_TICKET_TTL_SECONDS,
      ),
      nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signature = await deps.ticketSigner.signTypedData({
      domain: HUB_EIP712_DOMAIN(config.chainId),
      types: TravelTicketTypes,
      primaryType: "TravelTicket",
      message: ticket,
    });
    return c.json({ ticket: ticketToWire(ticket), signature });
  });

  // --- Sponsored transactions: ERC-4337 user operations (ADR 0005) ---

  /** Throws unless the user operation is the Player's own and makes only sponsored calls; true if one creates a Character. */
  function checkUserOperation(
    player: Address,
    method: string,
    params: unknown[],
  ): boolean {
    const [op, entryPoint, chainId] = params;
    if (
      typeof entryPoint !== "string" ||
      !isAddress(entryPoint, { strict: false }) ||
      !isAddressEqual(entryPoint, entryPoint06Address)
    )
      throw new HttpError(400, "only EntryPoint v0.6 is supported");
    if (
      method.startsWith("pm_") &&
      !(isHex(chainId) && Number(chainId) === config.chainId)
    )
      throw new HttpError(400, "wrong chain id");
    if (typeof op !== "object" || op === null)
      throw new HttpError(400, "invalid user operation");
    const { sender, initCode, callData } = op as Record<string, unknown>;
    if (
      typeof sender !== "string" ||
      !isAddress(sender, { strict: false }) ||
      !isAddressEqual(sender, player)
    )
      throw new HttpError(403, "user operations must come from your account");
    // a sponsored deployment must be the account the client creates, not any contract at that address
    if (
      !isHex(initCode) ||
      (initCode !== "0x" && !initCode.toLowerCase().startsWith(ACCOUNT_FACTORY))
    )
      throw new HttpError(403, "unsupported account factory");
    if (!isHex(callData)) throw new HttpError(400, "invalid callData");
    let calls: readonly { target: Address; value: bigint; data: Hex }[];
    try {
      const decoded = decodeFunctionData({ abi: accountAbi, data: callData });
      calls =
        decoded.functionName === "execute"
          ? [
              {
                target: decoded.args[0],
                value: decoded.args[1],
                data: decoded.args[2],
              },
            ]
          : decoded.args[0];
    } catch {
      throw new HttpError(403, "only game calls are sponsored");
    }
    if (calls.length === 0)
      throw new HttpError(403, "only game calls are sponsored");
    let createsCharacter = false;
    for (const call of calls) {
      const key = `${isAddressEqual(call.target, player) ? "account" : call.target.toLowerCase()}:${call.data.slice(0, 10).toLowerCase()}`;
      if (call.value !== 0n || !sponsoredCalls.has(key))
        throw new HttpError(403, "only game calls are sponsored");
      if (key === createCharacterCall) createsCharacter = true;
    }
    return createsCharacter;
  }

  /** Adds one to a daily count unless it is at max; false when it is. */
  async function countUp(identity: string, day: number, max: number) {
    const { rows } = await db.query(
      `INSERT INTO sponsorship (identity, day, count) VALUES ($1, $2, 1)
       ON CONFLICT (identity, day) DO UPDATE SET count = sponsorship.count + 1
       WHERE sponsorship.count < $3
       RETURNING count`,
      [identity, day, max],
    );
    return rows.length > 0;
  }

  /** Counts one Sponsored transaction against the Player's and the world's daily limits. */
  async function sponsor(player: Address) {
    const day = Math.floor(deps.now() / DAY_MS);
    const identity = player.toLowerCase();
    if (
      !(await countUp(identity, day, SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY))
    )
      throw new HttpError(
        429,
        `sponsored transaction limit reached (${SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY} per day)`,
      );
    if (!(await countUp("*", day, SPONSORED_TRANSACTIONS_PER_DAY))) {
      // the world's limit refused it: give the Player's count back
      await db.query(
        "UPDATE sponsorship SET count = count - 1 WHERE identity = $1 AND day = $2",
        [identity, day],
      );
      if (budgetLoggedDay !== day)
        deps.log(
          `daily sponsorship budget (${SPONSORED_TRANSACTIONS_PER_DAY}) used up`,
        );
      budgetLoggedDay = day;
      throw new HttpError(429, "the sponsorship budget for today is used up");
    }
  }

  // JSON-RPC proxy to the bundler and paymaster, whose URL holds the API key (never sent to the client)
  app.post("/aa", async (c) => {
    const bundler = deps.bundler;
    if (!bundler) throw new HttpError(503, "sponsorship is not configured");
    const player = c.get("address");
    if (!aaLimit(player.toLowerCase(), deps.now()))
      throw new HttpError(429, "too many requests");
    const body = await jsonBody(c.req);
    const { method, params } = body;
    if (typeof method !== "string" || !AA_METHODS.has(method))
      throw new HttpError(400, "method not allowed");
    if (!Array.isArray(params))
      throw new HttpError(400, "params must be an array");
    if (USER_OPERATION_METHODS.has(method)) {
      const createsCharacter = checkUserOperation(player, method, params);
      // createCharacter() reverts for a second Character; never pay for that
      if (
        createsCharacter &&
        (await chainRead(() => chain.hasCharacter(player)))
      )
        throw new HttpError(409, "you already have a Character");
    }
    if (method === "pm_getPaymasterData") await sponsor(player);
    let response: unknown;
    try {
      response = await bundler({
        jsonrpc: "2.0",
        id: body.id ?? null,
        method,
        params,
      });
    } catch (err) {
      deps.log(`bundler call failed: ${logSafe(err)}`);
      throw new HttpError(502, "bundler unavailable");
    }
    // ERC-7677: a stub marked final is used as is, so it is the sponsorship
    if (
      method === "pm_getPaymasterStubData" &&
      (response as { result?: { isFinal?: unknown } } | null)?.result
        ?.isFinal === true
    )
      await sponsor(player);
    return c.json(response as object);
  });

  // --- Reports and moderation ---

  app.post("/reports", async (c) => {
    const address = c.get("address");
    if (!reportLimit(address.toLowerCase(), deps.now()))
      throw new HttpError(429, "too many reports");
    const body = await jsonBody(c.req);
    const landId = landIdOf(body.landId);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 1 || reason.length > MAX_REASON_LENGTH)
      throw new HttpError(
        400,
        `reason must be 1 to ${MAX_REASON_LENGTH} characters`,
      );
    if (!(await landRow(landId))) throw new HttpError(404, "Land not found");
    await db.query(
      "INSERT INTO report (land_id, reporter, reason, created_at) VALUES ($1, $2, $3, $4)",
      [landId, address, reason, Math.floor(deps.now() / 1000)],
    );
    return c.json({ ok: true }, 201);
  });

  app.get("/admin/reports", async (c) => {
    const rows = (
      await db.query<{
        id: number;
        land_id: string;
        reporter: Address;
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
      "UPDATE delegation SET hidden = $2 WHERE land_id = $1 RETURNING land_id",
      [landId, body.hidden],
    );
    if (updated.rows.length === 0) throw new HttpError(404, "Land not found");
    deps.log(
      `Land ${landId} ${body.hidden ? "hidden" : "unhidden"} by ${c.get("address")}`,
    );
    return c.json({ landId, hidden: body.hidden });
  });

  return app;
}
