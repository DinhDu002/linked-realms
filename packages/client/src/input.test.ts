import { describe, expect, it } from "vitest";
import { createInputDiffer } from "./input.ts";

const idle = { up: false, down: false, left: false, right: false };

describe("createInputDiffer", () => {
  it("reports nothing while no key is pressed", () => {
    expect(createInputDiffer().next(idle)).toBeUndefined();
  });

  it("reports only changes", () => {
    const differ = createInputDiffer();
    const right = { ...idle, right: true };
    expect(differ.next(right)).toEqual(right);
    expect(differ.next({ ...right })).toBeUndefined();
    expect(differ.next({ ...right, up: true })).toEqual({ ...right, up: true });
    expect(differ.next(idle)).toEqual(idle);
    expect(differ.next(idle)).toBeUndefined();
  });
});
