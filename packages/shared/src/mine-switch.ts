// The Mine switch (docs/protocols/map-server-node.md): the one line the Land owner signs in a
// Land message's `Message` to switch the Land's Mine. Strict both ways, like identity.md's
// statements. Exported as `@linked-realms/shared/mine-switch`; it loads the WebAssembly module for
// the address check.
import { isAddress } from "@linked-realms/core";
import { StatementError } from "./identity.ts";

export interface MineSwitch {
  /** The Map server's own address. */
  mapServerKey: string;
  on: boolean;
  /** 1 or more when on, 0 when off. */
  threads: number;
  /** The session's challenge: 32 lowercase hexadecimal characters. */
  nonce: string;
}

const TITLE = "linked-realms Mine switch";
const LINE = new RegExp(
  `^${TITLE}; Map server key: ([^;]+); Mine: (on|off); Threads: (0|[1-9][0-9]{0,3}); Nonce: ([0-9a-f]{32})$`,
);

/** The switch in `text`, a Land message's decoded `Message`, or StatementError. */
export function parseMineSwitch(text: string): MineSwitch {
  const match = LINE.exec(text);
  if (!match) throw new StatementError(`not a "${TITLE}" line`);
  const [, mapServerKey, mine, threads, nonce] = match as unknown as string[] &
    Record<1 | 2 | 3 | 4, string>;
  if (!isAddress(mapServerKey))
    throw new StatementError("Map server key is not an address");
  const on = mine === "on";
  if (on !== (threads !== "0"))
    throw new StatementError("Threads is 0 exactly when the Mine is off");
  return { mapServerKey, on, threads: Number(threads), nonce };
}

/** The line for `fields`, or StatementError if it breaks the grammar. */
export function buildMineSwitch(fields: MineSwitch): string {
  const text = `${TITLE}; Map server key: ${fields.mapServerKey}; Mine: ${fields.on ? "on" : "off"}; Threads: ${fields.threads}; Nonce: ${fields.nonce}`;
  parseMineSwitch(text);
  return text;
}
