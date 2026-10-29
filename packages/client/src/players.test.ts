import { describe, expect, it } from "vitest";
import { characterLabel, characterMarks, readCharacter } from "./players.ts";

const address = "tlr1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const base = { id: 1, address, name: "Lan", x: 1, y: 2 };

describe("readCharacter", () => {
  it("accepts a well-formed Character", () => {
    expect(readCharacter({ ...base, isOwner: true, drivenByAi: true })).toEqual(
      {
        ...base,
        isOwner: true,
        drivenByAi: true,
      },
    );
  });

  it("defaults the optional fields", () => {
    expect(readCharacter({ id: 2, address, x: 0, y: 0 })).toEqual({
      id: 2,
      address,
      name: "",
      x: 0,
      y: 0,
      isOwner: false,
      drivenByAi: false,
    });
  });

  it.each([
    null,
    { ...base, id: 1.5 },
    { ...base, id: "1" },
    { ...base, address: 5 },
    { ...base, address: "" },
    { ...base, x: Number.NaN },
    { ...base, y: Number.POSITIVE_INFINITY },
    { ...base, x: "1" },
  ])("rejects %j", (value) => {
    expect(readCharacter(value)).toBeUndefined();
  });
});

describe("characterLabel", () => {
  const c = { ...base, isOwner: false, drivenByAi: false };

  it("shows the name, or the short address when it is empty", () => {
    expect(characterLabel(c)).toBe("Lan");
    expect(characterLabel({ ...c, name: "" })).toMatch(/^tlr1.+…/);
  });

  it("shows the short address for a name that shows nothing", () => {
    for (const name of ["\u3164", "\u2800\u2800", " \u200b "])
      expect(characterLabel({ ...c, name })).toMatch(/^tlr1.+…/);
  });

  it("keeps the marks apart from the name, so a name cannot fake them", () => {
    expect(characterMarks(c)).toEqual([]);
    expect(characterMarks({ ...c, drivenByAi: true, isOwner: true })).toEqual([
      "ai",
      "owner",
    ]);
    const faker = { ...c, name: "Mai ★ [AI]" };
    expect(characterLabel(faker)).toBe("Mai ★ [AI]");
    expect(characterMarks(faker)).toEqual([]);
  });

  it("strips control characters and cuts long names", () => {
    expect(characterLabel({ ...c, name: "a\nb‮c" })).toBe("abc");
    expect(characterLabel({ ...c, name: "x".repeat(100) })).toBe(
      "x".repeat(32),
    );
  });
});
