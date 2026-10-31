// The world end to end (docs/plans/phase-2b-world-without-chain.md, Verification 4, and the Mine
// of docs/plans/phase-2c-the-chain.md, item 24), against `docker compose --profile world up -d`:
// the real Hub, relay, Shell, seed Node and two Map servers with their Nodes.
// Run with `pnpm e2e:world`; HUB_PORT, SHELL_PORT and WORLD_PROJECT follow compose.yaml.
import { devices, expect, test, type Page } from "@playwright/test";
import {
  approveSigning,
  compose,
  directory,
  OWNERS,
  registerLand,
  signIn,
  type Land,
} from "./world.ts";

test("two Characters register their Lands, and one walks through a Gate into the other", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // 1-2. Each Character in its own browser (its own IndexedDB) registers the Map server naming it.
  const pages: Page[] = [];
  for (const owner of OWNERS) {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, owner);
    await registerLand(page);
    pages.push(page);
  }

  // 3. Both Lands get adjacent cells once the Hub's sweep sees them online (every 15 seconds).
  let home!: Land;
  let neighbour!: Land;
  await expect
    .poll(
      async () => {
        const lands = await directory();
        home = lands.find((l) => l.owner === OWNERS[0].address)!;
        neighbour = lands.find((l) => l.owner === OWNERS[1].address)!;
        return (
          !!home?.online &&
          !!neighbour?.online &&
          home.x !== null &&
          neighbour.x !== null &&
          Math.abs(home.x - neighbour.x!) + Math.abs(home.y! - neighbour.y!)
        );
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(1);

  // 4. The first Character enters its own Land and walks through the east Gate into the other,
  // which the spiral puts east of the first.
  expect([neighbour.x! - home.x!, neighbour.y! - home.y!]).toEqual([1, 0]);
  const page = pages[0]!;
  const iframe = page.locator("#frame-area iframe");
  const land = page.frameLocator("#frame-area iframe");
  await page.getByRole("button", { name: `Enter Land ${home.landId}` }).click();
  await expect(land.locator("#hud-land")).toContainText(`Land ${home.landId}`);
  await expect(land.locator("#pad")).toBeHidden(); // touch screens only
  // The spawn is under the Mine, 1.5 tiles south of the Gate's rows: walk to the east edge
  // (32 tiles at 4 tiles a second), then north along it into the Gate.
  await land.locator("canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(11_000);
  await page.keyboard.down("ArrowUp");
  await expect(iframe).toHaveAttribute("title", `Land ${neighbour.landId}`, {
    timeout: 10_000,
  });
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("ArrowRight");
  // The neighbour's Map server took the ticket and the arrival.
  await expect(land.locator("#hud-land")).toContainText(
    `Land ${neighbour.landId}`,
  );
  // It placed the Character one tile inside its west Gate: one step west is the way home.
  await land.locator("canvas").click({ position: { x: 5, y: 5 } });
  await page.keyboard.down("ArrowLeft");
  await expect(iframe).toHaveAttribute("title", `Land ${home.landId}`, {
    timeout: 4_000,
  });
  await page.keyboard.up("ArrowLeft");
  await expect(land.locator("#hud-land")).toContainText(`Land ${home.landId}`);

  // 5. Stopping the first Land's Map server shows it offline; starting it brings it back.
  await page.locator("#leave").click();
  const row = page.locator("#directory li", {
    hasText: `Land ${home.landId} `,
  });
  compose("stop", "map-1");
  try {
    await expect
      .poll(
        async () =>
          (await directory()).find((l) => l.landId === home.landId)?.online,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(false);
    await page.locator("#refresh-directory").click();
    await expect(row.locator(".offline")).toHaveText("offline");
  } finally {
    compose("start", "map-1");
  }
  await expect
    .poll(
      async () =>
        (await directory()).find((l) => l.landId === home.landId)?.online,
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  await page.locator("#refresh-directory").click();
  await expect(row.locator(".online")).toHaveText("online");
});

test("the Land owner switches the Mine on in the Shell, a visitor sees it win, and it goes off", async ({
  browser,
}) => {
  test.setTimeout(360_000);
  const home = (await directory()).find((l) => l.owner === OWNERS[0].address)!;
  expect(home.online).toBe(true);
  // The Land owner and a visitor, each in its own browser, in Land 1.
  const pages: Page[] = [];
  for (const character of OWNERS) {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, character);
    await page
      .getByRole("button", { name: `Enter Land ${home.landId}` })
      .click();
    pages.push(page);
  }
  const [page, visitorPage] = pages as [Page, Page];
  const land = page.frameLocator("#frame-area iframe");
  const visiting = visitorPage.frameLocator("#frame-area iframe");
  // Off after every start; available once map-1's Node has the seed and its chain (P5).
  for (const view of [land, visiting])
    await expect(view.locator("#hud-mine")).toHaveText("Mine OFF", {
      timeout: 60_000,
    });
  // The visitor's frame is loaded, so a hidden switch is one it was not given.
  await expect(visiting.locator("#mine-open")).toBeHidden();

  // map-1 has 3 CPUs, so 2 threads, and room for fast mode (compose.yaml).
  await land.getByRole("button", { name: "Switch the Mine" }).click();
  await land.getByLabel("Threads").fill("2");
  await land.getByRole("button", { name: "Sign in the Shell" }).click();
  await approveSigning(page);
  await expect(land.locator("#hud-notice")).toHaveText("The Mine is starting.");
  // Fast mode builds its 2 GiB dataset first.
  for (const view of [land, visiting])
    await expect(view.locator("#hud-mine")).toContainText(
      "Mine ON · 2 threads · fast",
      { timeout: 180_000 },
    );
  // The dev network's easy Target: a Block within seconds, flashed to the visitor too.
  await expect(visiting.locator("#hud-mine-won")).toHaveText(
    /^The Mine won Block #\d+ \(\+[\d.]+ GOLD\)$/,
    { timeout: 120_000 },
  );

  await land.getByRole("button", { name: "Switch the Mine" }).click();
  await expect(land.getByLabel("Off")).toBeChecked();
  await land.getByRole("button", { name: "Sign in the Shell" }).click();
  await approveSigning(page);
  for (const view of [land, visiting])
    await expect(view.locator("#hud-mine")).toHaveText("Mine OFF", {
      timeout: 30_000,
    });
  // Leave Land 1: a Map server refuses a Character already in it ("duplicate").
  for (const each of pages) await each.context().close();
});

test("on a phone, the touch pad walks a Character through a Gate and back", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // A phone with a touch screen, in this project's Chromium.
  const context = await browser.newContext(devices["Pixel 7"]);
  const page = await context.newPage();
  await signIn(page, OWNERS[0]);
  const lands = await directory();
  const home = lands.find((l) => l.owner === OWNERS[0].address)!;
  const neighbour = lands.find((l) => l.owner === OWNERS[1].address)!;
  expect(home.online && neighbour.online).toBe(true);
  expect([neighbour.x! - home.x!, neighbour.y! - home.y!]).toEqual([1, 0]);

  const iframe = page.locator("#frame-area iframe");
  const land = page.frameLocator("#frame-area iframe");
  await page.getByRole("button", { name: `Enter Land ${home.landId}` }).click();
  await expect(land.locator("#hud-land")).toContainText(`Land ${home.landId}`);
  const pad = land.locator("#pad");
  await expect(pad).toBeVisible();
  const box = (await pad.boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const reach = box.width * 0.4;
  // Real touches, as a finger makes them (Chromium's DevTools protocol).
  const cdp = await context.newCDPSession(page);
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    dx = 0,
    dy = 0,
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints:
        type === "touchEnd" ? [] : [{ x: centre.x + dx, y: centre.y + dy }],
    });
  // As with the keys: east to the edge, then the finger slides to north-east into the Gate.
  await touch("touchStart", reach, 0);
  await page.waitForTimeout(11_000);
  await touch("touchMove", reach * 0.7, -reach * 0.7);
  await expect(iframe).toHaveAttribute("title", `Land ${neighbour.landId}`, {
    timeout: 10_000,
  });
  await touch("touchEnd");
  await expect(land.locator("#hud-land")).toContainText(
    `Land ${neighbour.landId}`,
  );
  // One tap-and-hold west is the way home.
  await expect(land.locator("#pad")).toBeVisible();
  await touch("touchStart", -reach, 0);
  await expect(iframe).toHaveAttribute("title", `Land ${home.landId}`, {
    timeout: 4_000,
  });
  await touch("touchEnd");
  await expect(land.locator("#hud-land")).toContainText(`Land ${home.landId}`);
  await context.close();
});
