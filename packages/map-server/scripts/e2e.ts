// Manual end-to-end check against a local anvil: two fresh wallets create Characters, a Map
// server starts for the first one's Land, and two SDK clients join with signed messages.
// Usage: node scripts/e2e.ts   (anvil must be running with the contracts deployed)
import { spawn } from "node:child_process";
import { Client } from "@colyseus/sdk";
import {
  LAND_ROOM,
  Messages,
  deploymentFor,
  joinMessage,
  landAbi,
  playerRegistryAbi,
  type PlayerStateShape,
} from "@linked-realms/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? 2601);
const { Land, PlayerRegistry } = deploymentFor(foundry.id);
const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
});
interface PlayersView {
  players: Map<string, PlayerStateShape>;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const a = await newCharacter();
const b = await newCharacter();
console.log(`Character A ${a.account.address} owns Land ${a.landId}`);
console.log(`Character B ${b.account.address} owns Land ${b.landId}`);

const server = spawn("node", ["src/main.ts"], {
  env: {
    ...process.env,
    LAND_ID: String(a.landId),
    PORT: String(PORT),
    RPC_URL,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (chunk: Buffer) =>
  process.stdout.write(`[server] ${chunk}`),
);

try {
  await sleep(1500);
  const client = new Client(`ws://127.0.0.1:${PORT}`);
  const join = async (account: typeof a.account) => {
    const message = joinMessage(a.landId, Math.floor(Date.now() / 1000) + 60);
    const signature: Hex = await account.signMessage({ message });
    return client.joinOrCreate(LAND_ROOM, { message, signature });
  };
  const roomA = await join(a.account);
  const roomB = await join(b.account);
  await sleep(500);
  const view = (room: typeof roomA) => [
    ...(room.state as PlayersView).players.values(),
  ];
  console.log("A sees", view(roomA));
  console.log("B sees", view(roomB));

  roomB.send(Messages.input, {
    up: false,
    down: false,
    left: false,
    right: true,
  });
  await sleep(500);
  roomB.send(Messages.input, {
    up: false,
    down: false,
    left: false,
    right: false,
  });
  await sleep(300);
  console.log("after B walked east, A sees", view(roomA));

  roomA.send(Messages.input, {
    up: true,
    down: false,
    left: false,
    right: false,
  });
  await sleep(1500);
  console.log("after A walked north into the Mine, B sees", view(roomB));

  // A third join with A's wallet must be rejected.
  await join(a.account).then(
    () => console.log("UNEXPECTED: second session accepted"),
    (e: Error) => console.log("second session for A rejected:", e.message),
  );
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  console.log("server stopped");
}
process.exit(0);
