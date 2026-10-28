// Mining and issuance rules (PLAN.md section 5.2, decisions D8 and D9).
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const GOLD_DECIMALS = 18;

export const INTENDED_ROUND_SECONDS = 60n;
export const RETARGET_INTERVAL_ROUNDS = 60n;
export const MAX_RETARGET_FACTOR = 4n;

export const INITIAL_ROUND_REWARD = 50n * 10n ** 18n;
export const HALVING_INTERVAL_ROUNDS = 210_000n;
export const MAX_SUPPLY = 21_000_000n * 10n ** 18n;

/** Placeholder until the step 1B calibration (see docs/decisions). */
export const INITIAL_TARGET = 2n ** 256n / 60_000_000n;

export const MAX_TARGET = 2n ** 256n - 1n;

export interface MiningParams {
  initialTarget: bigint;
  intendedRoundSeconds: bigint;
  retargetIntervalRounds: bigint;
  maxRetargetFactor: bigint;
  initialReward: bigint;
  halvingIntervalRounds: bigint;
}

export const DEFAULT_MINING_PARAMS: MiningParams = {
  initialTarget: INITIAL_TARGET,
  intendedRoundSeconds: INTENDED_ROUND_SECONDS,
  retargetIntervalRounds: RETARGET_INTERVAL_ROUNDS,
  maxRetargetFactor: MAX_RETARGET_FACTOR,
  initialReward: INITIAL_ROUND_REWARD,
  halvingIntervalRounds: HALVING_INTERVAL_ROUNDS,
};

/** The hash a Solution must bring below the Target: keccak256(abi.encode(challenge, rewardWallet, nonce)). */
export function solutionHash(
  challenge: Hex,
  rewardWallet: Address,
  nonce: bigint,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [challenge, rewardWallet, nonce],
    ),
  );
}

export function meetsTarget(hash: Hex, target: bigint): boolean {
  return BigInt(hash) < target;
}

/** Reward for winning Round `round`, halved every `halvingIntervalRounds` Rounds. */
export function rewardForRound(
  round: bigint,
  params: MiningParams = DEFAULT_MINING_PARAMS,
): bigint {
  const halvings = round / params.halvingIntervalRounds;
  return halvings >= 256n ? 0n : params.initialReward >> halvings;
}

/** Target after a Retarget window of `actualSeconds`, limited to `maxRetargetFactor` either way. */
export function nextTarget(
  current: bigint,
  actualSeconds: bigint,
  params: MiningParams = DEFAULT_MINING_PARAMS,
): bigint {
  const expected = params.intendedRoundSeconds * params.retargetIntervalRounds;
  const min = expected / params.maxRetargetFactor;
  const max = expected * params.maxRetargetFactor;
  const actual =
    actualSeconds < min ? min : actualSeconds > max ? max : actualSeconds;
  if (actual > expected && current > MAX_TARGET / params.maxRetargetFactor)
    return MAX_TARGET;
  const result = (current * actual) / expected;
  return result === 0n ? 1n : result;
}
