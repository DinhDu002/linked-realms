// Passkey helpers. WebAuthn hands out a passkey's public key only when it is created, so a new device
// that sees a synced passkey recovers the key from two of its signatures; no server stores passkeys.
import { P256, PublicKey } from "ox";
import { concat, sha256, stringToHex, type Hex } from "viem";

export interface Assertion {
  metadata: { authenticatorData: Hex; clientDataJSON: string };
  signature: { r: bigint; s: bigint };
}

/** The two public keys that fit one WebAuthn signature (ECDSA recovery without the parity bit). */
function candidates({ metadata, signature }: Assertion): Hex[] {
  // WebAuthn signs sha256(authenticatorData || sha256(clientDataJSON))
  const payload = sha256(
    concat([
      metadata.authenticatorData,
      sha256(stringToHex(metadata.clientDataJSON)),
    ]),
  );
  return [0, 1].map((yParity) =>
    PublicKey.toHex(
      P256.recoverPublicKey({ payload, signature: { ...signature, yParity } }),
      { includePrefix: false },
    ),
  );
}

/** The passkey's public key (64 bytes, x then y): the one key that fits both signatures. */
export function recoverPublicKey(a: Assertion, b: Assertion): Hex {
  const fromB = candidates(b);
  const keys = candidates(a).filter((key) => fromB.includes(key));
  if (keys.length !== 1 || !keys[0])
    throw new Error("could not recover the passkey's public key");
  return keys[0];
}
