import { createConfig } from "ponder";
import {
  deploymentFor,
  landAbi,
  playerRegistryAbi,
} from "@linked-realms/shared";

const chainId = Number(process.env.CHAIN_ID ?? 31337);
const deployment = deploymentFor(chainId);

export default createConfig({
  database: {
    kind: "postgres",
    connectionString:
      process.env.DATABASE_URL ??
      "postgres://linked_realms:linked_realms@127.0.0.1:5432/linked_realms",
  },
  chains: {
    main: {
      id: chainId,
      rpc: process.env.PONDER_RPC_URL ?? "http://127.0.0.1:8545",
    },
  },
  contracts: {
    PlayerRegistry: {
      chain: "main",
      abi: playerRegistryAbi,
      address: deployment.PlayerRegistry.address,
      startBlock: deployment.PlayerRegistry.startBlock,
    },
    Land: {
      chain: "main",
      abi: landAbi,
      address: deployment.Land.address,
      startBlock: deployment.Land.startBlock,
    },
  },
});
