import { describe, expect, it, vi } from "vitest";
import { sealEntropy, WrongPasswordError } from "./keystore.ts";
import type { Key } from "@linked-realms/core";
import { createVault, LockedError } from "./vault.ts";

const fakeKey = (address: string, free: () => void) =>
  ({
    address,
    publicKey: new Uint8Array(1),
    sign: () => new Uint8Array(1),
    free,
  }) as unknown as Key;

const small = { m: 8, t: 1, p: 1 };
const address = "tlr1test";

async function setup(options: Parameters<typeof createVault>[1] = {}) {
  const record = await sealEntropy(
    new Uint8Array(32).fill(7),
    address,
    "pw",
    small,
  );
  const key = fakeKey(address, vi.fn());
  let entropyGiven: Uint8Array | undefined;
  const vault = createVault(record, {
    deriveKey: (entropy) => {
      entropyGiven = entropy;
      return key;
    },
    ...options,
  });
  return { vault, key, entropyGiven: () => entropyGiven };
}

describe("vault", () => {
  it("starts locked, and a wrong password leaves it locked", async () => {
    const { vault } = await setup();
    expect(vault.unlocked).toBe(false);
    expect(() => vault.withKey(() => 1)).toThrow(LockedError);
    await expect(vault.unlock("nope")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(vault.unlocked).toBe(false);
  });

  it("unlocks, and zeroes the decrypted entropy as soon as the key exists", async () => {
    const { vault, key, entropyGiven } = await setup();
    await vault.unlock("pw");
    expect(vault.unlocked).toBe(true);
    expect(vault.withKey((k) => k)).toBe(key);
    expect(entropyGiven()).toEqual(new Uint8Array(32));
  });

  it("locking frees the key and drops the token", async () => {
    const { vault, key } = await setup();
    await vault.unlock("pw");
    vault.setToken({ value: "t", expiresAt: 1 });
    expect(vault.token?.value).toBe("t");
    const changed = vi.fn();
    vault.onChange(changed);
    vault.lock();
    expect(key.free).toHaveBeenCalledOnce();
    expect(vault.unlocked).toBe(false);
    expect(vault.token).toBeUndefined();
    expect(changed).toHaveBeenCalledOnce();
    expect(() => vault.withKey(() => 1)).toThrow(LockedError);
    vault.lock();
    expect(key.free).toHaveBeenCalledOnce();
  });

  it("keeps no token that arrives after Lock", async () => {
    const { vault } = await setup();
    await vault.unlock("pw");
    vault.lock();
    vault.setToken({ value: "late", expiresAt: 1 });
    expect(vault.token).toBeUndefined();
  });

  it("refuses a key that does not match the stored address, and frees it", async () => {
    const free = vi.fn();
    const { vault } = await setup({
      deriveKey: () => fakeKey("tlr1other", free),
    });
    await expect(vault.unlock("pw")).rejects.toThrow(/does not match/);
    expect(free).toHaveBeenCalledOnce();
    expect(vault.unlocked).toBe(false);
  });

  it("locks after 15 minutes without input, and input restarts the clock", async () => {
    vi.useFakeTimers();
    try {
      const { vault } = await setup();
      await vault.unlock("pw");
      vi.advanceTimersByTime(14 * 60_000);
      vault.touch();
      vi.advanceTimersByTime(14 * 60_000);
      expect(vault.unlocked).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(vault.unlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not lock under an open prompt", async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const { vault } = await setup({ idleMs: 1000, isBusy: () => busy });
      await vault.unlock("pw");
      vi.advanceTimersByTime(5000);
      expect(vault.unlocked).toBe(true);
      busy = false;
      vi.advanceTimersByTime(1000);
      expect(vault.unlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
