import { Key } from "@linked-realms/core";
import { describe, expect, it, vi } from "vitest";
import type { Payment } from "./gold.ts";
import { NodeError } from "./node.ts";
import {
  createPortHandler,
  type PortDeps,
  type SignAnswer,
} from "./portHandler.ts";
import { LockedError } from "./vault.ts";

const signed = { statement: "s", publicKey: "k", signature: "g" };

function setup(over: Partial<PortDeps> = {}) {
  let time = 1_000_000;
  const sent: Record<string, unknown>[] = [];
  const deps: PortDeps = {
    now: () => time,
    land: { landId: 7, origin: "https://7.lands.example" },
    character: () => ({ address: "tlr1abc", name: "Lan" }),
    send: (m) => sent.push(m as Record<string, unknown>),
    travel: vi.fn(async () => ({ ok: true as const })),
    isUnlocked: () => true,
    ensureUnlocked: vi.fn(async () => true),
    isCurrent: () => true,
    dialogOpen: () => false,
    confirm: vi.fn(async () => "approved" as const),
    sign: vi.fn(() => signed),
    preparePayment: vi.fn(async () => payment),
    confirmPayment: vi.fn(async () => "approved" as const),
    sendPayment: vi.fn(async () => "ab01"),
    ...over,
  };
  return {
    deps,
    sent,
    handler: createPortHandler(deps),
    advance: (ms: number) => (time += ms),
  };
}

const sign = (id: string, text: unknown = "hi") => ({
  type: "signMessage",
  id,
  text,
});

describe("messages", () => {
  it("ignores unknown types, non-objects and messages over 64 KiB", async () => {
    const { handler, sent, deps } = setup();
    await handler.handle({ type: "mystery" });
    await handler.handle("travel");
    await handler.handle(null);
    await handler.handle({ type: "travel", direction: "up" });
    await handler.handle(sign("a", "x".repeat(70_000)));
    const cyclic: Record<string, unknown> = { type: "travel" };
    cyclic.self = cyclic;
    await handler.handle(cyclic);
    expect(sent).toEqual([]);
    expect(deps.travel).not.toHaveBeenCalled();
  });

  it("drops a message whose UTF-8 form is over 64 KiB even if its length is not", async () => {
    const { handler, sent } = setup();
    await handler.handle(sign("a", "é".repeat(40_000)));
    expect(sent).toEqual([]);
  });

  it("drops a sign or pay request without a usable id", async () => {
    const { handler, sent } = setup();
    await handler.handle({ type: "signMessage", text: "x" });
    await handler.handle(sign(""));
    await handler.handle(sign("i".repeat(65)));
    await handler.handle({ type: "pay", id: 5 });
    expect(sent).toEqual([]);
  });
});

describe("travel", () => {
  it("passes the direction on and says nothing when it works", async () => {
    const { handler, sent, deps } = setup();
    await handler.handle({ type: "travel", direction: "east" });
    expect(deps.travel).toHaveBeenCalledWith("east", expect.any(Function));
    expect(sent).toEqual([]);
  });

  it("answers travelRefused with the reason and the Land", async () => {
    const { handler, sent } = setup({
      travel: async () => ({ ok: false, reason: "offline", landId: 8 }),
    });
    await handler.handle({ type: "travel", direction: "east" });
    expect(sent).toEqual([
      {
        type: "travelRefused",
        direction: "east",
        reason: "offline",
        landId: 8,
      },
    ]);
  });

  it("answers error when the trip throws", async () => {
    const { handler, sent } = setup({
      travel: async () => {
        throw new Error("boom");
      },
    });
    await handler.handle({ type: "travel", direction: "north" });
    expect(sent).toEqual([
      { type: "travelRefused", direction: "north", reason: "error" },
    ]);
  });

  it("accepts one a second", async () => {
    const { handler, sent, deps, advance } = setup();
    await handler.handle({ type: "travel", direction: "east" });
    advance(999);
    await handler.handle({ type: "travel", direction: "east" });
    expect(sent).toEqual([
      { type: "travelRefused", direction: "east", reason: "rate-limited" },
    ]);
    advance(1);
    await handler.handle({ type: "travel", direction: "west" });
    expect(deps.travel).toHaveBeenCalledTimes(2);
  });

  it("answers busy while one is in progress, even within the second", async () => {
    let finish!: () => void;
    const { handler, sent, advance } = setup({
      travel: () => new Promise((r) => (finish = () => r({ ok: true }))),
    });
    const first = handler.handle({ type: "travel", direction: "east" });
    advance(300);
    await handler.handle({ type: "travel", direction: "north" });
    advance(5000);
    await handler.handle({ type: "travel", direction: "south" });
    expect(sent).toEqual([
      { type: "travelRefused", direction: "north", reason: "busy" },
      { type: "travelRefused", direction: "south", reason: "busy" },
    ]);
    finish();
    await first;
  });
});

const RECIPIENT = Key.fromEntropy(new Uint8Array(32).fill(8), 0).address;
const payment: Payment = {
  networkId: 1,
  sender: "tlr1abc",
  nonce: 0n,
  to: RECIPIENT,
  amount: 150_000_000n,
  memo: new TextEncoder().encode("Lantern"),
  fee: 38_290n,
  withPublicKey: true,
};
const pay = (id: string, fields: Record<string, unknown> = {}) => ({
  type: "pay",
  id,
  amount: "1.5",
  recipient: RECIPIENT,
  memo: "Lantern",
  ...fields,
});

describe("pay", () => {
  it("prices the payment, shows the Shell's prompt with the Land, and returns only the transaction id", async () => {
    const { handler, sent, deps } = setup();
    await handler.handle(pay("p1"));
    expect(deps.preparePayment).toHaveBeenCalledWith({
      to: RECIPIENT,
      amount: "1.5",
      memo: "Lantern",
      fee: "",
    });
    expect(deps.confirmPayment).toHaveBeenCalledWith({
      landId: 7,
      origin: "https://7.lands.example",
      payment,
    });
    expect(deps.sendPayment).toHaveBeenCalledWith(payment);
    expect(sent).toEqual([{ type: "signResult", id: "p1", txId: "ab01" }]);
  });

  it("takes no memo as an empty one", async () => {
    const { handler, deps } = setup();
    await handler.handle(pay("p1", { memo: undefined }));
    expect(deps.preparePayment).toHaveBeenCalledWith(
      expect.objectContaining({ memo: "" }),
    );
  });

  it.each([
    ["no amount", { amount: undefined }],
    ["an amount that is a number", { amount: 1.5 }],
    ["an amount with a space", { amount: " 1.5" }],
    ["nine decimals", { amount: "0.000000001" }],
    ["a zero amount", { amount: "0" }],
    ["a recipient that is not an address", { recipient: "tlr1x" }],
    ["a recipient with a space", { recipient: `${RECIPIENT} ` }],
    ["a memo that is not text", { memo: 5 }],
    ["a memo over 80 bytes", { memo: "é".repeat(41) }],
    ["a memo with a lone surrogate", { memo: "\ud800" }],
  ])("answers invalid to %s, before anything else", async (_, fields) => {
    const { handler, sent, deps } = setup({ isUnlocked: () => false });
    await handler.handle(pay("p1", fields));
    expect(sent).toEqual([{ type: "signResult", id: "p1", error: "invalid" }]);
    expect(deps.ensureUnlocked).not.toHaveBeenCalled();
    expect(deps.preparePayment).not.toHaveBeenCalled();
  });

  it("does not send without approval, and counts the refusal with signMessage's", async () => {
    const { handler, sent, deps, advance } = setup({
      confirm: vi.fn(async () => "denied" as const),
      confirmPayment: vi.fn(async () => "denied" as const),
    });
    await handler.handle(pay("p1"));
    // busy for 10 seconds after a refusal, for a signature as for a payment
    await handler.handle(sign("s1"));
    await handler.handle(pay("p2"));
    advance(10_000);
    await handler.handle(pay("p3"));
    advance(10_000);
    await handler.handle(sign("s2"));
    expect(deps.sendPayment).not.toHaveBeenCalled();
    expect(sent.map((m) => [m.id, m.error])).toEqual([
      ["p1", "denied"],
      ["s1", "busy"],
      ["p2", "busy"],
      ["p3", "denied"],
      ["s2", "denied"],
    ]);
    advance(60_000);
    await handler.handle(pay("p4"));
    expect(sent.at(-1)).toEqual({
      type: "signResult",
      id: "p4",
      error: "blocked",
    });
    expect(deps.confirmPayment).toHaveBeenCalledTimes(2);
  });

  it("is busy while a signature or another payment is open", async () => {
    let answer: (a: SignAnswer) => void = () => {};
    const { handler, sent } = setup({
      confirmPayment: vi.fn(
        () => new Promise<SignAnswer>((resolve) => (answer = resolve)),
      ),
    });
    const first = handler.handle(pay("p1"));
    await vi.waitFor(() => expect(answer).not.toBe(undefined));
    await new Promise((r) => setTimeout(r, 0));
    await handler.handle(pay("p2"));
    await handler.handle(sign("s1"));
    answer("approved");
    await first;
    expect(sent.map((m) => [m.id, m.error ?? m.txId])).toEqual([
      ["p2", "busy"],
      ["s1", "busy"],
      ["p1", "ab01"],
    ]);
  });

  it("answers failed when the payment cannot be made, and counts it, so a Land cannot keep the Shell calling the Node", async () => {
    const { handler, sent, deps, advance } = setup({
      preparePayment: vi.fn(async () => {
        throw new Error("Not enough Gold");
      }),
    });
    for (const id of ["a", "b", "c", "d"]) {
      await handler.handle(pay(id));
      advance(10_000);
    }
    expect(sent.map((m) => m.error)).toEqual([
      "failed",
      "failed",
      "failed",
      "blocked",
    ]);
    expect(deps.preparePayment).toHaveBeenCalledTimes(3);
    expect(deps.confirmPayment).not.toHaveBeenCalled();
  });

  it("answers failed when the Node refuses the signed payment, without counting a refusal", async () => {
    const { handler, sent } = setup({
      sendPayment: vi.fn(async () => {
        throw new NodeError(-32003, "x", "fee-too-low");
      }),
    });
    await handler.handle(pay("a"));
    await handler.handle(pay("b"));
    expect(sent.map((m) => m.error)).toEqual(["failed", "failed"]);
  });

  it("answers locked when the Player cancels the unlock or the Shell locked before it signed", async () => {
    const { handler, sent, deps } = setup({
      isUnlocked: () => false,
      ensureUnlocked: vi.fn(async () => false),
    });
    await handler.handle(pay("a"));
    expect(sent).toEqual([{ type: "signResult", id: "a", error: "locked" }]);
    expect(deps.preparePayment).not.toHaveBeenCalled();
    const late = setup({
      sendPayment: vi.fn(async () => {
        throw new LockedError();
      }),
    });
    await late.handler.handle(pay("b"));
    expect(late.sent).toEqual([
      { type: "signResult", id: "b", error: "locked" },
    ]);
  });

  it("answers busy before calling the Node while a dialog of the Shell is open, and counts no refusal", async () => {
    const { handler, sent, deps } = setup({ dialogOpen: () => true });
    for (const id of ["a", "b", "c", "d"]) await handler.handle(pay(id));
    expect(sent.map((m) => m.error)).toEqual(["busy", "busy", "busy", "busy"]);
    expect(deps.preparePayment).not.toHaveBeenCalled();
    // One that opened while the Node answered.
    const late = setup({ confirmPayment: vi.fn(async () => "busy" as const) });
    await late.handler.handle(pay("e"));
    await late.handler.handle(pay("f"));
    expect(late.sent.map((m) => m.error)).toEqual(["busy", "busy"]);
  });

  it("opens no prompt and answers nothing once its frame load has ended", async () => {
    let current = true;
    const { handler, sent, deps } = setup({
      isCurrent: () => current,
      preparePayment: vi.fn(async () => {
        current = false; // the Player left while the Node answered
        return payment;
      }),
    });
    await handler.handle(pay("a"));
    expect(deps.confirmPayment).not.toHaveBeenCalled();
    expect(deps.sendPayment).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("answers failed when signing fails after the Player approved", async () => {
    const { handler, sent } = setup({
      sendPayment: vi.fn(async () => {
        throw new Error("the signature failed");
      }),
    });
    await handler.handle(pay("a"));
    expect(sent).toEqual([{ type: "signResult", id: "a", error: "failed" }]);
  });
});

describe("signMessage", () => {
  it("shows the Shell's own data and signs a Land message after approval", async () => {
    const { handler, sent, deps, advance } = setup();
    advance(234);
    await handler.handle(sign("a1", "I agree"));
    expect(deps.confirm).toHaveBeenCalledWith({
      landId: 7,
      origin: "https://7.lands.example",
      character: { address: "tlr1abc", name: "Lan" },
      text: "I agree",
    });
    expect(deps.sign).toHaveBeenCalledWith({
      land: 7,
      landUrl: "https://7.lands.example",
      character: "tlr1abc",
      issued: 1000,
      message: "I agree",
    });
    expect(sent).toEqual([{ type: "signResult", id: "a1", signed }]);
  });

  it("opens no prompt once its frame load has ended during the unlock", async () => {
    let current = true;
    const { handler, sent, deps } = setup({
      isUnlocked: () => false,
      isCurrent: () => current,
      ensureUnlocked: vi.fn(async () => {
        current = false;
        return true;
      }),
    });
    await handler.handle(sign("a1"));
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("does not sign without approval", async () => {
    const { handler, sent, deps } = setup({
      confirm: async () => "denied" as const,
    });
    await handler.handle(sign("a1"));
    expect(deps.sign).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: "signResult", id: "a1", error: "denied" }]);
  });

  it("refuses text over 1,000 code points, and text that is not text, as invalid", async () => {
    const { handler, sent, deps } = setup();
    await handler.handle(sign("a", "x".repeat(1001)));
    await handler.handle(sign("b", 5));
    await handler.handle(sign("c", "lone \ud800 surrogate"));
    expect(sent.map((m) => m.error)).toEqual(["invalid", "invalid", "invalid"]);
    expect(deps.confirm).not.toHaveBeenCalled();
    await handler.handle(sign("d", "🌍".repeat(1000)));
    expect(sent.at(-1)).toMatchObject({ id: "d", signed });
  });

  it("answers busy to a second request while one is open", async () => {
    let answer!: (answer: SignAnswer) => void;
    const { handler, sent } = setup({
      confirm: () => new Promise((r) => (answer = r)),
    });
    const first = handler.handle(sign("a"));
    await vi.waitFor(() => expect(answer).toBeDefined());
    await handler.handle(sign("b"));
    expect(sent).toEqual([{ type: "signResult", id: "b", error: "busy" }]);
    answer("approved");
    await first;
    expect(sent.at(-1)).toMatchObject({ id: "a", signed });
  });

  it("answers busy for 10 seconds after a refusal, then asks again", async () => {
    const { handler, sent, deps, advance } = setup({
      confirm: vi.fn(async () => "denied" as const),
    });
    await handler.handle(sign("a"));
    advance(9999);
    await handler.handle(sign("b"));
    expect(sent.at(-1)).toEqual({ type: "signResult", id: "b", error: "busy" });
    advance(1);
    await handler.handle(sign("c"));
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    expect(sent.at(-1)).toEqual({
      type: "signResult",
      id: "c",
      error: "denied",
    });
  });

  it("blocks the Land after 3 refusals, however long it waits", async () => {
    const { handler, sent, deps, advance } = setup({
      confirm: vi.fn(async () => "denied" as const),
    });
    for (const id of ["a", "b", "c"]) {
      await handler.handle(sign(id));
      advance(10_000);
    }
    await handler.handle(sign("d"));
    advance(3_600_000);
    await handler.handle(sign("e"));
    expect(sent.map((m) => m.error)).toEqual([
      "denied",
      "denied",
      "denied",
      "blocked",
      "blocked",
    ]);
    expect(deps.confirm).toHaveBeenCalledTimes(3);
  });

  it("a new handler (the frame reloaded) starts with a clean count", async () => {
    const first = setup({ confirm: async () => "denied" as const });
    for (const id of ["a", "b", "c"]) {
      await first.handler.handle(sign(id));
      first.advance(10_000);
    }
    const second = setup();
    await second.handler.handle(sign("a"));
    expect(second.sent.at(-1)).toMatchObject({ signed });
  });

  it("answers locked when the Player cancels the unlock, and does not ask again while it cools down", async () => {
    const { handler, sent, deps, advance } = setup({
      isUnlocked: () => false,
      ensureUnlocked: vi.fn(async () => false),
    });
    await handler.handle(sign("a"));
    await handler.handle(sign("b"));
    await handler.handle({ type: "travel", direction: "east" });
    expect(sent.map((m) => m.error ?? m.reason)).toEqual(["locked", "busy"]);
    expect(deps.ensureUnlocked).toHaveBeenCalledTimes(1);
    expect(deps.confirm).not.toHaveBeenCalled();
    // The travel's own unlock is refused without a prompt too.
    const unlock = vi.mocked(deps.travel).mock.calls[0]![1];
    expect(await unlock()).toBe(false);
    expect(deps.ensureUnlocked).toHaveBeenCalledTimes(1);
    advance(10_000);
    await handler.handle(sign("c"));
    expect(deps.ensureUnlocked).toHaveBeenCalledTimes(2);
  });

  it("counts a cancelled unlock towards blocked", async () => {
    const { handler, sent, advance } = setup({
      isUnlocked: () => false,
      ensureUnlocked: async () => false,
    });
    for (const id of ["a", "b", "c", "d"]) {
      await handler.handle(sign(id));
      advance(10_000);
    }
    expect(sent.map((m) => m.error)).toEqual([
      "locked",
      "locked",
      "locked",
      "blocked",
    ]);
  });

  it("answers busy, and counts no refusal, when another Land's prompt is open", async () => {
    const { handler, sent, deps } = setup({
      confirm: vi.fn(async () => "busy" as const),
    });
    for (const id of ["a", "b", "c", "d"]) await handler.handle(sign(id));
    expect(sent.map((m) => m.error)).toEqual(["busy", "busy", "busy", "busy"]);
    expect(deps.confirm).toHaveBeenCalledTimes(4);
  });

  it("answers locked when the Shell locked while the prompt was open", async () => {
    const { handler, sent } = setup({
      sign: () => {
        throw new LockedError();
      },
    });
    await handler.handle(sign("a"));
    expect(sent).toEqual([{ type: "signResult", id: "a", error: "locked" }]);
  });
});
