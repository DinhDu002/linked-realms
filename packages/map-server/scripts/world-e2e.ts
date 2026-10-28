// The Done-when scenario of Phase 1C, against `docker compose --profile world up -d` (README: Run the
// world): a Player signs in, enters Land 1 through the relay, walks east through the Gate into Land 2
// (travelling exactly as the client does), then Land 1's Map server is stopped and the Directory must
// show it offline, and online again once it is started.
// Usage: pnpm e2e:world   (env: WORLD_PROJECT, default linked-realms-world; RPC_URL and HUB_URL override)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, type Room } from "@colyseus/sdk";
import {
  GATE_WEST,
  LAND_ROOM,
  Messages,
  deploymentFor,
  gateOf,
  gateSpawn,
  parseLandMap,
  playerRegistryAbi,
  relayLandUrl,
  type Directory,
  type PlayerStateShape,
} from "@linked-realms/shared";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { createSiweMessage } from "viem/siwe";

const PROJECT = process.env.WORLD_PROJECT ?? "linked-realms-world";
// Ask compose where the world's ports are, never assume the defaults: 8545 is usually the
// developer's own anvil, and this script sends transactions.
function publishedUrl(service: string, port: number): string {
  const out = execFileSync(
    "docker",
    [
      "compose",
      "-p",
      PROJECT,
      "--profile",
      "world",
      "port",
      service,
      String(port),
    ],
    { encoding: "utf8" },
  ).trim();
  return `http://${out.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
}
const RPC_URL = process.env.RPC_URL ?? publishedUrl("anvil", 8545);
const HUB_URL = (process.env.HUB_URL ?? publishedUrl("hub-api", 8787)).replace(
  /\/+$/,
  "",
);
// hub-api's HUB_SIWE_DOMAIN default: the client's dev server
const SIWE_DOMAIN = "localhost:5173";
const SIWE_URI = "http://localhost:5173";
// anvil's public test mnemonic: not a secret
const player = mnemonicToAccount(
  "test test test test test test test test test test test junk",
  { addressIndex: 4 },
);
const map = parseLandMap(
  readFileSync(
    fileURLToPath(new URL("../../../maps/empty-land.json", import.meta.url)),
    "utf8",
  ),
);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
}

async function hub(
  method: string,
  path: string,
  options: { body?: unknown; token?: string } = {},
): Promise<unknown> {
  const res = await fetch(`${HUB_URL}${path}`, {
    method,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

const directory = () => hub("GET", "/directory") as Promise<Directory>;
const landOnline = async (landId: number) =>
  (await directory()).lands.find((l) => l.landId === landId)?.online === true;

async function waitFor(
  what: string,
  until: () => Promise<boolean>,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (!(await until().catch(() => false))) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
  return Date.now() - started;
}

const compose = (...args: string[]) =>
  execFileSync(
    "docker",
    ["compose", "-p", PROJECT, "--profile", "world", ...args],
    { stdio: "inherit" },
  );

const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
});
async function ensureCharacter(): Promise<void> {
  const { PlayerRegistry } = deploymentFor(foundry.id);
  const has = await publicClient.readContract({
    address: PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "hasCharacter",
    args: [player.address],
  });
  if (has) return;
  const hash = await createWalletClient({
    account: player,
    chain: foundry,
    transport: http(RPC_URL),
  }).writeContract({
    address: PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "createCharacter",
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function signIn(): Promise<string> {
  const { nonce } = (await hub("GET", "/auth/nonce")) as { nonce: string };
  const message = createSiweMessage({
    address: player.address,
    chainId: foundry.id,
    domain: SIWE_DOMAIN,
    uri: SIWE_URI,
    nonce,
    version: "1",
    statement: "Sign in to the linked-realms Hub.",
  });
  const signature = await player.signMessage({ message });
  const session = (await hub("POST", "/auth/verify", {
    body: { message, signature },
  })) as { token: string };
  return session.token;
}

interface PlayersView {
  players: Map<string, PlayerStateShape>;
}
const self = (room: Room): PlayerStateShape | undefined =>
  (room.state as PlayersView).players.get(room.sessionId);

/** Same call the client makes: a ticket from the Hub, then Colyseus through the relay. */
async function enter(token: string, landId: number, from?: number) {
  const grant = (await hub("POST", "/tickets", {
    body: from === undefined ? { landId } : { landId, from },
    token,
  })) as { ticket: { gate: number }; signature: string };
  const { relayUrl } = await directory();
  const room = await new Client(relayLandUrl(relayUrl, landId)).joinOrCreate(
    LAND_ROOM,
    grant,
  );
  await waitFor(
    "own Character in the room state",
    async () => !!self(room),
    5000,
  );
  return { room, gate: grant.ticket.gate };
}

/** Steers with input messages (what the keyboard sends) until `done`; false on timeout. */
async function walk(
  room: Room,
  target: { y: number },
  done: (p: PlayerStateShape) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const p = self(room);
    if (p && done(p)) {
      room.send(Messages.input, {
        up: false,
        down: false,
        left: false,
        right: false,
      });
      return true;
    }
    const dy = target.y - (p?.y ?? target.y);
    room.send(Messages.input, {
      up: dy < -4,
      down: dy > 4,
      left: false,
      right: true,
    });
    await sleep(50);
  }
  return false;
}

const rooms: Room[] = [];
try {
  await ensureCharacter();
  const token = await signIn();
  check("signed in with SIWE", token.length > 0);

  const first = await enter(token, 1);
  rooms.push(first.room);
  check("joined Land 1 through the relay", self(first.room) !== undefined);

  const eastGate = map.gates.east;
  const arrived = await walk(
    first.room,
    { y: (eastGate.tileY + eastGate.height / 2) * map.tileSize },
    (p) => gateOf(map, p) === "east",
    60_000,
  );
  const at = self(first.room);
  check("walked onto Land 1's east Gate", arrived, `at (${at?.x}, ${at?.y})`);

  // The client asks for the ticket first and leaves the old Land only once it has it.
  const second = await enter(token, 2, 1);
  await first.room.leave();
  rooms.length = 0;
  rooms.push(second.room);
  check(
    "ticket for Land 2 names the west Gate",
    second.gate === GATE_WEST,
    `gate ${second.gate}`,
  );
  const spawn = gateSpawn(map, "west");
  const there = self(second.room);
  check(
    "spawned one tile inside Land 2's west Gate",
    there !== undefined &&
      Math.abs(there.x - spawn.x) < 1 &&
      Math.abs(there.y - spawn.y) < 1,
    `at (${there?.x}, ${there?.y}), expected (${spawn.x}, ${spawn.y})`,
  );
  await second.room.leave();
  rooms.length = 0;

  check("Land 1 is online", await landOnline(1));
  compose("stop", "map-1");
  const offlineMs = await waitFor(
    "Land 1 to show offline",
    async () => !(await landOnline(1)),
    60_000,
  );
  check("Directory shows Land 1 offline", true, `after ${offlineMs} ms`);
  check("Land 2 stays online", await landOnline(2));
  // --no-deps: `compose start` would also re-run the one-shot services map-1 depends on
  compose("up", "-d", "--no-deps", "map-1");
  const onlineMs = await waitFor(
    "Land 1 to show online",
    () => landOnline(1),
    120_000,
  );
  check("Directory shows Land 1 online again", true, `after ${onlineMs} ms`);
} catch (error) {
  check(
    "scenario",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  for (const room of rooms) await room.leave().catch(() => undefined);
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);
