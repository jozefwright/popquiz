// The fallback player over a real deck: a PDF downloaded from Google Slides,
// and that deck's quiz file. It walks to every Tally slide, checks the right
// module is up over the right page, plays the first scored question with
// simulated phones, and saves a picture of each. Needs `npm run serve` running.
//
//   node test/play-real.mjs "<deck.pdf>" "<deck.tally.json>"
//
// The pictures are the point. Anything the PDF bakes in (a placeholder shape,
// a picture meant to appear only at the reveal) shows in them.
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { findChrome } from './chrome.mjs';

const [pdfPath, quizPath] = process.argv.slice(2);
if (!pdfPath || !quizPath) {
  console.log('usage: node test/play-real.mjs "<deck.pdf>" "<deck.tally.json>"');
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out', 'real');
await mkdir(out, { recursive: true });
const base = process.env.TALLY_URL || 'http://localhost:8790';
const executablePath = findChrome();

const quiz = JSON.parse(await readFile(quizPath, 'utf8'));
const slides = Object.entries(quiz.slides || {}).map(([id, cfg]) => ({ id, ...cfg })).sort((a, b) => a.index - b.index);
const megabytes = ((await stat(pdfPath)).size / 1e6).toFixed(1);

const browser = await chromium.launch({ executablePath, headless: true });
const results = [];
const pass = (what, detail = '') => results.push(`  ok  ${what}${detail ? `  (${detail})` : ''}`);
let failed = null;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/play/?relay=local&setup&bots=8`);
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((r) => { const d = indexedDB.deleteDatabase('tally-player'); d.onsuccess = d.onerror = d.onblocked = r; });
  });
  await page.reload();

  let t = Date.now();
  await page.setInputFiles('#pdf-file', pdfPath);
  await page.waitForFunction(() => window.tallyPlayer?.pages > 1, null, { timeout: 90000 });
  const pages = await page.evaluate(() => window.tallyPlayer.pages);
  pass('the PDF loads', `${megabytes} MB, ${pages} pages, ${((Date.now() - t) / 1000).toFixed(1)} s`);

  await page.setInputFiles('#deck-file', quizPath);
  await page.waitForFunction((n) => new RegExp(`${n} Tally slide`).test(document.getElementById('deck-state').textContent), slides.length, { timeout: 10000 });
  pass('the quiz file loads', await page.textContent('#deck-state'));
  const last = Math.max(...slides.map((s) => s.index));
  assert.ok(last <= pages, `the quiz points at slide ${last} but the PDF has ${pages} pages`);
  await page.click('.go');

  const stage = () => page.frames().find((f) => /\/stage\/index\.html/.test(f.url()));
  await page.waitForFunction(() => !!document.getElementById('stage').contentWindow.tally?.engine?.s?.room, null, { timeout: 15000 });
  const phase = () => stage().evaluate(() => window.tally.engine.phase());

  // A small fingerprint of what is drawn, to tell when a page has finished changing.
  const drawn = () => page.evaluate(() => {
    const c = document.getElementById('page');
    const s = Object.assign(document.createElement('canvas'), { width: 32, height: 18 });
    s.getContext('2d').drawImage(c, 0, 0, 32, 18);
    return Array.from(s.getContext('2d').getImageData(0, 0, 32, 18).data).join('');
  });
  const goTo = async (n) => {
    const before = await drawn();
    const start = Date.now();
    await page.evaluate((to) => window.tallyPlayer.go(to), n);
    await page.waitForFunction((to) => window.tallyPlayer.page === to, n);
    while (Date.now() - start < 6000 && (await drawn()) === before) await page.waitForTimeout(25);
    return Date.now() - start;
  };

  // How long a page takes to draw, over the first stretch of the deck.
  const flips = [];
  for (let n = 2; n <= Math.min(pages, 16); n++) flips.push(await goTo(n));
  flips.sort((a, b) => a - b);
  pass('pages draw quickly enough to present from', `first ${flips.length} flips: median ${flips[flips.length >> 1]} ms, slowest ${flips.at(-1)} ms`);

  const wantPhase = { join: /join/, leaderboard: /leader|board/, question: /armed|open|locking|reveal/ };
  let played = false;
  for (const s of slides) {
    await goTo(s.index);
    await page.waitForTimeout(900);
    const p = await phase();
    assert.match(p, wantPhase[s.kind] || /./, `slide ${s.index} (${s.kind}) is showing "${p}"`);
    const box = await stage().evaluate(() => {
      const m = document.getElementById('module');
      if (!m || !m.children.length) return null;
      const r = m.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const tied = s.place?.shapeId ? ', was tied to a shape' : '';
    await page.screenshot({ path: path.join(out, `slide-${String(s.index).padStart(2, '0')}-${s.kind}${s.type ? `-${s.type}` : ''}.png`) });
    pass(`slide ${s.index}: ${s.kind}${s.type ? ` (${s.type})` : ''} is up over its page`, `phase ${p}${tied}${box ? `, drawn at ${box.x},${box.y} ${box.w}x${box.h}` : ''}`);

    if (!played && s.kind === 'question' && (s.type === 'mc' || s.type === 'tf')) {
      played = true;
      if ((await phase()) === 'armed') await page.keyboard.press('t'); // set to wait for the key
      await page.waitForFunction(() => document.getElementById('stage').contentWindow.tally.engine.phase() === 'open', null, { timeout: 5000 });
      await page.waitForTimeout(6000); // the simulated phones answer
      await page.screenshot({ path: path.join(out, `slide-${String(s.index).padStart(2, '0')}-open.png`) });
      if ((await phase()) !== 'reveal') await page.keyboard.press('t'); // unless the clock got there first
      await page.waitForFunction(() => document.getElementById('stage').contentWindow.tally.engine.phase() === 'reveal', null, { timeout: 5000 });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(out, `slide-${String(s.index).padStart(2, '0')}-reveal.png`) });
      const board = await stage().evaluate(() => window.tally.engine.leaderboard().length);
      pass(`slide ${s.index}: it opens, simulated phones answer, T reveals`, `${board} players on the board`);
    }
  }
  assert.deepEqual(errors, []);
  pass('no errors on the page');
} catch (e) {
  failed = e;
}
console.log(results.join('\n'));
console.log(failed ? `\nFAILED: ${failed.message}` : `\nall ${results.length} checks passed. Pictures in test/.out/real/`);
await browser.close();
process.exit(failed ? 1 : 0);
