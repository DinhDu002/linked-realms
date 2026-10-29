import { describe, expect, it } from "vitest";
import {
  acceptConnect,
  isOutsideFrame,
  parseShellMessage,
  travelRefusedText,
} from "./shell.ts";

const parent = { name: "parent" };
const port = {} as MessagePort;
const connect = { type: "linked-realms/connect", api: 1 };

const statement = { statement: "s", publicKey: "k", signature: "g" };
const init = {
  type: "init",
  land: { landId: 7, url: "https://7.lands.example", ownerName: "Mai" },
  character: { address: "tlr1abc", name: "Lan" },
  handoff: { ticket: statement, arrival: { ...statement, statement: "a" } },
};

describe("isOutsideFrame", () => {
  it("is true only when the window is its own parent", () => {
    const top = {} as { parent: unknown };
    top.parent = top;
    expect(isOutsideFrame(top)).toBe(true);
    expect(isOutsideFrame({ parent })).toBe(false);
  });
});

describe("acceptConnect", () => {
  it("keeps the first port of a connect from the parent window", () => {
    expect(
      acceptConnect({ source: parent, data: connect, ports: [port] }, parent),
    ).toBe(port);
  });

  it.each([
    ["another source", { source: {}, data: connect, ports: [port] }],
    [
      "another type",
      { source: parent, data: { ...connect, type: "x" }, ports: [port] },
    ],
    [
      "another api",
      { source: parent, data: { ...connect, api: 2 }, ports: [port] },
    ],
    ["no data object", { source: parent, data: "connect", ports: [port] }],
    ["null data", { source: parent, data: null, ports: [port] }],
    ["no port", { source: parent, data: connect, ports: [] }],
  ])("refuses %s", (_name, event) => {
    expect(acceptConnect(event, parent)).toBeUndefined();
  });
});

describe("parseShellMessage init", () => {
  it("reads land, Character and handoff", () => {
    expect(parseShellMessage(init)).toEqual(init);
  });

  it("drops fields it does not know", () => {
    const m = parseShellMessage({
      ...init,
      extra: 1,
      land: { ...init.land, x: 1 },
    });
    expect(m).toEqual(init);
  });

  it.each([
    ["no land", { ...init, land: undefined }],
    ["land id 0", { ...init, land: { ...init.land, landId: 0 } }],
    ["land id as text", { ...init, land: { ...init.land, landId: "7" } }],
    ["url not text", { ...init, land: { ...init.land, url: 7 } }],
    ["no Character", { ...init, character: null }],
    ["address not text", { ...init, character: { name: "Lan", address: 1 } }],
    ["no handoff", { ...init, handoff: undefined }],
    ["no arrival", { ...init, handoff: { ticket: statement } }],
    [
      "bad ticket",
      { ...init, handoff: { ...init.handoff, ticket: { statement: "s" } } },
    ],
  ])("refuses %s", (_name, data) => {
    expect(parseShellMessage(data)).toBeUndefined();
  });
});

describe("parseShellMessage travelRefused", () => {
  it("reads direction, reason and the optional Land", () => {
    expect(
      parseShellMessage({
        type: "travelRefused",
        direction: "east",
        reason: "offline",
        landId: 8,
      }),
    ).toEqual({
      type: "travelRefused",
      direction: "east",
      reason: "offline",
      landId: 8,
    });
    expect(
      parseShellMessage({
        type: "travelRefused",
        direction: "north",
        reason: "no-land",
      }),
    ).toEqual({ type: "travelRefused", direction: "north", reason: "no-land" });
  });

  it("refuses a bad direction or reason", () => {
    expect(
      parseShellMessage({
        type: "travelRefused",
        direction: "up",
        reason: "busy",
      }),
    ).toBeUndefined();
    expect(
      parseShellMessage({
        type: "travelRefused",
        direction: "east",
        reason: "boom",
      }),
    ).toBeUndefined();
  });
});

describe("parseShellMessage", () => {
  it.each([
    null,
    5,
    "init",
    [],
    {},
    { type: "signResult", id: "a" },
    { type: 1 },
  ])("ignores %j", (data) => {
    expect(parseShellMessage(data)).toBeUndefined();
  });
});

describe("travelRefusedText", () => {
  const m = (reason: string, landId?: number) =>
    travelRefusedText({ direction: "east", reason, landId } as never);

  it("names the missing and the offline Land", () => {
    expect(m("no-land")).toBe("No Land to the east");
    expect(m("offline", 8)).toBe("Land 8 is offline");
    expect(m("offline")).toBe("The Land to the east is offline");
  });

  it("gives every other reason a plain sentence", () => {
    for (const reason of ["locked", "busy", "rate-limited", "error"])
      expect(m(reason)).toMatch(/^[A-Z].+\.$/);
  });
});
