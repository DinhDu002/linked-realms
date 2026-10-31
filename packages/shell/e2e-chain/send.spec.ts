// Item 19 of docs/plans/phase-2c-the-chain.md: a Shell on a dev Node sends Gold between two
// Characters (flow 4). The Node mines for MINER, who sends to a Character made in Setup.
import { expect, test, type Page } from "@playwright/test";
import { createCharacter, openShell, PASSWORD } from "../e2e/fixtures.ts";
import { MINER } from "./node.ts";

async function restoreMiner(page: Page) {
  await page.goto("/setup.html");
  await page.getByRole("button", { name: "Restore from 24 words" }).click();
  const form = page.locator("#step-restore");
  await form.getByLabel("Your 24 words").fill(MINER.words);
  await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await form.getByLabel("Repeat the password").fill(PASSWORD);
  await form.getByRole("button", { name: "Restore Character" }).click();
  await expect(page.locator("#done-address")).toHaveText(MINER.address);
  await openShell(page);
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

test("a Character sends Gold it mined to another, through the Shell's own prompt", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const sender = await (await browser.newContext()).newPage();
  const receiver = await (await browser.newContext()).newPage();
  const { address: to } = await createCharacter(receiver);
  await openShell(receiver);
  await expect(receiver.locator("#balance")).toHaveText("0 GOLD");
  await expect(
    receiver.getByRole("list", { name: "Recent transactions" }),
  ).toHaveText("No transactions yet.");

  await restoreMiner(sender);
  // The Node mines for MINER from its genesis: wait for a first Block's reward.
  await expect(async () => {
    await sender.getByRole("button", { name: "Refresh Directory" }).click();
    await expect(sender.locator("#balance")).not.toHaveText(/^(…|0 GOLD)$/, {
      timeout: 2_000,
    });
  }).toPass({ timeout: 300_000, intervals: [3_000] });

  const send = async (amount: string, memo: string) => {
    await sender.getByLabel("Recipient address").fill(to);
    await sender.getByLabel("Amount (GOLD)").fill(amount);
    await sender.getByLabel("Memo (optional, at most 80 bytes)").fill(memo);
    await sender.getByRole("button", { name: "Send", exact: true }).click();
    return sender.getByRole("dialog", { name: "Send Gold" });
  };

  // Deny signs nothing.
  let prompt = await send("2", "not this one");
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Deny" }).click();
  await expect(sender.locator("#send-status")).toHaveText(
    "Not sent: nothing was signed.",
  );

  // The prompt shows the full recipient address, the memo and the fee of a first transaction,
  // which carries the sender's public key: 2,517 + 10 + 1,312 bytes at the minimum 10 a byte.
  prompt = await send("1.25", "first Gold");
  await expect(prompt.locator("#pay-from")).toHaveText(
    new RegExp(`${MINER.address}`),
  );
  await expect(prompt.locator("#pay-to")).toHaveText(to);
  await expect(prompt.locator("#pay-amount")).toHaveText("1.25 GOLD");
  await expect(prompt.locator("#pay-memo")).toHaveText("first Gold");
  await expect(prompt.locator("#pay-fee")).toHaveText("0.0003839 GOLD");
  await expect(prompt.locator("#pay-total")).toHaveText("1.2503839 GOLD");
  const approve = prompt.getByRole("button", { name: "Approve" });
  await expect(approve).not.toHaveAttribute("aria-disabled");
  await approve.click();
  await expect(prompt).toBeHidden();
  await expect(sender.locator("#send-status")).toHaveText(
    "Sent 1.25 GOLD. It is confirmed once a Block holds it.",
  );
  await expect(
    sender.getByRole("list", { name: "Recent transactions" }),
  ).toContainText(`waiting for a Block · sent 1.25 GOLD to ${to}`);

  // Confirmed once a Block holds it, on both sides.
  const sent = new RegExp(
    `Block #\\d+ · sent 1\\.25 GOLD to ${to} · fee 0\\.0003839 GOLD · memo "first Gold"`,
  );
  await waitForTransaction(sender, sent, 300_000);
  await waitForTransaction(
    receiver,
    new RegExp(
      `Block #\\d+ · received 1\\.25 GOLD from ${MINER.address} · memo "first Gold"`,
    ),
    60_000,
  );
  await expect(receiver.locator("#balance")).toHaveText("1.25 GOLD");
});
