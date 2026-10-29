import { test as base, expect, type Frame, type Page } from "@playwright/test";
import { HUB_URL, landOrigin, SHELL_ORIGIN } from "./ports.ts";

export { expect };

export const PASSWORD = "correct horse battery";

/** What the hostile Land page (land-server.ts) exposes inside its frame. */
interface LandApi {
  log: Record<string, unknown>[];
  clicks: number;
  connect?: { api: number; origin: string };
  send(message: unknown): void;
  count(type: string, id?: string): number;
  probe(): Promise<Record<string, unknown>>;
  shout(message: unknown): void;
  reload(): void;
}
declare global {
  var land: LandApi;
}

interface RawHubState {
  signIns: Record<string, number>;
  tickets: { landId: number; from?: number; character: string }[];
  reports: { landId: number; reason: string; reporter: string }[];
  delegations: { owner: string; hub: string; mapServerKey: string }[];
  names: Record<string, string>;
  sessionTokens: string[];
}

/** What the Hub stub has seen from one Character (the stub is shared by every test in parallel). */
export async function hubState(address: string) {
  const raw = (await (await fetch(`${HUB_URL}/__state`)).json()) as RawHubState;
  return {
    signIns: raw.signIns[address] ?? 0,
    tickets: raw.tickets.filter((t) => t.character === address),
    reports: raw.reports.filter((r) => r.reporter === address),
    delegations: raw.delegations.filter((d) => d.owner === address),
    name: raw.names[address],
    sessionTokens: raw.sessionTokens,
  };
}

/** Runs Setup's "Create a new Character"; returns its address and its 24 words. */
export async function createCharacter(
  page: Page,
  password = PASSWORD,
): Promise<{ address: string; words: string[] }> {
  await page.goto("/setup.html");
  await page.getByRole("button", { name: "Create a new Character" }).click();
  const words = await page.locator("#words li").allTextContents();
  expect(words).toHaveLength(24);
  await page.getByRole("button", { name: "I wrote them down" }).click();
  for (const label of await page.locator("#confirm-fields label").all()) {
    const n = Number(/#(\d+)/.exec((await label.textContent()) ?? "")![1]);
    await page.getByLabel(`Word #${n}`, { exact: true }).fill(words[n - 1]!);
  }
  const form = page.locator("#step-confirm");
  await form.getByLabel("Password", { exact: true }).fill(password);
  await form.getByLabel("Repeat the password").fill(password);
  await form.getByRole("button", { name: "Create Character" }).click();
  await expect(page.locator("#done")).toBeVisible();
  return {
    address: (await page.locator("#done-address").textContent())!,
    words,
  };
}

export function unlockDialog(page: Page) {
  return page.getByRole("dialog", { name: "Unlock the Shell" });
}

export async function unlock(page: Page, password = PASSWORD) {
  const dialog = unlockDialog(page);
  await dialog.getByLabel("Password").fill(password);
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog).toBeHidden();
}

/** Opens the Shell and unlocks it. */
export async function openShell(page: Page) {
  await page.goto("/");
  await unlock(page);
  await expect(page.locator("#view-home")).toBeVisible();
}

/** The frame of a Land once it has received `init` (the Shell's connection is up). */
export async function connectedFrame(
  page: Page,
  landId: number,
): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        found = page
          .frames()
          .find((f) => f.url().startsWith(landOrigin(landId)));
        if (!found) return false;
        try {
          return await found.evaluate(() => land.count("init") > 0);
        } catch {
          return false; // navigating
        }
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found!;
}

export async function enterLand(page: Page, landId: number): Promise<Frame> {
  await page.getByRole("button", { name: `Enter Land ${landId}` }).click();
  return connectedFrame(page, landId);
}

/** The messages a Land has received on its port, of one type. */
export const received = (frame: Frame, type: string) =>
  frame.evaluate((t) => land.log.filter((m) => m.type === t), type) as Promise<
    Record<string, unknown>[]
  >;

export const send = (frame: Frame, message: unknown) =>
  frame.evaluate((m) => land.send(m), message);

export function signPrompt(page: Page) {
  return page.getByRole("dialog", {
    name: "A Land asks you to sign a message",
  });
}

/** A Character made once per worker and stored in each test's browser, so tests do not wait for Setup. */
export const test = base.extend<
  { shellOrigin: string },
  {
    character: {
      address: string;
      state: Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>;
    };
  }
>({
  character: [
    async ({ browser }, use) => {
      const context = await browser.newContext({ baseURL: SHELL_ORIGIN });
      const page = await context.newPage();
      const { address } = await createCharacter(page);
      const state = await context.storageState({ indexedDB: true });
      await context.close();
      await use({ address, state });
    },
    { scope: "worker" },
  ],
  storageState: async ({ character }, use) => use(character.state),
  shellOrigin: SHELL_ORIGIN,
});

/** Tests that start from an empty browser. */
export const plain = base;
