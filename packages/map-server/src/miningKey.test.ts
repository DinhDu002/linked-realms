import { afterEach, describe, expect, it, vi } from "vitest";
import { reportMiningKey, type RpcClient } from "./miningKey.ts";

const address = "0x000000000000000000000000000000000000dEaD";

function fakeClient(chainId: number, balance: bigint) {
  return {
    getChainId: vi.fn(async () => chainId),
    getBalance: vi.fn(async () => balance),
    setBalance: vi.fn(async () => {}),
  } satisfies RpcClient;
}

describe("reportMiningKey", () => {
  afterEach(() => vi.restoreAllMocks());

  it("tops up an empty key on anvil", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = fakeClient(31337, 0n);
    await reportMiningKey(client, 31337, address, true);
    expect(client.setBalance).toHaveBeenCalledExactlyOnceWith(
      address,
      10n ** 18n,
    );
  });

  it("never tops up on another chain, and warns when the key is empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient(11155111, 0n);
    await reportMiningKey(client, 11155111, address, false);
    expect(client.setBalance).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("refuses when CHAIN_ID disagrees with the RPC", async () => {
    const client = fakeClient(11155111, 0n);
    await expect(
      reportMiningKey(client, 31337, address, false),
    ).rejects.toThrow(/refusing to start/);
    expect(client.setBalance).not.toHaveBeenCalled();
  });

  it("does not top up a funded key on anvil", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const client = fakeClient(31337, 5n * 10n ** 18n);
    await reportMiningKey(client, 31337, address, false);
    expect(client.setBalance).not.toHaveBeenCalled();
  });
});
