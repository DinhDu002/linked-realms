import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Key } from "@linked-realms/core";
import {
  CHARACTER_HALF_SIZE_PX,
  gateNumber,
  gateSpawn,
  parseLandMap,
  spawnPosition,
  type Direction,
} from "@linked-realms/shared";
import {
  signStatement,
  type SignedStatement,
} from "@linked-realms/shared/identity";
import { buildMineSwitch } from "@linked-realms/shared/mine-switch";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  type ServerMessage,
} from "@linked-realms/shared/land-protocol";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  createLandServer,
  MAX_CHARACTERS,
  MAX_INPUTS_PER_SECOND,
  type LandServer,
} from "./land.ts";
import {
  NodeRefused,
  type BlockFound,
  type MineStatus,
  type NodeInfo,
  type NodeLink,
} from "./node.ts";

const LAND_ID = 7;
const mapText = readFileSync(
  fileURLToPath(new URL("../../../maps/empty-land.json", import.meta.url)),
  "utf8",
);
const map = parseLandMap(mapText);
const spawn = spawnPosition(map);

const seeded = (byte: number) => Key.fromSeed(new Uint8Array(32).fill(byte));
const hub = seeded(0x48);
const forger = seeded(0x49);
const owner = seeded(1);
const visitor = seeded(2);
const mapServer = seeded(0x4d);

let nowMs = 1_800_000_000_000;
const nowSeconds = () => Math.floor(nowMs / 1000);

interface TicketOptions {
  landId?: number;
  gate?: number;
  name?: string;
  issued?: number;
  expiresIn?: number;
  signer?: Key;
  nonce?: string;
}

/** A Travel ticket for `character`, signed by `signer` (the Hub unless a test forges it). */
function ticketFor(
  character: Key,
  {
    landId = LAND_ID,
    gate = 0,
    name = "",
    issued = nowSeconds(),
    expiresIn = 60,
    signer = hub,
    nonce = randomBytes(16).toString("hex"),
  }: TicketOptions = {},
) {
  return {
    nonce,
    signed: signStatement(
      "travel-ticket",
      {
        hub: "hub.test",
        character: character.address,
        name,
        land: landId,
        gate,
        issued,
        expires: issued + expiresIn,
        nonce,
      },
      signer,
    ),
  };
}

function arrivalFor(
  key: Key,
  nonce: string,
  { landId = LAND_ID, drivenByAi = false } = {},
) {
  return signStatement(
    "arrival",
    { land: landId, ticketNonce: nonce, drivenByAi },
    key,
  );
}

interface Handoff {
  ticket: SignedStatement;
  arrival: SignedStatement;
}

/** A valid handoff for `character`; options adjust the ticket or the arrival. */
function handoff(
  character: Key,
  ticket: TicketOptions = {},
  arrival: { landId?: number; drivenByAi?: boolean; signer?: Key } = {},
): Handoff {
  const t = ticketFor(character, ticket);
  return {
    ticket: t.signed,
    arrival: arrivalFor(arrival.signer ?? character, t.nonce, arrival),
  };
}

interface SwitchOptions {
  on?: boolean;
  threads?: number;
  land?: number;
  issued?: number;
  mapServerKey?: string;
}

/** A Land message carrying a Mine switch for `challenge`, signed by `key`. */
function switchFor(
  key: Key,
  challenge: string,
  {
    on = true,
    threads = on ? 2 : 0,
    land = LAND_ID,
    issued = nowSeconds(),
    mapServerKey = mapServer.address,
  }: SwitchOptions = {},
): SignedStatement {
  return signStatement(
    "land-message",
    {
      land,
      landUrl: "https://7.lands.example",
      character: key.address,
      issued,
      message: buildMineSwitch({ mapServerKey, on, threads, nonce: challenge }),
    },
    key,
  );
}

const OFF: MineStatus = {
  state: "off",
  threads: 0,
  mode: null,
  hashRate: 0,
  blocksWon: 0,
  rewardAddress: null,
};

/** A Node the test drives: its info and status, the calls it got, and what they answer. */
interface FakeNode {
  info: NodeInfo | undefined;
  status: MineStatus | undefined;
  calls: unknown[][];
  answer: () => Promise<MineStatus>;
  change(status: MineStatus | undefined): void;
  win(found: BlockFound): void;
  link: NodeLink;
}

function fakeNode(
  info: NodeInfo | undefined = { synced: true, connections: 1, maxThreads: 4 },
): FakeNode {
  const changed: (() => void)[] = [];
  const won: ((found: BlockFound) => void)[] = [];
  const fake: FakeNode = {
    info,
    status: OFF,
    calls: [],
    answer: (): Promise<MineStatus> => Promise.resolve(fake.status!),
    change(status: MineStatus | undefined) {
      fake.status = status;
      for (const listener of changed) listener();
    },
    win(found: BlockFound) {
      for (const listener of won) listener(found);
    },
    link: {
      info: () => fake.info,
      status: () => fake.status,
      start: (rewardAddress, threads) => {
        fake.calls.push(["start", rewardAddress, threads]);
        return fake.answer();
      },
      stop: () => {
        fake.calls.push(["stop"]);
        return fake.answer();
      },
      onChange: (listener) => void changed.push(listener),
      onWon: (listener) => void won.push(listener),
    },
  };
  return fake;
}

type Message = NonNullable<ServerMessage["message"]["case"]>;
type Value<K extends Message> = Extract<
  ServerMessage["message"],
  { case: K }
>["value"];

class Client {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<number>;
  #waiters: (() => void)[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data: Buffer) => {
      this.messages.push(fromBinary(ServerMessageSchema, data));
      for (const wake of this.#waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) =>
      this.socket.on("close", (code) => resolve(code)),
    );
    this.socket.on("error", () => {});
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
      this.socket.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode}`)),
      );
    });
  }

  sendRaw(bytes: Uint8Array | string): void {
    this.socket.send(bytes);
  }

  hello(h: Handoff | { ticket?: unknown; arrival?: unknown }): void {
    this.sendRaw(
      toBinary(
        ClientMessageSchema,
        create(ClientMessageSchema, {
          message: { case: "hello", value: h as Handoff },
        }),
      ),
    );
  }

  input(dx: number, dy: number, seq = 1): void {
    this.sendRaw(
      toBinary(
        ClientMessageSchema,
        create(ClientMessageSchema, {
          message: { case: "input", value: { dx, dy, seq } },
        }),
      ),
    );
  }

  mineSwitch(signed: SignedStatement | Record<string, string>): void {
    this.sendRaw(
      toBinary(
        ClientMessageSchema,
        create(ClientMessageSchema, {
          message: { case: "mineSwitch", value: { signed } },
        }),
      ),
    );
  }

  /** The first message of this kind that satisfies `where`; waits up to 3 seconds. */
  async waitFor<K extends Message>(
    kind: K,
    where: (value: Value<K>) => boolean = () => true,
  ): Promise<Value<K>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      for (const m of this.messages) {
        const value = m.message.value as Value<K> | undefined;
        if (m.message.case === kind && value && where(value)) return value;
      }
      if (Date.now() > deadline) throw new Error(`no ${kind} message`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  async refusedWith(): Promise<string> {
    const { code } = await this.waitFor("error");
    expect(await this.closed).toBe(1008);
    return code;
  }
}

describe("Land server", () => {
  let server: LandServer;
  let url: string;
  let httpUrl: string;
  const clients: Client[] = [];
  let uiDir: string;

  beforeAll(() => {
    uiDir = mkdtempSync(join(tmpdir(), "land-ui-"));
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(join(uiDir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(uiDir, "assets", "z.wasm"), "\0asm");
    writeFileSync(
      join(uiDir, "assets", "big-abc123.js"),
      Buffer.alloc(8 << 20),
    );
    writeFileSync(join(uiDir, ".secret"), "dotfile");
    writeFileSync(
      join(uiDir, "..", `${uiDir.split("/").pop()}-outside.txt`),
      "outside",
    );
  });

  async function start(
    options: Partial<Parameters<typeof createLandServer>[0]> = {},
    served: Parameters<LandServer["setLand"]>[0] | null = {
      landId: LAND_ID,
      owner: owner.address,
      ownerName: "Mai",
    },
  ) {
    nowMs = 1_800_000_000_000;
    server = createLandServer({
      map,
      mapText,
      hubTicketSigner: hub.address,
      landUiDir: uiDir,
      mapServerKey: mapServer.address,
      now: () => nowMs,
      tickMs: 10,
      ...options,
    });
    if (served) server.setLand(served);
    const port = await server.listen(0, "127.0.0.1");
    url = `ws://127.0.0.1:${port}/play`;
    httpUrl = `http://127.0.0.1:${port}`;
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    await server.close();
  });

  async function connect(): Promise<Client> {
    const client = new Client(url);
    clients.push(client);
    await client.opened();
    return client;
  }

  /** Connects, sends a hello, and waits for the welcome. */
  async function enter(h: Handoff) {
    const client = await connect();
    client.hello(h);
    const welcome = await client.waitFor("welcome");
    return { client, welcome };
  }

  describe("joining", () => {
    it("welcomes a Character with the map, the Land and everyone present", async () => {
      await start();
      const a = await enter(
        handoff(owner, { name: "Mai", gate: gateNumber("north") }),
      );
      expect(a.welcome.land).toMatchObject({
        landId: BigInt(LAND_ID),
        owner: owner.address,
        ownerName: "Mai",
      });
      expect(a.welcome.map).toBe(mapText);
      expect(a.welcome.characters).toHaveLength(1);

      const b = await enter(handoff(visitor, { name: "Bao" }));
      expect(b.welcome.you).not.toBe(a.welcome.you);
      expect(b.welcome.characters.map((c) => c.address).sort()).toEqual(
        [owner.address, visitor.address].sort(),
      );
      const joined = await a.client.waitFor("joined");
      expect(joined).toMatchObject({
        id: b.welcome.you,
        address: visitor.address,
        name: "Bao",
        isOwner: false,
        drivenByAi: false,
      });
      const self = a.welcome.characters.find((c) => c.id === a.welcome.you);
      expect(self).toMatchObject({ isOwner: true, name: "Mai" });
      // The owner arrived through the north Gate, the visitor from the Directory.
      expect({ x: self!.x, y: self!.y }).toEqual(gateSpawn(map, "north"));
      const other = b.welcome.characters.find((c) => c.id === b.welcome.you);
      expect({ x: other!.x, y: other!.y }).toEqual(spawn);
    });

    it("spawns at the Gate the ticket names", async () => {
      await start();
      for (const gate of ["north", "east", "south", "west"] as Direction[]) {
        const key = seeded(10 + gateNumber(gate));
        const { welcome } = await enter(
          handoff(key, { gate: gateNumber(gate) }),
        );
        const me = welcome.characters.find((c) => c.id === welcome.you)!;
        expect({ x: me.x, y: me.y }).toEqual(gateSpawn(map, gate));
      }
    });

    it("marks a Character that declares an AI", async () => {
      await start();
      const { welcome } = await enter(
        handoff(visitor, {}, { drivenByAi: true }),
      );
      expect(welcome.characters[0]?.drivenByAi).toBe(true);
    });

    it("tells the others when a Character leaves", async () => {
      await start();
      const a = await enter(handoff(owner));
      const b = await enter(handoff(visitor));
      b.client.socket.close();
      const left = await a.client.waitFor("left");
      expect(left.id).toBe(b.welcome.you);
      // The address is free again, with a fresh ticket.
      await enter(handoff(visitor));
    });

    it("refuses at most 64 Characters", async () => {
      await start();
      for (let i = 0; i < MAX_CHARACTERS; i++)
        await enter(handoff(seeded(100 + i)));
      const extra = await connect();
      extra.hello(handoff(seeded(200)));
      expect(await extra.refusedWith()).toBe("full");
    });

    it("refuses everything until the Land is known", async () => {
      await start({}, null);
      const client = await connect();
      client.hello(handoff(owner));
      expect(await client.refusedWith()).toBe("unavailable");
    });
  });

  describe("refuses", () => {
    async function refused(
      h: Handoff | { ticket?: unknown; arrival?: unknown },
    ) {
      const client = await connect();
      client.hello(h);
      return client.refusedWith();
    }

    it("a ticket not signed by the Hub's ticket key", async () => {
      await start();
      expect(await refused(handoff(visitor, { signer: forger }))).toBe(
        "bad-ticket",
      );
    });

    it("a ticket changed after signing", async () => {
      await start();
      const h = handoff(visitor);
      h.ticket.statement = h.ticket.statement.replace("Gate: 0", "Gate: 1");
      expect(await refused(h)).toBe("bad-ticket");
    });

    it("a ticket for another Land", async () => {
      await start();
      expect(await refused(handoff(visitor, { landId: LAND_ID + 1 }))).toBe(
        "wrong-land",
      );
    });

    it("an expired ticket", async () => {
      await start();
      expect(
        await refused(
          handoff(visitor, { issued: nowSeconds() - 120, expiresIn: 60 }),
        ),
      ).toBe("expired");
    });

    it("a ticket that expires too far ahead", async () => {
      await start();
      expect(await refused(handoff(visitor, { expiresIn: 600 }))).toBe(
        "too-far-ahead",
      );
    });

    it("a ticket issued before the Map server started", async () => {
      await start({ startedAt: nowSeconds() });
      expect(
        await refused(handoff(visitor, { issued: nowSeconds() - 10 })),
      ).toBe("before-start");
    });

    it("a reused ticket, until it expires", async () => {
      await start();
      const h = handoff(visitor);
      const first = await enter(h);
      first.client.socket.close();
      await first.client.closed;
      expect(await refused(h)).toBe("reused");
      // Forgotten once expired: an expired ticket is refused as expired, not as reused.
      nowMs += 61_000;
      expect(await refused(h)).toBe("expired");
    });

    it("a ticket whose checks failed is not recorded as used", async () => {
      await start();
      const t = ticketFor(visitor);
      const bad = { ticket: t.signed, arrival: arrivalFor(forger, t.nonce) };
      expect(await refused(bad)).toBe("key-mismatch");
      const good = { ticket: t.signed, arrival: arrivalFor(visitor, t.nonce) };
      await enter(good);
    });

    it("a missing or wrong arrival signature", async () => {
      await start();
      const h = handoff(visitor);
      expect(await refused({ ticket: h.ticket })).toBe("bad-arrival");
      const tampered = { ...h.arrival, signature: h.ticket.signature };
      expect(await refused({ ticket: h.ticket, arrival: tampered })).toBe(
        "bad-arrival",
      );
    });

    it("an arrival whose public key is not the ticket's Character", async () => {
      await start();
      expect(await refused(handoff(visitor, {}, { signer: forger }))).toBe(
        "key-mismatch",
      );
    });

    it("an arrival for another Land or another nonce", async () => {
      await start();
      expect(await refused(handoff(visitor, {}, { landId: LAND_ID + 1 }))).toBe(
        "mismatch",
      );
      const t = ticketFor(visitor);
      expect(
        await refused({
          ticket: t.signed,
          arrival: arrivalFor(visitor, randomBytes(16).toString("hex")),
        }),
      ).toBe("mismatch");
    });

    it("a hello with nothing in it, or garbage", async () => {
      await start();
      expect(await refused({ ticket: {}, arrival: {} })).toBe("bad-ticket");
      const client = await connect();
      client.hello({
        ticket: { statement: "x", publicKey: "y", signature: "z" },
      });
      expect(await client.refusedWith()).toBe("bad-ticket");
    });

    it("a second session for the same address", async () => {
      await start();
      await enter(handoff(owner));
      const second = await connect();
      second.hello(handoff(owner));
      expect(await second.refusedWith()).toBe("duplicate");
    });

    it("two simultaneous sessions for the same address", async () => {
      await start();
      const a = await connect();
      const b = await connect();
      a.hello(handoff(owner));
      b.hello(handoff(owner));
      const results = await Promise.all(
        [a, b].map((c) =>
          Promise.race([
            c.waitFor("welcome").then(() => "welcome"),
            c.waitFor("error").then((e) => e.code),
          ]),
        ),
      );
      expect(results.sort()).toEqual(["duplicate", "welcome"]);
    });

    it("two simultaneous hellos with one ticket", async () => {
      await start();
      const h = handoff(visitor);
      const a = await connect();
      const b = await connect();
      a.hello(h);
      b.hello(h);
      const results = await Promise.all(
        [a, b].map((c) =>
          Promise.race([
            c.waitFor("welcome").then(() => "welcome"),
            c.waitFor("error").then((e) => e.code),
          ]),
        ),
      );
      expect(results.sort()).toEqual(["reused", "welcome"]);
    });

    it("a text frame, a malformed frame, or an input before the hello", async () => {
      await start();
      for (const send of [
        (c: Client) => c.sendRaw("hello"),
        (c: Client) => c.sendRaw(new Uint8Array([0xff, 0xff, 0xff])),
        (c: Client) => c.input(1, 0),
      ]) {
        const client = await connect();
        send(client);
        expect(await client.refusedWith()).toBe("bad-message");
      }
    });

    it("a second hello", async () => {
      await start();
      const { client } = await enter(handoff(visitor));
      client.hello(handoff(owner));
      expect(await client.refusedWith()).toBe("bad-message");
    });

    it("a connection that sends no hello in time", async () => {
      await start({ helloTimeoutMs: 100 });
      const client = await connect();
      expect(await client.refusedWith()).toBe("bad-message");
    });

    it("marks no one as the owner when the Hub names someone else", async () => {
      await start(
        {},
        { landId: LAND_ID, owner: forger.address, ownerName: "" },
      );
      const { welcome } = await enter(handoff(owner));
      expect(welcome.characters[0]?.isOwner).toBe(false);
    });
  });

  describe("playing", () => {
    it("moves a Character and the Mine blocks it", async () => {
      await start();
      const { client, welcome } = await enter(handoff(owner));
      const me = () =>
        client.messages
          .flatMap((m) =>
            m.message.case === "moved" ? m.message.value.positions : [],
          )
          .filter((p) => p.id === welcome.you)
          .at(-1);
      client.input(1, 0, 1);
      const east = await client.waitFor("moved", (m) => m.positions.length > 0);
      expect(east.seq).toBe(1);
      expect(me()!.x).toBeGreaterThan(spawn.x);
      expect(me()!.y).toBe(spawn.y);

      client.input(0, -1, 2);
      const mineBottom = (map.mine.tileY + map.mine.height) * map.tileSize;
      await client.waitFor("moved", () => me()!.y < spawn.y);
      // Walk into the Mine until blocked: y stops at its bottom edge.
      await waitUntil(
        () => me()!.y <= mineBottom + CHARACTER_HALF_SIZE_PX + 7, // within one step
      );
      const blockedAt = me()!.y;
      expect(blockedAt).toBeGreaterThanOrEqual(
        mineBottom + CHARACTER_HALF_SIZE_PX,
      );
      const count = client.messages.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(me()!.y).toBe(blockedAt);
      // A blocked Character sends no more positions.
      expect(
        client.messages
          .slice(count)
          .some(
            (m) =>
              m.message.case === "moved" &&
              m.message.value.positions.length > 0,
          ),
      ).toBe(false);
    });

    it("sends each Character's moves to the others, with the receiver's seq", async () => {
      await start();
      const a = await enter(handoff(owner));
      const b = await enter(handoff(visitor));
      a.client.input(-1, 0, 5);
      const seen = await b.client.waitFor("moved", (m) =>
        m.positions.some((p) => p.id === a.welcome.you),
      );
      expect(seen.seq).toBe(0); // b has sent no Input
      expect(seen.positions.every((p) => p.id === a.welcome.you)).toBe(true);
    });

    it("refuses an input that is not -1, 0 or 1", async () => {
      await start();
      const { client } = await enter(handoff(owner));
      client.input(2, 0);
      expect(await client.refusedWith()).toBe("bad-message");
    });

    it("refuses inputs beyond the per-second limit, and counts again after a second", async () => {
      await start();
      const { client } = await enter(handoff(owner));
      for (let i = 1; i <= MAX_INPUTS_PER_SECOND; i++) client.input(0, 0, i);
      client.input(0, 0, 99);
      expect(await client.refusedWith()).toBe("rate-limited");

      const second = await enter(handoff(visitor));
      for (let i = 1; i <= MAX_INPUTS_PER_SECOND; i++)
        second.client.input(0, 0, i);
      // The server acknowledges the last Input once it has read all of them.
      await second.client.waitFor(
        "moved",
        (m) => m.seq === MAX_INPUTS_PER_SECOND,
      );
      nowMs += 1000;
      for (let i = 1; i < MAX_INPUTS_PER_SECOND; i++)
        second.client.input(0, 0, 100 + i);
      second.client.input(1, 0, 200); // the 30th of the second window
      await second.client.waitFor("moved", (m) => m.seq === 200);
    });
  });

  describe("the Mine", () => {
    /** The owner in the Land, their first MineState's challenge, and a way to read the next. */
    async function ownerIn(node = fakeNode()) {
      await start({ node: node.link });
      const { client } = await enter(handoff(owner));
      const first = await client.waitFor("mineState");
      return { client, node, challenge: first.challenge };
    }
    const results = (client: Client) =>
      client.messages.flatMap((m) =>
        m.message.case === "mineSwitchResult" ? [m.message.value] : [],
      );
    /** The answer to the switch sent after `before` results. */
    async function answerTo(client: Client, before: number) {
      await waitUntil(() => results(client).length > before);
      const { ok, code } = results(client)[before]!;
      return ok ? "ok" : code;
    }
    async function send(client: Client, signed: SignedStatement) {
      const before = results(client).length;
      client.mineSwitch(signed);
      return answerTo(client, before);
    }

    it("sends the Mine's state after welcome, with the challenge in the Land owner's copy only", async () => {
      const { challenge } = await ownerIn();
      expect(challenge).toMatch(/^[0-9a-f]{32}$/);
      const { client } = await enter(handoff(visitor));
      expect(await client.waitFor("mineState")).toMatchObject({
        status: "off",
        maxThreads: 4,
        challenge: "",
        mapServerKey: "",
      });
      const first = clients[0]!.messages.find(
        (m) => m.message.case === "mineState",
      )!.message.value;
      expect(first).toMatchObject({ mapServerKey: mapServer.address });
    });

    it("starts the Mine for the Land owner's address and renews the spent challenge", async () => {
      const { client, node, challenge } = await ownerIn();
      expect(
        await send(client, switchFor(owner, challenge, { threads: 3 })),
      ).toBe("ok");
      expect(node.calls).toEqual([["start", owner.address, 3]]);
      const fresh = await client.waitFor(
        "mineState",
        (m) => m.challenge !== challenge,
      );
      nowMs += 2000;
      expect(
        await send(client, switchFor(owner, fresh.challenge, { on: false })),
      ).toBe("ok");
      expect(node.calls.at(-1)).toEqual(["stop"]);
    });

    it("tells every client of a change and of a win", async () => {
      const { client, node } = await ownerIn();
      const { client: other } = await enter(handoff(visitor));
      await other.waitFor("mineState");
      node.change({
        state: "on",
        threads: 2,
        mode: "fast",
        hashRate: 1180.5,
        blocksWon: 0,
        rewardAddress: owner.address,
      });
      for (const c of [client, other])
        expect(
          await c.waitFor("mineState", (m) => m.status === "on"),
        ).toMatchObject({ threads: 2, mode: "fast", hashRate: 1180.5 });
      node.win({
        height: 1240,
        reward: "500004000",
        rewardAddress: owner.address,
      });
      for (const c of [client, other])
        expect(await c.waitFor("mineWon")).toMatchObject({
          height: 1240n,
          reward: "500004000",
          rewardAddress: owner.address,
        });
    });

    describe("refuses", () => {
      it("a switch from a visitor's session", async () => {
        const { node } = await ownerIn();
        const { client } = await enter(handoff(visitor));
        expect(await send(client, switchFor(visitor, "0".repeat(32)))).toBe(
          "not-owner",
        );
        expect(node.calls).toEqual([]);
      });

      it("a switch another Character signed, in the Land owner's session", async () => {
        const { client, challenge } = await ownerIn();
        expect(await send(client, switchFor(visitor, challenge))).toBe(
          "not-owner",
        );
      });

      it("a bad statement: a broken signature, garbage, or another Map server's key", async () => {
        const { client, node, challenge } = await ownerIn();
        const good = switchFor(owner, challenge);
        const forged = {
          ...good,
          statement: good.statement.replace("Threads: 2", "Threads: 3"),
        };
        expect(await send(client, forged)).toBe("bad-statement");
        nowMs += 2000;
        expect(
          await send(client, { statement: "x", publicKey: "", signature: "" }),
        ).toBe("bad-statement");
        nowMs += 2000;
        expect(
          await send(
            client,
            switchFor(owner, challenge, { mapServerKey: visitor.address }),
          ),
        ).toBe("bad-statement");
        expect(node.calls).toEqual([]);
        // None of them spent the challenge.
        nowMs += 2000;
        expect(await send(client, good)).toBe("ok");
      });

      it("a switch for another Land", async () => {
        const { client, challenge } = await ownerIn();
        expect(
          await send(
            client,
            switchFor(owner, challenge, { land: LAND_ID + 1 }),
          ),
        ).toBe("bad-statement");
      });

      it("a stale switch, on either side of the clock", async () => {
        const { client, challenge } = await ownerIn();
        expect(
          await send(
            client,
            switchFor(owner, challenge, { issued: nowSeconds() - 301 }),
          ),
        ).toBe("stale");
        nowMs += 2000;
        expect(
          await send(
            client,
            switchFor(owner, challenge, { issued: nowSeconds() + 301 }),
          ),
        ).toBe("stale");
        nowMs += 2000;
        expect(
          await send(
            client,
            switchFor(owner, challenge, { issued: nowSeconds() - 300 }),
          ),
        ).toBe("ok");
      });

      it("a wrong nonce, which spends nothing, and a replay", async () => {
        const { client, node, challenge } = await ownerIn();
        expect(await send(client, switchFor(owner, "f".repeat(32)))).toBe(
          "wrong-nonce",
        );
        nowMs += 2000;
        const good = switchFor(owner, challenge);
        expect(await send(client, good)).toBe("ok");
        nowMs += 2000;
        expect(await send(client, good)).toBe("wrong-nonce");
        expect(node.calls).toHaveLength(1);
      });

      it("another session's challenge", async () => {
        const { client, challenge } = await ownerIn();
        client.socket.close();
        await client.closed;
        const again = await enter(handoff(owner));
        const second = await again.client.waitFor("mineState");
        expect(second.challenge).not.toBe(challenge);
        expect(await send(again.client, switchFor(owner, challenge))).toBe(
          "wrong-nonce",
        );
      });

      it("an expired challenge, renewed at once", async () => {
        const { client, challenge } = await ownerIn();
        nowMs += 300_000;
        const renewed = await client.waitFor(
          "mineState",
          (m) => m.challenge !== challenge,
        );
        expect(renewed.challenge).toMatch(/^[0-9a-f]{32}$/);
        expect(await send(client, switchFor(owner, challenge))).toBe(
          "wrong-nonce",
        );
        nowMs += 2000;
        expect(await send(client, switchFor(owner, renewed.challenge))).toBe(
          "ok",
        );
      });

      it("more threads than the Node allows, before calling it", async () => {
        const { client, node, challenge } = await ownerIn();
        expect(
          await send(client, switchFor(owner, challenge, { threads: 5 })),
        ).toBe("bad-threads");
        expect(node.calls).toEqual([]);
      });

      it("a second switch within 2 seconds, or while one is with the Node", async () => {
        const { client, node, challenge } = await ownerIn();
        let release = () => {};
        node.answer = () =>
          new Promise((resolve) => (release = () => resolve(OFF)));
        client.mineSwitch(switchFor(owner, challenge));
        await waitUntil(() => node.calls.length === 1);
        expect(await send(client, switchFor(owner, challenge))).toBe(
          "rate-limited",
        );
        nowMs += 5000;
        expect(await send(client, switchFor(owner, challenge))).toBe(
          "rate-limited",
        );
        release();
        // The first switch's answer comes after the two refusals.
        expect(await answerTo(client, 2)).toBe("ok");
        expect(node.calls).toHaveLength(1);
      });

      it("a switch the Node cannot carry out", async () => {
        const down = fakeNode();
        const { client, challenge } = await ownerIn(down);
        down.answer = () => Promise.reject(new NodeRefused("node-unavailable"));
        expect(await send(client, switchFor(owner, challenge))).toBe(
          "unavailable",
        );
        const next = await client.waitFor(
          "mineState",
          (m) => m.challenge !== challenge,
        );
        nowMs += 2000;
        down.answer = () => Promise.reject(new NodeRefused("bad-threads"));
        expect(await send(client, switchFor(owner, next.challenge))).toBe(
          "bad-threads",
        );
      });

      it("every switch when the Land has no Node", async () => {
        await start();
        const { client } = await enter(handoff(owner));
        const state = await client.waitFor("mineState");
        expect(state.status).toBe("unavailable");
        expect(await send(client, switchFor(owner, state.challenge))).toBe(
          "unavailable",
        );
      });
    });
  });

  describe("the Land UI", () => {
    function get(
      path: string,
      method = "GET",
      headers: Record<string, string> = {},
    ) {
      return new Promise<{
        status: number;
        headers: Record<string, unknown>;
        body: string;
      }>((resolve, reject) => {
        const req = request(`${httpUrl}`, { method, path, headers }, (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body }),
          );
        });
        req.on("error", reject);
        req.end();
      });
    }

    it("serves index.html with no-cache and an ETag, and answers 304", async () => {
      await start();
      const res = await get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-cache");
      expect(res.body).toContain("<title>x</title>");
      const etag = res.headers.etag as string;
      expect(etag).toBeTruthy();
      const again = await get("/", "GET", { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(again.body).toBe("");
      const head = await get("/index.html", "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
    });

    it("serves hashed assets as immutable with the right type", async () => {
      await start();
      const js = await get("/assets/app-abc123.js");
      expect(js.headers["cache-control"]).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      const wasm = await get("/assets/z.wasm");
      expect(wasm.headers["content-type"]).toBe("application/wasm");
    });

    it("refuses traversal, dotfiles and directories", async () => {
      await start();
      const outside = `${uiDir.split("/").pop()}-outside.txt`;
      for (const path of [
        `/../${outside}`,
        `/%2e%2e/${outside}`,
        `/assets/..%2f..%2f${outside}`,
        `/assets/%2e%2e/%2e%2e/${outside}`,
        "/.secret",
        "/assets/",
        "/assets",
        "/missing.js",
        "/%00",
        "/%zz",
        "/..\\x",
      ]) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
        expect(res.body).not.toContain("outside");
        expect(res.body).not.toContain("dotfile");
      }
    });

    it("closes the file when the browser goes away mid-download", async () => {
      await start();
      const openFiles = () => readdirSync("/dev/fd").length;
      const before = openFiles();
      for (let i = 0; i < 10; i++)
        await new Promise<void>((resolve) => {
          const req = request(
            httpUrl,
            { path: "/assets/big-abc123.js" },
            (res) =>
              res.once("data", () => {
                req.destroy();
                resolve();
              }),
          );
          req.on("error", () => {});
          req.end();
        });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(openFiles()).toBeLessThanOrEqual(before + 2);
    });

    it("answers 405 to other methods", async () => {
      await start();
      const res = await get("/", "POST");
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    });

    it("answers 503 when the Land UI is not built", async () => {
      await start({ landUiDir: join(uiDir, "nope") });
      const res = await get("/");
      expect(res.status).toBe(503);
    });

    it("accepts a WebSocket upgrade only at /play", async () => {
      await start();
      const other = new Client(url.replace("/play", "/other"));
      await expect(other.opened()).rejects.toThrow(/404/);
    });
  });
});

/** Polls `check` for up to 3 seconds. */
async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
