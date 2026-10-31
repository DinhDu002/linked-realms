// What the world's end-to-end runs share (e2e-world/world.spec.ts, e2e-chain/chain.spec.ts), against
// `docker compose --profile world up -d`. HUB_PORT and WORLD_PROJECT follow compose.yaml.
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

export const HUB_URL = `http://localhost:${process.env.HUB_PORT || "8787"}`;
export const PROJECT = process.env.WORLD_PROJECT || "linked-realms-world";
export const PASSWORD = "correct horse battery";

// The development Characters that own map-1 and map-2 in compose.yaml. Public test words.
export const OWNERS = [
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

export interface Land {
  landId: number;
  owner: string;
  x: number | null;
  y: number | null;
  online: boolean;
}

export async function directory(): Promise<Land[]> {
  const response = await fetch(`${HUB_URL}/directory`);
  return ((await response.json()) as { lands: Land[] }).lands;
}

export const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-p", PROJECT, ...args], {
    stdio: "pipe",
  });

/** Restores `words` in Setup and opens the unlocked Shell. */
export async function signIn(page: Page, owner: (typeof OWNERS)[number]) {
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
export async function registerLand(page: Page) {
  const status = page.locator("#land-status");
  await expect(status).toHaveText(/^(You have no Land yet|Your Land is Land)/);
  if ((await status.textContent())!.startsWith("You have no Land yet"))
    await page.getByRole("button", { name: /^Register Map server / }).click();
  await expect(status).toContainText("Your Land is Land");
}

/** Approves the Land's signMessage in the Shell's own prompt, which takes no click in its first second. */
export async function approveSigning(page: Page) {
  const prompt = page.getByRole("dialog", {
    name: "A Land asks you to sign a message",
  });
  await expect(prompt).toBeVisible();
  await page.waitForTimeout(1200);
  await prompt.getByRole("button", { name: "Approve" }).click();
  await expect(prompt).toBeHidden();
}
