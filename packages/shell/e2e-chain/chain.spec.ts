// Gold end to end (docs/plans/phase-2c-the-chain.md, Verification 4), against
// `docker compose --profile world up -d` with the dev network's easy Target: Land 1's owner
// switches its Mine on, a visitor sees it win, the Land owner sends Gold it mined to the visitor
// through the Shell's own prompt, and the Mine is off after map-1 restarts.
// Run with `pnpm e2e:chain`; HUB_PORT, SHELL_PORT and WORLD_PROJECT follow compose.yaml.
import { expect, test, type Page } from "@playwright/test";
import {
  approveSigning,
  compose,
  directory,
  OWNERS,
  registerLand,
  signIn,
  type Land,
} from "../e2e-world/world.ts";

/** The base units of a Shell amount such as "1.25 GOLD" (8 decimals, crates/core/src/amount.rs). */
function units(text: string): bigint {
  const [whole, fraction = ""] = text.replace(/ GOLD$/, "").split(".");
  return BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
}

/** Refreshes the Home view until the balance passes `check`; returns it in base units. */
async function waitForBalance(
  page: Page,
  check: (units: bigint) => boolean,
  timeout: number,
) {
  let seen = -1n;
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh Directory" }).click();
    await expect(page.locator("#balance")).toHaveText(/^\d+(\.\d+)? GOLD$/, {
      timeout: 2_000,
    });
    seen = units((await page.locator("#balance").textContent())!);
    expect(check(seen)).toBe(true);
  }).toPass({ timeout, intervals: [3_000] });
  return seen;
}

/** Refreshes the Home view until the recent transactions hold a line matching `line`. */
async function waitForTransaction(page: Page, line: RegExp, timeout: number) {
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh Directory" }).click();
    await expect(
      page.getByRole("list", { name: "Recent transactions" }),
    ).toContainText(line, { timeout: 2_000 });
  }).toPass({ timeout, intervals: [3_000] });
}

test("Land 1's Mine wins Gold, its owner sends some to a visitor, and a restart leaves the Mine off", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const [owner, visitor] = OWNERS;
  // Two Characters, each in its own browser, and two Lands online.
  const pages: Page[] = [];
  for (const character of OWNERS) {
    const page = await (await browser.newContext()).newPage();
    await signIn(page, character);
    await registerLand(page);
    pages.push(page);
  }
  const [page, visitorPage] = pages as [Page, Page];
  let home!: Land;
  await expect
    .poll(
      async () => {
        const lands = await directory();
        home = lands.find((l) => l.owner === owner.address)!;
        return (
          !!home?.online &&
          lands.some((l) => l.owner === visitor.address && l.online)
        );
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const before = await waitForBalance(visitorPage, () => true, 30_000);

  // The Land owner and the visitor in Land 1; its Mine is off after every start (P5).
  const enter = async (each: Page) => {
    await each.locator("#refresh-directory").click();
    await each
      .getByRole("button", { name: `Enter Land ${home.landId}` })
      .click();
    const frame = each.frameLocator("#frame-area iframe");
    await expect(frame.locator("#hud-mine")).toHaveText("Mine OFF", {
      timeout: 60_000,
    });
    return frame;
  };
  const land = await enter(page);
  const visiting = await enter(visitorPage);

  // map-1 has 3 CPUs, so 2 threads, and room for fast mode (compose.yaml).
  await land.getByRole("button", { name: "Switch the Mine" }).click();
  await land.getByLabel("Threads").fill("2");
  await land.getByRole("button", { name: "Sign in the Shell" }).click();
  await approveSigning(page);
  await expect(land.locator("#hud-mine")).toContainText(
    "Mine ON · 2 threads · fast",
    { timeout: 180_000 },
  );
  // A Block won, and the effect in the visitor's client.
  await expect(visiting.locator("#hud-mine-won")).toHaveText(
    /^The Mine won Block #\d+ \(\+[\d.]+ GOLD\)$/,
    { timeout: 120_000 },
  );

  // Both go back to the Shell's Home view; the Mine keeps mining, so it takes the send.
  for (const each of pages) await each.locator("#leave").click();
  await waitForBalance(page, (gold) => gold > 0n, 60_000);
  const send = async (amount: string, memo: string) => {
    await page.getByLabel("Recipient address").fill(visitor.address);
    await page.getByLabel("Amount (GOLD)").fill(amount);
    await page.getByLabel("Memo (optional, at most 80 bytes)").fill(memo);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    return page.getByRole("dialog", { name: "Send Gold" });
  };

  // Deny signs nothing.
  let prompt = await send("2", "not this one");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Deny" }).click();
  await expect(page.locator("#send-status")).toHaveText(
    "Not sent: nothing was signed.",
  );

  // The prompt shows the full recipient address, the memo, and the fee at the minimum of 10 a
  // byte: 2,517 + 10 bytes, plus 1,312 for the public key if this is the Account's first send
  // (a world kept from an earlier run has it on the chain already).
  prompt = await send("1.25", "first Gold");
  await expect(prompt.locator("#pay-from")).toContainText(owner.address);
  await expect(prompt.locator("#pay-to")).toHaveText(visitor.address);
  await expect(prompt.locator("#pay-amount")).toHaveText("1.25 GOLD");
  await expect(prompt.locator("#pay-memo")).toHaveText("first Gold");
  await expect(prompt.locator("#pay-fee")).toHaveText(
    /^0\.000(3839|2527) GOLD$/,
  );
  const fee = (await prompt.locator("#pay-fee").textContent())!;
  expect(units((await prompt.locator("#pay-total").textContent())!)).toBe(
    units("1.25 GOLD") + units(fee),
  );
  await prompt.getByRole("button", { name: "Approve" }).click();
  await expect(prompt).toBeHidden();
  await expect(page.locator("#send-status")).toHaveText(
    "Sent 1.25 GOLD. It is confirmed once a Block holds it.",
  );
  await expect(
    page.getByRole("list", { name: "Recent transactions" }),
  ).toContainText(`waiting for a Block · sent 1.25 GOLD to ${visitor.address}`);

  // Confirmed once a Block holds it, on both sides, and the visitor's balance changes.
  await waitForTransaction(
    page,
    new RegExp(
      `Block #\\d+ · sent 1\\.25 GOLD to ${visitor.address} · fee ${fee.replace(".", "\\.")} · memo "first Gold"`,
    ),
    120_000,
  );
  await waitForTransaction(
    visitorPage,
    new RegExp(
      `Block #\\d+ · received 1\\.25 GOLD from ${owner.address} · memo "first Gold"`,
    ),
    60_000,
  );
  await waitForBalance(
    visitorPage,
    (gold) => gold === before + units("1.25 GOLD"),
    30_000,
  );

  // A restart of map-1 starts its Node with the Mine off (P5).
  compose("restart", "map-1");
  await expect
    .poll(
      () => compose("ps", "--format", "{{.Health}}", "map-1").toString().trim(),
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe("healthy");
  await expect
    .poll(
      async () =>
        (await directory()).find((l) => l.landId === home.landId)?.online,
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  await enter(page);
  // Leave Land 1: a Map server refuses a Character already in it ("duplicate").
  for (const each of pages) await each.context().close();
});
