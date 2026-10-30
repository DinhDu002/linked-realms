import {
  parseStatement,
  verifyStatement,
  type Handoff,
  type SignedStatement,
} from "@linked-realms/shared/identity";
import {
  connectedFrame,
  enterLand,
  expect,
  hubState,
  openShell,
  PASSWORD,
  received,
  send,
  signPrompt,
  test,
  unlock,
  unlockDialog,
} from "./fixtures.ts";
import { HUB_URL, landOrigin } from "./ports.ts";

interface Init {
  land: { landId: number; ownerName: string };
  character: { address: string };
  handoff: Handoff;
}

const approve = (page: import("@playwright/test").Page) =>
  signPrompt(page).getByRole("button", { name: "Approve" });
const deny = (page: import("@playwright/test").Page) =>
  signPrompt(page).getByRole("button", { name: "Deny" });

test.describe("the frame", () => {
  test("is a sandboxed iframe whose src is the Directory's URL, and the Land connects over a port", async ({
    page,
    character,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    const iframe = page.locator("#frame-area iframe");
    await expect(iframe).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-pointer-lock",
    );
    await expect(iframe).toHaveAttribute("allow", "");
    await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(iframe).toHaveAttribute("src", landOrigin(1));

    const connect = await frame.evaluate(() => land.connect);
    expect(connect).toEqual({ api: 1, origin: "http://localhost:4182" });

    const [init] = (await received(frame, "init")) as unknown as [Init];
    expect(init.land).toMatchObject({ landId: 1, ownerName: "Mai" });
    expect(init.character.address).toBe(character.address);
    const ticket = parseStatement(
      "travel-ticket",
      init.handoff.ticket.statement,
    );
    const arrival = parseStatement("arrival", init.handoff.arrival.statement);
    expect(ticket).toMatchObject({
      land: 1,
      gate: 0,
      character: character.address,
    });
    expect(arrival).toEqual({
      land: 1,
      ticketNonce: ticket.nonce,
      drivenByAi: false,
    });
    expect(verifyStatement(init.handoff.arrival, "arrival").address).toBe(
      character.address,
    );
    const first = (await hubState(character.address)).tickets;
    expect(first.at(-1)).toMatchObject({ landId: 1 });
    expect(first.at(-1)).not.toHaveProperty("from");

    // The bar names the Land, shows its origin and the warning.
    await expect(page.locator("#land-name")).toContainText("Land 1");
    await expect(page.locator("#land-origin")).toHaveText(landOrigin(1));
    await expect(page.locator("#warning")).toHaveText(
      "The Shell never asks for your 24 words outside Setup.",
    );
  });

  test("cannot cover the bar, whatever the Land does", async ({ page }) => {
    await openShell(page);
    const frame = await enterLand(page, 2); // its owner's name is very long
    const bar = (await page.locator("#bar").boundingBox())!;
    const box = (await page.locator("#frame-area iframe").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    // The Land's own page has an element far larger than the window on top of everything.
    expect(
      await frame.evaluate(
        () =>
          document.getElementById("cover")!.getBoundingClientRect().width >
          5 * innerWidth,
      ),
    ).toBe(true);
    for (const x of [bar.x + 5, bar.x + bar.width / 2, bar.x + bar.width - 5])
      for (const y of [bar.y + 2, bar.y + bar.height - 2])
        expect(
          await page.evaluate(
            ([px, py]) =>
              document.elementFromPoint(px!, py!)?.closest("#bar") !== null,
            [x, y],
          ),
        ).toBe(true);
    await expect(page.getByRole("button", { name: "Lock" })).toBeInViewport({
      ratio: 1,
    });
  });

  test("cannot read the Shell's page, storage or session token", async ({
    page,
    character,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    const probe = await frame.evaluate(() => land.probe());
    for (const key of [
      "parentDocument",
      "parentIndexedDB",
      "parentSessionStorage",
      "parentLocalStorage",
      "parentLocation",
      "topDocument",
    ])
      expect(probe[key], key).toBe("SecurityError");
    // Its own storage is its own: no Shell database, nothing stored.
    expect(probe.ownDatabases).not.toContain("linked-realms-shell");
    expect(probe.ownCookies).toBe("");
    expect(probe.ownSessionKeys).toEqual([]);
    expect(probe.ownLocalKeys).toEqual([]);

    // The Land opening a database of the same name gets an empty one in its own origin.
    const shellRecord = await frame.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const open = indexedDB.open("linked-realms-shell");
          open.onsuccess = () => {
            resolve(String(open.result.objectStoreNames.length));
            open.result.close();
          };
          open.onerror = () => resolve("error");
        }),
    );
    expect(shellRecord).toBe("0");

    // The token is nowhere the Land can see, and not in what the Shell handed it.
    const tokens = (await hubState(character.address)).sessionTokens;
    expect(tokens.length).toBeGreaterThan(0);
    const everything = JSON.stringify([
      await frame.evaluate(() => land.log),
      probe,
    ]);
    for (const token of tokens) expect(everything).not.toContain(token);
    // Nor does the Shell keep it in storage.
    expect(
      await page.evaluate(() =>
        JSON.stringify([localStorage, sessionStorage, document.cookie]),
      ),
    ).not.toContain(tokens[0]);
  });

  test("messages from other windows and origins are ignored", async ({
    page,
    character,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    const before = (await hubState(character.address)).tickets.length;
    // The page, the top window and a frame of another origin shout at the Shell.
    for (const m of [
      { type: "signMessage", id: "x", text: "hello" },
      { type: "travel", direction: "east" },
      { type: "pay", id: "y", amount: "1", recipient: "tlr1x", memo: "" },
    ])
      await frame.evaluate((message) => land.shout(message), m);
    await page.waitForTimeout(1500);
    await expect(signPrompt(page)).toBeHidden();
    expect((await hubState(character.address)).tickets).toHaveLength(before);
    await expect(page.locator("#frame-area iframe")).toHaveAttribute(
      "src",
      landOrigin(1),
    );
    expect(await received(frame, "signResult")).toEqual([]);
    expect(await received(frame, "travelRefused")).toEqual([]);
  });

  test("`pay` is refused", async ({ page }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await send(frame, {
      type: "pay",
      id: "p1",
      amount: "1.5",
      recipient: "tlr1x",
      memo: "Lantern",
    });
    await expect
      .poll(() => received(frame, "signResult"))
      .toEqual([{ type: "signResult", id: "p1", error: "unsupported" }]);
    await expect(signPrompt(page)).toBeHidden();
  });

  test("a Land that reloads at once is stopped; a reload later gets a fresh handoff", async ({
    page,
    character,
  }) => {
    await page.clock.install();
    await openShell(page);
    let frame = await enterLand(page, 1);
    const tickets = (await hubState(character.address)).tickets.length;
    await page.clock.fastForward(6000);
    await frame.evaluate(() => land.reload());
    frame = await connectedFrame(page, 1);
    expect((await hubState(character.address)).tickets).toHaveLength(
      tickets + 1,
    );
    // Again, within 5 seconds.
    await frame.evaluate(() => land.reload());
    await expect(page.locator("#status")).toHaveText(
      "This Land keeps reloading",
    );
    await expect(page.locator("#frame-area iframe")).toHaveCount(0);
  });
});

test.describe("signing", () => {
  test("is shown in the Shell's own prompt; nothing is returned until Approve is clicked", async ({
    page,
    character,
  }) => {
    await page.clock.install();
    await openShell(page);
    const frame = await enterLand(page, 1);
    const text =
      "I agree.‮ fdp.exe​\n<img src=x onerror=alert(1)><b>bold</b> \\u{41}";
    await send(frame, { type: "signMessage", id: "s1", text });
    await expect(signPrompt(page)).toBeVisible();

    // The header is the Shell's: the Land's id and origin, and the Character.
    await expect(page.locator("#sign-land")).toHaveText("Land 1");
    await expect(page.locator("#sign-origin")).toHaveText(landOrigin(1));
    await expect(page.locator("#sign-character")).toContainText(
      character.address,
    );
    // The Land's text is in its own labelled box, as plain text with visible escapes.
    const box = page.getByLabel("Text from the Land", { exact: false });
    await expect(box).toHaveText(
      "I agree.\\u{202e} fdp.exe\\u{200b}\\n<img src=x onerror=alert(1)><b>bold</b> \\\\u{41}",
    );
    expect(await page.locator("#sign-text *").count()).toBe(0);
    await expect(page.locator("#sign-text-label")).toContainText(
      "Text from the Land",
    );

    // Approve is not focused, and a click in the first second does nothing.
    await expect(approve(page)).not.toBeFocused();
    await page.clock.pauseAt(new Date(Date.now() + 100));
    await approve(page).click({ force: true });
    // Nothing from the keyboard approves, now or later.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.clock.runFor(1500);
    await approve(page).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    // A click from a script is not a pointer click either.
    await approve(page).evaluate((b) => (b as HTMLElement).click());
    await page.waitForTimeout(300);
    expect(await received(frame, "signResult")).toEqual([]);
    await expect(signPrompt(page)).toBeVisible();

    await approve(page).click();
    await expect(signPrompt(page)).toBeHidden();
    await expect.poll(() => received(frame, "signResult")).toHaveLength(1);
    const [result] = (await received(frame, "signResult")) as unknown as [
      { id: string; signed: SignedStatement },
    ];
    expect(result.id).toBe("s1");
    const verified = verifyStatement(result.signed, "land-message");
    expect(verified.address).toBe(character.address);
    expect(verified.fields).toMatchObject({
      land: 1,
      landUrl: landOrigin(1),
      character: character.address,
      message: text,
    });
  });

  test("Deny, Escape and a second request: denied, busy for 10 seconds", async ({
    page,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await send(frame, { type: "signMessage", id: "a", text: "one" });
    await expect(signPrompt(page)).toBeVisible();
    // One request at a time.
    await send(frame, { type: "signMessage", id: "b", text: "two" });
    await expect
      .poll(() => received(frame, "signResult"))
      .toEqual([{ type: "signResult", id: "b", error: "busy" }]);
    await deny(page).click();
    await expect
      .poll(async () =>
        (await received(frame, "signResult")).map((m) => m.error),
      )
      .toEqual(["busy", "denied"]);
    // After a refusal, busy.
    await send(frame, { type: "signMessage", id: "c", text: "three" });
    await expect.poll(() => received(frame, "signResult")).toHaveLength(3);
    expect((await received(frame, "signResult")).at(-1)).toMatchObject({
      id: "c",
      error: "busy",
    });
    await expect(signPrompt(page)).toBeHidden();
  });

  test("closing the prompt with Escape is a refusal", async ({ page }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await send(frame, { type: "signMessage", id: "a", text: "one" });
    await expect(signPrompt(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(signPrompt(page)).toBeHidden();
    await expect
      .poll(() => received(frame, "signResult"))
      .toEqual([{ type: "signResult", id: "a", error: "denied" }]);
  });

  test("after 3 refusals the Land is blocked until it reloads", async ({
    page,
  }) => {
    await page.clock.install();
    await openShell(page);
    const frame = await enterLand(page, 1);
    for (const [i, id] of ["a", "b", "c"].entries()) {
      await send(frame, { type: "signMessage", id, text: id });
      await expect(signPrompt(page)).toBeVisible();
      await deny(page).click();
      await expect
        .poll(() => received(frame, "signResult"))
        .toHaveLength(i + 1);
      await page.clock.fastForward(10_500);
    }
    await send(frame, { type: "signMessage", id: "d", text: "d" });
    await expect
      .poll(async () =>
        (await received(frame, "signResult")).map((m) => m.error),
      )
      .toEqual(["denied", "denied", "denied", "blocked"]);
    await expect(signPrompt(page)).toBeHidden();
  });

  test("clicks on the frame do nothing while the prompt is open", async ({
    page,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    const box = (await page.locator("#frame-area iframe").boundingBox())!;
    const spot = { x: box.x + 20, y: box.y + 20 };
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(() => frame.evaluate(() => land.clicks)).toBe(1);

    await send(frame, { type: "signMessage", id: "a", text: "x" });
    await expect(signPrompt(page)).toBeVisible();
    await expect(page.locator("#frame-area iframe")).toHaveJSProperty(
      "inert",
      true,
    );
    await page.mouse.click(spot.x, spot.y);
    await page.mouse.dblclick(spot.x, spot.y);
    await page.waitForTimeout(200);
    expect(await frame.evaluate(() => land.clicks)).toBe(1);
    await expect(signPrompt(page)).toBeVisible();

    await deny(page).click();
    await expect(page.locator("#frame-area iframe")).toHaveJSProperty(
      "inert",
      false,
    );
    await page.mouse.click(spot.x, spot.y);
    await expect.poll(() => frame.evaluate(() => land.clicks)).toBe(2);
  });
});

test.describe("signing across reloads", () => {
  test("a reload closes the open prompt; the new load's request gets its own prompt and delay", async ({
    page,
  }) => {
    await page.clock.install();
    await openShell(page);
    let frame = await enterLand(page, 1);
    await send(frame, { type: "signMessage", id: "old", text: "first text" });
    await expect(signPrompt(page)).toBeVisible();
    await expect(page.locator("#sign-text")).toHaveText("first text");
    // The Land reloads itself after the 5-second limit, prompt still open.
    await page.clock.fastForward(6000);
    await frame.evaluate(() => land.reload());
    await expect(signPrompt(page)).toBeHidden();
    frame = await connectedFrame(page, 1);
    await send(frame, { type: "signMessage", id: "new", text: "second text" });
    await expect(signPrompt(page)).toBeVisible();
    await expect(page.locator("#sign-text")).toHaveText("second text");
    // The new prompt has its own second: a click at once does nothing.
    const pageNow = await page.evaluate(() => Date.now()); // ahead of ours by the fast-forward
    await page.clock.pauseAt(new Date(pageNow + 100));
    await approve(page).click({ force: true });
    await page.waitForTimeout(300);
    await expect(signPrompt(page)).toBeVisible();
    expect(await received(frame, "signResult")).toEqual([]);
    await page.clock.runFor(1500);
    await approve(page).click();
    await expect.poll(() => received(frame, "signResult")).toHaveLength(1);
    const [result] = (await received(frame, "signResult")) as unknown as [
      { id: string; signed: SignedStatement },
    ];
    expect(result.id).toBe("new");
    expect(verifyStatement(result.signed, "land-message").fields.message).toBe(
      "second text",
    );
  });
});

test.describe("travel", () => {
  test("loads the neighbour with a ticket whose `from` is the current Land", async ({
    page,
    character,
  }) => {
    await openShell(page);
    await enterLand(page, 1);
    const frame1 = await connectedFrame(page, 1);
    const before = (await hubState(character.address)).tickets.length;
    await send(frame1, { type: "travel", direction: "east" });
    const frame2 = await connectedFrame(page, 2);

    await expect(page.locator("#frame-area iframe")).toHaveAttribute(
      "src",
      landOrigin(2),
    );
    await expect(page.locator("#frame-area iframe")).toHaveCount(1);
    await expect(page.locator("#land-origin")).toHaveText(landOrigin(2));
    // Land 2's first handoff: a ticket from Land 1, arriving at the west Gate (4).
    const tickets = (await hubState(character.address)).tickets;
    expect(tickets.at(-1)).toMatchObject({
      landId: 2,
      from: 1,
      character: character.address,
    });
    expect(tickets.slice(before)).toHaveLength(1); // the travel's ticket, used for the load
    const [init] = (await received(frame2, "init")) as unknown as [Init];
    const ticket = parseStatement(
      "travel-ticket",
      init.handoff.ticket.statement,
    );
    expect(ticket).toMatchObject({ land: 2, gate: 4 });
    expect(parseStatement("arrival", init.handoff.arrival.statement)).toEqual({
      land: 2,
      ticketNonce: ticket.nonce,
      drivenByAi: false,
    });
    // The first Land's frame is gone.
    expect(
      page.frames().filter((f) => f.url().startsWith(landOrigin(1))),
    ).toHaveLength(0);
  });

  test("answers no-land and offline, and the Character stays", async ({
    page,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await send(frame, { type: "travel", direction: "north" });
    await expect
      .poll(() => received(frame, "travelRefused"))
      .toEqual([
        { type: "travelRefused", direction: "north", reason: "no-land" },
      ]);
    await page.waitForTimeout(1100);
    await send(frame, { type: "travel", direction: "west" });
    await expect
      .poll(async () => (await received(frame, "travelRefused")).at(-1))
      .toEqual({
        type: "travelRefused",
        direction: "west",
        reason: "offline",
        landId: 3,
      });
    await expect(page.locator("#frame-area iframe")).toHaveAttribute(
      "src",
      landOrigin(1),
    );
  });

  test("answers busy while one runs, and accepts one `travel` a second", async ({
    page,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await frame.evaluate(() => {
      land.send({ type: "travel", direction: "north" });
      land.send({ type: "travel", direction: "north" });
    });
    await expect.poll(() => received(frame, "travelRefused")).toHaveLength(2);
    const reasons = (await received(frame, "travelRefused"))
      .map((m) => m.reason)
      .sort();
    expect(reasons).toEqual(["busy", "no-land"]);
    // That one is done, but it started less than a second ago.
    await send(frame, { type: "travel", direction: "north" });
    await expect.poll(() => received(frame, "travelRefused")).toHaveLength(3);
    expect((await received(frame, "travelRefused")).at(-1)).toMatchObject({
      reason: "rate-limited",
    });
    await page.waitForTimeout(1100);
    await send(frame, { type: "travel", direction: "north" });
    await expect.poll(() => received(frame, "travelRefused")).toHaveLength(4);
    expect((await received(frame, "travelRefused")).at(-1)).toMatchObject({
      reason: "no-land",
    });
  });

  test("a travel still waiting for its ticket when the Player leaves goes nowhere", async ({
    page,
  }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let asked = false;
    await page.route(`${HUB_URL}/tickets`, async (route) => {
      if (route.request().method() === "POST") {
        asked = true;
        await held;
      }
      await route.continue();
    });
    await send(frame, { type: "travel", direction: "east" });
    await expect.poll(() => asked).toBe(true);
    await page.getByRole("button", { name: "Leave Land" }).click();
    release();
    await page.waitForTimeout(1000);
    await expect(page.locator("#frame-area iframe")).toHaveCount(0);
    expect(
      page.frames().filter((f) => f.url().startsWith(landOrigin(2))),
    ).toHaveLength(0);
  });
});

test.describe("locking", () => {
  test("the Land keeps running; the next signature asks for the password, and cancelling answers locked", async ({
    page,
    character,
  }) => {
    await page.clock.install();
    await openShell(page);
    const frame = await enterLand(page, 1);
    const signIns = (await hubState(character.address)).signIns;
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
    // The Land is still there and still connected.
    await expect(page.locator("#frame-area iframe")).toBeVisible();
    await send(frame, { type: "travel", direction: "east" });
    await expect(unlockDialog(page)).toBeVisible();
    await unlockDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect
      .poll(() => received(frame, "travelRefused"))
      .toEqual([
        { type: "travelRefused", direction: "east", reason: "locked" },
      ]);

    // A cancelled unlock is a refusal: for 10 seconds this Land gets no password prompt.
    await send(frame, { type: "signMessage", id: "a", text: "x" });
    await expect
      .poll(() => received(frame, "signResult"))
      .toEqual([{ type: "signResult", id: "a", error: "busy" }]);
    await expect(unlockDialog(page)).toBeHidden();

    await page.clock.fastForward(10_000);
    await send(frame, { type: "signMessage", id: "b", text: "x" });
    await expect(unlockDialog(page)).toBeVisible();
    await unlockDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect
      .poll(async () => (await received(frame, "signResult")).at(-1))
      .toEqual({ type: "signResult", id: "b", error: "locked" });
    await expect(signPrompt(page)).toBeHidden();

    // Unlocking in the Shell's modal carries on to the prompt; the session token was dropped, so
    // the Shell signs in again.
    await page.clock.fastForward(10_000);
    await send(frame, { type: "signMessage", id: "c", text: "y" });
    await unlock(page);
    await expect(signPrompt(page)).toBeVisible();
    await deny(page).click();
    await expect
      .poll(async () => (await received(frame, "signResult")).at(-1))
      .toEqual({ type: "signResult", id: "c", error: "denied" });
    // The sign-in after an unlock runs in the background, so it may land after the answer.
    await expect
      .poll(async () => (await hubState(character.address)).signIns)
      .toBeGreaterThan(signIns);
  });

  test("a wrong password in the modal does not unlock", async ({ page }) => {
    await openShell(page);
    const frame = await enterLand(page, 1);
    await page.getByRole("button", { name: "Lock" }).click();
    await send(frame, { type: "signMessage", id: "a", text: "x" });
    const dialog = unlockDialog(page);
    await dialog.getByLabel("Password").fill("wrong wrong");
    await dialog.getByRole("button", { name: "Unlock" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Wrong password.");
    await expect(dialog).toBeVisible();
    expect(await received(frame, "signResult")).toEqual([]);
    await dialog.getByLabel("Password").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Unlock" }).click();
    await expect(signPrompt(page)).toBeVisible();
  });

  test("locks after 15 minutes without input on the Shell's page", async ({
    page,
  }) => {
    await page.clock.install();
    await openShell(page);
    await page.clock.fastForward("14:00");
    await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
    await page.mouse.move(10, 10); // input restarts the idle timer
    await page.clock.fastForward("14:00");
    await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
    await page.clock.fastForward("01:30");
    await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "The Shell is locked" }),
    ).toBeVisible();
  });
});

test.describe("the Shell's own controls", () => {
  test("names the Character", async ({ page, character }) => {
    await openShell(page);
    await page.getByLabel("Name", { exact: true }).fill("Lan");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.locator("#name-status")).toHaveText("Saved.");
    expect((await hubState(character.address)).name).toBe("Lan");
  });

  test("lists the Directory and enters a Land", async ({ page }) => {
    await openShell(page);
    const list = page.getByRole("list", { name: "Directory" });
    await expect(list.getByRole("listitem")).toHaveCount(3);
    await expect(list).toContainText("Land 3");
    await expect(list.getByRole("listitem").nth(2)).toContainText("offline");
    await enterLand(page, 1);
    await page.getByRole("button", { name: "Leave Land" }).click();
    await expect(page.locator("#frame-area iframe")).toHaveCount(0);
    await expect(list).toBeVisible();
  });

  test("reports a Land from the Shell, not from the frame", async ({
    page,
    character,
  }) => {
    await openShell(page);
    await enterLand(page, 1);
    await page.getByRole("button", { name: "Report this Land" }).click();
    await page.getByLabel("Reason").fill("It asks for my words");
    await page.getByRole("button", { name: "Send report" }).click();
    await expect(page.locator("#status")).toHaveText("Report on Land 1 sent.");
    expect((await hubState(character.address)).reports.at(-1)).toEqual({
      landId: 1,
      reason: "It asks for my words",
      reporter: character.address,
    });
  });

  test("registers a waiting Map server with a signed Delegation", async ({
    page,
    character,
  }) => {
    await fetch(`${HUB_URL}/__forget-land?owner=${character.address}`, {
      method: "POST",
    });
    await openShell(page);
    await expect(page.locator("#land-command")).toHaveText(
      `docker run -d --name linked-realms-land --restart unless-stopped -v linked-realms-land:/data -e LAND_OWNER=${character.address} -e HUB_URL=${HUB_URL} ghcr.io/dinhdu002/linked-realms-node:latest`,
    );
    await expect(page.locator("#land-status")).toHaveText(
      "You have no Land yet.",
    );
    await page.getByRole("button", { name: /^Register Map server / }).click();
    await expect(page.locator("#land-status")).toContainText(
      "Your Land is Land 9",
    );
    const [delegation] = (await hubState(character.address)).delegations;
    expect(delegation).toMatchObject({
      hub: "localhost:8791",
      owner: character.address,
    });
  });

  test("sets and removes the Land's own domain", async ({
    page,
    character,
  }) => {
    await fetch(`${HUB_URL}/__forget-land?owner=${character.address}`, {
      method: "POST",
    });
    await openShell(page);
    await expect(page.getByLabel("Domain")).toBeHidden();
    await page.getByRole("button", { name: /^Register Map server / }).click();
    await expect(page.locator("#domain-txt")).toHaveText("land=9");
    await expect(
      page.getByRole("button", { name: "Remove domain" }),
    ).toBeDisabled();
    await page.getByLabel("Domain").fill("other.example");
    await page.getByRole("button", { name: "Save domain" }).click();
    await expect(page.locator("#domain-status")).toHaveText(
      "add the DNS TXT record _linked-realms.other.example with the value land=9, then try again",
    );
    await page.getByLabel("Domain").fill("Play.Example");
    await page.getByRole("button", { name: "Save domain" }).click();
    await expect(page.locator("#domain-status")).toHaveText("Saved.");
    await expect(page.locator("#land-status")).toContainText(
      "Your Land is Land 9 at https://play.example.",
    );
    await expect(page.getByLabel("Domain")).toHaveValue("play.example");
    await page.getByRole("button", { name: "Remove domain" }).click();
    await expect(page.locator("#domain-status")).toHaveText("Removed.");
    await expect(page.getByLabel("Domain")).toHaveValue("");
    await expect(page.locator("#land-status")).toContainText(
      "Your Land is Land 9 at http://9.localhost:",
    );
  });

  test("goes full screen with the whole page and back", async ({ page }) => {
    await openShell(page);
    await expect(page.locator("#fullscreen-hint")).toBeHidden();
    await enterLand(page, 1);
    await page.getByRole("button", { name: "Full screen" }).click();
    // The whole page, not the frame: the Shell's prompts stay in view.
    await expect
      .poll(() =>
        page.evaluate(
          () => document.fullscreenElement === document.documentElement,
        ),
      )
      .toBe(true);
    await page.getByRole("button", { name: "Exit full screen" }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement))
      .toBeNull();
    await expect(
      page.getByRole("button", { name: "Full screen" }),
    ).toBeVisible();
  });

  test("links the web app manifest for the Home Screen", async ({ page }) => {
    await page.goto("/");
    const href = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    const response = await page.request.get(href!);
    expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({
      start_url: "/",
      display: "standalone",
    });
  });

  test("serves the Shell with the CSP and COOP headers", async ({ page }) => {
    const response = (await page.goto("/"))!;
    const headers = response.headers();
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    const csp = headers["content-security-policy"]!;
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self' http://localhost:8791");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

test.describe("on a touch screen without full screen", () => {
  // `pointer: coarse` comes from Chromium's touch emulation; Firefox has no isMobile.
  test.skip(({ browserName }) => browserName !== "chromium");
  test.use({ hasTouch: true, isMobile: true });

  test("hides the button and tells how to drop the bars", async ({ page }) => {
    // As on an iPhone, where Safari has no full screen for pages.
    await page.addInitScript(() =>
      Object.defineProperty(Document.prototype, "fullscreenEnabled", {
        get: () => false,
      }),
    );
    await openShell(page);
    await expect(page.locator("#fullscreen-hint")).toContainText(
      "add the Shell to your Home Screen",
    );
    await expect(page.locator("#fullscreen")).toBeHidden();
  });
});
