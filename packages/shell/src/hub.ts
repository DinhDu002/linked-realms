// The Hub's HTTP routes the Shell uses (packages/hub-api/README.md).
import type { SignedStatement } from "@linked-realms/shared/identity";
import type { LandDirectory, LandInfo } from "@linked-realms/shared";

export class HubError extends Error {
  override name = "HubError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SignIn {
  token: string;
  address: string;
  name: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface MapServerOffer {
  mapServerKey: string;
  issued: number;
}

export function createHubClient(
  hubUrl: string,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
) {
  async function call<T>(
    method: string,
    path: string,
    { token, body }: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${hubUrl}${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // The Directory's stale-while-revalidate is for shared caches; a browser honouring it
        // would answer every poll with the one before. The Shell always asks the Hub.
        cache: "no-cache",
      });
    } catch {
      throw new HubError(0, "The Hub cannot be reached");
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = (json as { error?: unknown } | undefined)?.error;
      throw new HubError(
        response.status,
        typeof message === "string"
          ? message
          : `The Hub answered ${response.status}`,
      );
    }
    return json as T;
  }

  const query = (name: string, value: string) =>
    `?${name}=${encodeURIComponent(value)}`;

  return {
    directory: () => call<LandDirectory>("GET", "/directory"),
    signIn: (signed: SignedStatement) =>
      call<SignIn>("POST", "/auth/verify", { body: signed }),
    setName: (token: string, name: string) =>
      call<{ name: string }>("PUT", "/me/name", { token, body: { name } }),
    ticket: (token: string, landId: number, from?: number) =>
      call<SignedStatement>("POST", "/tickets", {
        token,
        body: from === undefined ? { landId } : { landId, from },
      }),
    mapServers: (token: string, owner: string) =>
      call<{ mapServers: MapServerOffer[] }>(
        "GET",
        `/map-servers${query("owner", owner)}`,
        { token },
      ),
    createLand: (delegation: SignedStatement) =>
      call<{ landId: number }>("POST", "/lands", { body: delegation }),
    /** The Land this Character owns, or undefined. */
    async landOf(owner: string): Promise<LandInfo | undefined> {
      try {
        return await call<LandInfo>("GET", `/lands${query("owner", owner)}`);
      } catch (e) {
        if (e instanceof HubError && e.status === 404) return undefined;
        throw e;
      }
    },
    report: (token: string, landId: number, reason: string) =>
      call<{ ok: true }>("POST", "/reports", {
        token,
        body: { landId, reason },
      }),
  };
}

export type HubClient = ReturnType<typeof createHubClient>;
