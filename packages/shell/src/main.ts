import { formatAmount, ready } from "@linked-realms/core";
import { shortAddress, type LandInfo } from "@linked-realms/shared";
import { isName, signStatement } from "@linked-realms/shared/identity";
import { createAccount } from "./account.ts";
import {
  hubHost,
  hubUrl,
  landCommand,
  landImage,
  network,
  networkIdOf,
  nodeUrl,
} from "./config.ts";
import { el, make } from "./dom.ts";
import { createFrameHost, type FrameHost } from "./frame.ts";
import {
  describeTransaction,
  memoText,
  preparePayment,
  signPayment,
} from "./gold.ts";
import { prepareHandoff } from "./handoff.ts";
import { createHubClient } from "./hub.ts";
import { loadRecord, WrongPasswordError } from "./keystore.ts";
import { errorText, registerErrorText, sendErrorText } from "./messages.ts";
import { createModals } from "./modals.ts";
import {
  createNodeClient,
  NodeError,
  toHex,
  type PlacedTransaction,
} from "./node.ts";
import { createPortHandler, type TravelOutcome } from "./portHandler.ts";
import { planTravel, ticketRefusal } from "./travel.ts";
import { createVault, LockedError } from "./vault.ts";

const POLL_MS = 10_000;

async function main() {
  const viewNochar = el("view-nochar");
  const viewLocked = el("view-locked");
  const viewHome = el("view-home");
  const frameArea = el("frame-area");
  const statusEl = el("status");
  const retryButton = el<HTMLButtonElement>("retry");

  const record = await loadRecord();
  if (!record) {
    viewNochar.hidden = false;
    return;
  }
  await ready;

  const hub = createHubClient(hubUrl);
  const node = createNodeClient(nodeUrl);
  const networkId = networkIdOf(network);
  // The frame host needs the modals (to freeze) and the modals need it: tie them lazily.
  // eslint-disable-next-line prefer-const
  let frameHost: FrameHost;
  const modals = createModals((frozen) => frameHost.setFrozen(frozen));
  const vault = createVault(record, { isBusy: () => modals.isOpen });
  const account = createAccount({ vault, hub, hubHost });

  // --- Unlocking: the password is asked only here, in the Shell's own modal ---

  const unlockDialog = el<HTMLDialogElement>("unlock");
  const passwordInput = el<HTMLInputElement>("password");
  const unlockError = el("unlock-error");
  const unlockSubmit = el<HTMLButtonElement>("unlock-submit");
  let unlocking: Promise<boolean> | undefined;

  el("unlock-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    unlockSubmit.disabled = true;
    unlockError.textContent = "Unlocking…";
    try {
      // The page may pause for about a second: Argon2id runs on this thread.
      await new Promise((r) => setTimeout(r, 0));
      await vault.unlock(passwordInput.value);
      passwordInput.value = "";
      unlockDialog.close("unlocked");
    } catch (e) {
      unlockError.textContent =
        e instanceof WrongPasswordError ? "Wrong password." : errorText(e);
    } finally {
      unlockSubmit.disabled = false;
    }
  });
  el("unlock-cancel").addEventListener("click", () =>
    unlockDialog.close("cancel"),
  );

  /** True once the Shell is unlocked, asking for the password if needed; false when cancelled. */
  function ensureUnlocked(): Promise<boolean> {
    if (vault.unlocked) return Promise.resolve(true);
    unlocking ??= (async () => {
      unlockError.textContent = "";
      passwordInput.value = "";
      const result = await modals.show(unlockDialog);
      passwordInput.value = "";
      return result === "unlocked";
    })().finally(() => (unlocking = undefined));
    return unlocking;
  }

  // --- The Land's frame ---

  function notice(text: string | undefined, retry?: () => void) {
    statusEl.textContent = text ?? "";
    retryButton.hidden = !retry;
    retryButton.onclick = retry ? () => retry() : null;
    render();
  }

  async function travelFrom(
    from: LandInfo,
    direction: Parameters<typeof planTravel>[2],
    unlock: () => Promise<boolean>,
    isCurrent: () => boolean,
  ): Promise<TravelOutcome> {
    let plan;
    try {
      plan = planTravel(await hub.directory(), from.landId, direction);
    } catch {
      return { ok: false, reason: "error" };
    }
    if (plan.kind === "no-land") return { ok: false, reason: "no-land" };
    if (plan.kind === "offline")
      return { ok: false, reason: "offline", landId: plan.landId };
    if (plan.kind === "error") return { ok: false, reason: "error" };
    if (!(await unlock())) return { ok: false, reason: "locked" };
    try {
      // Asking first means a refusal leaves the Character where it is.
      const handoff = await prepareHandoff(
        { account, hub, vault },
        plan.land.landId,
        from.landId,
      );
      // The Player left, or the Land reloaded, while the ticket was on its way: stay put.
      if (!isCurrent()) return { ok: false, reason: "error" };
      frameHost.open(plan.land, {
        from: from.landId,
        prepared: { handoff, at: Date.now() },
      });
      render();
      return { ok: true };
    } catch (e) {
      return ticketRefusal(e, plan.land.landId);
    }
  }

  frameHost = createFrameHost({
    area: frameArea,
    notice,
    character: () => ({ address: vault.address, name: account.name }),
    onPortClosed: () => modals.cancelSign(),
    async prepare(land, from) {
      if (!(await ensureUnlocked())) throw new LockedError();
      return prepareHandoff({ account, hub, vault }, land.landId, from);
    },
    makeHandler: (land, send, isCurrent) =>
      createPortHandler({
        now: Date.now,
        land: { landId: land.landId, origin: new URL(land.url).origin },
        character: () => ({ address: vault.address, name: account.name }),
        send,
        travel: (direction, unlock) =>
          travelFrom(land, direction, unlock, isCurrent),
        isUnlocked: () => vault.unlocked,
        ensureUnlocked,
        confirm: (request) => modals.confirmSign(request),
        sign: (fields) =>
          vault.withKey((key) => signStatement("land-message", fields, key)),
      }),
  });

  async function enter(land: LandInfo) {
    const directoryStatus = el("directory-status");
    directoryStatus.textContent = "";
    try {
      if (!(await ensureUnlocked())) return;
      const handoff = await prepareHandoff(
        { account, hub, vault },
        land.landId,
      );
      frameHost.open(land, { prepared: { handoff, at: Date.now() } });
      render();
    } catch (e) {
      directoryStatus.textContent = `Cannot enter Land ${land.landId}: ${errorText(e)}`;
    }
  }

  function leave() {
    frameHost.close();
    notice(undefined);
    void refreshHome();
  }

  // --- The bar and the views ---

  function render() {
    const land = frameHost.land;
    const locked = !vault.unlocked;
    viewLocked.hidden = !(locked && !land);
    viewHome.hidden = locked || land !== undefined;
    frameArea.hidden = land === undefined;
    el("land-info").hidden = land === undefined;
    el("report").hidden = el("leave").hidden = land === undefined;
    el("lock").hidden = locked;
    el("unlock-button").hidden = !locked;
    if (land) {
      el("land-name").textContent =
        `Land ${land.landId}` +
        (land.ownerName ? ` · ${land.ownerName}'s Land` : "");
      el("land-origin").textContent = new URL(land.url).origin;
    }
  }

  el("lock").addEventListener("click", () => vault.lock());
  el("unlock-button").addEventListener("click", () => void ensureUnlocked());
  el("leave").addEventListener("click", leave);

  // Full screen takes the whole Shell page, so its prompts stay in view over the frame (P6).
  const fullscreen = el("fullscreen");
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.addEventListener("click", () => {
    const change = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    change.catch((e) => notice(`Full screen failed: ${errorText(e)}`));
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreen.textContent = document.fullscreenElement
      ? "Exit full screen"
      : "Full screen";
  });
  // A touch screen without full screen (iPhone) can still drop the bars from the Home Screen.
  el("fullscreen-hint").hidden =
    document.fullscreenEnabled ||
    !matchMedia("(pointer: coarse)").matches ||
    matchMedia("(display-mode: standalone)").matches;
  vault.onChange(() => {
    render();
    if (vault.unlocked) {
      // Sign in to the Hub again right away, without asking (flow 2).
      account
        .call(async () => undefined)
        .catch((e) => notice(errorText(e)))
        .then(refreshHome);
    } else nameLoaded = false;
  });
  for (const type of [
    "pointerdown",
    "pointermove",
    "keydown",
    "wheel",
    "touchstart",
  ])
    document.addEventListener(type, () => vault.touch(), {
      capture: true,
      passive: true,
    });

  // --- Report (from the Shell's own controls, not from inside the frame) ---

  const reportDialog = el<HTMLDialogElement>("report-dialog");
  const reportReason = el<HTMLTextAreaElement>("report-reason");
  const reportError = el("report-error");
  let reporting: LandInfo | undefined;

  el("report").addEventListener("click", async () => {
    reporting = frameHost.land;
    if (!reporting || !(await ensureUnlocked())) return;
    reportError.textContent = "";
    reportReason.value = "";
    await modals.show(reportDialog);
  });
  el("report-cancel").addEventListener("click", () =>
    reportDialog.close("cancel"),
  );
  el("report-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!reporting) return;
    const landId = reporting.landId;
    const reason = reportReason.value.trim();
    try {
      await account.call((token) => hub.report(token, landId, reason));
      reportDialog.close("sent");
      notice(`Report on Land ${landId} sent.`);
    } catch (e) {
      reportError.textContent = errorText(e);
    }
  });

  // --- Home: Character, Directory, Your Land ---

  let nameLoaded = false;
  const nameInput = el<HTMLInputElement>("name");
  const nameStatus = el("name-status");
  const address = record.address;
  el("character-address").textContent = address;
  el("character-short").textContent = shortAddress(address);
  const command = landCommand(address, hubUrl, landImage);
  el("land-command").textContent = command;

  function copyButton(id: string, text: string) {
    const button = el(id);
    const label = button.textContent;
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = label), 1500);
    });
  }
  copyButton("copy-address", address);
  copyButton("copy-land-command", command);

  el("name-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (name === "" || !isName(name)) {
      nameStatus.textContent =
        "A name has 1 to 32 characters, without control characters.";
      return;
    }
    try {
      const saved = await account.call((token) => hub.setName(token, name));
      account.setName(saved.name);
      nameInput.value = saved.name;
      nameStatus.textContent = "Saved.";
    } catch (e) {
      nameStatus.textContent = errorText(e);
    }
  });

  function renderDirectory(lands: LandInfo[]) {
    const list = el("directory");
    list.replaceChildren();
    if (lands.length === 0) list.append(make("li", "No Land has a cell yet."));
    for (const land of lands) {
      const row = make("li");
      row.append(
        make("strong", `Land ${land.landId}`),
        ` · ${land.ownerName || "unnamed"} · cell (${land.x}, ${land.y}) · `,
        make(
          "span",
          land.online ? "online" : "offline",
          land.online ? "online" : "offline",
        ),
        " · ",
        make("code", new URL(land.url).origin),
        " ",
      );
      const button = make("button", "Enter");
      button.type = "button";
      button.setAttribute("aria-label", `Enter Land ${land.landId}`);
      button.addEventListener("click", () => void enter(land));
      row.append(button);
      list.append(row);
    }
  }

  async function refreshDirectory() {
    const status = el("directory-status");
    try {
      renderDirectory((await hub.directory()).lands);
      if (status.textContent === "Cannot reach the Hub.")
        status.textContent = "";
    } catch {
      status.textContent = "Cannot reach the Hub.";
    }
  }

  async function register(mapServerKey: string) {
    const status = el("register-status");
    status.textContent = "Registering…";
    try {
      const delegation = vault.withKey((key) =>
        signStatement(
          "delegation",
          {
            hub: hubHost,
            owner: address,
            mapServerKey,
            issued: Math.floor(Date.now() / 1000),
          },
          key,
        ),
      );
      await hub.createLand(delegation);
      status.textContent = "";
    } catch (e) {
      status.textContent = registerErrorText(e);
    }
    await refreshYourLand();
  }

  const domainForm = el<HTMLFormElement>("domain-form");
  const domainInput = el<HTMLInputElement>("domain");
  const domainStatus = el("domain-status");
  /** The Land shown under "Your Land", and the own domain last put in the field. */
  let yourLand: LandInfo | undefined;
  let shownDomain: string | null | undefined;

  async function saveDomain(domain: string | null) {
    if (!yourLand) return;
    const { landId } = yourLand;
    domainStatus.textContent =
      domain === null ? "Removing…" : "The Hub is reading the TXT record…";
    try {
      await account.call((token) => hub.setDomain(token, landId, domain));
      domainStatus.textContent = domain === null ? "Removed." : "Saved.";
    } catch (e) {
      domainStatus.textContent = errorText(e);
    }
    await refreshYourLand();
  }
  domainForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const domain = domainInput.value.trim();
    void saveDomain(domain === "" ? null : domain);
  });
  el("remove-domain").addEventListener("click", () => void saveDomain(null));

  async function refreshYourLand() {
    const landStatus = el("land-status");
    const list = el("map-servers");
    try {
      const [land, offers] = await Promise.all([
        hub.landOf(address),
        account.call((token) => hub.mapServers(token, address)),
      ]);
      landStatus.textContent = !land
        ? "You have no Land yet."
        : `Your Land is Land ${land.landId} at ${land.url}. ` +
          (land.x === null
            ? "It has no cell yet: it gets one once its Map server is online. "
            : `Its cell is (${land.x}, ${land.y}). `) +
          (land.online ? "It is online." : "It is offline.");
      yourLand = land;
      domainForm.hidden = !land;
      if (land) {
        el("domain-txt").textContent = `land=${land.landId}`;
        el<HTMLButtonElement>("remove-domain").disabled = land.domain === null;
        // a poll must not wipe what the owner is typing
        if (land.domain !== shownDomain) {
          shownDomain = land.domain;
          domainInput.value = land.domain ?? "";
        }
      }
      list.replaceChildren();
      if (offers.mapServers.length === 0)
        list.append(
          make(
            "li",
            "No Map server is waiting. Run the command above; its Map server appears here once it has started.",
          ),
        );
      for (const offer of offers.mapServers) {
        const row = make("li");
        row.append(make("code", offer.mapServerKey), " ");
        const button = make("button", land ? "Use this one" : "Register");
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${land ? "Use" : "Register"} Map server ${shortAddress(offer.mapServerKey)}`,
        );
        button.addEventListener(
          "click",
          () => void register(offer.mapServerKey),
        );
        row.append(button);
        list.append(row);
      }
    } catch (e) {
      if (!(e instanceof LockedError)) landStatus.textContent = errorText(e);
    }
  }

  // --- Gold: balance, send and recent transactions, from the Public node ---

  const sendForm = el<HTMLFormElement>("send-form");
  const sendStatus = el("send-status");
  const sendSubmit = el<HTMLButtonElement>("send-submit");
  const goldStatus = el("gold-status");
  const field = (id: string) => el<HTMLInputElement>(id);
  // ponytail: sends wait here only until the page reloads; after that they show in the list once a
  // Block holds them.
  const pending = new Map<string, PlacedTransaction>();

  sendForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    sendSubmit.disabled = true;
    sendStatus.textContent = "Reading your account…";
    try {
      const memo = field("send-memo").value;
      const payment = await preparePayment(node, networkId, address, {
        to: field("send-to").value,
        amount: field("send-amount").value,
        memo,
        fee: field("send-fee").value,
      });
      sendStatus.textContent = "";
      const gold = (units: bigint) => `${formatAmount(units)} GOLD`;
      const answer = await modals.confirmPayment({
        from: account.name ? `${account.name} (${address})` : address,
        to: payment.to,
        amount: gold(payment.amount),
        memo: memo === "" ? "(none)" : memoText(payment.memo),
        fee: gold(payment.fee),
        total: gold(payment.amount + payment.fee),
      });
      if (answer !== "approved") {
        sendStatus.textContent = "Not sent: nothing was signed.";
        return;
      }
      const { bytes, id } = vault.withKey((key) => signPayment(key, payment));
      // Tracked before it leaves: if the Node's answer is lost, the list still shows whether the
      // Node holds it, so the Player does not pay twice by sending again.
      pending.set(id, {
        tx: {
          id,
          sender: address,
          nonce: Number(payment.nonce),
          fee: payment.fee.toString(),
          kind: "transfer",
          to: payment.to,
          amount: payment.amount.toString(),
          memo: toHex(payment.memo),
        },
        block: null,
      });
      try {
        await node.send(bytes);
      } catch (e) {
        // A JSON-RPC error is the Node's refusal; anything else may have reached it.
        if (e instanceof NodeError && e.code < 0) {
          pending.delete(id);
          throw e;
        }
        sendForm.reset();
        sendStatus.textContent =
          "The Node did not answer, so the Shell cannot tell whether it was sent. It shows below as waiting while the Node holds it: check there before sending again.";
        void refreshGold();
        return;
      }
      sendForm.reset();
      sendStatus.textContent = `Sent ${gold(payment.amount)}. It is confirmed once a Block holds it.`;
      void refreshGold();
    } catch (e) {
      sendStatus.textContent = sendErrorText(e);
    } finally {
      sendSubmit.disabled = false;
    }
  });

  let refreshes = 0;
  async function refreshGold() {
    const turn = ++refreshes;
    try {
      // The waiting sends first: one a Block took meanwhile is in the list read after.
      const checked = await Promise.all(
        [...pending.keys()].map(
          async (id) => [id, await node.transaction(id)] as const,
        ),
      );
      const [mine, recent] = await Promise.all([
        node.account(address),
        node.addressTxs(address),
      ]);
      if (turn !== refreshes) return; // a later refresh shows newer answers
      // A send stops waiting once a Block holds it, or the Node no longer has it.
      for (const [id, found] of checked) {
        if (found?.block || !found) pending.delete(id);
        if (!found)
          sendStatus.textContent =
            "A send left the Node without a Block: check the recent transactions, and send it again if it is not there.";
      }
      el("balance").textContent = `${formatAmount(mine?.balance ?? 0n)} GOLD`;
      const list = el("transactions");
      list.replaceChildren();
      const rows = [...pending.values(), ...recent];
      if (rows.length === 0) list.append(make("li", "No transactions yet."));
      for (const placed of rows)
        list.append(make("li", describeTransaction(placed, address)));
      goldStatus.textContent = "";
    } catch (e) {
      goldStatus.textContent = `Cannot read Gold from the Node at ${nodeUrl}: ${errorText(e)}`;
    }
  }

  async function refreshHome() {
    if (!vault.unlocked || frameHost.land) return;
    void refreshDirectory();
    void refreshGold();
    await refreshYourLand();
    if (!nameLoaded && vault.token) {
      nameLoaded = true;
      nameInput.value = account.name;
    }
  }
  el("refresh-directory").addEventListener("click", () => void refreshHome());
  setInterval(() => void refreshHome(), POLL_MS);

  render();
  void ensureUnlocked();
}

main().catch((e) => {
  el("status").textContent = errorText(e);
});
