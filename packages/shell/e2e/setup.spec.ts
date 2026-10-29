import {
  createCharacter,
  expect,
  openShell,
  PASSWORD,
  plain as test,
  unlock,
  unlockDialog,
} from "./fixtures.ts";

interface StoredKey {
  version: number;
  address: string;
  kdf: { alg: string; m: number; t: number; p: number; salt: Uint8Array };
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

test.describe("Setup", () => {
  test("creates a Character: 24 words, three confirmed, stored encrypted", async ({
    page,
  }) => {
    const { address, words } = await createCharacter(page);
    expect(address).toMatch(/^tlr1[a-z0-9]{60,}$/);
    expect(new Set(words).size).toBeGreaterThan(1);
    // Setup never shows a Land and has no frame.
    await expect(page.locator("iframe")).toHaveCount(0);
    // The words are gone from the page once the Character is stored.
    await expect(page.locator("body")).not.toContainText(
      words[0]! + " " + words[1]!,
    );

    const record = await page.evaluate(
      () =>
        new Promise<StoredKey>((resolve, reject) => {
          const open = indexedDB.open("linked-realms-shell");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result
              .transaction("keys")
              .objectStore("keys")
              .get("character");
            get.onsuccess = () => resolve(get.result);
          };
        }),
    );
    expect(Object.keys(record).sort()).toEqual(
      ["address", "ciphertext", "iv", "kdf", "version"].sort(),
    );
    expect(record).toMatchObject({
      version: 1,
      address,
      kdf: { alg: "argon2id", m: 65536, t: 3, p: 1 },
    });
    expect(record.kdf.salt).toHaveLength(16);
    expect(record.iv).toHaveLength(12);
    expect(record.ciphertext).toHaveLength(32 + 16); // 32 bytes and the AES-GCM tag
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
  });

  test("refuses a wrong confirmation word and a weak password", async ({
    page,
  }) => {
    await page.goto("/setup.html");
    await page.getByRole("button", { name: "Create a new Character" }).click();
    await page.getByRole("button", { name: "I wrote them down" }).click();
    for (const field of await page.locator("#confirm-fields input").all())
      await field.fill("zoo");
    await page
      .locator("#step-confirm")
      .getByLabel("Password", { exact: true })
      .fill("short");
    await page
      .locator("#step-confirm")
      .getByLabel("Repeat the password")
      .fill("short");
    await page.getByRole("button", { name: "Create Character" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "is not right" }),
    ).toBeVisible();
    await expect(page.locator("#done")).toBeHidden();
  });

  test("restores the same Character from its 24 words", async ({
    browser,
    page,
  }) => {
    const { address, words } = await createCharacter(page);
    const other = await browser.newContext({ baseURL: page.url() });
    try {
      const second = await other.newPage();
      await second.goto("/setup.html");
      await second
        .getByRole("button", { name: "Restore from 24 words" })
        .click();
      await second
        .getByLabel("Your 24 words")
        .fill(words.join("  ").toUpperCase());
      await second
        .locator("#step-restore")
        .getByLabel("Password", { exact: true })
        .fill("another password");
      await second
        .locator("#step-restore")
        .getByLabel("Repeat the password")
        .fill("another password");
      await second.getByRole("button", { name: "Restore Character" }).click();
      await expect(second.locator("#done-address")).toHaveText(address);
      // The words are not left in the field.
      await expect(second.getByLabel("Your 24 words")).toHaveValue("");
    } finally {
      await other.close();
    }
  });

  test("refuses words that are not a phrase", async ({ page }) => {
    await page.goto("/setup.html");
    await page.getByRole("button", { name: "Restore from 24 words" }).click();
    await page
      .locator("#step-restore")
      .getByLabel("Your 24 words")
      .fill("not a real phrase at all");
    await page
      .locator("#step-restore")
      .getByLabel("Password", { exact: true })
      .fill(PASSWORD);
    await page
      .locator("#step-restore")
      .getByLabel("Repeat the password")
      .fill(PASSWORD);
    await page.getByRole("button", { name: "Restore Character" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "24 valid words" }),
    ).toBeVisible();
  });

  test("asks before replacing a stored Character", async ({ page }) => {
    await createCharacter(page);
    await page.goto("/setup.html");
    await expect(page.locator("#existing")).toBeVisible();
    await page.getByRole("button", { name: "Create a new Character" }).click();
    const words = await page.locator("#words li").allTextContents();
    await page.getByRole("button", { name: "I wrote them down" }).click();
    for (const label of await page.locator("#confirm-fields label").all()) {
      const n = Number(/#(\d+)/.exec((await label.textContent()) ?? "")![1]);
      await page.getByLabel(`Word #${n}`, { exact: true }).fill(words[n - 1]!);
    }
    await page
      .locator("#step-confirm")
      .getByLabel("Password", { exact: true })
      .fill(PASSWORD);
    await page
      .locator("#step-confirm")
      .getByLabel("Repeat the password")
      .fill(PASSWORD);
    await page.getByRole("button", { name: "Create Character" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Replace the stored" }),
    ).toBeVisible();
    await expect(page.locator("#done")).toBeHidden();
  });
});

test.describe("Unlocking", () => {
  test("shows how to set up when there is no Character", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /Create a Character/ }),
    ).toBeVisible();
    await expect(unlockDialog(page)).toBeHidden();
  });

  test("a wrong password stays locked; the right one shows the Character", async ({
    page,
  }) => {
    const { address } = await createCharacter(page);
    await page.goto("/");
    const dialog = unlockDialog(page);
    await dialog.getByLabel("Password").fill("not my password");
    await dialog.getByRole("button", { name: "Unlock" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Wrong password.");
    await unlock(page);
    await expect(page.locator("#character-address")).toHaveText(address);
    await expect(page.locator("#character-short")).toContainText("…");
  });

  test("cancelling leaves the Shell locked, and the bar says where the words go", async ({
    page,
  }) => {
    await createCharacter(page);
    await page.goto("/");
    await unlockDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(
      page.getByRole("heading", { name: "The Shell is locked" }),
    ).toBeVisible();
    await expect(page.locator("#warning")).toHaveText(
      "The Shell never asks for your 24 words outside Setup.",
    );
    await page.getByRole("button", { name: "Unlock" }).first().click();
    await unlock(page);
    await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
  });

  test("a double click on Create stores the Character once, and it unlocks", async ({
    page,
  }) => {
    await page.goto("/setup.html");
    await page.getByRole("button", { name: "Create a new Character" }).click();
    const words = await page.locator("#words li").allTextContents();
    await page.getByRole("button", { name: "I wrote them down" }).click();
    for (const label of await page.locator("#confirm-fields label").all()) {
      const n = Number(/#(\d+)/.exec((await label.textContent()) ?? "")![1]);
      await page.getByLabel(`Word #${n}`, { exact: true }).fill(words[n - 1]!);
    }
    const form = page.locator("#step-confirm");
    await form.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await form.getByLabel("Repeat the password").fill(PASSWORD);
    const submit = form.getByRole("button", { name: "Create Character" });
    // Whether the race shows depends on timing, so check the guard itself: the button is
    // disabled while the Character is stored.
    await submit.evaluate((button: HTMLButtonElement) => {
      const watch = new MutationObserver(() => {
        if (!button.disabled) return;
        watch.disconnect();
        button.dataset.wasDisabled = "";
      });
      watch.observe(button, { attributes: true });
    });
    await submit.dblclick();
    await expect(page.locator("#done")).toBeVisible();
    await expect(page.locator("#create-submit")).toHaveAttribute(
      "data-was-disabled",
    );
    const address = await page.locator("#done-address").textContent();
    await openShell(page);
    await expect(page.locator("#character-address")).toHaveText(address!);
  });

  test("opens the Shell after Setup", async ({ page }) => {
    await createCharacter(page);
    await openShell(page);
  });
});
