import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Key,
  SCHEME_ML_DSA_44,
  addressFromBytes,
  addressToBytes,
  formatAmount,
  parseAmount,
  transactionId,
} from "./node.ts";

// The parts of crates/core/test-vectors/chain.json read here (its README says what each holds).
interface Chain {
  networks: { name: string; networkId: number }[];
  addresses: { address: string; bytes: string }[];
  invalidAddressBytes: { reason: string; bytes: string }[];
  transactions: {
    steps: { note: string; network: string; tx: string; id: string | null }[];
  };
  txBuilds: {
    step: number;
    networkId: number;
    signerXi: string;
    sender: string;
    nonce: string;
    fee: string;
    withPublicKey: boolean;
    transfer: { to: string; amount: string; memo: string } | null;
    rotation: { newScheme: number; newPublicKey: string } | null;
  }[];
  amounts: {
    valid: { text: string; units: string; formatted: string }[];
    invalid: { text: string; error: string }[];
  };
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../crates/core/test-vectors/chain.json", import.meta.url),
    "utf8",
  ),
) as Chain;

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (data: Uint8Array) => Buffer.from(data).toString("hex");
const networkId = (name: string) =>
  vectors.networks.find((n) => n.name === name)!.networkId;
// The vectors are signed with `rnd` of zeros, so signing again gives the same bytes.
const zeros = new Uint8Array(32);

describe("transactions", () => {
  it("builds every step of the ledger byte for byte, with its id", () => {
    expect(vectors.txBuilds.length).toBeGreaterThan(0);
    for (const b of vectors.txBuilds) {
      const step = vectors.transactions.steps[b.step]!;
      using key = Key.fromSeed(bytes(b.signerXi));
      const [nonce, fee] = [BigInt(b.nonce), BigInt(b.fee)];
      const signed = b.transfer
        ? key.signTransfer(
            b.networkId,
            b.sender,
            nonce,
            fee,
            b.transfer.to,
            BigInt(b.transfer.amount),
            bytes(b.transfer.memo),
            b.withPublicKey,
            zeros,
          )
        : key.signRotation(
            b.networkId,
            b.sender,
            nonce,
            fee,
            b.rotation!.newScheme,
            bytes(b.rotation!.newPublicKey),
            b.withPublicKey,
            zeros,
          );
      expect(hex(signed), step.note).toBe(step.tx);
      expect(hex(transactionId(networkId(step.network), signed))).toBe(step.id);
    }
  });

  it("gives the id of every step that is a transaction, and refuses the rest", () => {
    for (const step of vectors.transactions.steps) {
      const id = () =>
        hex(transactionId(networkId(step.network), bytes(step.tx)));
      if (step.id === null) expect(id, step.note).toThrow();
      else expect(id(), step.note).toBe(step.id);
    }
  });

  it("refuses what no Node would take", () => {
    using key = Key.fromSeed(zeros);
    const sign = (network: number, memo: Uint8Array, rnd = zeros) =>
      key.signTransfer(
        network,
        key.address,
        0n,
        0n,
        key.address,
        1n,
        memo,
        true,
        rnd,
      );
    expect(sign(1, new Uint8Array(80)).length).toBe(2517 + 80 + 1312);
    expect(() => sign(1, new Uint8Array(81))).toThrow(
      "memo longer than 80 bytes",
    );
    expect(() => sign(3, new Uint8Array())).toThrow("unknown network id");
    expect(() => sign(1, new Uint8Array(), new Uint8Array(31))).toThrow(
      "expected 32 bytes",
    );
    expect(() =>
      key.signTransfer(
        1,
        key.address,
        0n,
        0n,
        "tlr1",
        1n,
        new Uint8Array(),
        true,
        zeros,
      ),
    ).toThrow("not a valid address");
    const rotate = (scheme: number, length: number) =>
      key.signRotation(
        1,
        key.address,
        0n,
        0n,
        scheme,
        new Uint8Array(length),
        false,
        zeros,
      );
    expect(rotate(SCHEME_ML_DSA_44, 1312).length).toBe(3787);
    expect(() => rotate(SCHEME_ML_DSA_44, 1311)).toThrow();
    expect(() => rotate(2, 1312)).toThrow("unknown signature scheme");
  });
});

describe("amounts", () => {
  it("reads and shows GOLD as the vectors say", () => {
    for (const a of vectors.amounts.valid) {
      expect(parseAmount(a.text), a.text).toBe(BigInt(a.units));
      expect(formatAmount(BigInt(a.units))).toBe(a.formatted);
    }
    for (const a of vectors.amounts.invalid) {
      expect(() => parseAmount(a.text), JSON.stringify(a.text)).toThrow(
        a.error === "Overflow" ? "amount too large" : "not an amount in GOLD",
      );
    }
  });
});

describe("address bytes", () => {
  it("turns addresses into their payload and back", () => {
    for (const a of vectors.addresses) {
      expect(hex(addressToBytes(a.address))).toBe(a.bytes);
      expect(addressFromBytes(bytes(a.bytes))).toBe(a.address);
    }
    for (const a of vectors.invalidAddressBytes) {
      expect(() => addressFromBytes(bytes(a.bytes)), a.reason).toThrow();
    }
    expect(() => addressToBytes("tlr1")).toThrow("not a valid address");
  });
});
