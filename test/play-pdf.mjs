// Checks the fallback player's PDF path: load a PDF, see it drawn, move
// through it, reload and find the same page. Needs `npm run serve` running.
//   node test/play-pdf.mjs
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SCHEMA } from '../app/shared/sync.js';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out');
await mkdir(out, { recursive: true });
const base = process.env.TALLY_URL || 'http://localhost:8790';
const executablePath = findChrome();

const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
let failed = null;
try {
  // A three-page, 16:9 PDF, each page a different colour with its number on it.
  const maker = await browser.newPage();
  await maker.setContent(`<style>@page{size:1600px 900px;margin:0}body{margin:0}section{width:1600px;height:900px;display:grid;place-items:center;font:900 300px sans-serif;color:#fff;page-break-after:always}</style>
    <section style="background:#b3261e">1</section><section style="background:#14915a">2</section><section style="background:#1d4ed8">3</section>`);
  const pdfPath = path.join(out, 'three-pages.pdf');
  await maker.pdf({ path: pdfPath, width: '1600px', height: '900px', printBackground: true });
  await maker.close();

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/play/?relay=local&setup`);
  await page.evaluate(async () => {
    localStorage.removeItem('tally.player');
    await new Promise((r) => { const d = indexedDB.deleteDatabase('tally-player'); d.onsuccess = d.onerror = d.onblocked = r; });
  });
  await page.reload();
  await page.setInputFiles('#pdf-file', pdfPath);
  await page.waitForFunction(() => window.tallyPlayer?.pages === 3, null, { timeout: 15000 });
  results.push('  ok  a PDF loads and its pages are counted  (3 pages)');
  assert.match(await page.textContent('#pdf-state'), /three-pages\.pdf · 3 pages/);
  await page.click('.go');

  const centre = () => page.evaluate(() => {
    const c = document.getElementById('page');
    const d = c.getContext('2d').getImageData(Math.floor(c.width * 0.1), Math.floor(c.height * 0.1), 1, 1).data;
    return { hidden: c.hidden, rgb: [d[0], d[1], d[2]], w: c.width, aspect: +(c.width / c.height).toFixed(2) };
  });
  const near = (rgb, want) => rgb.every((v, i) => Math.abs(v - want[i]) < 12);
  await page.waitForFunction(() => document.getElementById('page').width > 300);
  let px = await centre();
  assert.ok(!px.hidden && near(px.rgb, [179, 38, 30]), `page 1 drawn: ${JSON.stringify(px)}`);
  assert.equal(px.aspect, 1.78);
  results.push(`  ok  page 1 is drawn, sharp and 16:9  (${px.w}px wide)`);

  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.tallyPlayer.page === 2);
  await page.waitForTimeout(600);
  px = await centre();
  assert.ok(near(px.rgb, [20, 145, 90]), `page 2 drawn: ${JSON.stringify(px)}`);
  results.push('  ok  the arrow key moves to page 2');

  await page.reload();
  await page.waitForFunction(() => window.tallyPlayer?.pages === 3 && document.getElementById('page').width > 300, null, { timeout: 15000 });
  await page.waitForTimeout(600);
  px = await centre();
  assert.equal(await page.evaluate(() => window.tallyPlayer.page), 2);
  assert.ok(near(px.rgb, [20, 145, 90]), `after reload: ${JSON.stringify(px)}`);
  results.push('  ok  a reload comes back to the same PDF on the same page');

  const stageUp = await page.waitForFunction(() => !!document.getElementById('stage').contentWindow.tally?.engine?.s?.room, null, { timeout: 10000 }).then(() => true);
  assert.ok(stageUp);
  results.push('  ok  the stage is running over the PDF');
  await page.screenshot({ path: path.join(out, 'play-pdf.png') });

  // The quiz fetched from a deck's shared copy, by pasting the deck's link.
  const deckId = `PLAYER_TEST_${Date.now().toString(36)}_0123456789`;
  const put = await fetch(`${base}/api/deck?id=${deckId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: SCHEMA, deck: { title: 'Shared quiz', slides: { a: { kind: 'join', index: 1 }, b: { kind: 'question', index: 2, type: 'tf', text: 'From the shared copy', correct: 0 } } } }) });
  assert.equal(put.status, 200);
  await page.keyboard.press('s');
  await page.fill('#deck-link', `https://docs.google.com/presentation/d/${deckId}/edit#slide=id.p`);
  await page.click('#deck-fetch');
  await page.waitForFunction(() => /2 quiz slides/.test(document.getElementById('deck-state').textContent), null, { timeout: 8000 });
  await page.click('.go');
  // The stage must be playing the fetched quiz, not the one it started with.
  // (The demo quiz has a join slide of its own, so "a join slide is up" proves nothing.)
  await page.waitForFunction((id) => document.getElementById('stage').contentWindow.tally?.deck?.presentationId === id, deckId, { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById('stage').contentWindow.tally?.engine?.view().cfg?.text === 'From the shared copy', null, { timeout: 10000 });
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => window.tallyPlayer.page === 1);
  await page.waitForFunction(() => document.getElementById('stage').contentWindow.tally?.engine?.phase() === 'join', null, { timeout: 10000 });
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.getElementById('stage').contentWindow.tally?.engine?.phase() === 'open', null, { timeout: 10000 });
  results.push("  ok  pasting a deck's link loads its quiz from the shared copy, with no file, and the stage plays it at once");
  assert.deepEqual(errors, []);
} catch (e) {
  failed = e;
}
console.log(results.join('\n'));
console.log(failed ? `\nFAILED: ${failed.message}` : `\nall ${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
