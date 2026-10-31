import type { LandDirectory } from "@linked-realms/shared";
import { describe, expect, it } from "vitest";
import { HubError } from "./hub.ts";
import { planTravel, ticketRefusal } from "./travel.ts";
import { LockedError } from "./vault.ts";

const land = (landId: number, x: number, y: number, online = true) => ({
  landId,
  owner: "o",
  ownerName: "",
  x,
  y,
  url: `http://${landId}.localhost`,
  mapServerKey: "k",
  online,
  domain: null,
});
const directory: LandDirectory = {
  lands: [land(1, 0, 0), land(2, 1, 0), land(3, 0, 1, false)],
};

describe("planTravel", () => {
  it("goes to the neighbour in the cell across the Gate", () => {
    expect(planTravel(directory, 1, "east")).toEqual({
      kind: "go",
      land: directory.lands[1],
    });
    expect(planTravel(directory, 2, "west")).toMatchObject({ kind: "go" });
  });

  it("says no-land when the cell is empty", () => {
    expect(planTravel(directory, 1, "north")).toEqual({ kind: "no-land" });
    expect(planTravel(directory, 1, "west")).toEqual({ kind: "no-land" });
  });

  it("says offline, with the Land, when its Map server is not connected", () => {
    expect(planTravel(directory, 1, "south")).toEqual({
      kind: "offline",
      landId: 3,
    });
  });

  it("is an error when the Directory does not list the current Land", () => {
    expect(planTravel(directory, 9, "east")).toEqual({ kind: "error" });
  });
});

describe("ticketRefusal", () => {
  it("names offline only when the Hub says the Land is offline", () => {
    const refusal = (status: number, message: string) =>
      ticketRefusal(new HubError(status, message), 8);
    expect(refusal(409, "Land is offline")).toEqual({
      ok: false,
      reason: "offline",
      landId: 8,
    });
    expect(refusal(409, "Lands are not adjacent")).toEqual({
      ok: false,
      reason: "error",
    });
    expect(refusal(409, "Land has no cell yet")).toEqual({
      ok: false,
      reason: "error",
    });
    expect(refusal(404, "Land not found")).toEqual({
      ok: false,
      reason: "no-land",
    });
    expect(refusal(429, "too many ticket requests")).toEqual({
      ok: false,
      reason: "rate-limited",
    });
    expect(ticketRefusal(new LockedError(), 8)).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(ticketRefusal(new Error("boom"), 8)).toEqual({
      ok: false,
      reason: "error",
    });
  });
});
