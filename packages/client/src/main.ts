import { connect, playUrl, type Connection } from "./connection.ts";
import { createGateEdge } from "./gate.ts";
import { attachPad } from "./input.ts";
import { LandScene, startGame } from "./scene.ts";
import { isOutsideFrame, startShell, travelRefusedText } from "./shell.ts";

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}
const statusEl = el("status");
const landEl = el("hud-land");
const noticeEl = el("hud-notice");
const errorEl = el("error");

if (isOutsideFrame(window)) {
  // No Shell, no handoff: nothing else to do here.
  statusEl.textContent = "Open this Land from the Shell";
} else {
  const gateEdge = createGateEdge();
  let connection: Connection | undefined;
  let started = false;

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
      });
      connection = connect(playUrl(window.location), handoff, {
        onMessage(message) {
          if (message.message.case === "welcome") statusEl.textContent = "";
          scene.handle(message);
        },
        onProblem(text) {
          statusEl.textContent = "";
          errorEl.textContent = text;
        },
      });
      attachPad(el("pad"), (keys) => scene.setTouch(keys));
      startGame(el("game"), scene);
    },
    onTravelRefused(m) {
      noticeEl.textContent = travelRefusedText(m);
    },
  });
  statusEl.textContent = "Waiting for the Shell…";
}
