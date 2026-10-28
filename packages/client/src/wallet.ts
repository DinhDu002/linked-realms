// Two kinds of wallet. Neither key ever leaves the browser (P2): the injected wallet keeps its
// own key; the dev wallet is a throwaway key in localStorage, offered only on local anvil.
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseEther,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEV_CHAIN_ID, type ClientConfig } from "./config.ts";

const DEV_KEY_STORAGE = "linked-realms.devWalletKey";
const DEV_FUNDS = parseEther("100");

export interface Wallet {
  kind: "injected" | "dev";
  label: string;
  address: Address;
  /** What to pass as `account`: the local account object for the dev wallet, the address otherwise. */
  account: Account | Address;
  client: WalletClient;
}

export function chainFor(config: ClientConfig): Chain {
  return defineChain({
    id: config.chainId,
    name: config.chainId === DEV_CHAIN_ID ? "Anvil" : `Chain ${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
}

export function createReader(config: ClientConfig): PublicClient {
  return createPublicClient({
    chain: chainFor(config),
    transport: http(config.rpcUrl),
  });
}

export function hasInjectedWallet(): boolean {
  return (window as { ethereum?: unknown }).ethereum !== undefined;
}

export async function connectInjected(config: ClientConfig): Promise<Wallet> {
  const provider = (window as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("no browser wallet found");
  const chain = chainFor(config);
  const [address] = await createWalletClient({
    chain,
    transport: custom(provider),
  }).requestAddresses();
  if (!address) throw new Error("the wallet returned no account");
  const client = createWalletClient({
    account: address,
    chain,
    transport: custom(provider),
  });
  await client.switchChain({ id: config.chainId });
  return {
    kind: "injected",
    label: "Browser wallet",
    address,
    account: address,
    client,
  };
}

/** Creates (or reloads) the dev wallet and tops it up through anvil's `anvil_setBalance`. */
export async function connectDev(config: ClientConfig): Promise<Wallet> {
  if (config.chainId !== DEV_CHAIN_ID)
    throw new Error("the dev wallet only exists on the local anvil chain");
  let key = localStorage.getItem(DEV_KEY_STORAGE);
  if (!key || !/^0x[0-9a-f]{64}$/.test(key)) {
    key = generatePrivateKey();
    localStorage.setItem(DEV_KEY_STORAGE, key);
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  const chain = chainFor(config);
  const reader = createReader(config);
  if (
    (await reader.getBalance({ address: account.address })) <
    DEV_FUNDS / 2n
  ) {
    await createTestClient({
      chain,
      mode: "anvil",
      transport: http(config.rpcUrl),
    }).setBalance({
      address: account.address,
      value: DEV_FUNDS,
    });
  }
  return {
    kind: "dev",
    label: "Dev wallet (local key in this browser, anvil only)",
    address: account.address,
    account,
    client: createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl),
    }),
  };
}
