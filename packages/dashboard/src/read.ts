// What the dashboard reads: the Public node's last Blocks (docs/protocols/node-rpc.md) and the
// Hub's Directory. Four calls a refresh, well under the RPC's limit of 10 a second.
import {
  WINDOW_BLOCKS,
  type BlockRow,
  type DashboardInput,
  type LandRow,
} from "./dashboard.ts";

const TIMEOUT_MS = 5000;

/** One JSON-RPC call; throws with the Node's message if it answers an error. */
export async function rpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const answer = (await response.json()) as {
    result?: unknown;
    error?: { message?: unknown };
  };
  if (answer.error)
    throw new Error(`${method}: ${String(answer.error.message)}`);
  return answer.result;
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function blockRow(
  header: unknown,
  created: Map<string, number | null>,
): BlockRow {
  const h = (header ?? {}) as Record<string, unknown>;
  if (
    !isCount(h.height) ||
    !isCount(h.timestamp) ||
    typeof h.id !== "string" ||
    typeof h.target !== "string" ||
    !/^[0-9a-f]{64}$/.test(h.target) ||
    typeof h.rewardAddress !== "string"
  )
    throw new Error("the Public node sent a Header this page cannot read");
  return {
    height: h.height,
    id: h.id,
    timestamp: h.timestamp,
    target: h.target,
    rewardAddress: h.rewardAddress,
    newAccounts: created.get(h.id) ?? null,
  };
}

/** The Lands in a Directory answer; undefined if it is not one. */
export function readLands(directory: unknown): LandRow[] | undefined {
  const lands = (directory as { lands?: unknown } | null)?.lands;
  if (!Array.isArray(lands)) return undefined;
  const rows = lands.map((land) => (land ?? {}) as Record<string, unknown>);
  if (
    !rows.every(
      (l) =>
        isCount(l.landId) &&
        typeof l.owner === "string" &&
        typeof l.online === "boolean",
    )
  )
    return undefined;
  return rows.map((l) => ({
    landId: l.landId as number,
    owner: l.owner as string,
    online: l.online as boolean,
  }));
}

/** The Hub's Lands; undefined (shown as "unknown") without a Hub or an answer in time. */
async function lands(hubUrl: string | undefined) {
  if (!hubUrl) return undefined;
  try {
    const response = await fetch(`${hubUrl}/directory`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? readLands(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

export async function readInput(
  nodeUrl: string,
  hubUrl: string | undefined,
  nowSeconds: number,
): Promise<DashboardInput> {
  const info = ((await rpc(nodeUrl, "lr_getInfo", [])) ?? {}) as Record<
    string,
    unknown
  >;
  if (!isCount(info.height) || !isCount(info.networkId))
    throw new Error("the Public node sent lr_getInfo this page cannot read");
  // The genesis is not won by anyone.
  const from = Math.max(1, info.height - WINDOW_BLOCKS + 1);
  const count = info.height - from + 1;
  const [headers, counts, directory] = await Promise.all([
    count > 0 ? rpc(nodeUrl, "lr_getHeaders", [from, count]) : [],
    count > 0 ? rpc(nodeUrl, "lr_getNewAccountCounts", [from, count]) : [],
    lands(hubUrl),
  ]);
  if (!Array.isArray(headers) || !Array.isArray(counts))
    throw new Error("the Public node sent a list this page cannot read");
  // By id: the best chain may have changed between the two calls.
  const created = new Map<string, number | null>();
  for (const c of counts as { id?: unknown; newAccounts?: unknown }[])
    if (typeof c?.id === "string")
      created.set(c.id, isCount(c.newAccounts) ? c.newAccounts : null);
  return {
    nowSeconds,
    networkId: info.networkId,
    blocks: headers.map((header) => blockRow(header, created)),
    lands: directory,
  };
}
