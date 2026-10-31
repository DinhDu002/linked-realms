import { describe, expect, it, vi } from "vitest";
import { createNodeClient, NodeError } from "./node.ts";

const reply = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("node client", () => {
  it("posts JSON-RPC 2.0 and reads the result", async () => {
    const fetchImpl = reply({ jsonrpc: "2.0", id: 1, result: "ab12" });
    const node = createNodeClient("http://node.test", fetchImpl);
    expect(await node.send(new Uint8Array([0xab, 0x12]))).toBe("ab12");
    expect(fetchImpl).toHaveBeenCalledWith("http://node.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "lr_sendTransaction",
        params: ["ab12"],
      }),
      cache: "no-store",
    });
  });

  it("reads balances and fee rates past 2^53 as bigint", async () => {
    const node = createNodeClient(
      "http://node.test",
      reply({
        result: { balance: "18446744073709551615", nonce: 3, hasKey: true },
      }),
    );
    expect(await node.account("tlr1x", true)).toEqual({
      balance: 18446744073709551615n,
      nonce: 3,
      hasKey: true,
    });
    const rate = createNodeClient("http://node.test", reply({ result: "10" }));
    expect(await rate.feeRate()).toBe(10n);
    const none = createNodeClient("http://node.test", reply({ result: null }));
    expect(await none.account("tlr1x")).toBeNull();
  });

  it("asks for the account with or without the mempool", async () => {
    const fetchImpl = reply({ result: null });
    const node = createNodeClient("http://node.test", fetchImpl);
    await node.account("tlr1a", true);
    await node.account("tlr1b");
    const params = fetchImpl.mock.calls.map(
      (call) =>
        (
          JSON.parse(
            (call as unknown as [string, RequestInit])[1].body as string,
          ) as {
            params: unknown;
          }
        ).params,
    );
    expect(params).toEqual([
      ["tlr1a", true],
      ["tlr1b", false],
    ]);
  });

  it("raises a refusal with its code and reason", async () => {
    const node = createNodeClient(
      "http://node.test",
      reply({
        error: {
          code: -32003,
          message: "the fee is below the minimum rate",
          data: { reason: "fee-too-low" },
        },
      }),
    );
    await expect(node.send(new Uint8Array(1))).rejects.toMatchObject({
      name: "NodeError",
      code: -32003,
      reason: "fee-too-low",
      message: "the fee is below the minimum rate",
    });
  });

  it("says when the Node cannot be reached or does not answer JSON-RPC", async () => {
    const down = createNodeClient("http://node.test", async () => {
      throw new TypeError("network");
    });
    await expect(down.info()).rejects.toMatchObject({ code: 0 });
    const proxy = createNodeClient(
      "http://node.test",
      vi.fn(async () => new Response("Bad Gateway", { status: 502 })),
    );
    await expect(proxy.info()).rejects.toMatchObject({ code: 502 });
    const tooMany = createNodeClient("http://node.test", reply({}, 429));
    await expect(tooMany.info()).rejects.toBeInstanceOf(NodeError);
  });
});
