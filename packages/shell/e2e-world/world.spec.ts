// The world end to end (docs/plans/phase-2b-world-without-chain.md, Verification 4), against
// `docker compose --profile world up -d`: the real Hub, relay, Shell and two Map servers.
// Run with `pnpm e2e:world`; HUB_PORT, SHELL_PORT and WORLD_PROJECT follow compose.yaml.
import { execFileSync } from "node:child_process";
import { devices, expect, test, type Page } from "@playwright/test";

const HUB_URL = `http://localhost:${process.env.HUB_PORT || "8787"}`;
const PROJECT = process.env.WORLD_PROJECT || "linked-realms-world";
const PASSWORD = "correct horse battery";

// The development Characters that own map-1 and map-2 in compose.yaml. Public test words.
const OWNERS = [
  {
    address:
      "tlr1qqqanzv64uheqjxt9vau0el7p0gndh7rmaykuhd3g9h3dyu0fzrr0mqulz55w",
    words:
      "absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice comic",
  },
  {
    address:
      "tlr1qqq6mwhq8utpqyv32mfjujhr0tquwgkaek95p2rheewme5q2hcm2zzg40pln3",
    words:
      "acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount exchange",
  },
] as const;

interface Land {
  landId: number;
  owner: string;
  x: number | null;
  y: number | null;
  online: boolean;
}

async function directory(): Promise<Land[]> {
  const response = await fetch(`${HUB_URL}/directory`);
  return ((await response.json()) as { lands: Land[] }).lands;
}

const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-p", PROJECT, ...args], {
    stdio: "pipe",
  });

/** Restores `words` in Setup and opens the unlocked Shell. */
async function signIn(page: Page, owner: (typeof OWNERS)[number]) {
  await page.goto("/setup.html");
  await page.getByRole("button", { name: "Restore from 24 words" }).click();
  const form = page.locator("#step-restore");
  await form.getByLabel("Your 24 words").fill(owner.words);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Restore Character" }).click();
  await expect(page.locator("#done-address")).toHaveText(owner.address);
  await page.goto("/");
  const unlock = page.getByRole("dialog", { name: "Unlock the Shell" });
  await unlock.getByLabel("Password").fill(PASSWORD);
  await unlock.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#view-home")).toBeVisible();
}

/** Registers the Map server waiting for this Character, unless an earlier run did. */
async function registerLand(page: Page) {
  const status = page.locator("#land-status");
  await expect(status).toHaveText(/^(You have no Land yet|Your Land is Land)/);
  if ((await status.textContent())!.startsWith("You have no Land yet"))
    await page.getByRole("button", { name: /^Register Map server / }).click();
  await expect(status).toContainText("Your Land is Land");
}

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
