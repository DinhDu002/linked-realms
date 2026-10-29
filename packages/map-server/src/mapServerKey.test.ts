import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateMapServerKey } from "./mapServerKey.ts";

const dir = () => mkdtempSync(join(tmpdir(), "map-server-key-"));

describe("loadOrCreateMapServerKey", () => {
  it("creates a 0600 file in a new directory, then loads the same key", () => {
    const path = join(dir(), "sub", "map-server-key");
    const a = loadOrCreateMapServerKey(path);
    expect(a.created).toBe(true);
    expect(a.key.address).toMatch(/^tlr1/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    const b = loadOrCreateMapServerKey(path);
    expect(b.created).toBe(false);
    expect(b.key.address).toBe(a.key.address);
  });

  it("derives the key from the seed in the file", () => {
    const path = join(dir(), "key");
    writeFileSync(path, `${"48".repeat(32)}\n`, { mode: 0o600 });
    expect(loadOrCreateMapServerKey(path).key.address).toBe(
      "tlr1qqqmkrz7wdckqgrm76sjdmyhslmd8r33gf4s3y4d7qqwwrrpgscdmrcgw5jya",
    );
  });

  it("rejects a malformed file and leaves it alone", () => {
    for (const text of [
      "not a key",
      "48".repeat(31),
      "48".repeat(33),
      "AB".repeat(32),
      "",
    ]) {
      const path = join(dir(), "key");
      writeFileSync(path, text, { mode: 0o600 });
      expect(() => loadOrCreateMapServerKey(path)).toThrow(/32-byte hex seed/);
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("rejects a file that others can read", () => {
    const path = join(dir(), "key");
    const { key } = loadOrCreateMapServerKey(path);
    chmodSync(path, 0o640);
    expect(() => loadOrCreateMapServerKey(path)).toThrow(/chmod 600/);
    chmodSync(path, 0o604);
    expect(() => loadOrCreateMapServerKey(path)).toThrow(/chmod 600/);
    chmodSync(path, 0o600);
    expect(loadOrCreateMapServerKey(path).key.address).toBe(key.address);
  });
});
