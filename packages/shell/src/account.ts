// Signing in to the Hub (flow 2): a statement with a nonce of our own and the current time. The
// token lives in the vault, so locking drops it and the next call signs in again.
import { signStatement } from "@linked-realms/shared/identity";
import { HubError, type HubClient } from "./hub.ts";
import type { Vault } from "./vault.ts";

/** Sign in again when the token has less than this left. */
const REFRESH_MARGIN_MS = 30_000;

export function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function createAccount({
  vault,
  hub,
  hubHost,
  now = Date.now,
}: {
  vault: Vault;
  hub: HubClient;
  hubHost: string;
  now?: () => number;
}) {
  let name = "";
  let signingIn: Promise<string> | undefined;

  function signIn(): Promise<string> {
    signingIn ??= (async () => {
      try {
        const signed = vault.withKey((key) =>
          signStatement(
            "hub-sign-in",
            {
              hub: hubHost,
              nonce: randomNonce(),
              issued: Math.floor(now() / 1000),
            },
            key,
          ),
        );
        const result = await hub.signIn(signed);
        name = result.name;
        vault.setToken({ value: result.token, expiresAt: result.expiresAt });
        return result.token;
      } finally {
        signingIn = undefined;
      }
    })();
    return signingIn;
  }

  async function token(): Promise<string> {
    const current = vault.token;
    if (current && current.expiresAt * 1000 - now() > REFRESH_MARGIN_MS)
      return current.value;
    return signIn();
  }

  return {
    get name() {
      return name;
    },
    setName(next: string) {
      name = next;
    },
    /** Runs `use` with a session token; signs in again once if the Hub says it is stale. Throws LockedError while locked. */
    async call<T>(use: (token: string) => Promise<T>): Promise<T> {
      try {
        return await use(await token());
      } catch (e) {
        if (!(e instanceof HubError) || e.status !== 401) throw e;
        vault.setToken(undefined);
        return use(await signIn());
      }
    },
  };
}

export type Account = ReturnType<typeof createAccount>;
