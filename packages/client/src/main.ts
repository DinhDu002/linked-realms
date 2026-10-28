import { Client, type Room } from "@colyseus/sdk";
import {
  LAND_ROOM,
  Messages,
  relayLandUrl,
  type Direction,
  type Directory,
  type JoinOptions,
  type LandMessage,
  type MapMessage,
  type MiningMessage,
} from "@linked-realms/shared";
import type { Game } from "phaser";
import { getAddress } from "viem";
import { createCharacter, hasCharacter, loadCharacter } from "./character.ts";
import { DEV_CHAIN_ID, parseConfig } from "./config.ts";
import { formatGold, statRows } from "./format.ts";
import { createGateEdge, decideGate } from "./gate.ts";
import { goldBalance, roundsWon } from "./gold.ts";
import {
  createHub,
  ownerMayRegister,
  REPORT_REASON_MAX,
  signDelegation,
} from "./hub.ts";
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
const hub = createHub({
  baseUrl: config.hubUrl,
  chainId: config.chainId,
  domain: window.location.host,
  uri: window.location.origin,
});

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}
const walletEl = el("wallet");
const actionsEl = el("actions");
const characterEl = el("character");
const directoryEl = el("directory");
const statusEl = el("status");
const errorEl = el("error");
const hudEl = el("hud");
const hudLandEl = el("hud-land");
const hudMineEl = el("hud-mine");
const mineControlsEl = el("mine-controls");
const mineToggleEl = el("mine-toggle") as HTMLButtonElement;
const mineThreadsEl = el("mine-threads") as HTMLInputElement;
const noticeEl = el("hud-notice");
const registerEl = el("register") as HTMLButtonElement;
const registerResultEl = el("register-result");
const reportReasonEl = el("report-reason") as HTMLInputElement;
const reportEl = el("report") as HTMLButtonElement;
const reportResultEl = el("report-result");
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
let directory: Directory | undefined;
let ownLandId: number | undefined;
let currentLandId: number | undefined;
let travelling = false;

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
  await signIn().catch(showError);
  await refresh();
}

async function signIn() {
  const w = wallet;
  if (!w) return;
  statusEl.textContent = "Sign in to the Hub in your wallet…";
  await hub.signIn(w.address, (message) =>
    w.client.signMessage({ account: w.account, message }),
  );
}

async function loadDirectory() {
  directory = await hub.directory();
  return directory;
}

async function refresh() {
  if (!wallet) return;
  const player = wallet.address;
  actionsEl.replaceChildren();
  characterEl.replaceChildren();
  directoryEl.replaceChildren();
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
  ownLandId = Number(view.landId);
  const land = document.createElement("p");
  land.textContent = `Your Land: ${view.landId} at (${view.x}, ${view.y})`;
  goldEl = document.createElement("div");
  characterEl.append(table, land, goldEl);
  // a failing log query must not hide the Enter button
  await refreshGold().catch(showError);
  if (!hub.signedIn()) actionsEl.append(button("Sign in to the Hub", signIn));
  await renderDirectory().catch(showError);
}

/** The Directory panel: every Land, online or not; "Enter" only for online ones. */
async function renderDirectory() {
  const { lands } = await loadDirectory();
  const heading = document.createElement("p");
  heading.textContent = `Lands: ${lands.length}`;
  const table = document.createElement("table");
  const head = table.insertRow();
  for (const title of ["Land", "At", "Status", ""])
    head.insertCell().textContent = title;
  for (const l of lands) {
    const row = table.insertRow();
    row.insertCell().textContent = String(l.landId);
    row.insertCell().textContent = `(${l.x}, ${l.y})`;
    row.insertCell().textContent = l.online ? "online" : "offline";
    if (l.online)
      row
        .insertCell()
        .append(button("Enter", () => joinLand(l.landId, undefined)));
  }
  directoryEl.replaceChildren(
    heading,
    table,
    button("Refresh Directory", renderDirectory),
  );
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

/** Leaves the Land on screen, if any. Its onLeave then sees `room` changed and does nothing. */
function teardown() {
  game?.destroy(true);
  game = undefined;
  hudEl.hidden = true;
  noticeEl.textContent = "";
  lastWon = undefined;
  currentLandId = undefined;
  room = undefined;
}

/** `from` is set when walking through a Gate. */
async function joinLand(landId: number, from: number | undefined) {
  if (!wallet || travelling) return;
  travelling = true;
  try {
    if (!hub.signedIn()) await signIn();
    statusEl.textContent = "Getting a ticket…";
    const grant = await hub.ticket(landId, from);
    const dir = directory ?? (await loadDirectory());
    // the old room is left only once the ticket is in hand
    const old = room;
    teardown();
    await old?.leave();
    statusEl.textContent = "Joining…";
    const options: JoinOptions = grant;
    const joined = await new Client(
      relayLandUrl(dir.relayUrl, landId),
    ).joinOrCreate(LAND_ROOM, options);
    startScene(joined, landId);
  } catch (error) {
    showError(error);
    if (!room) void refresh();
  } finally {
    statusEl.textContent = "";
    travelling = false;
  }
}

/** Reached the Gate: ask the Hub who is next door right now, then walk through or say why not. */
async function onGateStep(gate: Direction, land: LandMessage) {
  if (travelling) return;
  noticeEl.textContent = "";
  try {
    const { lands } = await loadDirectory();
    const decision = decideGate(gate, land, lands);
    if (decision.kind === "notice") noticeEl.textContent = decision.text;
    else await joinLand(decision.landId, decision.from);
  } catch (error) {
    showError(error);
  }
}

function startScene(joined: Room, landId: number) {
  const gateEdge = createGateEdge();
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
    (gate, land) => {
      const stepped = gateEdge(gate);
      if (stepped && joined === room) void onGateStep(stepped, land);
    },
  );
  joined.onMessage(Messages.map, (m: MapMessage) => scene.setMap(m.tiled));
  joined.onMessage(Messages.land, (m: LandMessage) => {
    scene.setLand(m);
    showOwnerTools(m, landId);
  });
  joined.onLeave(() => {
    if (room !== joined) return; // replaced by a newer room or torn down on purpose
    errorEl.textContent = "Left the Land.";
    teardown();
    void refresh();
  });
  room = joined;
  currentLandId = landId;
  registerEl.hidden = true;
  registerResultEl.textContent = "";
  reportResultEl.textContent = "";
  hudEl.hidden = false;
  game = startGame(el("game"), scene);
  actionsEl.replaceChildren();
}

/** Land owner on their own Land: offer to register the Map server's Mining key with the Hub. */
function showOwnerTools(message: LandMessage, landId: number) {
  registerEl.hidden =
    !wallet ||
    !ownerMayRegister({
      message,
      joinedLandId: landId,
      ownLandId,
      wallet: wallet.address,
    });
  registerEl.onclick = () =>
    void run(registerEl, async () => {
      if (!wallet || currentLandId !== landId) return;
      // issuedAt: the newest Delegation wins
      const issuedAt = Math.floor(Date.now() / 1000);
      const miningKey = getAddress(message.miningKey);
      statusEl.textContent = "Sign the Delegation in your wallet…";
      const signature = await signDelegation(
        wallet,
        config.chainId,
        landId,
        miningKey,
        issuedAt,
      );
      try {
        await hub.delegate(landId, { miningKey, issuedAt, signature });
        registerResultEl.textContent = `Registered ${miningKey} for Land ${landId}.`;
      } catch (error) {
        registerResultEl.textContent = `Registration failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
}

reportReasonEl.maxLength = REPORT_REASON_MAX;
reportEl.addEventListener(
  "click",
  () =>
    void run(reportEl, async () => {
      if (currentLandId === undefined) return;
      try {
        await hub.report(currentLandId, reportReasonEl.value);
        reportReasonEl.value = "";
        reportResultEl.textContent = `Reported Land ${currentLandId}.`;
      } catch (error) {
        reportResultEl.textContent = `Report failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
);

showConnectButtons();
