import { formatEther, type Address } from "viem";

const MIN_DEV_BALANCE = 10n ** 18n;
const ANVIL_CHAIN_ID = 31337;

/** The slice of a viem public client this needs; tests use a fake. */
export interface RpcClient {
  getChainId(): Promise<number>;
  getBalance(args: { address: Address }): Promise<bigint>;
  /** anvil_setBalance */
  setBalance(address: Address, wei: bigint): Promise<void>;
}

/**
 * Tops up the Mining key on anvil, and reports its address and balance. The chain id is asked of
 * the RPC itself, not taken from config: a wrong CHAIN_ID must never unlock anvil_setBalance on a
 * real network.
 */
export async function reportMiningKey(
  client: RpcClient,
  configuredChainId: number,
  address: Address,
  created: boolean,
): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== configuredChainId)
    throw new Error(
      `RPC is chain ${actual} but CHAIN_ID is ${configuredChainId}: refusing to start`,
    );
  let balance = await client.getBalance({ address });
  if (actual === ANVIL_CHAIN_ID && balance < MIN_DEV_BALANCE) {
    await client.setBalance(address, MIN_DEV_BALANCE);
    balance = MIN_DEV_BALANCE;
  }
  console.log(
    `Mining key ${created ? "created" : "loaded"}: ${address}, balance ${formatEther(balance)} ETH. Mining is off until the Land owner switches it on.`,
  );
  if (balance === 0n)
    console.warn(
      `WARNING: Mining key has no ETH: fund ${address} from a faucet to pay fees for submitting Solutions`,
    );
}
