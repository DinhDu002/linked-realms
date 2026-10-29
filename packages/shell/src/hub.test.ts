import { describe, expect, it, vi } from "vitest";
import { createHubClient, HubError } from "./hub.ts";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("hub client", () => {
  it("sends the token and the body, and reads the answer", async () => {
    const fetchImpl = reply(200, { token: "t" });
    const hub = createHubClient("http://hub.test", fetchImpl);
    await hub.ticket("tok", 2, 1);
    expect(fetchImpl).toHaveBeenCalledWith("http://hub.test/tickets", {
      method: "POST",
      headers: {
        Authorization: "Bearer tok",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ landId: 2, from: 1 }),
    });
  });

  it("raises the Hub's own message with its status", async () => {
    const hub = createHubClient(
      "http://hub.test",
      reply(409, { error: "Land is offline" }),
    );
    await expect(hub.ticket("t", 2)).rejects.toMatchObject({
      status: 409,
      message: "Land is offline",
    });
  });

  it("says when the Hub cannot be reached", async () => {
    const hub = createHubClient("http://hub.test", async () => {
      throw new TypeError("network");
    });
    await expect(hub.directory()).rejects.toMatchObject({ status: 0 });
  });

  it("reads 404 on the owner's Land as no Land", async () => {
    const hub = createHubClient(
      "http://hub.test",
      reply(404, { error: "Land not found" }),
    );
    expect(await hub.landOf("tlr1x")).toBeUndefined();
    const broken = createHubClient("http://hub.test", reply(500, {}));
    await expect(broken.landOf("tlr1x")).rejects.toBeInstanceOf(HubError);
  });
});
