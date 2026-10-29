import { P256, PublicKey, WebAuthnP256 } from "ox";
import { describe, expect, it } from "vitest";
import { recoverPublicKey, type Assertion } from "./passkey.ts";

const privateKey = P256.randomPrivateKey();
const publicKey = PublicKey.toHex(P256.getPublicKey({ privateKey }), {
  includePrefix: false,
});

/** What an authenticator returns: a P-256 signature over the WebAuthn payload. */
function assertion(challenge: `0x${string}`, key = privateKey): Assertion {
  const { metadata, payload } = WebAuthnP256.getSignPayload({
    challenge,
    origin: "https://game.test",
    rpId: "game.test",
  });
  return {
    metadata,
    signature: P256.sign({ payload, privateKey: key, hash: true }),
  };
}

describe("recoverPublicKey", () => {
  it("recovers the passkey's public key from two signatures, in the form viem's credential uses", () => {
    expect(recoverPublicKey(assertion("0x01"), assertion("0x02"))).toBe(
      publicKey,
    );
    expect(publicKey).toMatch(/^0x[0-9a-f]{128}$/);
  });

  it("refuses signatures from two different passkeys", () => {
    const foreign = assertion("0x02", P256.randomPrivateKey());
    expect(() => recoverPublicKey(assertion("0x01"), foreign)).toThrow(
      /could not recover/,
    );
  });
});
