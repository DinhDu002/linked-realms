// One-shot setup for the "world" compose profile (local development only): Characters for anvil dev
// accounts 1-3 (created one after another, so they get Lands 1, 2 and 3), a Mining key file per
// Map server, and a Delegation for each Land signed by its owner and posted to hub-api.
// The accounts come from anvil's public test mnemonic: their keys are not secret.
// Usage: node scripts/seed-world.ts   (env: RPC_URL, HUB_URL, KEYS_DIR)
import { loadOrCreateMiningKey } from "@linked-realms/miner";
import {
  DelegationTypes,
  HUB_EIP712_DOMAIN,
  deploymentFor,
  landAbi,
  playerRegistryAbi,
} from "@linked-realms/shared";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const HUB_URL = (process.env.HUB_URL ?? "http://127.0.0.1:8787").replace(
  /\/+$/,
  "",
);
// Map server N keeps its Mining key in <KEYS_DIR>/map-N/mining-key (a volume in compose)
const KEYS_DIR = process.env.KEYS_DIR ?? "/data";
const DEV_MNEMONIC =
  "test test test test test test test test test test test junk";
const LANDS = [1, 2, 3];

const { Land, PlayerRegistry } = deploymentFor(foundry.id);
const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
});

for (const landId of LANDS) {
  const owner = mnemonicToAccount(DEV_MNEMONIC, { addressIndex: landId });
  const wallet = createWalletClient({
    account: owner,
    chain: foundry,
    transport: http(RPC_URL),
  });

  const has = await publicClient.readContract({
    address: PlayerRegistry.address,
    abi: playerRegistryAbi,
    functionName: "hasCharacter",
    args: [owner.address],
  });
  if (!has) {
    const hash = await wallet.writeContract({
      address: PlayerRegistry.address,
      abi: playerRegistryAbi,
      functionName: "createCharacter",
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const got = await publicClient.readContract({
    address: Land.address,
    abi: landAbi,
    functionName: "landOf",
    args: [owner.address],
  });
  if (got !== BigInt(landId))
    throw new Error(
      `dev account ${landId} owns Land ${got}, expected ${landId}: the anvil is not fresh`,
    );

  const key = loadOrCreateMiningKey(`${KEYS_DIR}/map-${landId}/mining-key`);
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await wallet.signTypedData({
    domain: HUB_EIP712_DOMAIN(foundry.id),
    types: DelegationTypes,
    primaryType: "Delegation",
    message: {
      landId: BigInt(landId),
      miningKey: key.address,
      issuedAt: BigInt(issuedAt),
    },
  });
  const res = await fetch(`${HUB_URL}/lands/${landId}/delegation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ miningKey: key.address, issuedAt, signature }),
  });
  if (!res.ok)
    throw new Error(
      `hub-api refused the Delegation for Land ${landId}: ${res.status} ${await res.text()}`,
    );
  console.log(
    `Land ${landId}: owner ${owner.address}, Mining key ${key.address} registered`,
  );
}
