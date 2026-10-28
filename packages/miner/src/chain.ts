import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  BaseError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentFor, goldMineAbi } from "@linked-realms/shared";

export interface RoundInfo {
  round: bigint;
  challenge: Hex;
  target: bigint;
}

/** "lost": another Solution won the Round first. Other failures throw. */
export type SubmitOutcome = "won" | "lost";

export interface MinerChain {
  currentRound(): Promise<RoundInfo>;
  submit(
    round: bigint,
    nonce: bigint,
    rewardWallet: Address,
  ): Promise<SubmitOutcome>;
}

// viem polls for receipts every 4 s by default: far too slow for a 1 s block time, and the Miner is idle meanwhile.
const POLLING_INTERVAL_MS = 250;
const RECEIPT_TIMEOUT_MS = 60_000;

// GoldMine.submit uses at most ~150k gas (forge gas report: first mint plus a Retarget).
const SUBMIT_GAS = 300_000n;

function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError
    ? revert.data?.errorName
    : undefined;
}

export function createMinerChain(options: {
  rpcUrl: string;
  chainId: number;
  privateKey: Hex;
}): MinerChain {
  const { GoldMine } = deploymentFor(options.chainId);
  const chain = defineChain({
    id: options.chainId,
    name: `chain-${options.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const account = privateKeyToAccount(options.privateKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(),
    pollingInterval: POLLING_INTERVAL_MS,
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(),
    pollingInterval: POLLING_INTERVAL_MS,
  });

  async function currentRound(): Promise<RoundInfo> {
    const [round, challenge, target] = await publicClient.readContract({
      address: GoldMine.address,
      abi: goldMineAbi,
      functionName: "currentRound",
    });
    return { round, challenge, target };
  }

  return {
    currentRound,
    async submit(round, nonce, rewardWallet) {
      const call = {
        address: GoldMine.address,
        abi: goldMineAbi,
        functionName: "submit",
        args: [round, nonce, rewardWallet],
      } as const;
      try {
        let hash: Hex;
        try {
          const { request } = await publicClient.simulateContract({
            account,
            ...call,
          });
          hash = await walletClient.writeContract(request);
        } catch (error) {
          // The simulation runs against the latest block. Right after a win that is the block where this
          // Round started, so RoundAlreadyWonInThisBlock only means "not in this block": a new transaction
          // lands in a later block, where the Solution is still good. Send it with a fixed gas limit, since
          // gas estimation hits the same revert. (On an automining anvil no later block would ever come
          // otherwise, and on a real chain every Solution found in a Round's first block would be dropped.)
          if (revertName(error) !== "RoundAlreadyWonInThisBlock") throw error;
          hash = await walletClient.writeContract({ ...call, gas: SUBMIT_GAS });
        }
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: RECEIPT_TIMEOUT_MS,
        });
        if (receipt.status === "success") return "won";
        // Reverted after a passing simulation: it is "lost" only if another Solution moved the Round on.
        // Anything else (gas, hash mismatch, state change) is a real error and must surface.
        const now = await currentRound();
        if (now.round > round) return "lost";
        throw new Error(`submit transaction ${hash} reverted on-chain`);
      } catch (error) {
        if (revertName(error) === "StaleRound") return "lost";
        throw error;
      }
    },
  };
}
