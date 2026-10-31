// Wording for what the Hub, the Node and the vault can refuse.
import { formatAmount } from "@linked-realms/core";
import { SendError } from "./gold.ts";
import { HubError } from "./hub.ts";
import { NodeError } from "./node.ts";
import { LockedError } from "./vault.ts";

/** The least a transfer moves to an address with no Account (docs/protocols/transactions.md). */
const DUST = 38_290n;

/** What the Player reads when registering a Map server fails. */
export function registerErrorText(e: unknown): string {
  if (e instanceof LockedError)
    return "The Shell is locked. Unlock it and try again.";
  if (e instanceof HubError) {
    switch (e.status) {
      case 403:
        return "The Hub refused: that Map server has not named your Character as its owner. Check LAND_OWNER in its settings and restart it.";
      case 409:
        return "The Hub refused: that Map server already serves a Land, or a newer Delegation exists.";
      case 429:
        return "Too many new Lands were created from your network address today (3 at most). Try again tomorrow.";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** What the Player reads when something else fails. */
export function errorText(e: unknown): string {
  if (e instanceof LockedError)
    return "The Shell is locked. Unlock it and try again.";
  return e instanceof Error ? e.message : String(e);
}

/** What the Player reads when sending Gold fails: nothing was sent unless the Node says it holds it. */
export function sendErrorText(e: unknown): string {
  if (e instanceof SendError) return e.message;
  if (e instanceof NodeError) {
    if (e.code === 0) return "The Node cannot be reached, so nothing was sent.";
    if (e.code === -32005)
      return "The Node is answering too many calls from your network address. Wait a few seconds and try again.";
    switch (e.reason) {
      case "fee-too-low":
        return "The Node refused: the fee is too low. Leave the fee empty to pay what the Node asks.";
      case "dust":
        return `The Node refused: an address that has never received Gold needs at least ${formatAmount(DUST)} GOLD.`;
      case "nonce-gap":
        return "The Node refused: an earlier send of yours is missing from it. Wait for a Block and try again.";
      case "too-many":
        return "The Node refused: you have too many sends waiting. Wait for a Block and try again.";
      case "replacement-too-cheap":
        return "The Node refused: a send of yours is waiting with the same number. Wait for a Block and try again.";
      case "mempool-full":
        return "The Node refused: it holds too many transactions. Try a higher fee, or wait.";
      case "rule":
        return "The Node refused: the transaction breaks a chain rule, for example not enough Gold.";
    }
    return `The Node refused: ${e.message}`;
  }
  return errorText(e);
}
