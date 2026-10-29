import { describe, expect, it } from "vitest";
import { openEntropy, sealEntropy, WrongPasswordError } from "./keystore.ts";

const small = { m: 8, t: 1, p: 1 };
const entropy = Uint8Array.from({ length: 32 }, (_, i) => i);
const address = "tlr1example";

describe("key store", () => {
  it("opens what it sealed, with the parameters in the record", async () => {
    const record = await sealEntropy(entropy, address, "correct horse", small);
    expect(record).toMatchObject({
      version: 1,
      address,
      kdf: { alg: "argon2id", ...small },
    });
    expect(record.kdf.salt).toHaveLength(16);
    expect(record.iv).toHaveLength(12);
    expect(await openEntropy(record, "correct horse")).toEqual(entropy);
  });

  it("does not keep the entropy in the clear", async () => {
    const record = await sealEntropy(entropy, address, "pw", small);
    expect(record.ciphertext).toHaveLength(32 + 16);
    expect(record.ciphertext.slice(0, 32)).not.toEqual(entropy);
  });

  it("seals what it was given even if the caller wipes it at once", async () => {
    const mine = entropy.slice();
    const sealing = sealEntropy(mine, address, "pw", small);
    mine.fill(0);
    expect(await openEntropy(await sealing, "pw")).toEqual(entropy);
  });

  it("refuses a wrong password", async () => {
    const record = await sealEntropy(entropy, address, "right", small);
    await expect(openEntropy(record, "wrong")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("binds the address: a record moved to another address does not open", async () => {
    const record = await sealEntropy(entropy, address, "pw", small);
    await expect(
      openEntropy({ ...record, address: "tlr1other" }, "pw"),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("uses a fresh salt and IV every time", async () => {
    const a = await sealEntropy(entropy, address, "pw", small);
    const b = await sealEntropy(entropy, address, "pw", small);
    expect(a.kdf.salt).not.toEqual(b.kdf.salt);
    expect(a.iv).not.toEqual(b.iv);
  });
});
