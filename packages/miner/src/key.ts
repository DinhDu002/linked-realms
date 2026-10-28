import {
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/** Reads the Mining key file, or creates it (mode 0600) with a fresh key. */
export function loadOrCreateMiningKey(path: string): {
  privateKey: Hex;
  address: Address;
  created: boolean;
} {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = generatePrivateKey();
  let created = true;
  // Write a temp file, then hard-link it into place: link fails if the path exists, and the key file is
  // never visible half-written (a crash or a second Map server must not see an empty file).
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${fresh}\n`, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  } finally {
    unlinkSync(temp);
  }
  if (created) {
    return {
      privateKey: fresh,
      address: privateKeyToAccount(fresh).address,
      created,
    };
  }
  if (statSync(path).mode & 0o077)
    throw new Error(
      `Mining key file ${path} is readable by other users: run chmod 600 ${path}`,
    );
  const privateKey = readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey))
    throw new Error(
      `Mining key file ${path} must hold one 0x-prefixed 32-byte hex private key (delete the file to generate a new one)`,
    );
  return {
    privateKey: privateKey as Hex,
    address: privateKeyToAccount(privateKey as Hex).address,
    created,
  };
}
