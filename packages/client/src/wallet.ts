// Three kinds of wallet. No key ever leaves the browser or the authenticator (P2): the injected
// wallet keeps its own key; the passkey wallet (ADR 0005) is a Coinbase Smart Wallet owned by a
// passkey on this site's domain; the dev wallet is a throwaway key in localStorage, local anvil only.
import { WebAuthnP256 } from "ox";
import {
  bytesToHex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  isHex,
  parseAbi,
  parseEther,
  size,
  slice,
  toHex,
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  createBundlerClient,
  createWebAuthnCredential,
  toCoinbaseSmartAccount,
  toWebAuthnAccount,
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEV_CHAIN_ID, type ClientConfig } from "./config.ts";
import { recoverPublicKey } from "./passkey.ts";

const DEV_KEY_STORAGE = "linked-realms.devWalletKey";
const DEV_FUNDS = parseEther("100");
const PASSKEY_STORAGE = "linked-realms.passkey";
const PASSKEY_NAME = "linked-realms";
// hub-api accepts deployments through this version's factory only
const ACCOUNT_VERSION = "1.1";
const ownersAbi = parseAbi([
  "function addOwnerPublicKey(bytes32 x, bytes32 y)",
  "function nextOwnerIndex() view returns (uint256)",
  "function ownerAtIndex(uint256 index) view returns (bytes)",
  "function ownerCount() view returns (uint256)",
]);

export interface Wallet {
  kind: "injected" | "dev" | "passkey";
  label: string;
  address: Address;
  /** What to pass as `account`: the account object for the dev and passkey wallets, the address otherwise. */
  account: Account | Address;
  client: WalletClient;
  /** Sends one contract call and waits until it is mined; throws if it reverts. */
  send(call: { to: Address; data: Hex }): Promise<void>;
}

/** A passkey known on this device. `account` is set for a backup passkey, whose key does not derive the address. */
interface StoredPasskey {
  id: string;
  publicKey: Hex;
  account?: Address;
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

/** For wallets that send ordinary transactions. */
function sendTransaction(
  config: ClientConfig,
  client: WalletClient,
  account: Account | Address,
): Wallet["send"] {
  return async ({ to, data }) => {
    const hash = await client.sendTransaction({
      account,
      chain: client.chain,
      to,
      data,
    });
    const receipt = await createReader(config).waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success")
      throw new Error("the transaction reverted");
  };
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
    send: sendTransaction(config, client, address),
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
  const client = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });
  return {
    kind: "dev",
    label: "Dev wallet (local key in this browser, anvil only)",
    address: account.address,
    account,
    client,
    send: sendTransaction(config, client, account),
  };
}

function loadPasskey(): StoredPasskey | undefined {
  try {
    const p: unknown = JSON.parse(localStorage.getItem(PASSKEY_STORAGE) ?? "");
    if (
      typeof p === "object" &&
      p !== null &&
      "id" in p &&
      typeof p.id === "string" &&
      "publicKey" in p &&
      isHex(p.publicKey) &&
      size(p.publicKey) === 64 &&
      (!("account" in p) || isAddress(p.account as string))
    )
      return p as StoredPasskey;
  } catch {
    // nothing stored, or not ours
  }
  return undefined;
}

export function hasStoredPasskey(): boolean {
  return loadPasskey() !== undefined;
}

/** The owner index a backup passkey signs with: the account checks the key at that index. */
async function ownerIndexOf(
  reader: PublicClient,
  account: Address,
  publicKey: Hex,
): Promise<number> {
  const next = await reader.readContract({
    address: account,
    abi: ownersAbi,
    functionName: "nextOwnerIndex",
  });
  for (let i = 0n; i < next; i++) {
    const owner = await reader
      .readContract({
        address: account,
        abi: ownersAbi,
        functionName: "ownerAtIndex",
        args: [i],
      })
      // a removed owner's index reverts
      .catch(() => undefined);
    if (owner?.toLowerCase() === publicKey.toLowerCase()) return Number(i);
  }
  throw new Error("this passkey is no longer an owner of its account");
}

async function passkeyWallet(
  config: ClientConfig,
  passkey: StoredPasskey,
  authorization: () => Promise<string>,
): Promise<Wallet> {
  const reader = createReader(config);
  const account = await toCoinbaseSmartAccount({
    client: reader,
    owners: [toWebAuthnAccount({ credential: passkey })],
    version: ACCOUNT_VERSION,
    address: passkey.account,
    ownerIndex: passkey.account
      ? await ownerIndexOf(reader, passkey.account, passkey.publicKey)
      : 0,
  });
  return {
    kind: "passkey",
    label: "Passkey wallet",
    address: account.address,
    account,
    client: createWalletClient({
      account,
      chain: chainFor(config),
      transport: http(config.rpcUrl),
    }),
    // a user operation the Hub forwards to the paymaster (only game calls are sponsored)
    async send(call) {
      const session = await authorization();
      const bundler = createBundlerClient({
        account,
        client: reader,
        paymaster: true,
        transport: http(`${config.hubUrl}/aa`, {
          fetchOptions: { headers: { Authorization: session } },
        }),
      });
      const hash = await bundler.sendUserOperation({ calls: [call] });
      const { success } = await bundler.waitForUserOperationReceipt({ hash });
      if (!success) throw new Error("the transaction reverted");
    },
  };
}

/** Creates a passkey on this site's domain; the account it owns is deployed by its first transaction. */
export async function createPasskeyWallet(
  config: ClientConfig,
  authorization: () => Promise<string>,
): Promise<Wallet> {
  const credential = await createWebAuthnCredential({
    name: PASSKEY_NAME,
    // a fresh user id: with a shared one, the next account made on this device would replace this passkey
    user: {
      name: "linked-realms Player",
      id: crypto.getRandomValues(new Uint8Array(32)),
    },
  });
  const passkey = { id: credential.id, publicKey: credential.publicKey };
  localStorage.setItem(PASSKEY_STORAGE, JSON.stringify(passkey));
  return passkeyWallet(config, passkey, authorization);
}

/** Signs in with the passkey stored here, or with any of the site's passkeys the device can use. */
export async function signInWithPasskey(
  config: ClientConfig,
  authorization: () => Promise<string>,
): Promise<Wallet> {
  let passkey = loadPasskey();
  if (!passkey) {
    // this device has not seen the passkey's public key: two signatures recover it
    const challenge = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
    const first = await WebAuthnP256.sign({ challenge: challenge() });
    const second = await WebAuthnP256.sign({
      challenge: challenge(),
      credentialId: first.id,
    });
    const handle = (first.raw.response as { userHandle?: ArrayBuffer | null })
      .userHandle;
    passkey = {
      id: first.id,
      publicKey: recoverPublicKey(first, second),
      // a backup passkey's user id is its account's address (addBackupPasskey)
      ...(handle?.byteLength === 20 && {
        account: getAddress(bytesToHex(new Uint8Array(handle))),
      }),
    };
    localStorage.setItem(PASSKEY_STORAGE, JSON.stringify(passkey));
  }
  return passkeyWallet(config, passkey, authorization);
}

/** Owners of a deployed passkey wallet; 1 means no backup passkey. */
export function ownerCount(config: ClientConfig, account: Address) {
  return createReader(config).readContract({
    address: account,
    abi: ownersAbi,
    functionName: "ownerCount",
  });
}

/** Creates a second passkey (meant for another device or a security key) and adds it as an owner. */
export async function addBackupPasskey(wallet: Wallet): Promise<void> {
  const credential = await createWebAuthnCredential({
    name: PASSKEY_NAME,
    // the account's address as user id: signing in with this passkey finds the account from it
    user: {
      name: `linked-realms backup for ${wallet.address}`,
      id: hexToBytes(wallet.address),
    },
  });
  await wallet.send({
    to: wallet.address,
    data: encodeFunctionData({
      abi: ownersAbi,
      functionName: "addOwnerPublicKey",
      args: [
        slice(credential.publicKey, 0, 32),
        slice(credential.publicKey, 32),
      ],
    }),
  });
}
