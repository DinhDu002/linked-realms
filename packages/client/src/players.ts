import { shortAddress } from "@linked-realms/shared";

export interface CharacterState {
  id: number;
  address: string;
  name: string;
  x: number;
  y: number;
  isOwner: boolean;
  drivenByAi: boolean;
}

const NAME_MAX_CODE_POINTS = 32;

/** Map servers are untrusted (P1): render a Character only when its state is well-formed. */
export function readCharacter(value: unknown): CharacterState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.id !== "number" || !Number.isInteger(c.id)) return undefined;
  if (typeof c.address !== "string" || c.address === "") return undefined;
  if (typeof c.x !== "number" || typeof c.y !== "number") return undefined;
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return undefined;
  return {
    id: c.id,
    address: c.address,
    name: typeof c.name === "string" ? c.name : "",
    x: c.x,
    y: c.y,
    isOwner: c.isOwner === true,
    drivenByAi: c.drivenByAi === true,
  };
}

/** The name, or the short address when the name shows nothing (arrival.md). */
export function characterLabel(c: CharacterState): string {
  // Control characters (newlines, bidi marks) would let a name fake extra label text.
  const name = [...c.name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim()]
    .slice(0, NAME_MAX_CODE_POINTS)
    .join("");
  const visible = name.replace(
    /[\p{White_Space}\p{Default_Ignorable_Code_Point}\u2800]/gu,
    "",
  );
  return visible ? name : shortAddress(c.address);
}

/**
 * The "AI" and owner marks (arrival.md). The scene draws them as coloured badges apart from the
 * name, so a name such as "Mai ★" cannot pass for one.
 */
export function characterMarks(c: CharacterState): ("ai" | "owner")[] {
  return [
    ...(c.drivenByAi ? (["ai"] as const) : []),
    ...(c.isOwner ? (["owner"] as const) : []),
  ];
}
