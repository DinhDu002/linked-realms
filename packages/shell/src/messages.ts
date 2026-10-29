// Wording for what the Hub and the vault can refuse.
import { HubError } from "./hub.ts";
import { LockedError } from "./vault.ts";

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
