import { Key } from "@linked-realms/core";
import {
  parseStatement,
  signStatement,
  verifyStatement,
} from "@linked-realms/shared/identity";
import { describe, expect, it, vi } from "vitest";
import { createAccount } from "./account.ts";
import { hubHostOf } from "./config.ts";
import { prepareHandoff } from "./handoff.ts";
import { HubError, type HubClient } from "./hub.ts";
import { sealEntropy } from "./keystore.ts";
import { LockedError, createVault } from "./vault.ts";

const entropy = new Uint8Array(32).fill(9);
const ticketKey = Key.fromSeed(new Uint8Array(32).fill(0x48));
const small = { m: 8, t: 1, p: 1 };

async function setup(now = () => 1_700_000_000_000) {
  const character = Key.fromEntropy(entropy, 0);
  const address = character.address;
  character.free();
  const vault = createVault(await sealEntropy(entropy, address, "pw", small));
  await vault.unlock("pw");
  const signIn = vi.fn(async (signed: unknown) => {
    const { fields } = verifyStatement(signed, "hub-sign-in");
    return {
      token: `token-${fields.nonce}`,
      address,
      name: "Lan",
      expiresAt: Math.floor(now() / 1000) + 3600,
    };
  });
  const ticket = vi.fn(async (_token: string, landId: number, from?: number) =>
    signStatement(
      "travel-ticket",
      {
        hub: "hub.test",
        character: address,
        name: "Lan",
        land: landId,
        gate: from === undefined ? 0 : 4,
        issued: 1_700_000_000,
        expires: 1_700_000_060,
        nonce: "ab".repeat(16),
      },
      ticketKey,
    ),
  );
  const hub = { signIn, ticket } as unknown as HubClient;
  return {
    vault,
    address,
    signIn,
    ticket,
    hub,
    account: createAccount({ vault, hub, hubHost: "hub.test", now }),
  };
}

describe("account", () => {
  it("signs in with a statement of its own, once, and keeps the token and name", async () => {
    const { account, signIn, vault, address } = await setup();
    const used = vi.fn(async (token: string) => token);
    const token = await account.call(used);
    await account.call(used);
    expect(signIn).toHaveBeenCalledOnce();
    expect(token).toMatch(/^token-[0-9a-f]{32}$/);
    expect(account.name).toBe("Lan");
    const statement = signIn.mock.calls[0]![0] as { statement: string };
    expect(parseStatement("hub-sign-in", statement.statement)).toMatchObject({
      hub: "hub.test",
      issued: 1_700_000_000,
    });
    expect(verifyStatement(statement, "hub-sign-in").address).toBe(address);
    expect(vault.token?.value).toBe(token);
  });

  it("shares one sign-in between calls made together", async () => {
    const { account, signIn } = await setup();
    await Promise.all([
      account.call(async () => 1),
      account.call(async () => 2),
    ]);
    expect(signIn).toHaveBeenCalledOnce();
  });

  it("signs in again when the token is about to expire", async () => {
    let time = 1_700_000_000_000;
    const { account, signIn } = await setup(() => time);
    await account.call(async () => 1);
    time += 3600_000 - 10_000;
    await account.call(async () => 1);
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it("signs in again once when the Hub says the session is stale", async () => {
    const { account, signIn } = await setup();
    const use = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(new HubError(401, "invalid or expired session"))
      .mockResolvedValueOnce("ok");
    expect(await account.call(use)).toBe("ok");
    expect(signIn).toHaveBeenCalledTimes(2);
    await expect(
      account.call(async () => {
        throw new HubError(401, "again");
      }),
    ).rejects.toThrow("again");
  });

  it("needs the Shell unlocked, and a sign-in that ends after Lock leaves no token", async () => {
    const { account, vault } = await setup();
    vault.lock();
    await expect(account.call(async () => 1)).rejects.toBeInstanceOf(
      LockedError,
    );
    expect(vault.token).toBeUndefined();
  });
});

describe("handoff", () => {
  it("asks for a ticket and signs an arrival that binds its nonce, not driven by an AI", async () => {
    const { vault, account, hub, ticket, address } = await setup();
    const handoff = await prepareHandoff({ account, hub, vault }, 7, 6);
    expect(ticket).toHaveBeenCalledWith(expect.any(String), 7, 6);
    const arrival = verifyStatement(handoff.arrival, "arrival");
    expect(arrival.address).toBe(address);
    expect(arrival.fields).toEqual({
      land: 7,
      ticketNonce: "ab".repeat(16),
      drivenByAi: false,
    });
    expect(parseStatement("travel-ticket", handoff.ticket.statement).gate).toBe(
      4,
    );
  });

  it("refuses a ticket for another Land", async () => {
    const { vault, account, hub } = await setup();
    await expect(
      prepareHandoff({ account, hub, vault }, 8),
    ).resolves.toBeDefined();
    (hub.ticket as ReturnType<typeof vi.fn>).mockImplementationOnce(async () =>
      signStatement(
        "travel-ticket",
        {
          hub: "hub.test",
          character: vault.address,
          name: "",
          land: 99,
          gate: 0,
          issued: 1,
          expires: 2,
          nonce: "cd".repeat(16),
        },
        ticketKey,
      ),
    );
    await expect(prepareHandoff({ account, hub, vault }, 8)).rejects.toThrow(
      /another Land/,
    );
  });
});

describe("the Hub's host in statements", () => {
  it("is the URL's host, with its port when it is not the default", () => {
    expect(hubHostOf("http://localhost:8787")).toBe("localhost:8787");
    expect(hubHostOf("https://hub.example.org")).toBe("hub.example.org");
    expect(hubHostOf("https://hub.example.org:443")).toBe("hub.example.org");
    expect(hubHostOf("https://Hub.Example.org:8443/")).toBe(
      "hub.example.org:8443",
    );
  });
});
