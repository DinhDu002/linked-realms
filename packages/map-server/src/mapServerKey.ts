import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { Key } from "@linked-realms/core";

/**
 * Reads the Map server key's seed (64 hex characters) from `path`, or creates the file (mode
 * 0600) with a fresh random seed. The key only identifies this Map server to the Hub and the
 * relay; it holds no assets.
 */
export function loadOrCreateMapServerKey(path: string): {
  key: Key;
  created: boolean;
} {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = randomBytes(32).toString("hex");
  let created = true;
  try {
    // "wx": never overwrite a key that exists, even if two Map servers start together.
    writeFileSync(path, `${fresh}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  }
  if (created)
    chmodSync(path, 0o600); // the umask can only remove bits, but be explicit
  else if (statSync(path).mode & 0o077)
    throw new Error(
      `${path} is readable by others: run "chmod 600 ${path}" (or delete it to get a new key)`,
    );
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(text))
    throw new Error(
      `${path} must hold a 32-byte hex seed (64 lowercase hex characters); delete the file to create a new key`,
    );
  return { key: Key.fromSeed(Buffer.from(text, "hex")), created };
}
