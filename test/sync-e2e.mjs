// Two "laptops", one deck. Two separate Chrome profiles, each with the
// extension loaded and nothing in common but the deck's id, check that a quiz
// built in one is there in the other, and that a change made in the second
// comes back to the first.
//
// The sharing service is the local stand-in from scripts/serve.mjs (the same
// three calls as api/deck.js); Google Slides is a small mock, as in ext-e2e.
//
//   node test/sync-e2e.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..', 'app');
const executablePath = findChrome();
const PORT = 8796;
const DECK_ID = `SYNC_TEST_${Date.now().toString(36)}_0123456789`;
const URL_EDIT = `https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s2`;
// TALLY_SYNC_BASE=https://tally-quiz.vercel.app/api/deck runs this against the real service.
const SYNC_BASE = process.env.TALLY_SYNC_BASE || `http://localhost:${PORT}/api/deck`;

const EDITOR = `<!doctype html><title>Shared deck - Google Slides</title><body style="margin:0;background:#e9e9e9">
<svg width="120" height="200" style="position:absolute;left:0;top:60px"><g id="filmstrip-slide-0-s1"></g><g id="filmstrip-slide-1-s2"></g></svg>
<div id="workspace" style="position:absolute;left:300px;top:60px;width:800px;height:450px"><div id="pages"><svg viewBox="0 0 1600 900" width="800" height="450" style="position:absolute;left:0;top:0"><g id="editor-s2"><g id="editor-s2-bg"><rect width="1600" height="900" fill="#212121"/></g><g id="editor-title1"><rect x="96" y="72" width="900" height="180" fill="#ff4f26"/></g></g></svg></div><svg id="handles" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></svg></div>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await sleep(150);
  }
}

const server = spawn(process.execPath, [path.resolve(here, '..', 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await until(() => fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false), 8000, 'local server');

const profiles = [];
async function laptop(label) {
  const dir = await mkdtemp(path.join(tmpdir(), `tally-sync-${label}-`));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'],
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  // In use a change waits a minute before it is sent (see background.js). Here, 2.5 seconds.
  const settings = (base, pushAfter = 2500) => worker.evaluate((s) => chrome.storage.local.set({ 'tally.settings': s }), { syncBase: base, pushAfter });
  await settings(SYNC_BASE);
  await context.route('https://docs.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: EDITOR }));
  const page = context.pages()[0] || (await context.newPage());
  profiles.push({ dir, context });
  const stored = (key) => worker.evaluate((k) => chrome.storage.local.get(k).then((o) => o[k] ?? null), key);
  let opened = false;
  const open = async () => {
    // The second time, a real reload: going to the same address again would
    // not reopen the page at all.
    if (opened) await page.reload();
    else await page.goto(URL_EDIT);
    opened = true;
    await until(() => page.evaluate(() => document.documentElement.dataset.tally), 10000, `${label}: content script`);
  };
  const put = (cfg) => page.evaluate((c) => postMessage({ t: 'popquiz:dev', do: 'put-slide', slideId: 's2', cfg: c }, location.origin), cfg);
  const previewOptions = () => page.evaluate(() => [...(document.getElementById('popquiz-preview')?.shadowRoot.querySelectorAll('.tm-opt-text') || [])].map((e) => e.textContent));
  return { label, page, worker, stored, open, put, previewOptions, settings };
}

const results = [];
const pass = (what, detail = '') => results.push(`  ok  ${what}${detail ? `  (${detail})` : ''}`);
let failed = null;
try {
  const A = await laptop('A');
  const B = await laptop('B');
  const question = { kind: 'question', index: 2, type: 'mc', text: 'Built on laptop A', options: ['Alpha', 'Bravo', 'Charlie', 'Delta'], correct: 1, seconds: 15, place: { x: 0.06, y: 0.34, w: 0.88, h: 0.58 } };

  // Laptop A builds a question. Nothing else is shared with laptop B.
  await A.open();
  await A.put(question);
  await until(async () => (await A.stored(`tally.sync.${DECK_ID}`))?.pushedAt, 10000, 'A sends its quiz up');
  pass('laptop A: a question is built, and sent to the shared copy by itself');

  // Laptop B has never seen this deck. It opens it.
  assert.equal(await B.stored(`tally.deck.${DECK_ID}`), null);
  await B.open();
  const onB = await until(async () => { const o = await B.previewOptions(); return o.length === 4 ? o : null; }, 10000, 'B shows the quiz');
  assert.deepEqual(onB.map((s) => s.toUpperCase()), ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']);
  const deckB = await B.stored(`tally.deck.${DECK_ID}`);
  assert.equal(deckB.slides.s2.text, 'Built on laptop A');
  assert.equal(deckB.slides.s2.correct, 1);
  pass('laptop B: opening the same deck shows the question on the slide, with nothing copied by hand', onB.join(', '));

  // B changes it; A, on its next look, has the change.
  await B.put({ ...question, text: 'Changed on laptop B', options: ['Alpha', 'Bravo', 'Charlie', 'Echo'] });
  await until(async () => { const s = await B.stored(`tally.sync.${DECK_ID}`); return s?.pushedAt && !s.dirtyAt; }, 10000, 'B sends its change up');
  await A.open(); // reopening the deck is a look
  await until(async () => (await A.stored(`tally.deck.${DECK_ID}`))?.slides?.s2?.text === 'Changed on laptop B', 10000, 'A picks up the change');
  const onA = await until(async () => { const o = await A.previewOptions(); return o.length === 4 && /echo/i.test(o[3]) ? o : null; }, 6000, 'A redraws');
  assert.equal(await A.stored(`tally.kept.${DECK_ID}`), null, 'nothing needed setting aside');
  pass('laptop A: the change made on B arrives when the deck is next opened', onA.join(', '));

  // Changes go up in batches, because the real store counts every save and every
  // look against a monthly allowance. The stand-in counts them too.
  if (!process.env.TALLY_SYNC_BASE) {
    const cost = () => fetch(`${SYNC_BASE}?id=${DECK_ID}&counts=1`).then((r) => r.json());
    const sharedText = () => fetch(`${SYNC_BASE}?id=${DECK_ID}`).then((r) => r.json()).then((j) => j.deck.slides.s2.text);
    const settled = async () => { const s = await A.stored(`tally.sync.${DECK_ID}`); return s?.status === 'in step' && !s.dirtyAt; };
    await A.settings(SYNC_BASE, 5000);
    const before = await cost();
    for (const n of [1, 2, 3, 4]) {
      await A.put({ ...question, text: `Typing, change ${n}` });
      await sleep(600);
    }
    assert.equal((await cost()).saves, before.saves, 'nothing is sent while the wait runs');
    await until(settled, 12000, 'the batch is sent');
    const batched = await cost();
    assert.equal(batched.saves - before.saves, 1, 'four changes went up as one save');
    assert.equal(await sharedText(), 'Typing, change 4', 'and it is the last of them');

    // Leaving the deck's tab sends at once, however long the wait. (Closing or
    // navigating the tab is what a test browser can do; it cannot hide one.)
    await A.settings(SYNC_BASE, 600000);
    await A.put({ ...question, text: 'Typed, then the tab was left' });
    await sleep(1500);
    assert.ok((await A.stored(`tally.sync.${DECK_ID}`)).dirtyAt, 'the change is waiting');
    assert.equal((await cost()).saves, batched.saves);
    await A.page.goto('about:blank');
    await until(async () => (await cost()).saves === batched.saves + 1, 8000, 'leaving the tab sends what was waiting');
    assert.equal(await sharedText(), 'Typed, then the tab was left');

    // And a tab left with nothing to send costs nothing.
    await A.page.goto(URL_EDIT);
    await until(() => A.page.evaluate(() => document.documentElement.dataset.tally), 10000, 'A: content script');
    await until(settled, 8000, 'A is in step');
    await sleep(600);
    const quiet = await cost();
    await A.page.goto('about:blank');
    await sleep(1200);
    assert.deepEqual(await cost(), quiet, 'no look and no save');
    await A.page.goto(URL_EDIT);
    await until(() => A.page.evaluate(() => document.documentElement.dataset.tally), 10000, 'A: content script');
    await A.settings(SYNC_BASE);
    pass('changes go up in batches: four in a row are one save, leaving the tab sends at once, and leaving with nothing to send costs nothing', `${batched.saves - before.saves} save for 4 changes`);
  }

  // The shared copy unreachable: work carries on, and says so honestly.
  await A.settings('http://localhost:9/api/deck');
  await A.put({ ...question, text: 'Edited while offline' });
  await until(async () => (await A.stored(`tally.sync.${DECK_ID}`))?.status === 'unreachable', 10000, 'A reports the shared copy unreachable');
  assert.equal((await A.stored(`tally.deck.${DECK_ID}`)).slides.s2.text, 'Edited while offline', 'the local copy is untouched by the failure');
  await A.settings(SYNC_BASE);
  await A.open();
  await until(async () => { const s = await A.stored(`tally.sync.${DECK_ID}`); return s?.status === 'in step' && !s.dirtyAt; }, 10000, 'A catches up');
  const shared = await fetch(`${SYNC_BASE}?id=${DECK_ID}`).then((r) => r.json());
  assert.equal(shared.deck.slides.s2.text, 'Edited while offline');
  pass('with the shared copy unreachable, work carries on locally and is sent once it is back');

  // A copy of Tally from before 0.3.0 saves without saying what it is. That is
  // the copy that damaged a quiz on 14 Oct 2026: it is refused, and nothing changes.
  const mangled = { ...shared.deck, slides: { s2: { kind: 'question', type: 'mc', text: 'Mangled by an old copy', options: [] } } };
  const refused = await fetch(`${SYNC_BASE}?id=${DECK_ID}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deck: mangled, baseRev: shared.rev }) });
  assert.equal(refused.status, 426);
  assert.equal((await fetch(`${SYNC_BASE}?id=${DECK_ID}`).then((r) => r.json())).deck.slides.s2.text, 'Edited while offline', 'the shared copy is as it was');
  pass('a save from an out-of-date copy of Tally is refused, and the shared copy is untouched');

  // The versions those saves replaced were set aside, and one can be brought back from the panel.
  const history = await fetch(`${SYNC_BASE}?id=${DECK_ID}&history=1`).then((r) => r.json());
  assert.ok(history.versions.length >= 1, 'an earlier version was kept');
  const oldest = history.versions.at(-1);
  const was = await fetch(`${SYNC_BASE}?id=${DECK_ID}&rev=${oldest.rev}`).then((r) => r.json());
  assert.equal(was.deck.slides.s2.text, 'Built on laptop A', 'the first version is still there to be had');
  if (!process.env.TALLY_SYNC_BASE) {
    // The panel, as a plain page beside the stand-in service, pointed at the same deck.
    const panel = await A.page.context().newPage();
    await panel.addInitScript(([base, id, deck]) => { localStorage.setItem('tally.settings', JSON.stringify({ syncBase: base })); if (!localStorage.getItem(`tally.deck.${id}`)) localStorage.setItem(`tally.deck.${id}`, JSON.stringify(deck)); }, [SYNC_BASE, DECK_ID, shared.deck]);
    panel.on('dialog', (d) => d.accept());
    await panel.setViewportSize({ width: 380, height: 900 }); // a side panel's size: wider, and the sticky preview covers the page
    await panel.goto(`http://localhost:${PORT}/panel/panel.html?pid=${DECK_ID}&slide=s2`);
    await panel.click('#tab-quiz'); // sharing lives under the deck, on the Quiz tab, shown only while a sharing service is set
    await panel.locator('details.step summary', { hasText: 'Backups, sharing' }).click();
    await panel.getByRole('button', { name: 'Show earlier versions' }).click();
    const rows = panel.locator('button[title="Bring this one back"]');
    await until(async () => (await rows.count()) === history.versions.length, 6000, 'the panel lists the earlier versions');
    await rows.last().click();
    await until(() => panel.evaluate((id) => JSON.parse(localStorage.getItem(`tally.deck.${id}`) || '{}').slides?.s2?.text === 'Built on laptop A', DECK_ID), 6000, 'the earlier version is the quiz again');
    assert.equal(await panel.evaluate((id) => localStorage.getItem(`tally.keep.${id}`), DECK_ID), 'true', 'and what it replaced is to be kept in its turn');
    await panel.close();
  }
  pass('earlier versions are kept by the shared copy, listed in the panel, and one can be brought back', `${history.versions.length} kept`);

  // The other way about: a newer Tally has saved this quiz. This copy must neither take it nor save over it.
  if (!process.env.TALLY_SYNC_BASE) {
    const { readFile, writeFile } = await import('node:fs/promises');
    const file = path.resolve(here, '.out', 'sync', `${DECK_ID}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, schema: 99, rev: 'from-a-newer-tally', deck: { ...stored.deck, slides: { ...stored.deck.slides, s2: { ...stored.deck.slides.s2, text: 'Saved by a newer Tally', hologram: true } } } }));
    await A.open();
    await until(async () => (await A.stored(`tally.sync.${DECK_ID}`))?.status === 'outdated', 10000, 'A sees it is out of date');
    assert.equal((await A.stored(`tally.deck.${DECK_ID}`)).slides.s2.text, 'Edited while offline', 'it does not take a quiz it would only half understand');
    await A.put({ ...question, text: 'Typed on the out-of-date copy' });
    await sleep(4500);
    assert.equal((await A.stored(`tally.sync.${DECK_ID}`)).status, 'outdated');
    const still = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual([still.rev, still.deck.slides.s2.text, still.deck.slides.s2.hologram], ['from-a-newer-tally', 'Saved by a newer Tally', true], 'and saves nothing over it');
    assert.equal((await A.stored(`tally.deck.${DECK_ID}`)).slides.s2.text, 'Typed on the out-of-date copy', 'what is typed here stays here, safe');
    pass('a quiz saved by a newer Tally is neither taken nor written over; the laptop says it is out of date');
  }
} catch (e) {
  failed = e;
}
console.log(results.join('\n'));
console.log(failed ? `\nFAILED: ${failed.message}` : `\nall ${results.length} checks passed`);
for (const p of profiles) {
  await p.context.close().catch(() => {});
  await rm(p.dir, { recursive: true, force: true });
}
server.kill();
process.exit(failed ? 1 : 0);
