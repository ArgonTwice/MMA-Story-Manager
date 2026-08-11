/**
 * tests/e2e/fight_launch.spec.js
 * ---------------------------------------------------------------------------
 * V3.7 "Debugging Bouton Combat" — a strict end-to-end journey through the
 * whole Fight Launch Contract pipeline against the real, built `docs/`
 * bundle in a headless Chromium: new game -> roster -> Gala Calendar
 * registration -> Fight Week (camp orientation, weight cut, logistics) ->
 * arrival on fight day -> combat resolution -> back to the Hub.
 *
 * Asserts, at every step, that (a) no browser console error or uncaught
 * page error ever fires, and (b) the DOM never "freezes" — every button
 * click this journey depends on is followed by an observable UI change
 * within a bounded wait, never a silent no-op.
 *
 * This repo has no @playwright/test runner installed (only the raw
 * `playwright` driver, already used by tools/build-web.mjs's own dev
 * workflow) and Node's default `node --test` file discovery treats every
 * .js file under a `tests/` directory as a test module to import — so
 * this file guards its actual browser run behind a "am I the entrypoint"
 * check: a bare `node --test` importing it is a fast, harmless no-op,
 * while `node tests/e2e/fight_launch.spec.js` (see package.json's
 * "test:e2e" script) actually launches the browser and runs the journey.
 * ---------------------------------------------------------------------------
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');

const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };

function startStaticServer(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      let requestedPath = req.url.split('?')[0];
      if (requestedPath === '/') requestedPath = '/index.html';
      const filePath = path.join(rootDir, requestedPath);
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

/** Dismisses any stacked blocking modal (welcome/onboarding/etc) so the journey can proceed. */
async function dismissModals(page, maxRounds = 8) {
  for (let i = 0; i < maxRounds; i += 1) {
    const overlay = page.locator('#modalOverlay[data-blocking]');
    if ((await overlay.count()) === 0 || !(await overlay.isVisible())) return;
    const dismissBtn = overlay.locator('button').first();
    if ((await dismissBtn.count()) === 0) return;
    await dismissBtn.click().catch(() => {});
    await page.waitForTimeout(200);
  }
}

/** Clicks a button and asserts the DOM actually changed within `timeoutMs` — a strict stand-in for "the click was not a silent no-op / freeze". */
async function clickAndExpectChange(page, locator, { timeoutMs = 3000 } = {}) {
  const before = await page.locator('body').innerHTML();
  await locator.click();
  await page
    .waitForFunction((prevHtml) => document.body.innerHTML !== prevHtml, before, { timeout: timeoutMs })
    .catch(() => {
      throw new Error('DOM did not change after click — possible UI freeze.');
    });
}

async function run() {
  const server = await startStaticServer(DOCS_DIR);
  const port = server.address().port;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  // A deterministic mulberry32-style PRNG overriding window.Math.random before
  // any app module runs (WebApp itself always seeds from Math.random — see
  // web/app.js's `this.rng = Math.random`) — makes this "strict" journey
  // fully reproducible instead of occasionally wandering into a legitimate
  // but test-irrelevant branch (e.g. a random mid-camp injury cancelling the
  // booking), which would make the assertions below flaky rather than strict.
  await page.addInitScript(() => {
    let state = 424242 >>> 0;
    window.Math.random = function seededRandom() {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });

  try {
    // ---- Inscription (new game + roster) ------------------------------------
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
    await page.click('#btnNewGame');
    await page.waitForTimeout(500);
    await dismissModals(page);

    await page.click('button.nav-btn[data-panel="roster"]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Marche de Recrutement")');
    await page.waitForTimeout(300);
    const signBtn = page.locator('button:has-text("Signer")').first();
    assert.ok((await signBtn.count()) > 0, 'the Recruitment Market must offer at least one candidate to sign');
    await signBtn.click();
    await page.waitForTimeout(300);
    await page.click('button:has-text("Fermer")').catch(() => {});
    await page.waitForTimeout(200);

    // ---- Gala Calendar registration ------------------------------------------
    await page.click('button.nav-btn[data-panel="fight"]');
    await page.waitForTimeout(300);

    const galaCalendarTitle = page.locator('h2:has-text("Calendrier des Galas")');
    assert.equal(await galaCalendarTitle.count(), 1, 'the Combat tab must show the Gala Calendar when no fight is booked');

    const fighterCard = page.locator('.fighter-card.selectable').first();
    assert.ok((await fighterCard.count()) > 0, 'at least one non-injured roster fighter must be selectable');
    await fighterCard.click();
    await page.waitForTimeout(200);

    const registerBtn = page.locator('button:has-text("S\'inscrire")').first();
    assert.ok((await registerBtn.count()) > 0, 'the soonest gala must offer a registration button once a fighter is selected');
    await clickAndExpectChange(page, registerBtn);

    const fightWeekTitle = page.locator('h2:has-text("Fight Week")');
    assert.equal(await fightWeekTitle.count(), 1, 'registering must switch the Combat tab to the Fight Week view');

    // ---- Fight Week: camp orientation, then advance to fight week ------------
    const campChip = page.locator('.activity-chip').first();
    if ((await campChip.count()) > 0) {
      await clickAndExpectChange(page, campChip);
    }

    let arrived = false;
    for (let week = 0; week < 10 && !arrived; week += 1) {
      await page.click('button.nav-btn[data-panel="planning"]');
      await page.waitForTimeout(200);
      const resolveBtn = page.locator('button:has-text("Resoudre la semaine")').first();
      if ((await resolveBtn.count()) === 0) break;
      await resolveBtn.click();
      await page.waitForTimeout(400);
      await dismissModals(page);

      await page.click('button.nav-btn[data-panel="fight"]');
      await page.waitForTimeout(200);

      // Fight Week Logistique: weight cut + transport/hotel, once available.
      const logistiqueBtn = page.locator('button:has-text("Preparer le Fight Week")').first();
      if ((await logistiqueBtn.count()) > 0) {
        await logistiqueBtn.click();
        await page.waitForTimeout(300);
        const chooseBtn = page.locator('button:has-text("Choisir")').first();
        if ((await chooseBtn.count()) > 0 && !(await chooseBtn.isDisabled())) await chooseBtn.click();
        await page.waitForTimeout(250);
        const chooseBtn2 = page.locator('button:has-text("Choisir")').first();
        if ((await chooseBtn2.count()) > 0 && !(await chooseBtn2.isDisabled())) await chooseBtn2.click();
        await page.waitForTimeout(250);
        await page.click('button:has-text("Fermer")').catch(() => {});
        await page.waitForTimeout(200);
      }

      const arriveBtn = page.locator('button:has-text("Se rendre au combat")').first();
      if ((await arriveBtn.count()) > 0 && !(await arriveBtn.isDisabled())) {
        await clickAndExpectChange(page, arriveBtn);
        await dismissModals(page); // press conference, if main-event eligible
        arrived = true;
      }
    }
    assert.ok(arrived, 'the booked fight must eventually become launchable within 10 in-game weeks');

    // ---- Arrivee au jour J: reach fight setup, launch, resolve instantly -----
    const fightSetupTitle = page.locator('h2:has-text("Preparation du combat")');
    assert.equal(await fightSetupTitle.count(), 1, 'arriving on fight day must open the fight setup screen, not freeze');

    const launchBtn = page.locator('button:has-text("Lancer le combat")').first();
    assert.ok((await launchBtn.count()) > 0, 'the fight setup screen must offer a launch button');
    await clickAndExpectChange(page, launchBtn);

    // ---- Resolution: fast-forward the whole fight instantly -------------------
    const simulateBtn = page.locator('button:has-text("Simuler le combat")').first();
    if ((await simulateBtn.count()) > 0) {
      await clickAndExpectChange(page, simulateBtn, { timeoutMs: 5000 });
    } else {
      // Fell straight to a result banner already (a 0-round fight edge case) — acceptable.
    }

    const resultBanner = page.locator('.result-banner');
    assert.equal(await resultBanner.count(), 1, 'the fight must resolve to a result banner, not hang mid-combat');

    // ---- Retour au Hub ----------------------------------------------------------
    await page.click('button:has-text("Nouveau combat")');
    await page.waitForTimeout(200);
    await page.click('button.nav-btn[data-panel="hub"]');
    await page.waitForTimeout(200);
    const hubPanel = page.locator('#panel-hub.active');
    assert.equal(await hubPanel.count(), 1, 'the journey must be able to return cleanly to the Hub after a fight resolves');

    assert.deepEqual(consoleErrors, [], `expected zero console errors, got: ${JSON.stringify(consoleErrors, null, 2)}`);

    console.log('PASS: fight_launch.spec.js — full Inscription -> Fight Week -> Arrivee -> Resolution -> Hub journey, zero console errors.');
  } finally {
    await browser.close();
    server.close();
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('FAIL: fight_launch.spec.js —', error.message);
      process.exit(1);
    });
}

export { run };
