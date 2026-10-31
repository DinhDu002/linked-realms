// The Land's Node (docs/protocols/map-server-node.md): a client of its control listener, and
// `lr-node` run as a supervised child when this Map server spawns it. The Node is the Land
// owner's own; the Map server never asks it to sign anything.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";

export interface MineStatus {
  state: "off" | "starting" | "on";
  threads: number;
  mode: "fast" | "light" | null;
  /** Hashes a second over the last 10 seconds. */
  hashRate: number;
  blocksWon: number;
  rewardAddress: string | null;
}

export interface NodeInfo {
  synced: boolean;
  connections: number;
  maxThreads: number;
}

export interface BlockFound {
  height: number;
  /** Base units, as a decimal string. */
  reward: string;
  rewardAddress: string;
}

/** A JSON-RPC error from the Node, by its message (`node-unavailable`, `bad-threads`, …). */
export class NodeRefused extends Error {}

/** What the Land server needs from its Node. */
export interface NodeLink {
  /** The last `node_info`, or undefined while the Node cannot be reached. */
  info(): NodeInfo | undefined;
  /** The last `mine_status`, or undefined while the Node cannot be reached. */
  status(): MineStatus | undefined;
  /** Starts the Land's Mine for `rewardAddress` (`mine_start`, mode `auto`). */
  start(rewardAddress: string, threads: number): Promise<MineStatus>;
  stop(): Promise<MineStatus>;
  /** Called whenever `info()` or `status()` changes, the connection included. */
  onChange(listener: () => void): void;
  /** Called on each `mine_blockFound`. */
  onWon(listener: (found: BlockFound) => void): void;
}

const MINE = { id: "land" };
const INFO_EVERY_MS = 2000;
const RETRY_MS = 1000;
// mine_start stops a running Mine first, which waits up to about 20 seconds for a dataset build.
const CALL_TIMEOUT_MS = 60_000;

const STATES: readonly string[] = ["off", "starting", "on"];
const MODES: readonly unknown[] = ["fast", "light", null];
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** A `mine_status` result, or undefined if it is not one. */
export function readStatus(value: unknown): MineStatus | undefined {
  const v = value as Partial<Record<keyof MineStatus, unknown>> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    !STATES.includes(v.state as string) ||
    !MODES.includes(v.mode) ||
    !count(v.threads) ||
    !count(v.blocksWon) ||
    typeof v.hashRate !== "number" ||
    !Number.isFinite(v.hashRate) ||
    v.hashRate < 0 ||
    (v.rewardAddress !== null && typeof v.rewardAddress !== "string")
  )
    return undefined;
  return v as MineStatus;
}

function readInfo(value: unknown): NodeInfo | undefined {
  const v = value as Partial<Record<keyof NodeInfo, unknown>> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    typeof v.synced !== "boolean" ||
    !count(v.connections) ||
    !count(v.maxThreads)
  )
    return undefined;
  return {
    synced: v.synced,
    connections: v.connections,
    maxThreads: v.maxThreads,
  };
}

function readFound(value: unknown): BlockFound | undefined {
  const v = value as Partial<Record<keyof BlockFound, unknown>> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    !count(v.height) ||
    typeof v.reward !== "string" ||
    typeof v.rewardAddress !== "string"
  )
    return undefined;
  return { height: v.height, reward: v.reward, rewardAddress: v.rewardAddress };
}

/**
 * Keeps one WebSocket to the control listener at `url` (`ws://`, or `ws+unix://PATH:/`): it
 * subscribes to the Mine, asks `node_info` every 2 seconds and calls `mine_start` and
 * `mine_stop` on it. While the Node cannot be reached it tries again every second.
 */
export function connectControl(
  url: string,
  headers: Record<string, string>,
  log: (line: string) => void,
): NodeLink & { close(): void } {
  let socket: WebSocket | undefined;
  let info: NodeInfo | undefined;
  let status: MineStatus | undefined;
  let nextId = 1;
  let closed = false;
  let connected = false;
  let poll: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  const changed: (() => void)[] = [];
  const won: ((found: BlockFound) => void)[] = [];
  const notify = () => {
    for (const listener of changed) listener();
  };

  function call(method: string, params: object): Promise<unknown> {
    const open = socket;
    if (open?.readyState !== WebSocket.OPEN)
      return Promise.reject(new NodeRefused("node-unavailable"));
    const id = nextId++;
    open.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new NodeRefused("node-unavailable"));
      }, CALL_TIMEOUT_MS);
      pending.set(id, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  function refreshInfo() {
    call("node_info", {}).then(
      (value) => {
        const next = readInfo(value);
        if (JSON.stringify(next) === JSON.stringify(info)) return;
        info = next;
        notify();
      },
      () => {}, // the socket's close reports it
    );
  }

  function onMessage(text: string) {
    let m: { id?: unknown; method?: unknown; params?: { result?: unknown } };
    let error: { message?: unknown } | undefined;
    try {
      m = JSON.parse(text) as typeof m;
      error = (m as { error?: typeof error }).error;
    } catch {
      return;
    }
    if (typeof m.id === "number") {
      const waiting = pending.get(m.id);
      pending.delete(m.id);
      if (!waiting) return;
      if (error)
        waiting.reject(new NodeRefused(String(error.message ?? "refused")));
      else waiting.resolve((m as { result?: unknown }).result);
    } else if (m.method === "mine_status") {
      status = readStatus(m.params?.result);
      notify();
    } else if (m.method === "mine_blockFound") {
      const found = readFound(m.params?.result);
      if (found) for (const listener of won) listener(found);
    }
  }

  function open() {
    const ws = new WebSocket(url, { headers });
    socket = ws;
    ws.on("open", () => {
      connected = true;
      log("Connected to the Node's control listener");
      call("mine_subscribe", MINE).catch((error: unknown) =>
        log(`mine_subscribe failed: ${String(error)}`),
      );
      refreshInfo();
      poll = setInterval(refreshInfo, INFO_EVERY_MS);
    });
    ws.on("message", (data) => onMessage(String(data)));
    ws.on("error", () => {}); // 'close' follows
    ws.on("close", () => {
      clearInterval(poll);
      socket = undefined;
      for (const waiting of pending.values())
        waiting.reject(new NodeRefused("node-unavailable"));
      pending.clear();
      if (connected && !closed)
        log("Lost the Node's control listener; the Mine is unavailable");
      connected = false;
      if (info || status) {
        info = status = undefined;
        notify();
      }
      if (!closed) retry = setTimeout(open, RETRY_MS);
    });
  }
  open();

  /** The status a start or stop returned, shown at once rather than at the next notification. */
  const took = (value: unknown): MineStatus => {
    const next = readStatus(value);
    if (!next) throw new NodeRefused("not a mine status");
    status = next;
    notify();
    return next;
  };

  return {
    info: () => info,
    status: () => status,
    start: (rewardAddress, threads) =>
      call("mine_start", {
        ...MINE,
        rewardAddress,
        threads,
        mode: "auto",
      }).then(took),
    stop: () => call("mine_stop", MINE).then(took),
    onChange: (listener) => void changed.push(listener),
    onWon: (listener) => void won.push(listener),
    close() {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    },
  };
}

const STOP_TIMEOUT_MS = 30_000;
const MAX_RESTART_MS = 60_000;
/** lr-node's exit code for bad settings: starting it again cannot help. */
const BAD_SETTINGS = 2;

/**
 * Runs `bin args` as a child whose output goes to this console, and starts it again with a
 * growing delay (1 to 60 seconds) when it stops; it starts with its Mine off (P5).
 */
export function superviseNode(
  bin: string,
  args: string[],
  log: (line: string) => void,
): { stop(): Promise<void> } {
  let child: ChildProcess | undefined;
  let stopping = false;
  let delay = 1000;
  let timer: NodeJS.Timeout | undefined;
  // A Map server that exits any other way still takes its Node with it (SIGKILL cannot be caught).
  const killOnExit = () => child?.kill("SIGTERM");
  process.on("exit", killOnExit);

  function run() {
    const started = Date.now();
    const running = spawn(bin, args, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = running;
    let failed = false;
    running.on("error", (error) => {
      failed = true;
      child = undefined;
      log(
        `Could not run the Node (NODE_BIN ${bin}): ${error.message}. The Mine is unavailable; set NODE_BIN, or NODE_ENABLED=false`,
      );
    });
    running.on("exit", (code, signal) => {
      child = undefined;
      if (stopping || failed) return;
      if (code === BAD_SETTINGS) {
        log(
          "The Node refused its settings (exit code 2); fix them and start the Map server again",
        );
        return;
      }
      if (Date.now() - started > MAX_RESTART_MS) delay = 1000;
      log(
        `The Node stopped (${signal ?? `exit code ${code}`}); starting it again in ${delay / 1000} s, with its Mine off`,
      );
      timer = setTimeout(run, delay);
      delay = Math.min(delay * 2, MAX_RESTART_MS);
    });
  }
  run();

  return {
    async stop() {
      stopping = true;
      clearTimeout(timer);
      process.off("exit", killOnExit);
      const running = child;
      if (!running || running.exitCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        running.once("exit", () => resolve()),
      );
      running.kill("SIGTERM");
      const late = setTimeout(() => running.kill("SIGKILL"), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(late);
    },
  };
}

export type NodeConfig =
  | { controlUrl: string; secretFile: string }
  | { bin: string; network: string; dataDir: string; seeds: string[] };

/** The Land's Node as `config` says: an external one, or `lr-node` spawned on a Unix socket. */
export function startNode(
  config: NodeConfig,
  log: (line: string) => void,
): { link: NodeLink; close(): Promise<void> } {
  if ("controlUrl" in config) {
    const secret = readFileSync(config.secretFile);
    if (secret.length < 32)
      throw new Error(`NODE_CONTROL_SECRET_FILE must hold at least 32 bytes`);
    const control = connectControl(
      config.controlUrl,
      { authorization: `Bearer ${secret.toString("hex")}` },
      log,
    );
    return { link: control, close: async () => control.close() };
  }
  // lr-node refuses a socket in a directory others may write to.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const socketPath = join(config.dataDir, "control.sock");
  const child = superviseNode(
    config.bin,
    [
      "--network",
      config.network,
      "--data",
      config.dataDir,
      "--control",
      `unix:${socketPath}`,
      // ponytail: no public RPC; nothing here reads the chain yet (NODE_RPC_URL, when it does).
      "--rpc",
      "off",
      ...config.seeds.flatMap((seed) => ["--seed", seed]),
    ],
    log,
  );
  const control = connectControl(`ws+unix://${socketPath}:/`, {}, log);
  return {
    link: control,
    async close() {
      control.close();
      await child.stop();
    },
  };
}
