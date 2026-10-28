import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { encodeErrorResult, encodeFunctionResult, type Hex } from "viem";
import { deploymentFor, goldMineAbi } from "@linked-realms/shared";
import { createMinerChain } from "./chain.ts";

const KEY: Hex = `0x${"11".repeat(32)}`;
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const HASH: Hex = `0x${"ab".repeat(32)}`;
const BLOCK = {
  number: "0x1",
  hash: HASH,
  parentHash: HASH,
  baseFeePerGas: "0x1",
  timestamp: "0x1",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  transactions: [],
};

/** A minimal JSON-RPC node. `calls` answers eth_call in order (the last one repeats). */
function fakeNode(opts: {
  calls: Hex[] | "revert-all";
  receipt: "0x0" | "0x1";
  revert?: Hex;
}) {
  const seen: string[] = [];
  let callNo = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      seen.push(method);
      const reply = (result: unknown) =>
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      switch (method) {
        case "eth_call": {
          const next =
            opts.calls === "revert-all"
              ? undefined
              : opts.calls[Math.min(callNo++, opts.calls.length - 1)];
          if (next === undefined || next.startsWith("revert:"))
            return res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                error: {
                  code: 3,
                  message: "execution reverted",
                  data: opts.revert,
                },
              }),
            );
          return reply(next);
        }
        case "eth_estimateGas":
          return reply("0x5208");
        case "eth_getTransactionCount":
          return reply("0x0");
        case "eth_getBlockByNumber":
          return reply(BLOCK);
        case "eth_maxPriorityFeePerGas":
        case "eth_gasPrice":
          return reply("0x1");
        case "eth_sendRawTransaction":
          return reply(HASH);
        case "eth_getTransactionReceipt":
          return reply({
            transactionHash: HASH,
            transactionIndex: "0x0",
            blockHash: HASH,
            blockNumber: "0x1",
            from: WALLET,
            to: WALLET,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            effectiveGasPrice: "0x1",
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            status: opts.receipt,
            type: "0x2",
          });
        case "eth_blockNumber":
          return reply("0x1");
        default:
          return reply(null);
      }
    });
  });
  return new Promise<{ url: string; seen: string[]; server: Server }>(
    (resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${port}`, seen, server });
      }),
  );
}

const roundResult = (round: bigint) =>
  encodeFunctionResult({
    abi: goldMineAbi,
    functionName: "currentRound",
    result: [round, HASH, 5n, 0n],
  });
const staleRound = encodeErrorResult({
  abi: goldMineAbi,
  errorName: "StaleRound",
  args: [7n, 8n],
});
const noLand = encodeErrorResult({
  abi: goldMineAbi,
  errorName: "NoLand",
  args: [WALLET],
});

const wonInThisBlock = encodeErrorResult({
  abi: goldMineAbi,
  errorName: "RoundAlreadyWonInThisBlock",
});

let server: Server | undefined;
let seen: string[] = [];
afterEach(() => server?.close());

async function chainFor(opts: Parameters<typeof fakeNode>[0]) {
  const node = await fakeNode(opts);
  server = node.server;
  seen = node.seen;
  void deploymentFor(31337);
  return createMinerChain({
    rpcUrl: node.url,
    chainId: 31337,
    privateKey: KEY,
  });
}

describe("createMinerChain", () => {
  it("reads the current Round", async () => {
    const chain = await chainFor({ calls: [roundResult(7n)], receipt: "0x1" });
    expect(await chain.currentRound()).toEqual({
      round: 7n,
      challenge: HASH,
      target: 5n,
    });
  });

  it("returns won for a mined success", async () => {
    const chain = await chainFor({ calls: ["0x"], receipt: "0x1" });
    expect(await chain.submit(7n, 1n, WALLET)).toBe("won");
  });

  it("returns lost when the simulation reverts with StaleRound", async () => {
    const chain = await chainFor({
      calls: "revert-all",
      receipt: "0x1",
      revert: staleRound,
    });
    expect(await chain.submit(7n, 1n, WALLET)).toBe("lost");
  });

  it("sends anyway when the Round started in the latest block", async () => {
    const chain = await chainFor({
      calls: "revert-all",
      receipt: "0x1",
      revert: wonInThisBlock,
    });
    expect(await chain.submit(7n, 1n, WALLET)).toBe("won");
    expect(seen).toContain("eth_sendRawTransaction");
    expect(seen).not.toContain("eth_estimateGas");
  });

  it("throws on any other simulation revert", async () => {
    const chain = await chainFor({
      calls: "revert-all",
      receipt: "0x1",
      revert: noLand,
    });
    await expect(chain.submit(7n, 1n, WALLET)).rejects.toThrow();
  });

  it("returns lost for an on-chain revert only when the Round moved on", async () => {
    const chain = await chainFor({
      calls: ["0x", roundResult(8n)],
      receipt: "0x0",
    });
    expect(await chain.submit(7n, 1n, WALLET)).toBe("lost");
  });

  it("throws for an on-chain revert while the Round is unchanged", async () => {
    const chain = await chainFor({
      calls: ["0x", roundResult(7n)],
      receipt: "0x0",
    });
    await expect(chain.submit(7n, 1n, WALLET)).rejects.toThrow(
      /reverted on-chain/,
    );
  });

  it("sees the receipt well before viem's 4 s default polling interval", async () => {
    const chain = await chainFor({ calls: ["0x"], receipt: "0x1" });
    const t = Date.now();
    await chain.submit(7n, 1n, WALLET);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
