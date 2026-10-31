import { Key, transactionId } from "@linked-realms/core";
import { describe, expect, it, vi } from "vitest";
import {
  describeTransaction,
  preparePayment,
  SendError,
  signPayment,
  transferBytes,
  type SendForm,
} from "./gold.ts";
import { toHex, type Account, type NodeClient } from "./node.ts";

const DEV = 2;
const sender = Key.fromEntropy(new Uint8Array(32).fill(7), 0);
const recipient = Key.fromEntropy(new Uint8Array(32).fill(8), 0).address;

function stubNode({
  networkId = DEV,
  account = { balance: 500_000_000n, nonce: 4, hasKey: true } as Account | null,
  rate = 10n,
} = {}) {
  return {
    info: vi.fn(async () => ({ networkId, height: 9 })),
    account: vi.fn(async () => account),
    feeRate: vi.fn(async () => rate),
  } as unknown as NodeClient & {
    info: ReturnType<typeof vi.fn>;
    account: ReturnType<typeof vi.fn>;
    feeRate: ReturnType<typeof vi.fn>;
  };
}

const form = (fields: Partial<SendForm> = {}): SendForm => ({
  to: recipient,
  amount: "1.5",
  memo: "",
  fee: "",
  ...fields,
});

describe("preparePayment", () => {
  it("prices the transfer by its bytes at the Node's fee rate, from the account after its held sends", async () => {
    const node = stubNode({ rate: 12n });
    const payment = await preparePayment(
      node,
      DEV,
      sender.address,
      form({ memo: "hi" }),
    );
    expect(payment).toEqual({
      networkId: DEV,
      sender: sender.address,
      nonce: 4n,
      to: recipient,
      amount: 150_000_000n,
      memo: new TextEncoder().encode("hi"),
      fee: 12n * 2519n,
      withPublicKey: false,
    });
    expect(node.account).toHaveBeenCalledWith(sender.address, true);
  });

  it("adds the public key to the sender's first transaction, and pays for its bytes", async () => {
    const node = stubNode({
      account: { balance: 500_000_000n, nonce: 0, hasKey: false },
    });
    const payment = await preparePayment(node, DEV, sender.address, form());
    expect(payment.withPublicKey).toBe(true);
    expect(payment.fee).toBe(10n * (2517n + 1312n));
    expect(transferBytes(80, true)).toBe(3909);
  });

  it("takes a fee the Player typed instead of asking the Node", async () => {
    const node = stubNode();
    const payment = await preparePayment(
      node,
      DEV,
      sender.address,
      form({ fee: "0.001" }),
    );
    expect(payment.fee).toBe(100_000n);
    expect(node.feeRate).not.toHaveBeenCalled();
  });

  it.each([
    [{ to: "tlr1nope" }, /not a Character address/],
    [{ to: recipient.toUpperCase() }, /not a Character address/],
    [{ to: ` ${recipient}` }, /not a Character address/],
    [{ amount: "1.5 " }, /amount is not an amount of GOLD/],
    [{ amount: "1." }, /amount is not an amount of GOLD/],
    [{ amount: "0.123456789" }, /amount is not an amount of GOLD/],
    [{ amount: "-1" }, /amount is not an amount of GOLD/],
    [{ amount: "0" }, /more than 0/],
    [{ memo: "é".repeat(41) }, /at most 80 bytes; this one has 82/],
    [{ memo: `a${"é".repeat(40)}` }, /at most 80 bytes; this one has 81/],
    [{ fee: "x" }, /fee is not an amount of GOLD/],
  ])("refuses %o before signing anything", async (fields, message) => {
    const node = stubNode();
    const refused = preparePayment(node, DEV, sender.address, form(fields));
    await expect(refused).rejects.toBeInstanceOf(SendError);
    await expect(refused).rejects.toThrow(message);
  });

  it("checks the form before it calls the Node", async () => {
    const node = stubNode();
    await expect(
      preparePayment(node, DEV, sender.address, form({ amount: "" })),
    ).rejects.toThrow(/amount is not an amount of GOLD/);
    expect(node.info).not.toHaveBeenCalled();
  });

  it("takes an 80-byte memo", async () => {
    const payment = await preparePayment(
      stubNode(),
      DEV,
      sender.address,
      form({ memo: "é".repeat(40) }),
    );
    expect(payment.memo).toHaveLength(80);
  });

  it("refuses a Node on another network", async () => {
    await expect(
      preparePayment(stubNode({ networkId: 1 }), DEV, sender.address, form()),
    ).rejects.toThrow(/another network/);
  });

  it("refuses to spend more than the balance, fee included", async () => {
    await expect(
      preparePayment(stubNode({ account: null }), DEV, sender.address, form()),
    ).rejects.toThrow(/no Gold to send/);
    const emptied = { balance: 0n, nonce: 2, hasKey: true };
    await expect(
      preparePayment(
        stubNode({ account: emptied }),
        DEV,
        sender.address,
        form(),
      ),
    ).rejects.toThrow(/no Gold to send/);
    const exact = { balance: 150_000_000n + 25_170n, nonce: 1, hasKey: true };
    expect(
      (
        await preparePayment(
          stubNode({ account: exact }),
          DEV,
          sender.address,
          form(),
        )
      ).fee,
    ).toBe(25_170n);
    const short = { ...exact, balance: exact.balance - 1n };
    await expect(
      preparePayment(stubNode({ account: short }), DEV, sender.address, form()),
    ).rejects.toThrow(
      "Not enough Gold: 1.5002517 GOLD with the fee, and you have 1.50025169 GOLD.",
    );
  });
});

describe("signPayment", () => {
  it("signs for the payment's network, and the id is the Node's id of those bytes", async () => {
    const payment = await preparePayment(
      stubNode({
        account: { balance: 500_000_000n, nonce: 0, hasKey: false },
      }),
      DEV,
      sender.address,
      form({ memo: "thanks" }),
    );
    const { bytes, id } = signPayment(sender, payment);
    expect(bytes).toHaveLength(transferBytes(6, true));
    expect(id).toBe(toHex(transactionId(DEV, bytes)));
    expect(id).not.toBe(toHex(transactionId(1, bytes)));
  });
});

describe("describeTransaction", () => {
  const me = sender.address;
  const transfer = {
    id: "aa",
    nonce: 0,
    fee: "25170",
    kind: "transfer" as const,
    amount: "150000000",
    memo: "",
  };

  it("tells sends from receipts, and pending from confirmed", () => {
    const block = { id: "bb", height: 12, place: 0 };
    expect(
      describeTransaction(
        { tx: { ...transfer, sender: me, to: recipient }, block },
        me,
      ),
    ).toBe(`Block #12 · sent 1.5 GOLD to ${recipient} · fee 0.0002517 GOLD`);
    expect(
      describeTransaction(
        { tx: { ...transfer, sender: recipient, to: me }, block: null },
        me,
      ),
    ).toBe(`waiting for a Block · received 1.5 GOLD from ${recipient}`);
    expect(
      describeTransaction(
        { tx: { ...transfer, sender: me, kind: "rotation" }, block },
        me,
      ),
    ).toBe("Block #12 · key rotation");
  });

  it("shows a memo with what could hide or reorder text as escapes", () => {
    const memo = toHex(new TextEncoder().encode("pay‮me\n"));
    expect(
      describeTransaction(
        { tx: { ...transfer, sender: recipient, to: me, memo }, block: null },
        me,
      ),
    ).toContain('memo "pay\\u{202e}me\\n"');
  });
});
