import type { MoveInput } from "@linked-realms/shared";

export interface PressedKeys {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
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
