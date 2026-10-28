// Mining and issuance parameters (PLAN.md section 5.2, decision D9).
// Single source of truth (P9): the contracts must use the same values.

export const GOLD_DECIMALS = 18;

export const INTENDED_ROUND_SECONDS = 60n;
export const RETARGET_INTERVAL_ROUNDS = 60n;
export const MAX_RETARGET_FACTOR = 4n;

export const INITIAL_ROUND_REWARD = 50n * 10n ** 18n;
export const HALVING_INTERVAL_ROUNDS = 210_000n;
export const MAX_SUPPLY = 21_000_000n * 10n ** 18n;
