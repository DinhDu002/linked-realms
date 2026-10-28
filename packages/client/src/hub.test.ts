import { describe, expect, it } from "vitest";
import {
  createHub,
  ownerMayRegister,
  parseDirectory,
  parseNonce,
  parseSession,
  parseTicketGrant,
} from "./hub.ts";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const land = { landId: 1, owner: A, x: 0, y: 0, miningKey: B, online: true };
const sig = `0x${"ab".repeat(65)}`;
const wire = {
  player: A,
  landId: "2",
  gate: 4,
  expiresAt: "1900000000",
  nonce: `0x${"cd".repeat(32)}`,
};

describe("response validation", () => {
  it("accepts a well-formed Directory", () => {
    const d = parseDirectory({
      relayUrl: "wss://relay.example",
      lands: [land],
    });
    expect(d.lands[0]).toMatchObject({ landId: 1, online: true });
  });

  it.each([
    [{ lands: [land] }],
    [{ relayUrl: "javascript:alert(1)", lands: [] }],
    [{ relayUrl: "wss://r", lands: [{ ...land, online: "yes" }] }],
    [{ relayUrl: "wss://r", lands: [{ ...land, landId: 0 }] }],
    [{ relayUrl: "wss://r", lands: [{ ...land, owner: "0x12" }] }],
    [{ relayUrl: "wss://r", lands: [{ ...land, x: 1.5 }] }],
    [{ relayUrl: "wss://r", lands: "nope" }],
    [null],
  ])("rejects a bad Directory %j", (value) => {
    expect(() => parseDirectory(value)).toThrow(/bad response/);
  });

  it("validates nonce, session and ticket", () => {
    expect(parseNonce({ nonce: "abcdefgh12" })).toBe("abcdefgh12");
    expect(() => parseNonce({ nonce: "short" })).toThrow();
    expect(() => parseNonce({ nonce: "has space 1234" })).toThrow();
    expect(
      parseSession({ token: "abc.def", address: A, expiresAt: 5 }),
    ).toMatchObject({ token: "abc.def" });
    expect(() =>
      parseSession({ token: "a b", address: A, expiresAt: 5 }),
    ).toThrow();
    expect(() =>
      parseSession({ token: "x", address: "no", expiresAt: 5 }),
    ).toThrow();
    expect(parseTicketGrant({ ticket: wire, signature: sig }).ticket.gate).toBe(
      4,
    );
    expect(() =>
      parseTicketGrant({ ticket: { ...wire, gate: 9 }, signature: sig }),
    ).toThrow();
    expect(() =>
      parseTicketGrant({ ticket: wire, signature: "0x12" }),
    ).toThrow();
  });
});

describe("ownerMayRegister", () => {
  const message = { landId: 3, owner: A.toLowerCase(), miningKey: B };
  const base = {
    message,
    joinedLandId: 3,
    ownLandId: 3,
    wallet: A as `0x${string}`,
  };
  it("needs the owner, the own Land and the joined Land to agree", () => {
    expect(ownerMayRegister(base)).toBe(true);
    expect(ownerMayRegister({ ...base, ownLandId: 4 })).toBe(false);
    expect(ownerMayRegister({ ...base, ownLandId: undefined })).toBe(false);
    expect(
      ownerMayRegister({ ...base, message: { ...message, landId: 4 } }),
    ).toBe(false);
    expect(
      ownerMayRegister({ ...base, message: { ...message, owner: B } }),
    ).toBe(false);
    expect(
      ownerMayRegister({ ...base, message: { ...message, miningKey: "0x1" } }),
    ).toBe(false);
  });
});

describe("createHub", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });

  it("signs in with a SIWE message for this site and keeps the token in memory", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const hub = createHub({
      baseUrl: "http://hub.test/",
      chainId: 31337,
      domain: "game.test",
      uri: "https://game.test",
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return String(url).endsWith("/auth/nonce")
          ? json({ nonce: "abcdefgh12" })
          : json({ token: "tok", address: A, expiresAt: 9 });
      },
    });
    let signed = "";
    await hub.signIn(A, async (m) => ((signed = m), sig as `0x${string}`));
    expect(signed).toContain("game.test wants you to sign in");
    expect(signed).toContain("Nonce: abcdefgh12");
    expect(signed).toContain("URI: https://game.test");
    expect(seen[0]?.url).toBe("http://hub.test/auth/nonce");
    expect(hub.signedIn()).toBe(true);
  });

  it("refuses authed calls before sign-in and surfaces Hub errors", async () => {
    const hub = createHub({
      baseUrl: "http://hub.test",
      chainId: 1,
      domain: "d",
      uri: "https://d",
      fetch: async () => json({ error: "Land is offline" }, 409),
    });
    await expect(hub.ticket(2)).rejects.toThrow(/not signed in/);
    await expect(hub.directory()).rejects.toThrow(
      /Hub error 409: Land is offline/,
    );
    await expect(hub.report(1, "   ")).rejects.toThrow(/reason/);
    await expect(hub.report(1, "x".repeat(501))).rejects.toThrow(/reason/);
  });
});
