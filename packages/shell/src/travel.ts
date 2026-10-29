// Finding where a `travel` goes (docs/protocols/gate-travel.md): the neighbouring cell in a fresh
// Directory.
import {
  neighbourOf,
  type Direction,
  type LandDirectory,
} from "@linked-realms/shared";
import { HubError } from "./hub.ts";
import type { TravelOutcome } from "./portHandler.ts";
import { LockedError } from "./vault.ts";

export type TravelPlan =
  | { kind: "go"; land: LandDirectory["lands"][number] }
  | { kind: "no-land" }
  | { kind: "offline"; landId: number }
  /** The Directory does not list the Land the Character is in. */
  | { kind: "error" };

export function planTravel(
  directory: LandDirectory,
  currentLandId: number,
  direction: Direction,
): TravelPlan {
  const here = directory.lands.find((l) => l.landId === currentLandId);
  if (!here) return { kind: "error" };
  const cell = neighbourOf(here.x, here.y, direction);
  const there = directory.lands.find((l) => l.x === cell.x && l.y === cell.y);
  if (!there) return { kind: "no-land" };
  return there.online
    ? { kind: "go", land: there }
    : { kind: "offline", landId: there.landId };
}

/** The `travelRefused` for a failed ticket request (`POST /tickets`, gate-travel.md). */
export function ticketRefusal(e: unknown, landId: number): TravelOutcome {
  if (e instanceof LockedError) return { ok: false, reason: "locked" };
  if (e instanceof HubError) {
    // 404: the Land is gone, so the cell holds no Land.
    if (e.status === 404) return { ok: false, reason: "no-land" };
    // 409 is also "no cell yet" or "not adjacent" (the Directory moved meanwhile): not offline.
    if (e.status === 409 && e.message === "Land is offline")
      return { ok: false, reason: "offline", landId };
    if (e.status === 429) return { ok: false, reason: "rate-limited" };
  }
  return { ok: false, reason: "error" };
}
