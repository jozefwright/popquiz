// A newer Tally arrives on the laptop's disk while an older one is running.
// The panel must say so, one press of Reload Pop Quiz must bring the new one up,
// the open deck must come back on it, and the quiz must still be there.
//
// The extension is loaded from a copy of app/ in a temporary folder, so its
// files can be changed under it the way app/get/popquiz.sh changes them.
//
// What this cannot do is follow the extension through its own reload: loaded
// by a command-line flag, as a test must, it does not come back. So the press
// and the coming back are checked as two halves.
//
//   node test/update-e2e.mjs
import { chromium } from 'playwright-core';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const executablePath = findChrome();
const DECK_ID = `UPDATE_TEST_${Date.now().toString(36)}_0123456789`;
const NEXT = '9.9.9';
const EDITOR = `<!doctype html><title>Deck - Google Slides</title><body style="margin:0;background:#e9e9e9">
<div id="workspace" style="position:absolute;left:300px;top:60px;width:800px;height:450px"><div id="pages"><svg viewBox="0 0 1600 900" width="800" height="450" style="position:absolute;left:0;top:0"><g id="editor-s2"><g id="editor-s2-bg"><rect width="1600" height="900" fill="#1f1f1f"/></g></g></svg></div></div>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
}

const ext = await mkdtemp(path.join(tmpdir(), 'tally-update-ext-'));
await cp(path.resolve(here, '..', 'app'), ext, { recursive: true });
const was = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8')).version;
const profile = await mkdtemp(path.join(tmpdir(), 'tally-update-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'],
});
const results = [];
const pass = (what, detail = '') => results.push(`  ok  ${what}${detail ? `  (${detail})` : ''}`);
let failed = null;
let clicked = 'ok';
try {
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(worker.url()).host;
  const quiz = { v: 1, presentationId: DECK_ID, slides: { s2: { kind: 'question', type: 'mc', text: 'Still here after the update?', options: ['Yes', 'No'], correct: 0 } } };
  // Sharing off: this is about the extension and its files, not the service.
  await worker.evaluate(([id, deck]) => chrome.storage.local.set({ 'tally.settings': { syncBase: '' }, [`tally.deck.${id}`]: deck }), [DECK_ID, quiz]);
  await context.route('https://docs.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: EDITOR }));
  const deck = context.pages()[0] || (await context.newPage());
  await deck.goto(`https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s2`);
  await until(() => deck.evaluate(() => document.documentElement.dataset.tally), 10000, 'content script');
  assert.equal(await deck.evaluate(() => document.documentElement.dataset.tally), was);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await sleep(1500);
  assert.equal(await panel.evaluate(() => document.getElementById('update').hidden), true);
  pass('with nothing newer on the laptop, the panel says nothing about updates', `running ${was}`);

  // A newer copy lands in the folder, as popquiz.sh would put it: the manifest last.
  await writeFile(path.join(ext, 'version.json'), `{ "version": "${NEXT}" }\n`);
  await writeFile(path.join(ext, 'manifest.json'), (await readFile(path.join(ext, 'manifest.json'), 'utf8')).replace(`"version": "${was}"`, `"version": "${NEXT}"`));
  await panel.reload();
  const line = await until(() => panel.evaluate(() => { const u = document.getElementById('update'); return u.hidden ? null : { text: u.textContent, button: u.querySelector('button')?.textContent }; }), 8000, 'the panel sees the newer copy');
  assert.match(line.text, new RegExp(`Pop Quiz ${NEXT.replaceAll('.', '\\.')} is ready on this laptop`));
  assert.equal(line.button, 'Reload Pop Quiz');
  pass('a newer Tally on the laptop is announced in the panel, with a Reload Pop Quiz button', line.text.replace('Reload Pop Quiz', '').trim());

  // Coming back first, while there is still a worker to ask. On coming up with
  // the note that a reload was asked for, Tally reloads the decks that are open.
  // The step is asked for by message here, which stands in for the reload: an
  // extension loaded by a command-line flag, as this one is, does not come back
  // from chrome.runtime.reload() in a test browser. One loaded from
  // chrome://extensions does, and runs this same step as it starts.
  await deck.evaluate(() => (window.loadedBefore = true));
  await worker.evaluate(() => chrome.storage.local.set({ 'tally.revive': Date.now() }));
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: 'tally:revive' }));
  await until(() => deck.evaluate(() => window.loadedBefore !== true && !!document.documentElement.dataset.tally), 15000, 'the open deck is reloaded');
  const kept = await worker.evaluate((id) => chrome.storage.local.get([`tally.deck.${id}`, 'tally.revive']), DECK_ID);
  assert.equal(kept[`tally.deck.${DECK_ID}`].slides.s2.text, 'Still here after the update?');
  assert.equal(kept['tally.revive'] ?? null, null, 'the note is cleared once acted on');
  await deck.evaluate(() => (window.loadedBefore = true));
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: 'tally:revive' }));
  await sleep(1200);
  assert.equal(await deck.evaluate(() => window.loadedBefore), true, 'with no note, nothing is reloaded');
  pass('coming back after a reload, Tally reloads the decks that are open, once, and the quiz is still there');

  // Then the press itself: it must take Tally down to reload it. The panel is part of Tally, so it goes too.
  await panel.bringToFront();
  await panel.getByRole('button', { name: 'Reload Pop Quiz' }).click({ noWaitAfter: true }).catch((e) => { clicked = String(e.message).split('\n')[0]; });
  await until(() => panel.isClosed(), 8000, `Reload Pop Quiz takes the extension down to reload it (click: ${clicked})`);
  pass('one press of Reload Pop Quiz restarts the extension');
} catch (e) {
  failed = e;
}
console.log(results.join('\n'));
console.log(failed ? `\nFAILED: ${failed.message}` : `\nall ${results.length} checks passed`);
await context.close().catch(() => {});
await rm(profile, { recursive: true, force: true });
await rm(ext, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
