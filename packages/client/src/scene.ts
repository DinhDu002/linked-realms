// The Land in Phaser. Thin glue: logic lives in tiles.ts, input.ts, interpolate.ts, players.ts,
// mine.ts.
import Phaser from "phaser";
import {
  CHARACTER_HALF_SIZE_PX,
  DIRECTIONS,
  gateOf,
  parseLandMap,
  type Direction,
  type LandMap,
} from "@linked-realms/shared";
import type { ServerMessage } from "@linked-realms/shared/land-protocol";
import { createInputDiffer, type PressedKeys } from "./input.ts";
import { approach } from "./interpolate.ts";
import {
  mineHudText,
  mineMotion,
  readMineState,
  readMineWon,
  rewardText,
  rewardsTo,
  winText,
  type MineView,
  type WinView,
} from "./mine.ts";
import {
  characterLabel,
  characterMarks,
  readCharacter,
  type CharacterState,
} from "./players.ts";
import { paintGround } from "./tiles.ts";

interface CharacterView {
  body: Phaser.GameObjects.Container;
  target: { x: number; y: number };
}

export interface SceneLink {
  /** Sends the walking direction (each of dx, dy in -1, 0, 1) with a growing seq. */
  send(dx: number, dy: number, seq: number): void;
  /** Called every frame with the Gate the Character stands on, by the server's position. */
  onGate(gate: Direction | undefined): void;
  hud(text: string): void;
  notice(text: string): void;
  onMapError(message: string): void;
  /** A valid MineState, whether this page's Character is the Land owner, and the Mine's HUD line. */
  mine(view: MineView, owner: boolean, line: string): void;
  /** The HUD line of a Block the Mine won. */
  won(line: string): void;
  /** The Character tapped the Mine. */
  onMineTap(): void;
}

interface MineArt {
  glow: Phaser.GameObjects.Arc;
  gear: Phaser.GameObjects.Graphics;
  /** The Mine's centre and size on the map. */
  x: number;
  y: number;
  size: number;
}

export class LandScene extends Phaser.Scene {
  private readonly characters = new Map<number, CharacterState>();
  private readonly views = new Map<number, CharacterView>();
  private readonly differ = createInputDiffer();
  private keys?: Record<string, Phaser.Input.Keyboard.Key>;
  private touch: PressedKeys = {
    up: false,
    down: false,
    left: false,
    right: false,
  };
  private pendingTiled?: string;
  private landId?: bigint;
  private selfId?: number;
  private map?: LandMap;
  private mapDrawn = false;
  private ready = false;
  private seq = 0;
  private following = false;
  private hudText = "";
  private owner = { address: "", name: "" };
  private mineView?: MineView;
  private mineArt?: MineArt;
  /** The running Mine's pulse and sparks, stopped on each change. */
  private motions: (Phaser.Tweens.Tween | Phaser.Time.TimerEvent)[] = [];
  private spin = 0;
  private readonly reducedMotion =
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
    false;

  private readonly link: SceneLink;

  constructor(link: SceneLink) {
    super("land");
    this.link = link;
  }

  /** The directions the touch pad holds; they add to the keys. */
  setTouch(keys: PressedKeys): void {
    this.touch = keys;
  }

  /** Applies one decoded message from the Map server. */
  handle(message: ServerMessage): void {
    const m = message.message;
    switch (m.case) {
      case "welcome": {
        this.selfId = m.value.you;
        this.landId = m.value.land?.landId;
        this.owner = {
          address: m.value.land?.owner ?? "",
          name: m.value.land?.ownerName ?? "",
        };
        this.characters.clear();
        for (const c of m.value.characters) this.addCharacter(c);
        this.pendingTiled = m.value.map;
        if (this.ready) this.drawMap();
        break;
      }
      case "joined":
        this.addCharacter(m.value);
        break;
      case "left":
        this.characters.delete(m.value.id);
        break;
      case "moved":
        for (const p of m.value.positions) {
          const c = this.characters.get(p.id);
          if (c && Number.isFinite(p.x) && Number.isFinite(p.y)) {
            c.x = p.x;
            c.y = p.y;
          }
        }
        break;
      case "notice":
        this.link.notice(m.value.text);
        break;
      case "mineState": {
        const view = readMineState(m.value);
        if (!view) break;
        this.mineView = view;
        this.animateMine();
        const self = this.characters.get(this.selfId ?? -1);
        const label = rewardsTo(view.rewardAddress, this.owner);
        this.link.mine(view, self?.isOwner === true, mineHudText(view, label));
        break;
      }
      case "mineWon": {
        const win = readMineWon(m.value);
        if (!win) break;
        this.link.won(winText(win));
        this.playWin(win);
        break;
      }
    }
  }

  private addCharacter(raw: unknown): void {
    const c = readCharacter(raw);
    if (c) this.characters.set(c.id, c);
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
      this.link.onMapError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    this.mapDrawn = true;
    this.map = map;
    const size = map.width * map.tileSize;
    this.textures.addCanvas("ground", paintGround(map));
    this.add.image(0, 0, "ground").setOrigin(0, 0).setDepth(0);

    this.drawMine(map);

    // Gates: stepping on one travels to the neighbouring Land.
    const g = this.add.graphics().setDepth(1);
    for (const d of DIRECTIONS) {
      const gate = map.gates[d];
      g.fillStyle(0x6fa8dc).fillRect(
        gate.tileX * map.tileSize,
        gate.tileY * map.tileSize,
        gate.width * map.tileSize,
        gate.height * map.tileSize,
      );
    }

    this.cameras.main.setBounds(0, 0, size, size);
  }

  /** The Mine in its own container: generated graphics, not assets. */
  private drawMine(map: LandMap): void {
    const mw = map.mine.width * map.tileSize;
    const mh = map.mine.height * map.tileSize;
    const x = map.mine.tileX * map.tileSize + mw / 2;
    const y = map.mine.tileY * map.tileSize + mh / 2;
    const glow = this.add.circle(0, 0, mw * 0.6, 0xf2c230).setAlpha(0);
    const base = this.add.graphics();
    base.fillStyle(0x4a3b2a).fillRect(-mw / 2, -mh / 2, mw, mh);
    base.fillStyle(0xf2c230).fillCircle(0, 0, mw / 4);
    base.lineStyle(3, 0x1e150c).strokeRect(-mw / 2, -mh / 2, mw, mh);
    // A gear over the coin while the Mine runs.
    const gear = this.add.graphics().setVisible(false);
    gear.fillStyle(0x1e150c);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      gear.fillCircle(
        Math.cos(a) * mw * 0.2,
        Math.sin(a) * mw * 0.2,
        mw * 0.05,
      );
    }
    gear.lineStyle(mw * 0.06, 0x1e150c).strokeCircle(0, 0, mw * 0.15);
    const tap = this.add
      .zone(0, 0, mw, mh)
      .setInteractive({ useHandCursor: true })
      .on("pointerdown", () => this.link.onMineTap());
    this.add.container(x, y, [glow, base, gear, tap]).setDepth(1);
    this.mineArt = { glow, gear, x, y, size: mw };
    this.animateMine();
  }

  /** Starts or stops the Mine's pulse, spin and sparks for the last MineState (P5). */
  private animateMine(): void {
    const art = this.mineArt;
    if (!art) return;
    for (const m of this.motions) m.destroy();
    this.motions = [];
    const motion = mineMotion(this.mineView);
    art.gear.setVisible(motion !== undefined);
    art.glow.setAlpha(0).setScale(1);
    // prefers-reduced-motion: no pulse, spin or sparks; the HUD line says it all.
    if (!motion || this.reducedMotion) return;
    art.glow.setAlpha(motion.glow * 0.3);
    this.motions.push(
      this.tweens.add({
        targets: art.glow,
        alpha: motion.glow,
        scale: 1.15,
        duration: motion.pulseMs / 2,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      }),
      this.time.addEvent({
        delay: 1000 / motion.sparksPerSecond,
        loop: true,
        callback: () => {
          const half = (art.size / 2) * 0.6;
          const x = art.x + Phaser.Math.Between(-half, half);
          this.spark(x, art.y, 0, -Phaser.Math.Between(24, 40));
        },
      }),
    );
  }

  /** One small gold spark from (x, y), moving by (dx, dy) as it fades. */
  private spark(x: number, y: number, dx: number, dy: number): void {
    const dot = this.add.rectangle(x, y, 3, 3, 0xffe066).setDepth(4);
    this.tweens.add({
      targets: dot,
      x: x + dx,
      y: y + dy,
      alpha: 0,
      duration: 900,
      onComplete: () => dot.destroy(),
    });
  }

  /** The win everyone in the Land sees: a ring, a burst and "+N GOLD" rising (decision 2). */
  private playWin(win: WinView): void {
    const art = this.mineArt;
    if (!art) return;
    const text = this.add
      .text(art.x, art.y, rewardText(win), {
        fontSize: "20px",
        fontStyle: "bold",
        color: "#f2c230",
        stroke: "#1e150c",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(10);
    this.tweens.add({
      targets: text,
      y: this.reducedMotion ? art.y : art.y - 48,
      alpha: 0,
      duration: 1600,
      onComplete: () => text.destroy(),
    });
    if (this.reducedMotion) return;
    const ring = this.add
      .circle(art.x, art.y, art.size / 2)
      .setStrokeStyle(3, 0xf2c230)
      .setDepth(4);
    this.tweens.add({
      targets: ring,
      scale: 4,
      alpha: 0,
      duration: 600,
      onComplete: () => ring.destroy(),
    });
    const reach = art.size * 1.2;
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      this.spark(art.x, art.y, Math.cos(a) * reach, Math.sin(a) * reach);
    }
  }

  update(_time: number, deltaMs: number): void {
    this.sendInput();
    const motion = mineMotion(this.mineView);
    if (motion && this.mineArt && !this.reducedMotion) {
      this.spin =
        (this.spin + (motion.spinDegPerSecond * deltaMs) / 1000) % 360;
      this.mineArt.gear.setAngle(this.spin);
    }
    this.syncViews();
    for (const [id, view] of this.views) {
      view.body.x = approach(view.body.x, view.target.x, deltaMs);
      view.body.y = approach(view.body.y, view.target.y, deltaMs);
      if (id === this.selfId) {
        if (!this.following) {
          this.following = true;
          this.cameras.main.startFollow(view.body, true, 0.15, 0.15);
        }
        // the server's position decides, not the interpolated sprite
        if (this.map) this.link.onGate(gateOf(this.map, view.target));
      }
    }
    const hud = `Land ${this.landId ?? "…"} · ${this.characters.size} Character(s)`;
    if (hud !== this.hudText) this.link.hud((this.hudText = hud));
  }

  private sendInput(): void {
    const k = this.keys;
    // Before welcome the socket may not be open yet: a key held now is sent once it is.
    if (this.selfId === undefined) return;
    const down = (...names: string[]) => names.some((n) => k?.[n]?.isDown);
    const t = this.touch;
    const input = this.differ.next({
      up: t.up || down("W", "UP"),
      down: t.down || down("S", "DOWN"),
      left: t.left || down("A", "LEFT"),
      right: t.right || down("D", "RIGHT"),
    });
    if (input)
      this.link.send(
        Number(input.right) - Number(input.left),
        Number(input.down) - Number(input.up),
        ++this.seq,
      );
  }

  /** Mirrors the Characters the server told us about into game objects. */
  private syncViews(): void {
    for (const [id, c] of this.characters) {
      const view = this.views.get(id);
      if (view) view.target = { x: c.x, y: c.y };
      else this.views.set(id, this.createView(c));
    }
    for (const [id, view] of this.views) {
      if (this.characters.has(id)) continue;
      view.body.destroy();
      this.views.delete(id);
    }
  }

  private createView(c: CharacterState): CharacterView {
    const own = c.id === this.selfId;
    const half = CHARACTER_HALF_SIZE_PX;
    const square = this.add
      .rectangle(0, 0, half * 2, half * 2, own ? 0xffffff : 0xc0504d)
      .setStrokeStyle(own ? 3 : 1, own ? 0xf2c230 : 0x000000);
    const text = (value: string, color: string, background: string) =>
      this.add
        .text(0, -half - 8, value, {
          fontSize: "12px",
          color,
          backgroundColor: background,
        })
        .setOrigin(0, 1);
    // The name, then badges in colours a name's plain text cannot take.
    const parts = [
      text(characterLabel(c), "#ffffff", "rgba(0,0,0,0.6)"),
      ...characterMarks(c).map((mark) =>
        mark === "ai"
          ? text("AI", "#ffffff", "#1f6feb")
          : text("★", "#000000", "#f2c230"),
      ),
    ];
    const gap = 3;
    let x =
      -(parts.reduce((w, p) => w + p.width, 0) + gap * (parts.length - 1)) / 2;
    for (const part of parts) {
      part.x = x;
      x += part.width + gap;
    }
    const body = this.add
      .container(c.x, c.y, [square, ...parts])
      .setDepth(own ? 3 : 2);
    return { body, target: { x: c.x, y: c.y } };
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
