// Setup (flow 1): the only page that asks for the 24 words, and it never loads a Land. Nothing
// reaches the Hub: the Character exists only as the encrypted entropy stored here.
import {
  entropyFromWords,
  Key,
  ready,
  wordsFromEntropy,
} from "@linked-realms/core";
import { el, make } from "./dom.ts";
import { loadRecord, saveRecord, sealEntropy } from "./keystore.ts";
import {
  CONFIRM_COUNT,
  normalizeWords,
  passwordProblem,
  pickConfirmPositions,
} from "./words.ts";

const sections = [
  "choose",
  "step-words",
  "step-confirm",
  "step-restore",
  "done",
];
function show(id: string) {
  for (const s of sections) el(s).hidden = s !== id;
}
const input = (id: string) => el<HTMLInputElement>(id);

const randomBelow = (below: number) =>
  crypto.getRandomValues(new Uint32Array(1))[0]! % below;

async function main() {
  await ready;
  const existing = await loadRecord();
  if (existing) {
    el("existing").hidden = false;
    el("existing-address").textContent = existing.address;
  }

  /** Stores the Character behind `entropy`, wipes it and everything typed. */
  async function store(
    entropy: Uint8Array,
    password: string,
    error: HTMLElement,
  ) {
    if (existing && !input("replace").checked) {
      error.textContent = "Tick “Replace the stored Character” above first.";
      return false;
    }
    const key = Key.fromEntropy(entropy, 0);
    const address = key.address;
    key.free();
    await saveRecord(await sealEntropy(entropy, address, password));
    el("done-address").textContent = address;
    show("done");
    return true;
  }

  // One store at a time: a second submit while Argon2id runs would race the first one's wipe.
  let storing = false;
  /** Runs `job` unless one is running, with `button` disabled meanwhile. */
  async function once(button: string, job: () => Promise<void>) {
    if (storing) return;
    storing = true;
    el<HTMLButtonElement>(button).disabled = true;
    try {
      await job();
    } finally {
      storing = false;
      el<HTMLButtonElement>(button).disabled = false;
    }
  }

  let entropy: Uint8Array | undefined;
  let words: string[] = [];
  let positions: number[] = [];

  function wipe() {
    entropy?.fill(0);
    entropy = undefined;
    words = [];
    el("words").replaceChildren();
    el("confirm-fields").replaceChildren();
    for (const id of [
      "create-password",
      "create-password2",
      "restore-words",
      "restore-password",
      "restore-password2",
    ])
      input(id).value = "";
  }

  // Create: show the words, then ask for three of them and a password.
  el("choose-create").addEventListener("click", () => {
    entropy = crypto.getRandomValues(new Uint8Array(32));
    words = wordsFromEntropy(entropy).split(" ");
    el("words").replaceChildren(...words.map((w) => make("li", w)));
    show("step-words");
  });
  el("words-cancel").addEventListener("click", () => {
    wipe();
    show("choose");
  });
  el("words-next").addEventListener("click", () => {
    positions = pickConfirmPositions(words.length, randomBelow);
    const fields = el("confirm-fields");
    fields.replaceChildren();
    el("create-error").textContent = "";
    positions.forEach((p, i) => {
      const label = make("label", `Word #${p + 1}`);
      label.htmlFor = `confirm-${i}`;
      const field = document.createElement("input");
      Object.assign(field, {
        id: `confirm-${i}`,
        autocomplete: "off",
        autocapitalize: "none",
        spellcheck: false,
        required: true,
      });
      fields.append(label, field);
    });
    el("words").replaceChildren(); // not on screen while the Player confirms
    show("step-confirm");
  });
  el("confirm-back").addEventListener("click", () => {
    el("words").replaceChildren(...words.map((w) => make("li", w)));
    show("step-words");
  });
  el("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void once("create-submit", create);
  });
  async function create() {
    const error = el("create-error");
    for (let i = 0; i < CONFIRM_COUNT; i++)
      if (
        normalizeWords(input(`confirm-${i}`).value) !== words[positions[i]!]
      ) {
        error.textContent = `Word #${positions[i]! + 1} is not right. Show the words again and check.`;
        return;
      }
    const password = input("create-password").value;
    const problem = passwordProblem(password, input("create-password2").value);
    if (problem) {
      error.textContent = problem;
      return;
    }
    error.textContent = "Creating…";
    try {
      if (entropy && (await store(entropy, password, error))) wipe();
      else if (error.textContent === "Creating…") error.textContent = "";
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  // Restore: the Player types the words.
  el("choose-restore").addEventListener("click", () => show("step-restore"));
  el("restore-cancel").addEventListener("click", () => {
    wipe();
    show("choose");
  });
  el("restore-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void once("restore-submit", restore);
  });
  async function restore() {
    const error = el("restore-error");
    const password = input("restore-password").value;
    const problem = passwordProblem(password, input("restore-password2").value);
    if (problem) {
      error.textContent = problem;
      return;
    }
    let restored: Uint8Array | undefined;
    try {
      try {
        restored = entropyFromWords(
          normalizeWords(input("restore-words").value),
        );
      } catch {
        // reported below
      }
      if (restored?.length !== 32) {
        error.textContent =
          "These are not 24 valid words. Check the spelling and the order.";
        return;
      }
      error.textContent = "Restoring…";
      if (await store(restored, password, error)) wipe();
      else if (error.textContent === "Restoring…") error.textContent = "";
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      restored?.fill(0);
    }
  }
}

main().catch((e) => {
  document.body.prepend(
    make("p", e instanceof Error ? e.message : String(e), "error"),
  );
});
