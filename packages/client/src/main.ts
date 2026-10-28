import { Client, type Room } from "@colyseus/sdk";
import {
  joinMessage,
  LAND_ROOM,
  Messages,
  type JoinOptions,
  type LandMessage,
  type MapMessage,
} from "@linked-realms/shared";
import type { Game } from "phaser";
import { createCharacter, hasCharacter, loadCharacter } from "./character.ts";
import { DEV_CHAIN_ID, parseConfig } from "./config.ts";
import { statRows } from "./format.ts";
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

let wallet: Wallet | undefined;
let room: Room | undefined;
let game: Game | undefined;

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

async function run(b: HTMLButtonElement, task: () => Promise<void>) {
  b.disabled = true;
  errorEl.textContent = "";
  try {
    await task();
  } catch (error) {
    errorEl.textContent =
      error instanceof Error ? error.message : String(error);
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
  characterEl.append(table, land);
  actionsEl.append(button(`Enter Land ${config.landId}`, enterLand));
}

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
      hudEl.textContent = text;
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
    room = undefined;
    void refresh();
  });
  room = joined;
  hudEl.hidden = false;
  game = startGame(el("game"), scene);
  actionsEl.replaceChildren();
}

showConnectButtons();
