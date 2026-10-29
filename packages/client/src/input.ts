import type { MoveInput } from "@linked-realms/shared";

export interface PressedKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

const IDLE: PressedKeys = { up: false, down: false, left: false, right: false };

/**
 * The directions a finger at (x, y) from the touch pad's centre holds: none in the middle quarter
 * of the radius, else one of 8 sectors of 45° on the axes and the diagonals. Screen y grows down.
 */
export function padKeys(x: number, y: number, radius: number): PressedKeys {
  const distance = Math.hypot(x, y);
  if (distance < radius / 4) return { ...IDLE };
  const edge = Math.sin(Math.PI / 8) * distance; // 22.5° off an axis
  return { up: y < -edge, down: y > edge, left: x < -edge, right: x > edge };
}

/**
 * Follows one finger held on `pad` and reports the directions it holds.
 * Touch events, not pointer events: Chromium sends a frame made while a finger was down (a
 * travel while walking) the touches but not their pointer events, so the pad went dead.
 */
export function attachPad(
  pad: HTMLElement,
  onChange: (keys: PressedKeys) => void,
): void {
  let held: number | undefined;
  const holding = (touches: TouchList) =>
    [...touches].find((t) => t.identifier === held);
  const follow = (touch: Touch) => {
    const box = pad.getBoundingClientRect();
    onChange(
      padKeys(
        touch.clientX - box.left - box.width / 2,
        touch.clientY - box.top - box.height / 2,
        box.width / 2,
      ),
    );
  };
  pad.addEventListener(
    "touchstart",
    (event) => {
      event.preventDefault(); // no emulated mouse clicks, no long-press menu
      // The first finger steers; one whose end never came here no longer counts.
      const touch = event.changedTouches[0];
      if (holding(event.touches) || !touch) return;
      held = touch.identifier;
      follow(touch);
    },
    { passive: false },
  );
  // A touch's moves keep coming to the pad when the finger slides off it.
  pad.addEventListener("touchmove", (event) => {
    const touch = holding(event.changedTouches);
    if (touch) follow(touch);
  });
  for (const type of ["touchend", "touchcancel"] as const)
    pad.addEventListener(type, (event) => {
      if (!holding(event.changedTouches)) return;
      held = undefined;
      onChange({ ...IDLE });
    });
}

/** Remembers the last sent input so the server only hears about changes. */
export function createInputDiffer() {
  let last: MoveInput = { up: false, down: false, left: false, right: false };
  return {
    /** Returns the new input when it differs from the last one returned, else undefined. */
    next(current: PressedKeys): MoveInput | undefined {
      if (
        current.up === last.up &&
        current.down === last.down &&
        current.left === last.left &&
        current.right === last.right
      )
        return undefined;
      last = { ...current };
      return last;
    },
  };
}
