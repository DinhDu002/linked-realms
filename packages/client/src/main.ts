import { ready } from "@linked-realms/core";
import { connect, playUrl, type Connection } from "./connection.ts";
import { createGateEdge } from "./gate.ts";
import { attachPad } from "./input.ts";
import { switchLine, switchResultText, type MineView } from "./mine.ts";
import { LandScene, startGame } from "./scene.ts";
import {
  isOutsideFrame,
  signErrorText,
  startShell,
  travelRefusedText,
} from "./shell.ts";

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}
const statusEl = el("status");
const landEl = el("hud-land");
const noticeEl = el("hud-notice");
const errorEl = el("error");
const mineEl = el("hud-mine");
const mineWonEl = el("hud-mine-won");
const mineOpenEl = el("mine-open") as HTMLButtonElement;
const mineFormEl = el("mine-form") as HTMLFormElement;
const mineFieldsEl = el("mine-fields") as HTMLFieldSetElement;
const mineOnEl = el("mine-on") as HTMLInputElement;
const mineOffEl = el("mine-off") as HTMLInputElement;
const mineThreadsEl = el("mine-threads") as HTMLInputElement;

if (isOutsideFrame(window)) {
  // No Shell, no handoff: nothing else to do here.
  statusEl.textContent = "Open this Land from the Shell";
} else {
  const gateEdge = createGateEdge();
  let connection: Connection | undefined;
  let started = false;
  // The Land owner's switch: the last MineState, and whether a switch is being signed.
  let mine: MineView | undefined;
  let owner = false;
  let signing = false;
  let sentOn = false;

  const showMineControl = () => {
    const down = mine?.status === "unavailable";
    // While the Node is down the form closes and the switch is disabled (plan item 22).
    if (!owner || down) mineFormEl.hidden = true;
    mineOpenEl.hidden = !owner || !mineFormEl.hidden;
    mineOpenEl.disabled = down;
    mineFieldsEl.disabled = signing;
    mineThreadsEl.disabled = !mineOnEl.checked;
    mineThreadsEl.max = String(mine?.maxThreads ?? 1);
  };
  const openMineForm = () => {
    if (!owner || !mine || mine.status === "unavailable" || !mineFormEl.hidden)
      return;
    // Offer the other state, with the threads the Mine runs or 1.
    mineOnEl.checked = mine.status === "off";
    mineOffEl.checked = !mineOnEl.checked;
    mineThreadsEl.value = String(
      Math.min(mine.maxThreads, Math.max(1, mine.threads)),
    );
    mineFormEl.hidden = false;
    showMineControl();
    mineFieldsEl.querySelector<HTMLElement>("button[type=submit]")?.focus();
  };
  mineOpenEl.addEventListener("click", openMineForm);
  mineFormEl.addEventListener("change", showMineControl);
  el("mine-cancel").addEventListener("click", () => {
    mineFormEl.hidden = true;
    showMineControl();
  });
  mineFormEl.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!mine || signing) return;
    const on = mineOnEl.checked;
    const built = switchLine(mine, on, Number(mineThreadsEl.value));
    if ("problem" in built) {
      noticeEl.textContent = built.problem;
      return;
    }
    signing = true;
    showMineControl();
    noticeEl.textContent = "Approve the switch in the Shell's prompt.";
    void shell.signMessage(built.line).then((answer) => {
      signing = false;
      if ("error" in answer) {
        noticeEl.textContent = signErrorText(answer.error);
      } else if (connection?.sendMineSwitch(answer.signed)) {
        sentOn = on;
        noticeEl.textContent = "Switch sent to the Land…";
        mineFormEl.hidden = true;
      } else {
        noticeEl.textContent =
          "Not connected to the Land: the switch was not sent. Reload the Land.";
      }
      showMineControl();
    });
  });

  const shell = startShell(window, {
    onInit({ handoff }) {
      if (started) return; // the Shell sends init once per frame load
      started = true;
      statusEl.textContent = "Connecting…";
      const scene = new LandScene({
        send: (dx, dy, seq) => connection?.sendInput(dx, dy, seq),
        onGate(gate) {
          const direction = gateEdge(gate);
          if (!direction) return;
          noticeEl.textContent = "";
          shell.travel(direction);
        },
        hud: (text) => {
          landEl.textContent = text;
        },
        notice: (text) => {
          noticeEl.textContent = text;
        },
        onMapError(message) {
          errorEl.textContent = `Map rejected: ${message}`;
          connection?.close();
        },
        mine(view, isOwner, line) {
          mine = view;
          owner = isOwner;
          mineEl.textContent = line;
          showMineControl();
        },
        won(line) {
          mineWonEl.textContent = line;
        },
        onMineTap: openMineForm,
      });
      // The Mine's texts and the switch line need the WebAssembly module (mine.ts).
      void ready.then(
        () => {
          connection = connect(playUrl(window.location), handoff, {
            onMessage(message) {
              const m = message.message;
              if (m.case === "welcome") statusEl.textContent = "";
              if (m.case === "mineSwitchResult")
                noticeEl.textContent = switchResultText(m.value, sentOn);
              scene.handle(message);
            },
            onProblem(text) {
              statusEl.textContent = "";
              errorEl.textContent = text;
            },
          });
        },
        () => {
          statusEl.textContent = "";
          errorEl.textContent = "This page could not load. Reload the Land.";
        },
      );
      attachPad(el("pad"), (keys) => scene.setTouch(keys));
      startGame(el("game"), scene);
    },
    onTravelRefused(m) {
      noticeEl.textContent = travelRefusedText(m);
    },
  });
  statusEl.textContent = "Waiting for the Shell…";
}
