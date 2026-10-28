// Manual end-to-end check against a local anvil: two fresh wallets create Characters, a Map
// server starts for the first one's Land, and two SDK clients join with Travel tickets signed by a
// throwaway key standing in for the Hub.
// Usage: node scripts/e2e.ts   (anvil must be running with the contracts deployed)
import { spawn } from "node:child_process";
import { Client } from "@colyseus/sdk";
import {
  GATE_NONE,
  HUB_EIP712_DOMAIN,
  TRAVEL_TICKET_TTL_SECONDS,
  TravelTicketTypes,
  ticketToWire,
  LAND_ROOM,
  Messages,
  deploymentFor,
  landAbi,
  playerRegistryAbi,
  type PlayerStateShape,
} from "@linked-realms/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
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

// No Hub here: a throwaway key plays the Hub. The Map servers trust its address, and this
// script signs the Travel tickets (the same typed data hub-api signs).
const hub = privateKeyToAccount(generatePrivateKey());
async function ticketFor(account: PrivateKeyAccount, landId: number) {
  const ticket = {
    player: account.address,
    landId: BigInt(landId),
    gate: GATE_NONE,
    expiresAt: BigInt(
      Math.floor(Date.now() / 1000) + TRAVEL_TICKET_TTL_SECONDS,
    ),
    nonce: generatePrivateKey(), // 32 random bytes
  };
  const signature = await hub.signTypedData({
    domain: HUB_EIP712_DOMAIN(foundry.id),
    types: TravelTicketTypes,
    primaryType: "TravelTicket",
    message: ticket,
  });
  return { ticket: ticketToWire(ticket), signature };
}

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
    HUB_TICKET_SIGNER: hub.address,
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
  const join = async (account: typeof a.account) =>
    client.joinOrCreate(LAND_ROOM, await ticketFor(account, a.landId));
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
