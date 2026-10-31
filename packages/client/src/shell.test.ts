import { describe, expect, it } from "vitest";
import {
  acceptConnect,
  isOutsideFrame,
  parseShellMessage,
  signErrorText,
  startShell,
  travelRefusedText,
  type SignError,
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

describe("parseShellMessage signResult", () => {
  it("reads a signed statement or an error", () => {
    expect(
      parseShellMessage({ type: "signResult", id: "a1", signed: statement }),
    ).toEqual({ type: "signResult", id: "a1", signed: statement });
    expect(
      parseShellMessage({ type: "signResult", id: "a1", error: "denied" }),
    ).toEqual({ type: "signResult", id: "a1", error: "denied" });
  });

  it.each([
    ["an id that is not a string", { id: 1, error: "denied" }],
    [
      "both a signed statement and an error",
      { id: "a", signed: statement, error: "busy" },
    ],
    ["an unknown error", { id: "a", error: "nope" }],
    ["a txId, which answers pay, not signMessage", { id: "a", txId: "00" }],
    [
      "a malformed statement",
      { id: "a", signed: { ...statement, signature: 5 } },
    ],
  ])("refuses %s", (_, fields) => {
    expect(
      parseShellMessage({ type: "signResult", ...fields }),
    ).toBeUndefined();
  });
});

describe("signErrorText", () => {
  it("gives every error its own plain sentence", () => {
    const errors: SignError[] = [
      "denied",
      "busy",
      "blocked",
      "invalid",
      "failed",
      "locked",
    ];
    const texts = errors.map(signErrorText);
    expect(new Set(texts).size).toBe(errors.length);
    for (const text of texts) expect(text).toMatch(/^[A-Z].+\.$/);
  });
});

describe("startShell signMessage", () => {
  // A window whose parent connects with one end of a channel; the test is the Shell at the other.
  function connected() {
    let listener: ((event: unknown) => void) | undefined;
    const win = {
      parent,
      addEventListener: (_: string, fn: (event: unknown) => void) =>
        (listener = fn),
    };
    const link = startShell(win as never, {
      onInit() {},
      onTravelRefused() {},
    });
    const channel = new MessageChannel();
    const asked: unknown[] = [];
    channel.port2.onmessage = (e) => asked.push(e.data);
    const answer = (data: object) =>
      channel.port2.postMessage({ type: "signResult", ...data });
    return {
      link,
      asked,
      answer,
      connect: () =>
        listener!({ source: parent, data: connect, ports: [channel.port1] }),
      close: () => channel.port1.close(),
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it("settles each request with the answer of its id", async () => {
    const shell = connected();
    shell.connect();
    const first = shell.link.signMessage("one");
    const second = shell.link.signMessage("two");
    await tick();
    expect(shell.asked).toEqual([
      { type: "signMessage", id: "1", text: "one" },
      { type: "signMessage", id: "2", text: "two" },
    ]);
    shell.answer({ id: "9", error: "busy" }); // no such request: ignored
    shell.answer({ id: "2", error: "denied" });
    shell.answer({ id: "1", signed: statement });
    expect(await second).toEqual({ error: "denied" });
    expect(await first).toEqual({ signed: statement });
    shell.close();
  });

  it("answers failed before the Shell has connected", async () => {
    const shell = connected();
    expect(await shell.link.signMessage("early")).toEqual({ error: "failed" });
    await tick();
    expect(shell.asked).toEqual([]);
    shell.close();
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
