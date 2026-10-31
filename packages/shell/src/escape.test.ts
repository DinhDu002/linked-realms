import { describe, expect, it } from "vitest";
import { visibleEscapes } from "./escape.ts";

describe("visibleEscapes", () => {
  it("leaves printable text alone, spaces and emoji included", () => {
    expect(visibleEscapes("Hello, Mai's Land! 🌍 café")).toBe(
      "Hello, Mai's Land! 🌍 café",
    );
  });

  it("shows control characters", () => {
    expect(visibleEscapes("a\u0000b\u001bc\u007fd")).toBe(
      "a\\u{0}b\\u{1b}c\\u{7f}d",
    );
    expect(visibleEscapes("a\nb\tc\rd")).toBe("a\\nb\\tc\\rd");
  });

  it("shows bidi controls", () => {
    expect(visibleEscapes("Approve‮ txt.exe")).toBe("Approve\\u{202e} txt.exe");
    expect(visibleEscapes("⁦x⁩")).toBe("\\u{2066}x\\u{2069}");
  });

  it("shows invisible characters", () => {
    expect(visibleEscapes("a​b⁠c﻿d­e")).toBe(
      "a\\u{200b}b\\u{2060}c\\u{feff}d\\u{ad}e",
    );
    expect(visibleEscapes("x\u{e0041}")).toBe("x\\u{e0041}"); // a tag character
    expect(visibleEscapes("ᅟㅤ")).toBe("\\u{115f}\\u{3164}");
  });

  it("shows spaces that are not a plain space, and line and paragraph separators", () => {
    expect(visibleEscapes("a b　c d ")).toBe(
      "a\\u{a0}b\\u{3000}c\\u{2028}d\\u{2029}",
    );
  });

  it("shows unassigned, private-use and lone surrogate code points", () => {
    expect(visibleEscapes("\u{10ffff}\ud800")).toBe(
      "\\u{10ffff}\\u{e000}\\u{d800}",
    );
  });

  it("doubles backslashes, so typed text cannot pass for an escape", () => {
    expect(visibleEscapes("\\u{202e}")).toBe("\\\\u{202e}");
    expect(visibleEscapes("\\n")).toBe("\\\\n");
  });
});
