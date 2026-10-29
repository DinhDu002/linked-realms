// The Character's 32 bytes of entropy, encrypted with the Player's password and kept in IndexedDB
// in the Shell's origin. The encryption is pure (WebCrypto and Argon2id) so it runs in Node tests.
import { argon2id } from "hash-wasm";

export interface Argon2Params {
  m: number;
  t: number;
  p: number;
}

/** What the Shell writes today; the record carries its own, so they can be raised later. */
export const DEFAULT_KDF: Argon2Params = { m: 65536, t: 3, p: 1 };

type Bytes = Uint8Array<ArrayBuffer>;

export interface KeyRecord {
  version: 1;
  address: string;
  kdf: { alg: "argon2id"; salt: Bytes } & Argon2Params;
  iv: Bytes;
  ciphertext: Bytes;
}

export class WrongPasswordError extends Error {
  override name = "WrongPasswordError";
  constructor() {
    super("Wrong password");
  }
}

const utf8 = (text: string): Bytes => new TextEncoder().encode(text);

async function aesKey(
  password: string,
  kdf: KeyRecord["kdf"],
  usage: KeyUsage,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password: utf8(password.normalize("NFKC")),
    salt: kdf.salt,
    parallelism: kdf.p,
    iterations: kdf.t,
    memorySize: kdf.m,
    hashLength: 32,
    outputType: "binary",
  });
  try {
    return await crypto.subtle.importKey(
      "raw",
      raw as Bytes,
      "AES-GCM",
      false,
      [usage],
    );
  } finally {
    raw.fill(0);
  }
}

/**
 * Encrypts `entropy` under a fresh salt and IV. It is copied before the first await, so the caller
 * may wipe its own array at any time.
 */
export async function sealEntropy(
  entropy: Uint8Array,
  address: string,
  password: string,
  params: Argon2Params = DEFAULT_KDF,
): Promise<KeyRecord> {
  const plain = entropy.slice();
  const kdf = {
    alg: "argon2id" as const,
    ...params,
    salt: crypto.getRandomValues(new Uint8Array(16)),
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await aesKey(password, kdf, "encrypt");
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8(address) },
        key,
        plain as Bytes, // never a SharedArrayBuffer
      ),
    );
    return { version: 1, address, kdf, iv, ciphertext };
  } finally {
    plain.fill(0);
  }
}

/** The entropy, to be wiped by the caller; throws WrongPasswordError when the password does not fit. */
export async function openEntropy(
  record: KeyRecord,
  password: string,
): Promise<Uint8Array> {
  const key = await aesKey(password, record.kdf, "decrypt");
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: record.iv,
          additionalData: utf8(record.address),
        },
        key,
        record.ciphertext,
      ),
    );
  } catch {
    throw new WrongPasswordError();
  }
}

// --- IndexedDB (not available in Node; exercised by the browser tests) ---

export const DB_NAME = "linked-realms-shell";
const STORE = "keys";
const RECORD_KEY = "character";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  const db = await request(opening);
  try {
    return await request(use(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

export const loadRecord = (): Promise<KeyRecord | undefined> =>
  withStore("readonly", (s) => s.get(RECORD_KEY));

export const saveRecord = (record: KeyRecord): Promise<IDBValidKey> =>
  withStore("readwrite", (s) => s.put(record, RECORD_KEY));
