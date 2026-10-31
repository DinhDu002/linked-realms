// A small stand-in for a test network Node's JSON-RPC (crates/node/src/rpc.rs): every account
// holds 10 GOLD with no key yet, and `lr_sendTransaction` keeps what it was sent without checking
// it. `GET /__sent` lists the transfers it holds.
import type { IncomingMessage, ServerResponse } from "node:http";
import { addressFromBytes, transactionId } from "@linked-realms/core";
import { NODE_PORT } from "./ports.ts";
import { listenOnLoopbacks } from "./listen.ts";

const TEST_NETWORK = 1;

export interface SentTransfer {
  id: string;
  sender: string;
  to: string;
  /** Base units. */
  amount: string;
  fee: string;
  memo: string;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The fields of a transfer's bytes (crates/core/src/tx.rs; integers are big-endian). */
function readTransfer(bytes: Uint8Array): SentTransfer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    id: hex(transactionId(TEST_NETWORK, bytes)),
    sender: addressFromBytes(bytes.subarray(3, 37)),
    fee: view.getBigUint64(45).toString(),
    to: addressFromBytes(bytes.subarray(53, 87)),
    amount: view.getBigUint64(87).toString(),
    memo: Buffer.from(bytes.subarray(96, 96 + bytes[95]!)).toString(),
  };
}

export async function startNodeStub(): Promise<() => void> {
  const sent: SentTransfer[] = [];

  function call(method: string, params: unknown[]): unknown {
    switch (method) {
      case "lr_getInfo":
        return { networkId: TEST_NETWORK, height: 1 };
      case "lr_getAccount":
        return { balance: "1000000000", nonce: 0, hasKey: false };
      case "lr_estimateFee":
        return "10";
      case "lr_sendTransaction": {
        const transfer = readTransfer(Buffer.from(String(params[0]), "hex"));
        sent.push(transfer);
        return transfer.id;
      }
      case "lr_getTransaction": {
        const transfer = sent.find((t) => t.id === params[0]);
        if (!transfer) return null;
        const { id, sender, to, amount, fee, memo } = transfer;
        return {
          tx: {
            id,
            sender,
            nonce: 0,
            fee,
            kind: "transfer",
            to,
            amount,
            memo: hex(Buffer.from(memo)),
          },
          block: null,
        };
      }
      case "lr_getAddressTxs":
        return [];
      default:
        throw new Error(`no method ${method}`);
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    const reply = (body: unknown) =>
      res
        .writeHead(200, { ...cors, "Content-Type": "application/json" })
        .end(JSON.stringify(body));
    if (req.method === "GET" && req.url === "/__sent") return reply(sent);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    try {
      reply({ jsonrpc: "2.0", id, result: call(method, params ?? []) });
    } catch (e) {
      reply({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: (e as Error).message },
      });
    }
  };
  return listenOnLoopbacks((req, res) => void handler(req, res), NODE_PORT);
}
