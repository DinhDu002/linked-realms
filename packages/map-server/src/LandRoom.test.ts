import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import {
  HUB_EIP712_DOMAIN,
  LAND_ROOM,
  Messages,
  TRAVEL_TICKET_TTL_SECONDS,
  TravelTicketTypes,
  gateNumber,
  gateOf,
  gateSpawn,
  parseLandMap,
  spawnPosition,
  ticketToWire,
  type Direction,
  type JoinOptions,
} from "@linked-realms/shared";
import type { MinerStatus } from "@linked-realms/miner";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { clock, type LandRoom } from "./LandRoom.ts";
import { createServer } from "./server.ts";

const LAND_ID = 7;
const mapText = readFileSync(
  fileURLToPath(new URL("../../../maps/empty-land.json", import.meta.url)),
  "utf8",
);
const map = parseLandMap(mapText);
const spawn = spawnPosition(map);

const owner = privateKeyToAccount(generatePrivateKey());
const visitor = privateKeyToAccount(generatePrivateKey());

const hub = privateKeyToAccount(generatePrivateKey());
const forger = privateKeyToAccount(generatePrivateKey());
const CHAIN_ID = 31337;
const land = { owner: owner.address, x: 1, y: 0 };

const fakeStatus: MinerStatus = {
  on: false,
  threads: 1,
  hashRate: 0,
  round: 0n,
  submitted: 0,
  won: 0,
};
const mining = {
  start: vi.fn<(threads: number) => void>(),
  stop: vi.fn(async () => {}),
  status: vi.fn((): MinerStatus => fakeStatus),
};

type Account = typeof owner;

/** A Travel ticket for `account`, signed by `signer` (the Hub unless a test forges it). */
async function joinOptions(
  account: Account,
  {
    landId = LAND_ID,
    expiresIn = TRAVEL_TICKET_TTL_SECONDS,
    gate = 0,
    signer = hub,
    nonce = generatePrivateKey(), // any 32 random bytes
  } = {},
): Promise<JoinOptions> {
  const ticket = {
    player: account.address,
    landId: BigInt(landId),
    gate,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + expiresIn),
    nonce,
  };
  const signature = await signer.signTypedData({
    domain: HUB_EIP712_DOMAIN(CHAIN_ID),
    types: TravelTicketTypes,
    primaryType: "TravelTicket",
    message: ticket,
  });
  return { ticket: ticketToWire(ticket), signature };
}

const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("LandRoom", () => {
  let colyseus: ColyseusTestServer;

  // One server for the file: re-booting on the same port between tests is flaky.
  beforeAll(async () => {
    const server = createServer({
      landId: LAND_ID,
      map,
      mapText,
      land,
      hubSigner: hub.address,
      chainId: CHAIN_ID,
      mining,
    });
    colyseus = await boot(server);
  });
  afterEach(() => {
    mining.start.mockClear();
    mining.stop.mockClear();
    mining.status.mockImplementation(() => fakeStatus);
    return colyseus.cleanup();
  });
  afterAll(() => colyseus.shutdown());

  async function createRoom() {
    return colyseus.createRoom<LandRoom>(LAND_ROOM, {});
  }

  it("shows both players to both clients and marks only the Land owner", async () => {
    const room = await createRoom();
    const a = await colyseus.connectTo(room, await joinOptions(owner));
    const b = await colyseus.connectTo(room, await joinOptions(visitor));
    await idle(200); // let a patch reach both clients

    for (const client of [a, b]) {
      expect(client.state.landId).toBe(LAND_ID);
      expect(client.state.players.size).toBe(2);
      const mine = client.state.players.get(a.sessionId)!;
      const theirs = client.state.players.get(b.sessionId)!;
      expect(mine.address).toBe(owner.address);
      expect(mine.isOwner).toBe(true);
      expect(theirs.address).toBe(visitor.address);
      expect(theirs.isOwner).toBe(false);
      expect(mine.x).toBe(spawn.x);
      expect(mine.y).toBe(spawn.y);
    }
  });

  it("sends the map text and the Land info after joining", async () => {
    const room = await createRoom();
    const client = await colyseus.sdk.joinById(
      room.roomId,
      await joinOptions(visitor),
    );
    const mapMessage = new Promise<{ tiled: string }>((resolve) =>
      client.onMessage(Messages.map, resolve),
    );
    const landMessage = new Promise<unknown>((resolve) =>
      client.onMessage(Messages.land, resolve),
    );
    expect((await mapMessage).tiled).toBe(mapText);
    expect(await landMessage).toEqual({
      landId: LAND_ID,
      owner: owner.address,
      x: 1,
      y: 0,
    });
  });

  it("moves the player on the server and the Mine blocks it", async () => {
    const room = await createRoom();
    const client = await colyseus.connectTo(room, await joinOptions(owner));
    client.send(Messages.input, {
      up: false,
      down: false,
      left: false,
      right: true,
    });
    await idle(300);
    const player = room.state.players.get(client.sessionId)!;
    expect(player.x).toBeGreaterThan(spawn.x);
    expect(player.y).toBe(spawn.y);

    client.send(Messages.input, {
      up: true,
      down: false,
      left: false,
      right: false,
    });
    await idle(1500);
    const mineBottom = (map.mine.tileY + map.mine.height) * map.tileSize;
    expect(player.y).toBeLessThan(spawn.y);
    expect(player.y).toBeGreaterThanOrEqual(mineBottom);
    const blockedAt = player.y;
    await idle(300);
    expect(player.y).toBe(blockedAt);
  });

  it("ignores invalid input", async () => {
    const room = await createRoom();
    const client = await colyseus.connectTo(room, await joinOptions(owner));
    client.send(Messages.input, { up: "yes", down: 1 });
    client.send(Messages.input, "right");
    await idle(300);
    const player = room.state.players.get(client.sessionId)!;
    expect(player.x).toBe(spawn.x);
    expect(player.y).toBe(spawn.y);
  });

  it("drops input beyond the per-second limit", async () => {
    const room = await createRoom();
    // Frozen clock: all sends fall in one window, so the test cannot straddle a boundary.
    const real = clock.now;
    const frozen = Date.now();
    clock.now = () => frozen;
    onTestFinished(() => {
      clock.now = real;
    });
    const client = await colyseus.connectTo(room, await joinOptions(owner));
    const stop = { up: false, down: false, left: false, right: false };
    for (let i = 0; i < 30; i++) client.send(Messages.input, stop);
    client.send(Messages.input, { ...stop, right: true });
    await idle(300);
    expect(room.state.players.get(client.sessionId)!.x).toBe(spawn.x);
  });

  it.each(["north", "east", "south", "west"] as Direction[])(
    "spawns a Player arriving at the %s Gate one tile inside it",
    async (direction) => {
      const room = await createRoom();
      const client = await colyseus.connectTo(
        room,
        await joinOptions(visitor, { gate: gateNumber(direction) }),
      );
      const player = room.state.players.get(client.sessionId)!;
      const expected = gateSpawn(map, direction);
      expect({ x: player.x, y: player.y }).toEqual(expected);
      expect(gateOf(map, expected)).toBeUndefined(); // not on the Gate: no instant bounce back
    },
  );

  it("ignores a client-supplied clock option", async () => {
    const client = await colyseus.sdk.create(LAND_ROOM, {
      ...(await joinOptions(owner)),
      now: 1,
    });
    expect(client.sessionId).toBeTruthy();
  });

  it("refuses a second room", async () => {
    await createRoom();
    // Valid join options, so only the room limit can be the reason.
    await expect(
      colyseus.sdk.create(LAND_ROOM, await joinOptions(owner)),
    ).rejects.toThrow(); // Colyseus masks the onCreate error text
  });

  it("removes the player on leave", async () => {
    const room = await createRoom();
    const client = await colyseus.connectTo(room, await joinOptions(owner));
    expect(room.state.players.size).toBe(1);
    await client.leave();
    await idle(100);
    expect(room.state.players.size).toBe(0);
  });

  describe("rejects", () => {
    async function rejected(options: unknown) {
      const room = await createRoom();
      const error = await colyseus.connectTo(room, options).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeDefined();
      expect(room.state.players.size).toBe(0);
      return error!;
    }

    it("a ticket not signed by the Hub", async () => {
      const error = await rejected(
        await joinOptions(owner, { signer: forger }),
      );
      expect(error.message).toMatch(/not signed by the Hub/);
    });

    it("a ticket whose fields were changed after signing", async () => {
      const good = await joinOptions(owner);
      const error = await rejected({
        ...good,
        ticket: { ...good.ticket, gate: 2 },
      });
      expect(error.message).toMatch(/not signed by the Hub/);
    });

    it("a ticket for another Land", async () => {
      const error = await rejected(await joinOptions(owner, { landId: 8 }));
      expect(error.message).toMatch(/another Land/);
    });

    it("an expired ticket", async () => {
      const error = await rejected(
        await joinOptions(owner, { expiresIn: -10 }),
      );
      expect(error.message).toMatch(/expired/);
    });

    it("a ticket that expires too far ahead", async () => {
      await rejected(
        await joinOptions(owner, {
          expiresIn: TRAVEL_TICKET_TTL_SECONDS + 100,
        }),
      );
    });

    it("a reused ticket", async () => {
      const options = await joinOptions(owner);
      const room = await createRoom();
      await colyseus.connectTo(room, options);
      const error = await colyseus.connectTo(room, options).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/already used/);
      expect(room.state.players.size).toBe(1);
    });

    it("a malformed ticket or signature", async () => {
      const good = await joinOptions(owner);
      for (const bad of [
        { ...good, ticket: { ...good.ticket, player: "0x1234" } },
        { ...good, ticket: { ...good.ticket, gate: 9 } },
        { ...good, ticket: { ...good.ticket, expiresAt: "-1" } },
        { ...good, ticket: { ...good.ticket, nonce: "0x01" } },
        { ...good, ticket: "ticket" },
        { ...good, signature: "0x1234" },
        { ticket: good.ticket },
      ]) {
        const error = await rejected(bad);
        expect(error.message).toMatch(/malformed/);
        expect(error.stack ?? "").not.toMatch(/LandRoom\.ts/);
      }
    });

    it("missing join options", async () => {
      await rejected({});
    });

    it("a second session for the same address", async () => {
      const room = await createRoom();
      await colyseus.connectTo(room, await joinOptions(owner));
      const error = await colyseus
        .connectTo(room, await joinOptions(owner))
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(error?.message).toMatch(/already in this Land/);
      expect(room.state.players.size).toBe(1);
    });

    it("two simultaneous sessions for the same address", async () => {
      const room = await createRoom();
      const results = await Promise.allSettled([
        colyseus.connectTo(room, await joinOptions(owner)),
        colyseus.connectTo(room, await joinOptions(owner)),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(room.state.players.size).toBe(1);
    });
  });

  describe("mining", () => {
    it("ignores a switch from anyone but the Land owner", async () => {
      const room = await createRoom();
      const client = await colyseus.connectTo(room, await joinOptions(visitor));
      client.send(Messages.mining, { on: true, threads: 2 });
      client.send(Messages.mining, { on: false, threads: 2 });
      await idle(200);
      expect(mining.start).not.toHaveBeenCalled();
      expect(mining.stop).not.toHaveBeenCalled();
    });

    it("starts and stops mining for the Land owner", async () => {
      const room = await createRoom();
      const client = await colyseus.connectTo(room, await joinOptions(owner));
      client.send(Messages.mining, { on: true, threads: 2 });
      await idle(200);
      expect(mining.start).toHaveBeenCalledExactlyOnceWith(2);
      client.send(Messages.mining, { on: false, threads: 2 });
      await idle(200);
      expect(mining.stop).toHaveBeenCalledOnce();
    });

    it("survives a failing stop", async () => {
      mining.stop.mockRejectedValueOnce(new Error("boom"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      onTestFinished(() => error.mockRestore());
      const room = await createRoom();
      const client = await colyseus.connectTo(room, await joinOptions(owner));
      client.send(Messages.mining, { on: false, threads: 1 });
      await idle(200);
      expect(error).toHaveBeenCalledOnce();
    });

    it("ignores malformed messages", async () => {
      const room = await createRoom();
      const client = await colyseus.connectTo(room, await joinOptions(owner));
      for (const bad of [
        null,
        "on",
        {},
        { on: "yes", threads: 1 },
        { on: true, threads: 0 },
        { on: true, threads: 1.5 },
        { on: true },
      ])
        client.send(Messages.mining, bad);
      await idle(200);
      expect(mining.start).not.toHaveBeenCalled();
      expect(mining.stop).not.toHaveBeenCalled();
    });

    it("mirrors the miner status in the room state", async () => {
      mining.status.mockImplementation(() => ({
        on: true,
        threads: 3,
        hashRate: 1234.5,
        round: 42n,
        submitted: 5,
        won: 4,
      }));
      const room = await createRoom();
      const client = await colyseus.connectTo(room, await joinOptions(visitor));
      await idle(800); // one refresh (500 ms) plus a patch
      expect(client.state.mining.toJSON()).toEqual({
        on: true,
        threads: 3,
        hashRate: 1234.5,
        round: 42,
        submitted: 5,
        won: 4,
      });
    });

    it("counts mining messages toward the rate limit", async () => {
      const room = await createRoom();
      const real = clock.now;
      const frozen = Date.now();
      clock.now = () => frozen;
      onTestFinished(() => {
        clock.now = real;
      });
      const client = await colyseus.connectTo(room, await joinOptions(owner));
      const stop = { up: false, down: false, left: false, right: false };
      for (let i = 0; i < 30; i++) client.send(Messages.input, stop);
      client.send(Messages.mining, { on: true, threads: 1 });
      await idle(300);
      expect(mining.start).not.toHaveBeenCalled();
    });
  });
});
