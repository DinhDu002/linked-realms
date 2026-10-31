// The API both entry points share. Keys are ML-DSA-44 (docs/protocols/identity.md); call
// `Key.free()` when done so the private key is wiped. `sign`, `signTransfer` and `signRotation`
// take 32 fresh random bytes as `rnd`. Transactions (docs/protocols/transactions.md) take a
// network id and amounts in base units, as `bigint`.
export {
  Key,
  addressFromBytes,
  addressFromPublicKey,
  addressToBytes,
  entropyFromWords,
  formatAmount,
  isAddress,
  parseAmount,
  transactionId,
  verify,
  wordsFromEntropy,
} from "../pkg/linked_realms_core.js";

/** Scheme id of ML-DSA-44 in addresses. */
export const SCHEME_ML_DSA_44 = 1;
