// End-to-end over the public site: the published fallback player hosts a
// room, and phones in two different browser engines join it at the public
// address, over the real relay.
//   node test/public-e2e.mjs
import { chromium, webkit, devices } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out');
await mkdir(out, { recursive: true });
const SITE = process.env.TALLY_SITE || 'https://play.popquiz.fun';
const chromePath = findChrome();

const results = [];
const pass = (what, detail = '') => results.push(`  ok  ${what}${detail ? `  (${detail})` : ''}`);
let failed = null;
const browsers = [];

try {
  const chrome = await chromium.launch({ executablePath: chromePath, headless: true });
  browsers.push(chrome);
  const stage = await (await chrome.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await stage.goto(`${SITE}/play/`);
  const engine = (fn) => stage.evaluate((f) => new Function('e', `return (${f})(e)`)(document.getElementById('stage').contentWindow.tally.engine), fn.toString());
  await stage.waitForFunction(() => document.getElementById('stage').contentWindow.tally?.engine?.s?.room, null, { timeout: 20000 });
  await engine((e) => e.newSession());
  await stage.evaluate(() => window.tallyPlayer.go(2));
  await stage.waitForFunction(() => document.getElementById('stage').contentWindow.tally.engine.link === 'live', null, { timeout: 20000 });
  const room = await engine((e) => e.s.room);
  const shown = await stage.evaluate(() => document.getElementById('stage').contentDocument.querySelector('.tm-join-how b')?.textContent);
  assert.equal(shown, new URL(SITE).host);
  pass('the published player hosts a room, and its join slide names the public address', `${shown}, room ${room}`);
  await stage.screenshot({ path: path.join(out, 'public-join-slide.png') });

  const phones = [];
  const open = async (label, launch, device) => {
    let browser;
    try {
      browser = await launch();
    } catch (e) {
      results.push(`  --  ${label}: could not start this browser engine here (${String(e.message).split('\n')[0].slice(0, 90)})`);
      return;
    }
    browsers.push(browser);
    const context = await browser.newContext({ ...device });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${SITE}/?r=${room}`);
    await page.fill('#name', label);
    await page.tap('button.go');
    await page.waitForFunction(() => window.tally.player.screen() === 'waiting', null, { timeout: 20000 });
    phones.push({ label, page, errors });
  };
  await open('iPhone', () => webkit.launch(), devices['iPhone 13']);
  await open('Android', () => chromium.launch({ executablePath: chromePath, headless: true }), devices['Pixel 7']);
  assert.ok(phones.length > 0, 'at least one phone engine ran');
  await stage.waitForFunction((n) => document.getElementById('stage').contentWindow.tally.engine.view().playerCount === n, phones.length, { timeout: 10000 });
  pass('phones join at the public address', phones.map((p) => p.label).join(' and '));

  await stage.evaluate(() => window.tallyPlayer.go(5));
  for (const p of phones) await p.page.waitForFunction(() => window.tally.player.screen() === 'question', null, { timeout: 10000 });
  pass('the question reaches every phone by itself');
  for (const [i, p] of phones.entries()) {
    await p.page.tap(`button.opt >> nth=${i === 0 ? 1 : 0}`); // slide 5 is the planets question, B (Saturn) right: the first phone is right, the second wrong
    await p.page.tap('button.go'); // then lock in
    await p.page.waitForFunction(() => window.tally.player.confirmed(), null, { timeout: 8000 });
  }
  await stage.waitForFunction((n) => document.getElementById('stage').contentWindow.tally.engine.view().answered === n, phones.length, { timeout: 5000 });
  pass('a tap on each phone is counted on the big screen');
  // A T in a question's first second and a half is taken as a double press and
  // ignored (engine.advance), so end it the way a presenter would, after that.
  await stage.waitForTimeout(1700);
  await engine((e) => e.advance());
  for (const p of phones) await p.page.waitForFunction(() => window.tally.player.screen() === 'result', null, { timeout: 8000 });
  const heads = [];
  for (const p of phones) heads.push(`${p.label}: ${await p.page.textContent('h1')}`);
  assert.match(heads[0], /Correct/);
  if (heads[1]) assert.match(heads[1], /Not this time/);
  pass('the reveal lands on every phone', heads.join(', '));
  for (const p of phones) {
    await p.page.waitForTimeout(500);
    await p.page.screenshot({ path: path.join(out, `public-phone-${p.label.toLowerCase()}.png`) });
    assert.deepEqual(p.errors, [], `${p.label} logged no errors`);
  }
  pass('no errors on any phone');
} catch (e) {
  failed = e;
}
console.log(results.join('\n'));
console.log(failed ? `\nFAILED: ${failed.message}` : `\nall checks passed against ${SITE}`);
for (const b of browsers) await b.close().catch(() => {});
process.exit(failed ? 1 : 0);
