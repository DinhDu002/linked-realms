import {
  chmodSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateMiningKey } from "./key.ts";

const dir = () => mkdtempSync(join(tmpdir(), "miner-key-"));

describe("loadOrCreateMiningKey", () => {
  it("creates a 0600 file in a new 0700 directory, then reuses it", () => {
    const path = join(dir(), "sub", "mining-key");
    const a = loadOrCreateMiningKey(path);
    expect(a.created).toBe(true);
    expect(a.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8").trim()).toBe(a.privateKey);
    expect(readdirSync(join(path, ".."))).toEqual(["mining-key"]);
    const b = loadOrCreateMiningKey(path);
    expect(b).toEqual({ ...a, created: false });
  });

  it("rejects a malformed file", () => {
    const path = join(dir(), "key");
    writeFileSync(path, "not a key", { mode: 0o600 });
    expect(() => loadOrCreateMiningKey(path)).toThrow(/32-byte hex/);
    expect(() => loadOrCreateMiningKey(path)).toThrow(/delete the file/);
  });

  it("rejects a group-readable file", () => {
    const path = join(dir(), "key");
    const { privateKey } = loadOrCreateMiningKey(path);
    chmodSync(path, 0o640);
    expect(() => loadOrCreateMiningKey(path)).toThrow(/chmod 600/);
    chmodSync(path, 0o600);
    expect(loadOrCreateMiningKey(path).privateKey).toBe(privateKey);
  });
});
