// Sending Gold from the Shell (docs/plans/phase-2c-the-chain.md, flow 4): what the Player typed,
// checked and priced against the Public node, then signed only after the Shell's own prompt.
import {
  formatAmount,
  isAddress,
  parseAmount,
  transactionId,
  type Key,
} from "@linked-realms/core";
import { visibleEscapes } from "./escape.ts";
import { toHex, type NodeClient, type PlacedTransaction } from "./node.ts";

/** A transfer's bytes without its memo, and what the sender's first one adds: its public key (scheme 1). */
export const TRANSFER_BYTES = 2517;
export const PUBLIC_KEY_BYTES = 1312;
export const MEMO_MAX_BYTES = 80;

/** What the Player should fix before anything is signed. */
export class SendError extends Error {
  override name = "SendError";
}

export interface SendForm {
  to: string;
  /** GOLD, as typed. */
  amount: string;
  memo: string;
  /** GOLD, or empty for the fee rate that would put it in the next Block now. */
  fee: string;
}

/** A transfer ready to show in the payment prompt and to sign. Amounts in base units. */
export interface Payment {
  networkId: number;
  sender: string;
  nonce: bigint;
  to: string;
  amount: bigint;
  memo: Uint8Array;
  fee: bigint;
  withPublicKey: boolean;
}

export const transferBytes = (memoBytes: number, withPublicKey: boolean) =>
  TRANSFER_BYTES + memoBytes + (withPublicKey ? PUBLIC_KEY_BYTES : 0);

function readGold(text: string, what: string): bigint {
  try {
    return parseAmount(text);
  } catch {
    throw new SendError(
      `The ${what} is not an amount of GOLD: digits, then optionally a dot and up to 8 digits.`,
    );
  }
}

/**
 * The recipient, amount and memo, checked as given, with no space trimmed: what a Land's `pay`
 * must already be. Throws SendError.
 */
export function readTransfer(form: Omit<SendForm, "fee">): {
  to: string;
  amount: bigint;
  memo: Uint8Array;
} {
  if (!isAddress(form.to))
    throw new SendError(
      "The recipient is not a Character address: tlr1 and then lowercase letters and digits.",
    );
  const amount = readGold(form.amount, "amount");
  if (amount === 0n) throw new SendError("The amount must be more than 0.");
  const memo = new TextEncoder().encode(form.memo);
  if (memo.length > MEMO_MAX_BYTES)
    throw new SendError(
      `The memo is at most ${MEMO_MAX_BYTES} bytes; this one has ${memo.length}.`,
    );
  return { to: form.to, amount, memo };
}

/**
 * Checks the form and prices the transfer for `sender`, from its account as it will be after its
 * transactions the Node already holds. Refuses a Node on another network than `networkId`.
 */
export async function preparePayment(
  node: NodeClient,
  networkId: number,
  sender: string,
  form: SendForm,
): Promise<Payment> {
  const { to, amount, memo } = readTransfer(form);
  const [info, account] = await Promise.all([
    node.info(),
    node.account(sender, true),
  ]);
  if (info.networkId !== networkId)
    throw new SendError(
      "The Node is on another network than this Shell, so nothing was signed.",
    );
  if (!account || account.balance === 0n)
    throw new SendError("You have no Gold to send yet.");
  const withPublicKey = !account.hasKey;
  const fee =
    form.fee === ""
      ? (await node.feeRate()) *
        BigInt(transferBytes(memo.length, withPublicKey))
      : readGold(form.fee, "fee");
  if (account.balance < amount + fee)
    throw new SendError(
      `Not enough Gold: ${formatAmount(amount + fee)} GOLD with the fee, and you have ${formatAmount(account.balance)} GOLD.`,
    );
  return {
    networkId,
    sender,
    nonce: BigInt(account.nonce),
    to,
    amount,
    memo,
    fee,
    withPublicKey,
  };
}

/** Signs `payment` with the Character's key: only after the Player approved it. */
export function signPayment(
  key: Key,
  p: Payment,
): { bytes: Uint8Array; id: string } {
  const bytes = key.signTransfer(
    p.networkId,
    p.sender,
    p.nonce,
    p.fee,
    p.to,
    p.amount,
    p.memo,
    p.withPublicKey,
    crypto.getRandomValues(new Uint8Array(32)),
  );
  return { bytes, id: toHex(transactionId(p.networkId, bytes)) };
}

/** A memo's bytes as text, with what could hide or reorder text shown as escapes. */
export const memoText = (memo: Uint8Array) =>
  visibleEscapes(new TextDecoder().decode(memo));

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/** One line of the recent transactions, as `me` sees it. */
export function describeTransaction(
  { tx, block }: PlacedTransaction,
  me: string,
): string {
  const where = block ? `Block #${block.height}` : "waiting for a Block";
  if (tx.kind !== "transfer") return `${where} · key rotation`;
  const amount = `${formatAmount(BigInt(tx.amount ?? "0"))} GOLD`;
  const memo = tx.memo ? ` · memo "${memoText(fromHex(tx.memo))}"` : "";
  return tx.sender === me
    ? `${where} · sent ${amount} to ${tx.to} · fee ${formatAmount(BigInt(tx.fee))} GOLD${memo}`
    : `${where} · received ${amount} from ${tx.sender}${memo}`;
}
