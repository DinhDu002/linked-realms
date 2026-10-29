// The Shell's own dialogs. While one is open the Land's frame is frozen: inert, with no pointer
// events (shell-land-ui.md, "The Shell's signing prompt").
import { visibleEscapes } from "./escape.ts";
import { el } from "./dom.ts";
import type { SignAnswer, SignRequest } from "./portHandler.ts";

export const APPROVE_DELAY_MS = 1000;

export function createModals(setFrozen: (frozen: boolean) => void) {
  let open = 0;
  const hold = () => {
    open++;
    setFrozen(true);
  };
  const release = () => {
    if (--open === 0) setFrozen(false);
  };

  /** Opens `dialog` modally; resolves with its return value ("" when closed with Escape). */
  function show(dialog: HTMLDialogElement): Promise<string> {
    return new Promise((resolve) => {
      hold();
      dialog.addEventListener(
        "close",
        () => {
          release();
          resolve(dialog.returnValue);
        },
        { once: true },
      );
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  // One signing prompt for the whole Shell, whichever frame load asked: a second request must not
  // change the text under an Approve button that is already armed. Its state ends the moment it is
  // answered or cancelled, not when the browser later fires `close`.
  let finishSign: ((value: string) => void) | undefined;

  /**
   * The signing prompt. Everything above the Land's text is the Shell's own. Approve is not
   * focused and answers only a real pointer click (a keyboard or scripted click has `detail` 0),
   * and only a second after the prompt opened. Deny and closing both answer "denied".
   */
  function confirmSign(request: SignRequest): Promise<SignAnswer> {
    if (finishSign) return Promise.resolve("busy");
    const dialog = el<HTMLDialogElement>("sign");
    const approve = el("sign-approve");
    const { character } = request;
    const name = visibleEscapes(character.name);
    el("sign-land").textContent = `Land ${request.landId}`;
    el("sign-origin").textContent = request.origin;
    el("sign-character").textContent = name
      ? `${name} (${character.address})`
      : character.address;
    el("sign-text").textContent = visibleEscapes(request.text);
    el("sign-text").scrollTop = 0;

    return new Promise((resolve) => {
      const openedAt = Date.now();
      approve.setAttribute("aria-disabled", "true");
      const ready = setTimeout(
        () => approve.removeAttribute("aria-disabled"),
        APPROVE_DELAY_MS,
      );
      const finish = (value: string) => {
        if (finishSign !== finish) return; // answered already
        finishSign = undefined;
        clearTimeout(ready);
        approve.removeEventListener("click", onClick);
        dialog.removeEventListener("close", onClose);
        el("sign-text").textContent = "";
        if (dialog.open) dialog.close();
        release();
        resolve(value === "approve" ? "approved" : "denied");
      };
      const onClick = (event: MouseEvent) => {
        if (
          event.isTrusted &&
          event.detail > 0 &&
          Date.now() - openedAt >= APPROVE_DELAY_MS
        )
          finish("approve");
      };
      // Deny or Escape. A `close` the browser fires late for an earlier prompt finds the dialog
      // open again and is ignored.
      const onClose = () => {
        if (!dialog.open) finish(dialog.returnValue);
      };
      finishSign = finish;
      approve.addEventListener("click", onClick);
      dialog.addEventListener("close", onClose);
      hold();
      dialog.returnValue = "";
      dialog.showModal();
    });
  }

  /** Closes an open signing prompt as a refusal: its frame load is gone. */
  function cancelSign() {
    finishSign?.("");
  }

  return {
    show,
    confirmSign,
    cancelSign,
    get isOpen() {
      return open > 0;
    },
  };
}

export type Modals = ReturnType<typeof createModals>;
