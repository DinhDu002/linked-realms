import { Client, type Room } from "@colyseus/sdk";
import {
  joinMessage,
  LAND_ROOM,
  Messages,
  type JoinOptions,
  type LandMessage,
  type MapMessage,
  type MiningMessage,
} from "@linked-realms/shared";
import type { Game } from "phaser";
import { createCharacter, hasCharacter, loadCharacter } from "./character.ts";
import { DEV_CHAIN_ID, parseConfig } from "./config.ts";
import { formatGold, statRows } from "./format.ts";
import { goldBalance, roundsWon } from "./gold.ts";
import { miningLabel } from "./mining.ts";
import { LandScene, startGame } from "./scene.ts";
import {
  connectDev,
  connectInjected,
  createReader,
  hasInjectedWallet,
  type Wallet,
} from "./wallet.ts";

const config = parseConfig(import.meta.env);
const reader = createReader(config);

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}
const walletEl = el("wallet");
const actionsEl = el("actions");
const characterEl = el("character");
const statusEl = el("status");
const errorEl = el("error");
const hudEl = el("hud");
const hudLandEl = el("hud-land");
const hudMineEl = el("hud-mine");
const mineControlsEl = el("mine-controls");
const mineToggleEl = el("mine-toggle") as HTMLButtonElement;
const mineThreadsEl = el("mine-threads") as HTMLInputElement;
const ROUNDS_SHOWN = 10;
const GOLD_REFRESH_MIN_MS = 5000;

let wallet: Wallet | undefined;
let room: Room | undefined;
let game: Game | undefined;
let goldEl: HTMLElement | undefined;
let lastWon: number | undefined;
let goldTimer: ReturnType<typeof setTimeout> | undefined;
let goldAt = 0;
let miningOn = false;

/** Everything shown to the user goes through textContent, never innerHTML. */
function button(
  label: string,
  onClick: () => Promise<void>,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => void run(b, onClick));
  return b;
}

function showError(error: unknown) {
  errorEl.textContent = error instanceof Error ? error.message : String(error);
}

async function run(b: HTMLButtonElement, task: () => Promise<void>) {
  b.disabled = true;
  errorEl.textContent = "";
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    statusEl.textContent = "";
    b.disabled = false;
  }
}

function showConnectButtons() {
  actionsEl.replaceChildren();
  if (hasInjectedWallet())
    actionsEl.append(
      button("Connect browser wallet", () => connect(connectInjected)),
    );
  if (config.chainId === DEV_CHAIN_ID)
    actionsEl.append(button("Use dev wallet", () => connect(connectDev)));
  if (actionsEl.childElementCount === 0)
    errorEl.textContent = "No browser wallet found.";
}

async function connect(open: (c: typeof config) => Promise<Wallet>) {
  statusEl.textContent = "Connecting…";
  wallet = await open(config);
  walletEl.textContent = `${wallet.label}: ${wallet.address}`;
  await refresh();
}

async function refresh() {
  if (!wallet) return;
  const player = wallet.address;
  actionsEl.replaceChildren();
  characterEl.replaceChildren();
  statusEl.textContent = "Reading chain…";
  if (!(await hasCharacter(reader, config.chainId, player))) {
    actionsEl.append(
      button("Create Character", async () => {
        if (!wallet) return;
        statusEl.textContent =
          "Creating Character (waiting for the transaction)…";
        await createCharacter(reader, config.chainId, wallet);
        await refresh();
      }),
    );
    characterEl.textContent = "No Character yet.";
    return;
  }
  const view = await loadCharacter(reader, config.chainId, player);
  const table = document.createElement("table");
  for (const [key, value] of statRows(view.stats)) {
    const row = table.insertRow();
    row.insertCell().textContent = key;
    row.insertCell().textContent = value;
  }
  const land = document.createElement("p");
  land.textContent = `Your Land: ${view.landId} at (${view.x}, ${view.y})`;
  goldEl = document.createElement("div");
  characterEl.append(table, land, goldEl);
  // a failing log query must not hide the Enter button
  await refreshGold().catch(showError);
  actionsEl.append(button(`Enter Land ${config.landId}`, enterLand));
}

/** The GOLD balance and the last Rounds won, read from the chain. */
async function refreshGold() {
  const target = goldEl;
  if (!wallet || !target) return;
  const player = wallet.address;
  const [balance, rounds] = await Promise.all([
    goldBalance(reader, config.chainId, player),
    roundsWon(reader, config.chainId, player),
  ]);
  if (target !== goldEl) return; // the panel was rebuilt meanwhile
  const balanceEl = document.createElement("p");
  balanceEl.textContent = `Balance: ${formatGold(balance)}`;
  const heading = document.createElement("p");
  heading.textContent = `Rounds won: ${rounds.length}`;
  const table = document.createElement("table");
  const head = table.insertRow();
  for (const title of ["Round", "Reward", "Block"])
    head.insertCell().textContent = title;
  for (const r of rounds.slice(0, ROUNDS_SHOWN)) {
    const row = table.insertRow();
    row.insertCell().textContent = r.round.toString();
    row.insertCell().textContent = formatGold(r.reward);
    row.insertCell().textContent = r.blockNumber.toString();
  }
  target.replaceChildren(
    balanceEl,
    heading,
    ...(rounds.length > 0 ? [table] : []),
    button("Refresh GOLD", refreshGold),
  );
}

/** The room state is untrusted: a Map server flipping `won` must not make us hit the RPC more than once per interval. */
function scheduleGoldRefresh() {
  if (goldTimer) return;
  const wait = Math.max(0, goldAt + GOLD_REFRESH_MIN_MS - Date.now());
  goldTimer = setTimeout(() => {
    goldTimer = undefined;
    goldAt = Date.now();
    void refreshGold().catch(showError);
  }, wait);
}

mineToggleEl.addEventListener("click", () => {
  const n = Math.floor(Number(mineThreadsEl.value));
  // 256 is the protocol maximum (parseMiningMessage); the server clamps further
  const threads = Number.isFinite(n) ? Math.min(256, Math.max(1, n)) : 1;
  const message: MiningMessage = { on: !miningOn, threads };
  room?.send(Messages.mining, message);
});

async function enterLand() {
  if (!wallet || room) return;
  statusEl.textContent = "Sign the join message in your wallet…";
  const message = joinMessage(
    config.landId,
    Math.floor(Date.now() / 1000) + 120,
  );
  const signature = await wallet.client.signMessage({
    account: wallet.account,
    message,
  });
  statusEl.textContent = "Joining…";
  const options: JoinOptions = { message, signature };
  const joined = await new Client(config.mapServerUrl).joinOrCreate(
    LAND_ROOM,
    options,
  );
  const scene = new LandScene(
    joined,
    (text) => {
      hudLandEl.textContent = text;
    },
    (mining, isOwner) => {
      hudMineEl.textContent = miningLabel(mining);
      miningOn = mining?.on === true;
      mineControlsEl.hidden = !isOwner || !mining;
      mineToggleEl.textContent = miningOn
        ? "Turn mining off"
        : "Turn mining on";
      if (mining?.on && document.activeElement !== mineThreadsEl)
        mineThreadsEl.value = String(mining.threads);
      if (mining && mining.won !== lastWon) {
        lastWon = mining.won;
        scheduleGoldRefresh();
      }
    },
    (reason) => {
      errorEl.textContent = `Map rejected: ${reason}`;
    },
  );
  joined.onMessage(Messages.map, (m: MapMessage) => scene.setMap(m.tiled));
  joined.onMessage(Messages.land, (m: LandMessage) => scene.setLand(m));
  joined.onLeave(() => {
    errorEl.textContent = "Left the Land.";
    game?.destroy(true);
    game = undefined;
    hudEl.hidden = true;
    lastWon = undefined;
    room = undefined;
    void refresh();
  });
  room = joined;
  hudEl.hidden = false;
  game = startGame(el("game"), scene);
  actionsEl.replaceChildren();
}

showConnectButtons();
