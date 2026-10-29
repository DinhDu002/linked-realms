// What the paymaster pays for (PLAN.md D5, ADR 0005). hub-api enforces this list and these limits;
// the CDP Paymaster's own allowlist and limits are set to the same values (docs/runbooks/base-sepolia.md).

/** `to` names a contract in the deployment, or "account": a call from the Player's account to itself. */
export const SPONSORED_CALLS = [
  { to: "PlayerRegistry", signature: "createCharacter()" },
  { to: "Land", signature: "setDesignHash(uint256,bytes32)" },
  // a backup passkey: without one, a lost passkey loses the Land (ADR 0005)
  { to: "account", signature: "addOwnerPublicKey(bytes32,bytes32)" },
] as const;

/** Sponsored transactions (user operations) per Player per UTC day. */
export const SPONSORED_TRANSACTIONS_PER_PLAYER_PER_DAY = 20;

/** Sponsored transactions per UTC day for the whole world. */
export const SPONSORED_TRANSACTIONS_PER_DAY = 10_000;
