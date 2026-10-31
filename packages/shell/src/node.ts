// The Node RPC methods the Shell uses (docs/protocols/node-rpc.md), on the Public node. The Node
// holds no key: the Shell builds and signs every transaction itself and only sends its bytes.

export class NodeError extends Error {
  override name = "NodeError";
  /** The JSON-RPC error code, the HTTP status when the answer is not JSON-RPC, or 0 when unreachable. */
  readonly code: number;
  /** Why a transaction was refused (-32003): `fee-too-low`, `dust`, `nonce-gap`… */
  readonly reason: string | undefined;
  constructor(code: number, message: string, reason?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

export interface NodeInfo {
  networkId: number;
  height: number;
}

export interface Account {
  /** Base units. */
  balance: bigint;
  nonce: number;
  hasKey: boolean;
}

export interface Transaction {
  id: string;
  sender: string;
  nonce: number;
  /** Base units, as a decimal string. */
  fee: string;
  kind: "transfer" | "rotation";
  to?: string;
  amount?: string;
  /** Hex. */
  memo?: string;
}

export interface PlacedTransaction {
  tx: Transaction;
  /** Null while the Node holds it in its mempool. */
  block: { id: string; height: number; place: number } | null;
}

export const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function createNodeClient(
  nodeUrl: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
  let nextId = 1;

  async function call<T>(method: string, params: unknown[] = []): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(nodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        cache: "no-store",
      });
    } catch {
      throw new NodeError(0, "The Node cannot be reached");
    }
    const json = (await response.json().catch(() => undefined)) as
      | {
          result?: unknown;
          error?: { code?: unknown; message?: unknown; data?: unknown };
        }
      | undefined;
    const error = json?.error;
    if (error) {
      const reason = (error.data as { reason?: unknown } | undefined)?.reason;
      throw new NodeError(
        typeof error.code === "number" ? error.code : response.status,
        typeof error.message === "string" ? error.message : "The Node refused",
        typeof reason === "string" ? reason : undefined,
      );
    }
    if (!response.ok || json === undefined || !("result" in json))
      throw new NodeError(
        response.status,
        `The Node answered ${response.status}`,
      );
    return json.result as T;
  }

  return {
    info: () => call<NodeInfo>("lr_getInfo"),
    /** The account on the tip, or with `includeMempool` after its own held transactions; null if none. */
    async account(
      address: string,
      includeMempool = false,
    ): Promise<Account | null> {
      const raw = await call<{
        balance: string;
        nonce: number;
        hasKey: boolean;
      } | null>("lr_getAccount", [address, includeMempool]);
      return raw && { ...raw, balance: BigInt(raw.balance) };
    },
    /** Base units a byte that would put a transaction in the next Block now. */
    feeRate: async () => BigInt(await call<string>("lr_estimateFee")),
    /** Sends signed transaction bytes; resolves with the id the Node gives them. */
    send: (bytes: Uint8Array) =>
      call<string>("lr_sendTransaction", [toHex(bytes)]),
    transaction: (id: string) =>
      call<PlacedTransaction | null>("lr_getTransaction", [id]),
    /** Up to 20 transactions sent or received by `address` in Blocks, newest first. */
    addressTxs: (address: string) =>
      call<PlacedTransaction[]>("lr_getAddressTxs", [address]),
  };
}

export type NodeClient = ReturnType<typeof createNodeClient>;
