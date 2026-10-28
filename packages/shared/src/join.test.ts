import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  joinMessage,
  JoinRejected,
  JOIN_TTL_SECONDS,
  verifyJoinRequest,
} from "./join.ts";

const account = privateKeyToAccount(generatePrivateKey());
const now = 1_800_000_000;

async function request(landId: number, expiresAt: number) {
  const message = joinMessage(landId, expiresAt);
  return { message, signature: await account.signMessage({ message }) };
}

describe("verifyJoinRequest", () => {
  it("recovers the signer", async () => {
    const r = await request(3, now + 60);
    expect(await verifyJoinRequest({ ...r, landId: 3, nowSeconds: now })).toBe(
      account.address,
    );
  });

  it("rejects a message for another Land", async () => {
    const r = await request(4, now + 60);
    await expect(
      verifyJoinRequest({ ...r, landId: 3, nowSeconds: now }),
    ).rejects.toThrow(JoinRejected);
  });

  it("rejects an expired message", async () => {
    const r = await request(3, now - 1);
    await expect(
      verifyJoinRequest({ ...r, landId: 3, nowSeconds: now }),
    ).rejects.toThrow("expired");
  });

  it("rejects a message that lives too long", async () => {
    const r = await request(3, now + JOIN_TTL_SECONDS + 1);
    await expect(
      verifyJoinRequest({ ...r, landId: 3, nowSeconds: now }),
    ).rejects.toThrow(JoinRejected);
  });

  it("rejects malformed input", async () => {
    await expect(
      verifyJoinRequest({
        message: 1,
        signature: "0x",
        landId: 3,
        nowSeconds: now,
      }),
    ).rejects.toThrow(JoinRejected);
    const r = await request(3, now + 60);
    await expect(
      verifyJoinRequest({
        message: `${r.message}\nextra`,
        signature: r.signature,
        landId: 3,
        nowSeconds: now,
      }),
    ).rejects.toThrow(JoinRejected);
  });

  it("returns a different signer when the message was altered", async () => {
    const r = await request(3, now + 60);
    const other = joinMessage(3, now + 61);
    expect(
      await verifyJoinRequest({
        message: other,
        signature: r.signature,
        landId: 3,
        nowSeconds: now,
      }),
    ).not.toBe(account.address);
  });
});
