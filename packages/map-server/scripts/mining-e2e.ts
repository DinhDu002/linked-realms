// Manual end-to-end check of mining on a local anvil: two Map servers (Land A and Land B) mine
// together; every reward must land in the wallet of the Land owner whose server submitted it, and
// the Round time must settle near the intended value after the Retargets.
// Needs anvil running with contracts deployed using DEV_ROUND_SECONDS and DEV_RETARGET_INTERVAL_ROUNDS.
// Usage: pnpm --filter @linked-realms/map-server e2e:mining
// Env: RPC_URL, ROUNDS (default: 4 retarget windows), TIMEOUT_SECONDS (default 1800), PORT_A, PORT_B.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@colyseus/sdk";
import {
  LAND_ROOM,
  Messages,
  deploymentFor,
  goldMineAbi,
  goldTokenAbi,
  joinMessage,
  landAbi,
  playerRegistryAbi,
} from "@linked-realms/shared";
import {
  createPublicClient,
  createWalletClient,
  getAbiItem,
  http,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const TIMEOUT_SECONDS = Number(process.env.TIMEOUT_SECONDS ?? 1800);
const PORTS = [
  Number(process.env.PORT_A ?? 2611),
  Number(process.env.PORT_B ?? 2612),
];
const { Land, PlayerRegistry, GoldMine, GoldToken } = deploymentFor(foundry.id);
const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sameAddress = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

async function newCharacter() {
  const account = privateKeyToAccount(generatePrivateKey());
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [account.address, numberToHex(10n ** 18n)] as never,
  });
  const wallet = createWalletClient({
    account,
    chain: foundry,
    transport: http(RPC_URL),
  });
  const hash = await wallet.writeContract({
    address: PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "createCharacter",
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const landId = await publicClient.readContract({
    address: Land.address,
    abi: landAbi,
    functionName: "landOf",
    args: [account.address],
  });
  return { account, landId: Number(landId) };
}

const params = await publicClient.readContract({
  address: GoldMine.address,
  abi: goldMineAbi,
  functionName: "params",
});
const intended = Number(params.intendedRoundSeconds);
const interval = Number(params.retargetIntervalRounds);
const targetRounds = Number(process.env.ROUNDS ?? 4 * interval);
console.log(
  `intended Round time ${intended}s, Retarget every ${interval} Rounds, waiting for ${targetRounds} Rounds`,
);

const characters = [await newCharacter(), await newCharacter()];
characters.forEach((c, i) =>
  console.log(
    `Character ${"AB"[i]} ${c.account.address} owns Land ${c.landId}`,
  ),
);

const children: ChildProcess[] = [];
const dir = mkdtempSync(join(tmpdir(), "linked-realms-mining-"));
const packageDir = fileURLToPath(new URL("..", import.meta.url));

// SIGKILL after a grace period: a server stuck in shutdown must not outlive this script.
async function killChildren() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }),
    ),
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void killChildren().then(() => process.exit(130)));

/** Starts a Map server for one Land and resolves with its Mining key address. */
function startServer(index: number): Promise<Address> {
  const character = characters[index]!;
  const child = spawn("node", ["src/main.ts"], {
    cwd: packageDir,
    env: {
      ...process.env,
      LAND_ID: String(character.landId),
      PORT: String(PORTS[index]),
      RPC_URL,
      MINING_KEY_FILE: join(dir, `key-${index}`),
      MINING_MAX_THREADS: "1",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let key: Address | undefined;
    child.once("exit", () => reject(new Error(`server ${index} exited early`)));
    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(`[${"AB"[index]}] ${text}`);
      key ??= /Mining key \w+: (0x[0-9a-fA-F]{40})/.exec(text)?.[1] as Address;
      if (key && text.includes("Map server for Land")) resolve(key);
    });
  });
}

const failures: string[] = [];
const check = (ok: boolean, text: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failures.push(text);
};

async function joinAndMine(index: number) {
  const { account, landId } = characters[index]!;
  const message = joinMessage(landId, Math.floor(Date.now() / 1000) + 60);
  const signature: Hex = await account.signMessage({ message });
  const room = await new Client(`ws://127.0.0.1:${PORTS[index]}`).joinOrCreate(
    LAND_ROOM,
    { message, signature },
  );
  // P5: a fresh Map server must not be mining until the Land owner asks.
  await sleep(1000);
  check(
    room.state.mining.on === false,
    `${"AB"[index]} mining is off at start`,
  );
  room.send(Messages.mining, { on: true, threads: 1 });
  return room;
}

let rooms: Awaited<ReturnType<typeof joinAndMine>>[] = [];
try {
  const keys = await Promise.all([startServer(0), startServer(1)]);
  const startBlock = await publicClient.getBlockNumber();
  rooms = await Promise.all([joinAndMine(0), joinAndMine(1)]);

  const roundWon = getAbiItem({ abi: goldMineAbi, name: "RoundWon" });
  const retargeted = getAbiItem({ abi: goldMineAbi, name: "Retargeted" });
  const wonCount = async () =>
    (
      await publicClient.getLogs({
        address: GoldMine.address,
        event: roundWon,
        fromBlock: startBlock,
      })
    ).length;

  const deadline = Date.now() + TIMEOUT_SECONDS * 1000;
  let won = 0;
  while (won < targetRounds && Date.now() < deadline) {
    await sleep(2000);
    won = await wonCount();
  }
  check(won >= targetRounds, `${won}/${targetRounds} Rounds won in time`);

  // Switch mining off and let in-flight submissions land before reading the final state.
  for (const room of rooms)
    room.send(Messages.mining, { on: false, threads: 1 });
  await sleep(3000);
  const endBlock = await publicClient.getBlockNumber();
  const range = {
    address: GoldMine.address,
    fromBlock: startBlock,
    toBlock: endBlock,
  };
  const wins = await publicClient.getLogs({ ...range, event: roundWon });
  const retargets = await publicClient.getLogs({ ...range, event: retargeted });

  const rewards = [0n, 0n];
  for (const { args } of wins) {
    const index = keys.findIndex((k) => sameAddress(k, args.submitter!));
    const ok =
      index >= 0 &&
      sameAddress(args.rewardWallet!, characters[index]!.account.address);
    check(
      ok,
      `Round ${args.round} submitted by ${args.submitter}, reward to ${args.rewardWallet}`,
    );
    if (ok) rewards[index] = rewards[index]! + args.reward!;
  }
  check(
    rewards.every((r) => r > 0n),
    `both servers won Rounds (${wins.length} total)`,
  );
  for (const [i, { account }] of characters.entries()) {
    const balance = await publicClient.readContract({
      address: GoldToken.address,
      abi: goldTokenAbi,
      functionName: "balanceOf",
      args: [account.address],
      blockNumber: endBlock,
    });
    check(
      balance === rewards[i],
      `GOLD of ${"AB"[i]} ${balance} equals the sum of its rewards ${rewards[i]}`,
    );
  }

  const means = retargets.map((l) => Number(l.args.actualSeconds!) / interval);
  means.forEach((m, i) =>
    console.log(`window ${i + 1}: mean Round time ${m.toFixed(1)}s`),
  );
  const last = means.at(-1);
  check(
    last !== undefined && last >= intended / 2 && last <= intended * 2,
    `last window mean ${last?.toFixed(1)}s is within [${intended / 2}, ${intended * 2}]`,
  );
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  for (const room of rooms) {
    room.send(Messages.mining, { on: false, threads: 1 });
    await room.leave().catch(() => {});
  }
  await killChildren();
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  failures.length === 0 ? "PASS" : `FAIL: ${failures.length} check(s) failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
