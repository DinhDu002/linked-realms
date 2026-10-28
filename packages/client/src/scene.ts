// The Land in Phaser. Thin glue: logic lives in tiles.ts, input.ts, interpolate.ts, format.ts.
import Phaser from "phaser";
import {
  CHARACTER_HALF_SIZE_PX,
  Messages,
  parseLandMap,
  type LandMap,
  type LandMessage,
  type MiningStateShape,
  type PlayerStateShape,
} from "@linked-realms/shared";
import type { Room } from "@colyseus/sdk";
import { shortAddress } from "./format.ts";
import { createInputDiffer } from "./input.ts";
import { approach } from "./interpolate.ts";
import { readMining } from "./mining.ts";
import { readPlayer } from "./players.ts";
import { paintGround } from "./tiles.ts";

interface PlayerView {
  body: Phaser.GameObjects.Container;
  target: { x: number; y: number };
}

export class LandScene extends Phaser.Scene {
  private readonly players = new Map<string, PlayerView>();
  private readonly differ = createInputDiffer();
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;
  private pendingTiled?: string;
  private land?: LandMessage;
  private mapDrawn = false;
  private ready = false;

  private readonly room: Room;
  private readonly hud: (text: string) => void;
  private readonly onMapError: (message: string) => void;
  private following = false;
  private hudText = "";
  private miningKey = "";
  private readonly onMining: (
    mining: MiningStateShape | undefined,
    isOwner: boolean,
  ) => void;

  constructor(
    room: Room,
    hud: (text: string) => void,
    onMining: (mining: MiningStateShape | undefined, isOwner: boolean) => void,
    onMapError: (message: string) => void,
  ) {
    super("land");
    this.room = room;
    this.hud = hud;
    this.onMining = onMining;
    this.onMapError = onMapError;
  }

  /** Called with the Messages.map payload. */
  setMap(tiled: string): void {
    this.pendingTiled = tiled;
    if (this.ready) this.drawMap();
  }

  setLand(land: LandMessage): void {
    this.land = land;
  }

  create(): void {
    this.keys = this.input.keyboard?.addKeys(
      "W,A,S,D,UP,DOWN,LEFT,RIGHT",
    ) as Record<string, Phaser.Input.Keyboard.Key>;
    this.ready = true;
    if (this.pendingTiled !== undefined) this.drawMap();
  }

  private drawMap(): void {
    if (this.mapDrawn || this.pendingTiled === undefined) return;
    let map: LandMap;
    try {
      // P6: never render a map that has not been validated.
      map = parseLandMap(this.pendingTiled);
    } catch (error) {
      this.onMapError(error instanceof Error ? error.message : String(error));
      void this.room.leave();
      return;
    }
    this.mapDrawn = true;
    const size = map.width * map.tileSize;
    this.textures.addCanvas("ground", paintGround(map));
    this.add.image(0, 0, "ground").setOrigin(0, 0).setDepth(0);

    // The Mine: a generated graphic, not an asset.
    const mine = map.mine;
    const g = this.add.graphics().setDepth(1);
    const mx = mine.tileX * map.tileSize;
    const my = mine.tileY * map.tileSize;
    const mw = mine.width * map.tileSize;
    const mh = mine.height * map.tileSize;
    g.fillStyle(0x4a3b2a).fillRect(mx, my, mw, mh);
    g.fillStyle(0xf2c230).fillCircle(mx + mw / 2, my + mh / 2, mw / 4);
    g.lineStyle(3, 0x1e150c).strokeRect(mx, my, mw, mh);

    this.cameras.main.setBounds(0, 0, size, size);
  }

  update(_time: number, deltaMs: number): void {
    this.sendInput();
    this.syncPlayers();
    for (const [id, view] of this.players) {
      view.body.x = approach(view.body.x, view.target.x, deltaMs);
      view.body.y = approach(view.body.y, view.target.y, deltaMs);
      if (id === this.room.sessionId && !this.following) {
        this.following = true;
        this.cameras.main.startFollow(view.body, true, 0.15, 0.15);
      }
    }
    const coords = this.land ? ` (${this.land.x}, ${this.land.y})` : "";
    const hud = `Land ${this.land?.landId ?? "…"}${coords} · ${this.players.size} player(s)`;
    if (hud !== this.hudText) this.hud((this.hudText = hud));
  }

  private sendInput(): void {
    const k = this.keys;
    if (!k) return;
    const down = (...names: string[]) => names.some((n) => k[n]?.isDown);
    const input = this.differ.next({
      up: down("W", "UP"),
      down: down("S", "DOWN"),
      left: down("A", "LEFT"),
      right: down("D", "RIGHT"),
    });
    if (input) this.room.send(Messages.input, input);
  }

  /** Mirrors room.state.players into game objects (polled; the state is tiny). */
  private syncPlayers(): void {
    const state = this.room.state as
      { players?: Map<string, unknown>; mining?: unknown } | undefined;
    const seen = new Set<string>();
    let isOwner = false;
    state?.players?.forEach((raw, id) => {
      const p = readPlayer(raw);
      if (!p) return;
      seen.add(id);
      if (id === this.room.sessionId) isOwner = p.isOwner;
      const view = this.players.get(id);
      if (view) {
        view.target = { x: p.x, y: p.y };
      } else {
        this.players.set(id, this.createPlayer(id, p));
      }
    });
    for (const [id, view] of this.players) {
      if (seen.has(id)) continue;
      view.body.destroy();
      this.players.delete(id);
    }
    this.syncMining(state, isOwner);
  }

  /** Polled like players; the UI is told only when something changed. */
  private syncMining(state: object | undefined, isOwner: boolean): void {
    const mining = readMining(
      (state as { mining?: unknown } | undefined)?.mining,
    );
    const key = JSON.stringify([mining, isOwner]);
    if (key === this.miningKey) return;
    this.miningKey = key;
    this.onMining(mining, isOwner);
  }

  private createPlayer(id: string, p: PlayerStateShape): PlayerView {
    const own = id === this.room.sessionId;
    const half = CHARACTER_HALF_SIZE_PX;
    const square = this.add
      .rectangle(0, 0, half * 2, half * 2, own ? 0xffffff : 0xc0504d)
      .setStrokeStyle(own ? 3 : 1, own ? 0xf2c230 : 0x000000);
    const label = this.add
      .text(0, -half - 8, own ? "you" : shortAddress(p.address), {
        fontSize: "12px",
        color: "#ffffff",
        backgroundColor: "rgba(0,0,0,0.6)",
      })
      .setOrigin(0.5, 1);
    const body = this.add
      .container(p.x, p.y, [square, label])
      .setDepth(own ? 3 : 2);
    return { body, target: { x: p.x, y: p.y } };
  }
}

export function startGame(parent: HTMLElement, scene: LandScene): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#111111",
    scale: { mode: Phaser.Scale.RESIZE, width: "100%", height: "100%" },
    scene,
  });
}
