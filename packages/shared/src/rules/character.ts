// Character stats (PLAN.md section 5.1, P10: stored as key–value pairs).

export const CHARACTER_STAT_KEYS = [
  "strength",
  "agility",
  "intelligence",
  "stamina",
] as const;
export type CharacterStatKey = (typeof CHARACTER_STAT_KEYS)[number];

export const INITIAL_STAT_VALUE = 1n;
