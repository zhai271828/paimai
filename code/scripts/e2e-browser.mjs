import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const outDir = path.resolve("output/e2e");
const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:5173";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true
});

const errors = [];

try {
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  captureErrors(mobile, "mobile-entry");
  await mobile.goto(baseUrl, { waitUntil: "networkidle" });
  await mobile.screenshot({ path: path.join(outDir, "mobile-entry.png"), fullPage: true });
  await mobile.close();

  const pages = [];
  for (let i = 0; i < 4; i += 1) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    captureErrors(page, `player-${i + 1}`);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    pages.push(page);
  }

  await pages[0].locator("label", { hasText: "昵称" }).locator("input").fill("A");
  await pages[0].getByRole("button", { name: /创建房间/ }).click();
  await pages[0].waitForSelector(".room-code strong");
  const joinCode = (await pages[0].locator(".room-code strong").innerText()).trim();
  await pages[0].reload({ waitUntil: "networkidle" });
  await pages[0].waitForSelector(".room-code strong");
  const recoveredJoinCode = (await pages[0].locator(".room-code strong").innerText()).trim();
  if (recoveredJoinCode !== joinCode) throw new Error("Page reload did not resume the original room.");
  await pages[0].screenshot({ path: path.join(outDir, "resume-after-refresh.png"), fullPage: true });

  for (let i = 1; i < pages.length; i += 1) {
    await pages[i].locator("label", { hasText: "昵称" }).locator("input").fill(String.fromCharCode(65 + i));
    await pages[i].getByPlaceholder("4位房间码").fill(joinCode);
    await pages[i].getByRole("button", { name: /加入/ }).click();
    await pages[i].waitForSelector(".room-code strong");
  }

  for (const page of pages) {
    await page.getByRole("button", { name: /^准备$/ }).click();
  }
  await pages[0].getByRole("button", { name: /开始/ }).click();
  await pages[0].waitForSelector(".role-reveal-modal");
  await pages[0].screenshot({ path: path.join(outDir, "role-reveal.png"), fullPage: true });
  await closeRoleRevealModals(pages);

  await pages[0].keyboard.down("Tab");
  await pages[0].waitForSelector(".scoreboard-panel");
  await pages[0].waitForTimeout(300);
  await pages[0].screenshot({ path: path.join(outDir, "scoreboard-tab.png"), fullPage: true });
  await pages[0].keyboard.up("Tab");
  await pages[0].waitForSelector(".scoreboard-panel", { state: "detached" });

  await pages[0].getByRole("button", { name: /推进阶段/ }).click();
  await pages[0].waitForSelector(".dice-panel");
  await pages[0].waitForTimeout(750);
  await pages[0].screenshot({ path: path.join(outDir, "dice-roll.png"), fullPage: true });
  await pages[0].getByRole("button", { name: /推进阶段/ }).click();
  await pages[0].waitForSelector(".dice-panel", { state: "detached" });
  await pages[0].waitForSelector(".hint-strip");
  await pages[0].waitForSelector(".auction-mode-modal");
  await pages[0].waitForTimeout(300);
  await pages[0].screenshot({ path: path.join(outDir, "auction-mode-modal.png"), fullPage: true });
  await closeNoticeModals(pages);

  const cardModalOpened =
    (await openFirstTargetModal(
      pages,
      ".right-rail button[data-target-mode='artifact'], .right-rail button[data-target-mode='ownedArtifact'], .right-rail button[data-target-mode='playerAuctionArtifact']"
    )) ?? (await openFirstTargetModal(pages, ".right-rail button[data-target-mode]"));
  if (!cardModalOpened) throw new Error("Unable to open card target modal during card window.");
  if (cardModalOpened) {
    await cardModalOpened.screenshot({ path: path.join(outDir, "target-modal-card.png"), fullPage: true });
    await selectFirstModalChoices(cardModalOpened);
    const confirm = cardModalOpened.locator(".target-modal").getByRole("button", { name: /确认/ });
    if (!(await confirm.isEnabled())) {
      await cardModalOpened.locator(".target-modal").getByRole("button", { name: /取消|关闭/ }).first().click();
    } else {
      await confirm.click();
    }
    await cardModalOpened.waitForTimeout(200);
    await drainReactions(pages);
  }

  await pages[1].getByRole("button", { name: /推进阶段/ }).click();

  await resolveAuctionInBrowser(pages, 80);
  await pages[1].waitForSelector(".purchase-modal", { timeout: 5000 });
  await pages[1].waitForTimeout(300);
  await pages[1].screenshot({ path: path.join(outDir, "purchase-modal.png"), fullPage: true });
  await pages[1].locator(".purchase-modal").getByRole("button", { name: /知道了|收到/ }).first().click();
  await pages[0].waitForSelector(".commission-modal", { timeout: 5000 });
  await pages[0].waitForTimeout(300);
  await pages[0].screenshot({ path: path.join(outDir, "commission-modal.png"), fullPage: true });
  await pages[0].locator(".commission-modal").getByRole("button", { name: /知道了|收到/ }).first().click();
  await pages[1].keyboard.down("b");
  await pages[1].waitForSelector(".backpack-panel");
  await pages[1].waitForTimeout(300);
  await pages[1].screenshot({ path: path.join(outDir, "backpack-b.png"), fullPage: true });
  await pages[1].keyboard.up("b");
  await pages[1].waitForSelector(".backpack-panel", { state: "detached" });

  await advanceUntilPhase(pages, "freeTrade");
  await pages[1].waitForSelector(".trade-builder", { timeout: 5000 });
  await pages[1].locator(".trade-builder select").first().selectOption({ label: "C" });
  await pages[1].locator(".segmented-control").getByRole("button", { name: /^卖出$/ }).click();
  await pages[1].locator(".trade-builder input[type='number']").fill("120");
  await pages[1].getByRole("button", { name: /发起交易/ }).click();
  await pages[2].waitForSelector(".trade-offer-modal", { timeout: 5000 });
  await pages[2].waitForTimeout(300);
  await pages[2].screenshot({ path: path.join(outDir, "trade-offer-modal.png"), fullPage: true });
  await pages[2].locator(".trade-offer-modal").getByRole("button", { name: /拒绝/ }).click();

  const roleModalOpened = await openFirstTargetModal(pages, ".right-rail button[data-target-mode]:not([data-target-mode='none'])");
  if (roleModalOpened) {
    await roleModalOpened.screenshot({ path: path.join(outDir, "target-modal-role.png"), fullPage: true });
    await selectFirstModalChoices(roleModalOpened);
    await roleModalOpened.locator(".target-modal").getByRole("button", { name: /取消/ }).click();
  }

  await pages[0].screenshot({ path: path.join(outDir, "desktop-host.png"), fullPage: true });
  await pages[1].screenshot({ path: path.join(outDir, "desktop-winner.png"), fullPage: true });

  await pages[0].getByRole("button", { name: "设置" }).click();
  await pages[0].waitForSelector(".settings-modal");
  await pages[0].screenshot({ path: path.join(outDir, "settings-modal.png"), fullPage: true });
  await pages[0].getByRole("button", { name: /退出房间/ }).click();
  await pages[0].waitForSelector(".leave-room-panel");
  await pages[0].screenshot({ path: path.join(outDir, "leave-room-confirm.png"), fullPage: true });
  await pages[0].locator(".leave-room-panel").getByRole("button", { name: /取消/ }).click();
  await pages[0].locator(".settings-modal").getByRole("button", { name: /关闭/ }).click();

  const stateText = await pages[1].evaluate(() => window.render_game_to_text?.() ?? "{}");
  fs.writeFileSync(path.join(outDir, "winner-state.json"), stateText);

  for (const page of pages) await page.close();

  const closeHost = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const closeGuest = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  captureErrors(closeHost, "close-host");
  captureErrors(closeGuest, "close-guest");
  await closeHost.goto(baseUrl, { waitUntil: "networkidle" });
  await closeGuest.goto(baseUrl, { waitUntil: "networkidle" });
  await closeHost.evaluate(() => localStorage.clear());
  await closeGuest.evaluate(() => localStorage.clear());
  await closeHost.locator("label", { hasText: "昵称" }).locator("input").fill("CloseA");
  await closeHost.getByRole("button", { name: /创建房间/ }).click();
  await closeHost.waitForSelector(".room-code strong");
  const closeCode = (await closeHost.locator(".room-code strong").innerText()).trim();
  await closeGuest.locator("label", { hasText: "昵称" }).locator("input").fill("CloseB");
  await closeGuest.getByPlaceholder("4位房间码").fill(closeCode);
  await closeGuest.getByRole("button", { name: /加入/ }).click();
  await closeGuest.waitForSelector(".room-code strong");
  await closeHost.getByRole("button", { name: "设置" }).click();
  await closeHost.getByRole("button", { name: /退出房间/ }).click();
  await closeHost.locator(".leave-room-panel").getByRole("button", { name: /确认退出/ }).click();
  await closeGuest.waitForSelector(".entry-panel");
  await closeGuest.screenshot({ path: path.join(outDir, "room-closed-entry.png"), fullPage: true });
  await closeGuest.getByRole("button", { name: /创建房间/ }).click();
  await closeGuest.waitForSelector(".room-code strong");
  if ((await closeGuest.locator(".connection-pill.failed").count()) > 0) {
    throw new Error("Creator should not see connection failed after creating a new room.");
  }
  await closeGuest.waitForTimeout(500);
  await closeGuest.screenshot({ path: path.join(outDir, "recreate-after-close.png"), fullPage: true });
  await closeHost.close();
  await closeGuest.close();

  if (errors.length > 0) {
    fs.writeFileSync(path.join(outDir, "console-errors.json"), JSON.stringify(errors, null, 2));
    throw new Error(`Browser console errors detected: ${errors.length}`);
  }

  console.log(`browser-e2e ok ${outDir}`);
} finally {
  await browser.close();
}

function captureErrors(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push({ label, type: "console", text: message.text() });
  });
  page.on("pageerror", (error) => {
    errors.push({ label, type: "pageerror", text: String(error) });
  });
}

async function openFirstTargetModal(pages, selector) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    for (const page of pages) {
      const buttons = page.locator(selector);
      const count = await buttons.count();
      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (!(await button.isVisible()) || !(await button.isEnabled())) continue;
        await button.click();
        const modal = page.locator(".target-modal");
        try {
          await modal.waitFor({ state: "visible", timeout: 700 });
          const confirm = modal.getByRole("button", { name: /确认/ });
          if ((await confirm.count()) > 0 && !(await confirm.first().isEnabled())) {
            await modal.getByRole("button", { name: /取消|关闭/ }).first().click();
            continue;
          }
          return page;
        } catch {
          // Some actions can execute immediately after state changes; keep searching.
        }
      }
    }
    await pages[0].waitForTimeout(250);
  }
  return undefined;
}

async function selectFirstModalChoices(page) {
  const selects = page.locator(".target-modal select");
  const count = await selects.count();
  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const options = await select.locator("option").evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
    if (options[0]) await select.selectOption(options[0]);
  }
}

async function closeRoleRevealModals(pages) {
  for (const page of pages) {
    const modal = page.locator(".role-reveal-modal");
    if ((await modal.count()) === 0) continue;
    if (!(await modal.first().isVisible())) continue;
    await modal.first().getByRole("button", { name: /知道了|关闭/ }).first().click();
    await page.waitForSelector(".role-reveal-modal", { state: "detached" });
  }
}

async function closeNoticeModals(pages) {
  for (const page of pages) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const modal = page.locator(".notice-modal");
      if ((await modal.count()) === 0) break;
      if (!(await modal.first().isVisible())) break;
      const button = modal.first().getByRole("button", { name: /知道了|收到|关闭/ }).first();
      await button.click();
      await page.waitForTimeout(120);
    }
  }
}

async function drainReactions(pages) {
  for (let round = 0; round < 4; round += 1) {
    let clicked = false;
    for (const page of pages) {
      const pass = page.getByRole("button", { name: /放弃/ });
      if ((await pass.count()) === 0) continue;
      const first = pass.first();
      if (!(await first.isVisible()) || !(await first.isEnabled())) continue;
      await first.click();
      clicked = true;
      await page.waitForTimeout(150);
    }
    if (!clicked) return;
  }
}

async function resolveAuctionInBrowser(pages, amount) {
  await pages[1].waitForSelector(".auction-controls", { timeout: 5000 });
  const auctionText = await pages[1].locator(".auction-controls").innerText();
  if (auctionText.includes("当前价")) {
    await pages[1].locator(".auction-controls input").fill(String(amount));
    await pages[1].getByRole("button", { name: /出价/ }).click();
    for (const page of [pages[2], pages[3], pages[0]]) {
      const pass = page.getByRole("button", { name: /退出/ });
      await clickFirstVisible(pass, 1000);
    }
    return;
  }
  if (auctionText.includes("当前荷兰价")) {
    await pages[1].getByRole("button", { name: /喊停/ }).click();
    return;
  }
  const bidders = [pages[1], pages[2], pages[3]];
  for (let index = 0; index < bidders.length; index += 1) {
    const page = bidders[index];
    const input = page.locator(".auction-controls input");
    if ((await input.count()) === 0) continue;
    await input.fill(String(Math.max(0, amount - index * 10)));
    await page.getByRole("button", { name: /提交暗标/ }).click();
  }
}

async function advanceUntilPhase(pages, targetPhase, maxSteps = 5) {
  for (let step = 0; step < maxSteps; step += 1) {
    const phase = await readPhase(pages[0]);
    if (phase === targetPhase) return;
    if (phase === "auction") {
      await resolveAuctionInBrowser(pages, 70);
      await pages[0].waitForTimeout(350);
      await closeNoticeModals(pages);
      continue;
    }
    let clicked = false;
    for (const page of pages) {
      clicked = await clickFirstVisible(page.getByRole("button", { name: /推进阶段/ }), 1500);
      if (clicked) break;
    }
    if (!clicked) throw new Error(`Unable to advance from ${phase} toward ${targetPhase}.`);
    await pages[0].waitForTimeout(350);
    await closeNoticeModals(pages);
  }
  const finalPhase = await readPhase(pages[0]);
  if (finalPhase === targetPhase) return;
  throw new Error(`Did not reach ${targetPhase}; current phase is ${finalPhase}.`);
}

async function readPhase(page) {
  const stateText = await page.evaluate(() => window.render_game_to_text?.() ?? "{}");
  return JSON.parse(stateText).phase;
}

async function clickFirstVisible(locator, timeout = 1000) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (!(await candidate.isVisible({ timeout: Math.min(300, timeout) }))) continue;
      if (!(await candidate.isEnabled({ timeout: Math.min(300, timeout) }))) continue;
      await candidate.click({ timeout });
      return true;
    } catch {
      // State can update between locating and clicking; the caller can continue.
    }
  }
  return false;
}
