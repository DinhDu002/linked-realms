import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Hex } from "viem";
import {
  DelegationTypes,
  GATE_EAST,
  GATE_NONE,
  HUB_EIP712_DOMAIN,
  JoinRejected,
  parseWireTicket,
  relayLandUrl,
  shortAddress,
  ticketToWire,
  TRAVEL_TICKET_TTL_SECONDS,
  TravelTicketTypes,
  verifyTravelTicket,
  type TravelTicket,
} from "./hub.ts";

const hub = privateKeyToAccount(generatePrivateKey());
const player = privateKeyToAccount(generatePrivateKey());
const chainId = 31337;
const now = 1_800_000_000;

function ticket(over: Partial<TravelTicket> = {}): TravelTicket {
  return {
    player: player.address,
    landId: 3n,
    gate: GATE_EAST,
    expiresAt: BigInt(now + TRAVEL_TICKET_TTL_SECONDS),
    nonce: `0x${"ab".repeat(32)}`,
    ...over,
  };
}

function sign(t: TravelTicket, signer = hub, id = chainId) {
  return signer.signTypedData({
    domain: HUB_EIP712_DOMAIN(id),
    types: TravelTicketTypes,
    primaryType: "TravelTicket",
    message: t,
  });
}

async function verify(
  t: unknown,
  signature: unknown,
  over: { landId?: number; nowSeconds?: number } = {},
) {
  return verifyTravelTicket({
    ticket: t,
    signature,
    hubSigner: hub.address,
    chainId,
    landId: 3,
    nowSeconds: now,
    ...over,
  });
}

describe("verifyTravelTicket", () => {
  it("accepts a ticket signed by the Hub, sent over JSON", async () => {
    const t = ticket();
    const wire = JSON.parse(JSON.stringify(ticketToWire(t)));
    expect(await verify(wire, await sign(t))).toEqual(t);
  });

  it("accepts GATE_NONE and the longest allowed expiry", async () => {
    const t = ticket({
      gate: GATE_NONE,
      expiresAt: BigInt(now + TRAVEL_TICKET_TTL_SECONDS + 5),
    });
    expect(await verify(ticketToWire(t), await sign(t))).toEqual(t);
  });

  it("rejects another signer", async () => {
    const t = ticket();
    const other = privateKeyToAccount(generatePrivateKey());
    await expect(verify(ticketToWire(t), await sign(t, other))).rejects.toThrow(
      "not signed by the Hub",
    );
  });

  it("rejects a signature for another chain", async () => {
    const t = ticket();
    await expect(
      verify(ticketToWire(t), await sign(t, hub, 1)),
    ).rejects.toThrow(JoinRejected);
  });

  it("rejects a ticket for another Land", async () => {
    const t = ticket();
    await expect(
      verify(ticketToWire(t), await sign(t), { landId: 4 }),
    ).rejects.toThrow("another Land");
  });

  it("rejects an expired ticket", async () => {
    const t = ticket({ expiresAt: BigInt(now) });
    await expect(verify(ticketToWire(t), await sign(t))).rejects.toThrow(
      "expired",
    );
  });

  it("rejects a ticket that expires too far ahead", async () => {
    const t = ticket({
      expiresAt: BigInt(now + TRAVEL_TICKET_TTL_SECONDS + 6),
    });
    await expect(verify(ticketToWire(t), await sign(t))).rejects.toThrow(
      "too far ahead",
    );
  });

  it("rejects a ticket altered after signing", async () => {
    const t = ticket();
    const sig = await sign(t);
    await expect(
      verify(ticketToWire(ticket({ gate: 1 })), sig),
    ).rejects.toThrow("not signed by the Hub");
  });

  it("rejects a malformed signature", async () => {
    const wire = ticketToWire(ticket());
    for (const sig of [undefined, 1, "0x", `0x${"00".repeat(65)}`]) {
      await expect(verify(wire, sig)).rejects.toThrow(JoinRejected);
    }
  });

  const good = ticketToWire(ticket());
  const malformed: Array<[string, unknown]> = [
    ["null", null],
    ["a string", "ticket"],
    ["a short player", { ...good, player: "0x12" }],
    ["a numeric landId", { ...good, landId: 3 }],
    ["a hex landId", { ...good, landId: "0x3" }],
    ["a negative landId", { ...good, landId: "-3" }],
    ["a leading-zero landId", { ...good, landId: "03" }],
    ["an oversized landId", { ...good, landId: `1${"0".repeat(77)}` }],
    ["a gate of 5", { ...good, gate: 5 }],
    ["a fractional gate", { ...good, gate: 1.5 }],
    ["a string gate", { ...good, gate: "1" }],
    [
      "an expiresAt over uint64",
      { ...good, expiresAt: (2n ** 64n).toString() },
    ],
    ["a numeric expiresAt", { ...good, expiresAt: now }],
    ["a short nonce", { ...good, nonce: "0xab" }],
    ["a missing nonce", { ...good, nonce: undefined }],
  ];
  it.each(malformed)("rejects %s", async (_, wire) => {
    await expect(verify(wire, `0x${"11".repeat(65)}`)).rejects.toThrow(
      JoinRejected,
    );
  });
});

describe("parseWireTicket", () => {
  it("drops extra fields", () => {
    const t = ticket();
    expect(parseWireTicket({ ...ticketToWire(t), admin: true })).toEqual(t);
  });
});

describe("Delegation", () => {
  it("signs and verifies offline", async () => {
    const message = {
      landId: 3n,
      miningKey: privateKeyToAccount(generatePrivateKey()).address,
      issuedAt: BigInt(now),
    };
    const domain = HUB_EIP712_DOMAIN(chainId);
    const signature: Hex = await player.signTypedData({
      domain,
      types: DelegationTypes,
      primaryType: "Delegation",
      message,
    });
    const check = (address: typeof player.address, m = message) =>
      verifyTypedData({
        address,
        domain,
        types: DelegationTypes,
        primaryType: "Delegation",
        message: m,
        signature,
      });
    expect(await check(player.address)).toBe(true);
    expect(await check(hub.address)).toBe(false);
    expect(await check(player.address, { ...message, landId: 4n })).toBe(false);
  });
});

describe("relayLandUrl", () => {
  it("joins without double slashes", () => {
    expect(relayLandUrl("wss://relay.example", 7)).toBe(
      "wss://relay.example/land/7",
    );
    expect(relayLandUrl("ws://localhost:8080//", 7)).toBe(
      "ws://localhost:8080/land/7",
    );
  });
});

describe("shortAddress", () => {
  it("keeps tlr1 and the first and last 6 characters that differ", () => {
    expect(
      shortAddress(
        "tlr1qqq6pcg9hrzz8tnya7wl2f5c5w9gngwatvfahg05g22vq86w7v39c9saugmkh",
      ),
    ).toBe("tlr16pcg9h…augmkh");
  });
});
