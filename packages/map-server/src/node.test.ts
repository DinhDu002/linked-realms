import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  connectControl,
  NodeRefused,
  readStatus,
  startNode,
  superviseNode,
  type BlockFound,
} from "./node.ts";

const ADDRESS =
  "tlr1qqqcfumqdlzsgtqzvz39p459ttpuy9l3krp4y6gtt6pf5svrnjp0kxqsnx73t";
const OFF = {
  id: "land",
  state: "off",
  threads: 0,
  mode: null,
  hashRate: 0,
  blocksWon: 0,
  rewardAddress: null,
};
const ON = {
  ...OFF,
  state: "on",
  threads: 2,
  mode: "fast",
  hashRate: 1180.5,
  rewardAddress: ADDRESS,
};
const INFO = {
  height: 12,
  tip: "ab",
  connections: 1,
  synced: true,
  maxThreads: 4,
  memoryAvailableMiB: null,
};

/** waits up to 3 seconds for `check` */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A control listener that answers like lr-node's, recording each request and its headers. */
function fakeControl(listen: (server: Server) => void) {
  const requests: { method: string; params: unknown }[] = [];
  const authorizations: (string | undefined)[] = [];
  const sockets: WebSocket[] = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (socket, request) => {
    sockets.push(socket);
    authorizations.push(request.headers.authorization);
    socket.on("message", (data) => {
      const { id, method, params } = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: { threads?: number };
      };
      requests.push({ method, params });
      const reply = (body: object) =>
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
      if (method === "node_info") reply({ result: INFO });
      else if (method === "mine_subscribe") {
        reply({ result: "s1" });
        notify("mine_status", OFF);
      } else if (method === "mine_start" && params.threads! > 4)
        reply({ error: { code: -32602, message: "bad-threads" } });
      else if (method === "mine_start") reply({ result: ON });
      else if (method === "mine_stop") reply({ result: OFF });
    });
  });
  const notify = (method: string, result: unknown) => {
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          params: { subscription: "s1", result },
        }),
      );
  };
  listen(http);
  return {
    http,
    requests,
    authorizations,
    notify,
    drop: () => {
      for (const socket of sockets.splice(0)) socket.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

describe("readStatus", () => {
  it("takes lr-node's mine_status and refuses anything else", () => {
    expect(readStatus(ON)).toMatchObject({ state: "on", mode: "fast" });
    expect(readStatus(OFF)).toMatchObject({ state: "off", mode: null });
    expect(readStatus({ ...ON, blocksWon: 0xffffffff })).toBeDefined();
    for (const bad of [
      null,
      "on",
      { ...ON, state: "ON" },
      { ...ON, mode: "turbo" },
      { ...ON, threads: -1 },
      { ...ON, threads: 1.5 },
      { ...ON, blocksWon: "3" },
      // land.proto's uint32 fields: more would fail every session's MineState.
      { ...ON, threads: 2 ** 32 },
      { ...ON, blocksWon: 2 ** 32 },
      { ...ON, hashRate: Number.NaN },
      { ...ON, hashRate: -1 },
      { ...ON, rewardAddress: 7 },
    ])
      expect(readStatus(bad)).toBeUndefined();
  });
});

describe("connectControl", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function overUnix() {
    const path = join(mkdtempSync(join(tmpdir(), "control-")), "control.sock");
    const control = fakeControl((http) => http.listen(path));
    cleanups.push(control.close);
    const changes: string[] = [];
    const won: BlockFound[] = [];
    const link = connectControl(`ws+unix://${path}:/`, {}, () => {});
    cleanups.push(link.close);
    link.onChange(() => changes.push(link.status()?.state ?? "gone"));
    link.onWon((found) => won.push(found));
    return { control, link, changes, won };
  }

  it("subscribes to the Mine, reads node_info and follows the notifications", async () => {
    const { control, link, won } = overUnix();
    await until(() => link.info() !== undefined && link.status() !== undefined);
    expect(control.requests.map((r) => r.method)).toEqual(
      expect.arrayContaining(["mine_subscribe", "node_info"]),
    );
    expect(control.requests[0]).toEqual({
      method: "mine_subscribe",
      params: { id: "land" },
    });
    expect(link.info()).toEqual({
      synced: true,
      connections: 1,
      maxThreads: 4,
    });
    expect(link.status()?.state).toBe("off");
    control.notify("mine_status", ON);
    await until(() => link.status()?.state === "on");
    control.notify("mine_blockFound", {
      id: "land",
      height: 1240,
      hash: "0a",
      reward: "500004000",
      rewardAddress: ADDRESS,
      time: 1,
    });
    await until(() => won.length === 1);
    expect(won[0]).toEqual({
      height: 1240,
      reward: "500004000",
      rewardAddress: ADDRESS,
    });
  });

  it("tells of no change while node_info stays the same", async () => {
    const { link, changes } = overUnix();
    await until(() => link.info() !== undefined && link.status() !== undefined);
    const before = changes.length;
    await new Promise((resolve) => setTimeout(resolve, 2200)); // one more node_info
    expect(changes).toHaveLength(before);
  });

  it("starts and stops the Mine, and shows what it answered at once", async () => {
    const { control, link, changes } = overUnix();
    await until(() => link.status() !== undefined);
    expect((await link.start(ADDRESS, 2)).state).toBe("on");
    expect(control.requests.at(-1)).toEqual({
      method: "mine_start",
      params: { id: "land", rewardAddress: ADDRESS, threads: 2, mode: "auto" },
    });
    expect(link.status()?.state).toBe("on");
    expect(changes.at(-1)).toBe("on");
    expect((await link.stop()).state).toBe("off");
    expect(control.requests.at(-1)).toEqual({
      method: "mine_stop",
      params: { id: "land" },
    });
    const refused = link.start(ADDRESS, 9);
    await expect(refused).rejects.toBeInstanceOf(NodeRefused);
    await expect(refused).rejects.toThrow("bad-threads");
  });

  it("is unavailable while the Node cannot be reached, then connects again", async () => {
    const { control, link, changes } = overUnix();
    await until(() => link.status() !== undefined);
    control.drop();
    await until(() => link.info() === undefined && link.status() === undefined);
    expect(changes.at(-1)).toBe("gone");
    await expect(link.stop()).rejects.toThrow("node-unavailable");
    await until(() => link.status() !== undefined); // tried again after a second
  });

  it("sends the secret with the upgrade on TCP", async () => {
    const control = fakeControl((http) => http.listen(0, "127.0.0.1"));
    cleanups.push(control.close);
    await new Promise((resolve) => control.http.once("listening", resolve));
    const { port } = control.http.address() as AddressInfo;
    const link = connectControl(
      `ws://127.0.0.1:${port}`,
      { authorization: "Bearer 0707" },
      () => {},
    );
    cleanups.push(link.close);
    await until(() => link.status() !== undefined);
    expect(control.authorizations).toEqual(["Bearer 0707"]);
  });
});

/** A fake lr-node: appends its arguments to a file, then runs `then`. */
function fakeBin(then: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-node-"));
  const bin = join(dir, "lr-node");
  const runs = join(dir, "runs");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${runs}\n${then}\n`);
  chmodSync(bin, 0o755);
  const count = () => {
    try {
      return readFileSync(runs, "utf8").trim().split("\n").length;
    } catch {
      return 0;
    }
  };
  return { bin, runs, count };
}

describe("superviseNode", () => {
  it("starts the Node again when it stops, and stops it on request", async () => {
    const { bin, runs, count } = fakeBin("exit 1");
    const lines: string[] = [];
    const node = superviseNode(bin, ["--network", "dev"], (l) => lines.push(l));
    await until(() => count() === 2); // the second start, a second after the first
    expect(readFileSync(runs, "utf8").split("\n")[0]).toBe("--network dev");
    expect(lines[0]).toMatch(
      /The Node stopped \(exit code 1\); starting it again in 1 s, with its Mine off/,
    );
    await node.stop();
    const after = count();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(count()).toBe(after);
  });

  it("stops a running Node with SIGTERM", async () => {
    const { bin, count } = fakeBin(
      "trap 'exit 0' TERM; while :; do sleep 0.05; done",
    );
    const lines: string[] = [];
    const node = superviseNode(bin, [], (l) => lines.push(l));
    await until(() => count() === 1);
    await node.stop();
    expect(lines).toEqual([]);
  });

  it("does not start the Node again when it refused its settings or cannot run", async () => {
    const { bin, count } = fakeBin("exit 2");
    const lines: string[] = [];
    const node = superviseNode(bin, [], (l) => lines.push(l));
    await until(() => lines.length === 1);
    expect(lines[0]).toMatch(/refused its settings \(exit code 2\)/);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(count()).toBe(1);
    await node.stop();

    const missing: string[] = [];
    const none = superviseNode("/nonexistent/lr-node", [], (l) =>
      missing.push(l),
    );
    await until(() => missing.length === 1);
    expect(missing[0]).toMatch(
      /Could not run the Node \(NODE_BIN \/nonexistent\/lr-node\).*NODE_ENABLED=false/,
    );
    await none.stop();
  });
});

describe("startNode", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("reaches an external Node with its secret, at least 32 bytes, in hex", async () => {
    const control = fakeControl((http) => http.listen(0, "127.0.0.1"));
    cleanups.push(control.close);
    await new Promise((resolve) => control.http.once("listening", resolve));
    const { port } = control.http.address() as AddressInfo;
    const secretFile = join(mkdtempSync(join(tmpdir(), "secret-")), "secret");
    const config = { controlUrl: `ws://127.0.0.1:${port}`, secretFile };
    writeFileSync(secretFile, Buffer.alloc(31, 7));
    expect(() => startNode(config, () => {})).toThrow(/at least 32 bytes/);
    writeFileSync(secretFile, Buffer.alloc(32, 7));
    const node = startNode(config, () => {});
    cleanups.push(node.close);
    await until(() => node.link.status() !== undefined);
    expect(control.authorizations).toEqual([`Bearer ${"07".repeat(32)}`]);
  });

  it("spawns lr-node on a Unix socket in its own data directory, with no RPC", async () => {
    const { bin, runs, count } = fakeBin("exit 1");
    const dataDir = join(mkdtempSync(join(tmpdir(), "node-data-")), "lr-node");
    const node = startNode(
      { bin, network: "dev", dataDir, seeds: ["seed:9444", "10.0.0.2:9444"] },
      () => {},
    );
    cleanups.push(node.close);
    await until(() => count() === 1);
    expect(readFileSync(runs, "utf8").split("\n")[0]).toBe(
      `--network dev --data ${dataDir} --control unix:${dataDir}/control.sock --rpc off --seed seed:9444 --seed 10.0.0.2:9444`,
    );
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
  });
});
