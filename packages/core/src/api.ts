// The API both entry points share. Keys are ML-DSA-44 (docs/protocols/identity.md); call
// `Key.free()` when done so the private key is wiped. `sign` takes 32 fresh random bytes as `rnd`.
export {
  Key,
  addressFromPublicKey,
  entropyFromWords,
  isAddress,
  verify,
  wordsFromEntropy,
} from "../pkg/linked_realms_core.js";

/** Scheme id of ML-DSA-44 in addresses. */
export const SCHEME_ML_DSA_44 = 1;
