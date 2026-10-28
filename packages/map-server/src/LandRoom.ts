import { Room, ServerError, type Client } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";
import {
  Messages,
  SERVER_TICK_HZ,
  parseInputMessage,
  parseMiningMessage,
  spawnPosition,
  step,
  verifyJoinRequest,
  JoinRejected,
  type LandMap,
  type LandMessage,
  type MapMessage,
  type MoveInput,
} from "@linked-realms/shared";
import type { Miner } from "@linked-realms/miner";
import type { Address } from "viem";
import type { Chain, LandInfo } from "./chain.ts";

// Field names match PlayerStateShape in shared/src/protocol.ts.
export const PlayerState = schema(
  {
    address: t.string(),
    x: t.float32(),
    y: t.float32(),
    isOwner: t.boolean(),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

// Field names match MiningStateShape in shared/src/protocol.ts.
export const MiningState = schema(
  {
    on: t.boolean(),
    threads: t.uint16(),
    hashRate: t.float64(),
    round: t.float64(),
    submitted: t.uint32(),
    won: t.uint32(),
  },
  "MiningState",
);
export type MiningState = SchemaType<typeof MiningState>;

export const LandState = schema(
  {
    landId: t.uint32(),
    players: t.map(PlayerState),
    mining: t.ref(MiningState),
  },
  "LandState",
);
export type LandState = SchemaType<typeof LandState>;

export interface LandRoomOptions {
  landId: number;
  /** The validated map and the text it was parsed from (sent to clients as is). */
  map: LandMap;
  mapText: string;
  /** Read once at start-up: a Land is soulbound, so its owner never changes. */
  land: LandInfo;
  chain: Chain;
  /** Lives as long as the process, not the room: mining goes on while the Land is empty. */
  mining: Pick<Miner, "start" | "stop" | "status">;
}

// Tests replace the clock here. It is not a room option: options are shallow-merged with
// client-supplied ones, so anything optional there could be set by an anonymous client.
export const clock = { now: (): number => Date.now() };

// Rooms are created before onAuth runs, so any client could otherwise open extra rooms:
// unauthenticated resource use, and the same address in two rooms. One Land = one room.
const liveRooms = new Set<unknown>();

const MINING_REFRESH_MS = 500;

// Input and mining messages share one per-session budget.
export const MAX_INPUTS_PER_SECOND = 30;
const NO_INPUT: MoveInput = {
  up: false,
  down: false,
  left: false,
  right: false,
};

interface Session {
  input: MoveInput;
  windowStart: number;
  windowCount: number;
}

export class LandRoom extends Room<{ state: LandState }> {
  override maxClients = 64;
  #options!: LandRoomOptions;
  #sessions = new Map<string, Session>();

  override onCreate(options: LandRoomOptions): void {
    if (liveRooms.size > 0) throw new ServerError(4403, "room already exists");
    liveRooms.add(this);
    this.#options = options;
    this.state = new LandState();
    this.state.landId = options.landId;
    this.state.mining = new MiningState();
    this.#refreshMining();
    this.onMessage(Messages.input, (client, message) =>
      this.#onInput(client, message),
    );
    this.onMessage(Messages.mining, (client, message) =>
      this.#onMining(client, message),
    );
    this.setSimulationInterval(
      (dtMs) => this.#tick(dtMs),
      1000 / SERVER_TICK_HZ,
    );
    this.clock.setInterval(() => this.#refreshMining(), MINING_REFRESH_MS);
  }

  override async onAuth(
    _client: Client,
    joinOptions: { message?: unknown; signature?: unknown },
  ): Promise<Address> {
    const { landId, chain } = this.#options;
    try {
      const signer = await verifyJoinRequest({
        message: joinOptions?.message,
        signature: joinOptions?.signature,
        landId,
        nowSeconds: Math.floor(clock.now() / 1000),
      });
      if (!(await chain.hasCharacter(signer)))
        throw new JoinRejected("wallet has no Character");
      if (this.#playerOf(signer))
        throw new JoinRejected("already in this Land");
      return signer;
    } catch (error) {
      // Never leak stack traces or RPC details to an untrusted client.
      if (error instanceof JoinRejected)
        throw new ServerError(4401, error.message);
      console.error("join check failed:", error);
      throw new ServerError(4500, "could not verify the join request");
    }
  }

  override onJoin(client: Client): void {
    const signer = client.auth as Address;
    // Re-checked here because two onAuth calls for one address can interleave.
    if (this.#playerOf(signer))
      throw new ServerError(4401, "already in this Land");
    const { map, mapText, land, landId } = this.#options;
    const spawn = spawnPosition(map);
    const player = new PlayerState();
    player.address = signer;
    player.x = spawn.x;
    player.y = spawn.y;
    player.isOwner = signer.toLowerCase() === land.owner.toLowerCase();
    this.state.players.set(client.sessionId, player);
    this.#sessions.set(client.sessionId, {
      input: NO_INPUT,
      windowStart: 0,
      windowCount: 0,
    });
    client.send(Messages.map, { tiled: mapText } satisfies MapMessage);
    client.send(Messages.land, {
      landId,
      owner: land.owner,
      x: land.x,
      y: land.y,
    } satisfies LandMessage);
  }

  override onDispose(): void {
    liveRooms.delete(this);
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    this.#sessions.delete(client.sessionId);
  }

  #playerOf(address: string): PlayerState | undefined {
    const lower = address.toLowerCase();
    for (const player of this.state.players.values())
      if (player.address.toLowerCase() === lower) return player;
    return undefined;
  }

  /** Counts the message against the session's budget; undefined when it is over. */
  #admit(client: Client): Session | undefined {
    const session = this.#sessions.get(client.sessionId);
    if (!session) return undefined;
    const nowMs = clock.now();
    if (nowMs - session.windowStart >= 1000) {
      session.windowStart = nowMs;
      session.windowCount = 0;
    }
    return ++session.windowCount > MAX_INPUTS_PER_SECOND ? undefined : session;
  }

  #onInput(client: Client, message: unknown): void {
    const session = this.#admit(client);
    if (!session) return;
    const input = parseInputMessage(message);
    if (input) session.input = input;
  }

  #onMining(client: Client, message: unknown): void {
    // Only the Land owner may switch mining (P5); everyone else is ignored silently.
    if (!this.state.players.get(client.sessionId)?.isOwner) return;
    if (!this.#admit(client)) return;
    const request = parseMiningMessage(message);
    if (!request) return;
    const { mining } = this.#options;
    if (request.on) mining.start(request.threads);
    else
      mining.stop().catch((error: unknown) => {
        console.error("could not stop mining:", error);
      });
  }

  #refreshMining(): void {
    const status = this.#options.mining.status();
    const state = this.state.mining;
    state.on = status.on;
    state.threads = status.threads;
    state.hashRate = status.hashRate;
    state.round = Number(status.round);
    state.submitted = status.submitted;
    state.won = status.won;
  }

  #tick(dtMs: number): void {
    const { map } = this.#options;
    for (const [sessionId, player] of this.state.players) {
      const input = this.#sessions.get(sessionId)?.input ?? NO_INPUT;
      const next = step(map, { x: player.x, y: player.y }, input, dtMs);
      player.x = next.x;
      player.y = next.y;
    }
  }
}
