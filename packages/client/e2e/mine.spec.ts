// The Land's Mine in a real browser (docs/plans/phase-2c-the-chain.md, item 24): the reference Map
// server with a Node the test drives, and a stub Shell that frames the Land UI, hands it a Travel
// ticket and answers each signMessage as the test says.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser } from "@playwright/test";
import { Key } from "@linked-realms/core";
import { parseLandMap } from "@linked-realms/shared";
import { signStatement } from "@linked-realms/shared/identity";
import {
  createLandServer,
  type LandServer,
} from "@linked-realms/map-server/src/land.ts";
import type {
  BlockFound,
  MineStatus,
  NodeLink,
} from "@linked-realms/map-server/src/node.ts";

const LAND_ID = 7;
const seeded = (byte: number) => Key.fromSeed(new Uint8Array(32).fill(byte));
const hub = seeded(0x48);
const owner = seeded(1);
const visitor = seeded(2);
const mapServer = seeded(0x4d);
const OFF: MineStatus = {
  state: "off",
  threads: 0,
  mode: null,
  hashRate: 0,
  blocksWon: 0,
  rewardAddress: null,
};
const mapText = readFileSync(
  fileURLToPath(new URL("../../../maps/empty-land.json", import.meta.url)),
  "utf8",
);
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A Node the test drives: the calls it got, its status, and its wins. */
function fakeNode() {
  const changed: (() => void)[] = [];
  const won: ((found: BlockFound) => void)[] = [];
  let status = OFF;
  const change = (next: MineStatus) => {
    status = next;
    for (const listener of changed) listener();
  };
  const calls: unknown[][] = [];
  const link: NodeLink = {
    info: () => ({ synced: true, connections: 1, maxThreads: 4 }),
    status: () => status,
    async start(rewardAddress, threads) {
      calls.push(["start", rewardAddress, threads]);
      change({ ...OFF, state: "starting", threads, rewardAddress });
      return status;
    },
    async stop() {
      calls.push(["stop"]);
      change(OFF);
      return status;
    },
    onChange: (listener) => void changed.push(listener),
    onWon: (listener) => void won.push(listener),
  };
  const win = (found: BlockFound) => {
    for (const listener of won) listener(found);
  };
  return { link, calls, change, win };
}

let node: ReturnType<typeof fakeNode>;
let server: LandServer;
let landUrl: string;
// The stub Shells, by path, on another origin than the Land (both on loopback, which Chromium
// requires of a page that frames one there).
const shells = new Map<string, string>();
let shellServer: Server;
let shellOrigin: string;

test.beforeAll(async () => {
  shellServer = createServer((request, response) => {
    const page = shells.get(request.url ?? "");
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" });
    response.end(page ?? "");
  });
  await new Promise<void>((resolve) =>
    shellServer.listen(0, "127.0.0.1", resolve),
  );
  shellOrigin = `http://localhost:${(shellServer.address() as AddressInfo).port}`;
});

test.afterAll(() => shellServer.close());

test.beforeEach(async () => {
  node = fakeNode();
  server = createLandServer({
    map: parseLandMap(mapText),
    mapText,
    hubTicketSigner: hub.address,
    landUiDir: fileURLToPath(new URL("../dist", import.meta.url)),
    mapServerKey: mapServer.address,
    node: node.link,
  });
  server.setLand({ landId: LAND_ID, owner: owner.address, ownerName: "Mai" });
  landUrl = `http://127.0.0.1:${await server.listen(0, "127.0.0.1")}`;
});

test.afterEach(() => server.close());

/** The handoff the Shell gives the Land UI: the Hub's Travel ticket and the Character's arrival. */
function handoff(character: Key) {
  const nonce = randomBytes(16).toString("hex");
  const issued = nowSeconds();
  return {
    ticket: signStatement(
      "travel-ticket",
      {
        hub: "hub.test",
        character: character.address,
        name: "",
        land: LAND_ID,
        gate: 0,
        issued,
        expires: issued + 60,
        nonce,
      },
      hub,
    ),
    arrival: signStatement(
      "arrival",
      { land: LAND_ID, ticketNonce: nonce, drivenByAi: false },
      character,
    ),
  };
}

/**
 * Opens the Land in a stub Shell for `character`, in a browser context of its own, framed with the
 * sandbox shell-land-ui.md requires (no forms). Each signMessage is signed with the Character's
 * key as a Land message, or denied, as `answer` says.
 */
async function openLand(
  browser: Browser,
  character: Key,
  answer: () => "approve" | "deny" = () => "approve",
) {
  const page = await (await browser.newContext()).newPage();
  await page.exposeFunction("signLand", (text: string) =>
    answer() === "deny"
      ? { error: "denied" }
      : {
          signed: signStatement(
            "land-message",
            {
              land: LAND_ID,
              landUrl,
              character: character.address,
              issued: nowSeconds(),
              message: text,
            },
            character,
          ),
        },
  );
  const init = {
    type: "init",
    land: { landId: LAND_ID, url: landUrl, ownerName: "Mai" },
    character: { address: character.address, name: "" },
    handoff: handoff(character),
  };
  const shell = `<!doctype html>
<iframe src="${landUrl}/" sandbox="allow-scripts allow-same-origin allow-pointer-lock" style="width: 960px; height: 640px; border: 0"></iframe>
<script>
  const frame = document.querySelector("iframe");
  frame.addEventListener("load", () => {
    const { port1, port2 } = new MessageChannel();
    frame.contentWindow.postMessage({ type: "linked-realms/connect", api: 1 }, "*", [port2]);
    port1.onmessage = async ({ data }) => {
      if (data.type === "signMessage")
        port1.postMessage({ type: "signResult", id: data.id, ...(await signLand(data.text)) });
    };
    port1.postMessage(${JSON.stringify(init)});
  });
</script>`;
  const path = `/${randomBytes(8).toString("hex")}`;
  shells.set(path, shell);
  await page.goto(shellOrigin + path);
  return page.frameLocator("iframe");
}

test("the Land owner's switch asks the Shell: Deny changes nothing, Approve starts the Mine", async ({
  browser,
}) => {
  let answer: "approve" | "deny" = "deny";
  const land = await openLand(browser, owner, () => answer);
  await expect(land.locator("#hud-mine")).toHaveText("Mine OFF");
  await land.getByRole("button", { name: "Switch the Mine" }).click();
  await land.getByLabel("Threads").fill("2");
  const sign = land.getByRole("button", { name: "Sign in the Shell" });
  await sign.click();
  await expect(land.locator("#hud-notice")).toHaveText(
    "You did not sign, so nothing changed.",
  );
  expect(node.calls).toEqual([]);

  answer = "approve";
  await sign.click();
  await expect(land.locator("#hud-notice")).toHaveText("The Mine is starting.");
  expect(node.calls).toEqual([["start", owner.address, 2]]);
  await expect(land.locator("#hud-mine")).toContainText(
    "Mine starting · 2 threads",
  );
  await expect(land.locator("#mine-form")).toBeHidden();
});

test("a visitor sees the Mine run and the win flash, but has no switch", async ({
  browser,
}) => {
  const owned = await openLand(browser, owner);
  const visiting = await openLand(browser, visitor);
  await expect(visiting.locator("#hud-mine")).toHaveText("Mine OFF");
  await expect(owned.locator("#mine-open")).toBeVisible();
  await expect(visiting.locator("#mine-open")).toBeHidden();

  node.change({
    state: "on",
    threads: 2,
    mode: "fast",
    hashRate: 1180.5,
    blocksWon: 0,
    rewardAddress: owner.address,
  });
  for (const land of [owned, visiting])
    await expect(land.locator("#hud-mine")).toContainText(
      "Mine ON · 2 threads · fast",
    );
  node.win({
    height: 1240,
    reward: "500004000",
    rewardAddress: owner.address,
  });
  for (const land of [owned, visiting])
    await expect(land.locator("#hud-mine-won")).toHaveText(
      "The Mine won Block #1240 (+5.00004 GOLD)",
    );
  await expect(visiting.locator("#mine-open")).toBeHidden();
});
