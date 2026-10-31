// The 24 words of a Character: reading what the Player types, and which words to ask for.

/** Lowercase words separated by single spaces, however the Player typed them. */
export function normalizeWords(text: string): string {
  return text.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

export const CONFIRM_COUNT = 3;

/** `CONFIRM_COUNT` different positions in `0..count-1`, ascending. `random` returns a uniform integer below its argument. */
export function pickConfirmPositions(
  count: number,
  random: (below: number) => number,
): number[] {
  const picked = new Set<number>();
  while (picked.size < CONFIRM_COUNT) picked.add(random(count));
  return [...picked].sort((a, b) => a - b);
}

export const MIN_PASSWORD_LENGTH = 8;

/** Why a new password is not acceptable, or undefined. */
export function passwordProblem(
  password: string,
  repeated: string,
): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== repeated) return "The two passwords differ.";
  return undefined;
}
