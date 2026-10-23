// End-to-end test of the extension itself, in a real Chromium with the
// unpacked extension loaded.
//
// Google Slides needs a signed-in account, so this test stands a mock in its
// place: requests to docs.google.com are answered with two small pages that
// reproduce the markup the spike found (docs/SLIDES.md). The content script cannot
// tell the difference, so everything from "slideshow starts" to "the module
// is drawn over the placeholder" runs for real, as does the relay and a phone.
//
// What this cannot prove is that Google's markup still matches the mock. That
// is what the check in the real deck is for.
//
//   node test/ext-e2e.mjs
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Player } from '../app/shared/player.js';
import { liveTransport } from './helpers/relay.mjs';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '..', 'app');
const out = path.join(here, '.out');
await mkdir(out, { recursive: true });
const executablePath = findChrome();

const DECK_ID = 'MOCKDECK';
const SLIDES = ['s1', 's2', 's3', 's4', 's5', 's6'];
// Two photos on slide s6, in slide units: an option's votes are shown over each.
const PHOTOS = { pa6: { x: 160, y: 300, w: 480, h: 520 }, pb6: { x: 960, y: 300, w: 480, h: 520 } };
// The placeholder rectangle on slide s2, in slide units of 1600 x 900.
const PH = { x: 96, y: 324, w: 1408, h: 504 };

const shapesFor = (id, prefix) =>
  id === 's2'
    ? `<g id="${prefix}title1"><rect x="96" y="72" width="900" height="180" fill="#ff4f26"/></g><g id="${prefix}before1"><rect x="1100" y="72" width="180" height="180" fill="#888"/></g><g id="${prefix}after1"><rect x="1300" y="72" width="180" height="180" fill="#2fd07a"/></g><g id="${prefix}ph1"><rect x="${PH.x}" y="${PH.y}" width="${PH.w}" height="${PH.h}" fill="#3a3a3a" stroke="#fff"/></g>`
    : `<g id="${prefix}title-${id}"><rect x="96" y="72" width="700" height="150" fill="#ff4f26"/></g>${id === 's6' ? `<g id="${prefix}pa6"><rect x="160" y="300" width="480" height="520" fill="#6b5a4a"/></g><g id="${prefix}pb6"><rect x="960" y="300" width="480" height="520" fill="#4a5a6b"/></g>` : ''}`;

const EDITOR = `<!doctype html><title>Mock deck - Google Slides</title>
<body style="margin:0;background:#e9e9e9;font-family:sans-serif">
<!-- The filmstrip as Slides builds it (read off the real deck, 12 Oct 2026): a box that scrolls, one svg of thumbnails, and inside each
     thumbnail a nested svg in slide units holding the slide's group, its background and its shapes, all with ids. -->
<div class="punch-filmstrip-scroll" style="position:absolute;left:0;top:60px;width:136px;height:300px;overflow:hidden auto">
<svg class="punch-filmstrip-thumbnails" width="120" height="${SLIDES.length * 80 + 10}" style="position:absolute;left:0;top:0">${SLIDES.map((id, i) => `<g class="punch-filmstrip-thumbnail"><g transform="translate(5 ${i * 80 + 5})"><svg viewBox="0 0 1600 900" width="110" height="62"><g><g id="filmstrip-slide-${i}-${id}"><path d="M0 0h1600v900h-1600z" fill="#333"/><g id="filmstrip-slide-${i}-${id}-bg"><rect width="1600" height="900" fill="#1f1f1f"/></g>${shapesFor(id, `filmstrip-slide-${i}-`)}</g></g></svg></g></g>`).join('')}</svg>
</div>
<div id="workspace" style="position:absolute;left:300px;top:60px;width:800px;height:450px"><div id="pages"></div><svg id="handles" style="position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none"></svg></div>
<button id="present" style="position:absolute;right:20px;top:10px">Slideshow</button>
<button id="presenter" style="position:absolute;right:120px;top:10px">Presenter view</button>
<script>
  const SLIDES = ${JSON.stringify(SLIDES)};
  const shapesFor = ${shapesFor.toString()};
  const PH = ${JSON.stringify(PH)};
  function showSlide(id) {
    history.replaceState(null, '', '#slide=id.' + id);
    document.getElementById('pages').innerHTML = '<svg viewBox="0 0 1600 900" width="800" height="450" style="position:absolute;left:0;top:0"><g id="editor-' + id + '"><g id="editor-' + id + '-bg"><rect width="1600" height="900" fill="#1f1f1f"/></g>' + shapesFor(id, 'editor-') + '</g></svg>';
  }
  showSlide((location.hash.match(/slide=id\\.(\\w+)/) || [])[1] || 's2');
  window.openSlide = showSlide;
  window.moveShape = (dx) => { const r = document.querySelector('#editor-ph1 rect'); r.setAttribute('x', +r.getAttribute('x') + dx); };
  // Slides marks a selection with a blue outline in the layer above the pages.
  window.selectShape = (id) => {
    const layer = document.getElementById('handles');
    layer.innerHTML = '';
    if (!id) return;
    const r = document.getElementById('editor-' + id).getBoundingClientRect();
    const o = layer.getBoundingClientRect();
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M' + (r.x - o.x) + ' ' + (r.y - o.y) + 'h' + r.width + 'v' + r.height + 'h' + -r.width + 'z');
    path.setAttribute('stroke', '#1a73e8');
    path.setAttribute('fill', 'none');
    layer.appendChild(path);
  };
  window.canvasPresses = 0;
  document.getElementById('workspace').addEventListener('mousedown', () => window.canvasPresses++);
  // As Slides does it: a blank window, named punch_speaker_notes_..., written into afterwards.
  // The write comes late on purpose. Writing into a window drops every listener
  // on it, so a listener attached once, before the write, hears nothing after.
  document.getElementById('presenter').onclick = () => {
    const w = window.open('about:blank', 'punch_speaker_notes_mock', 'width=700,height=500');
    setTimeout(() => { w.document.open(); w.document.write('<title>Presenter view</title><body><button>Next</button><textarea id="qa"></textarea></body>'); w.document.close(); window.notesWindow = w; }, 1500);
    document.getElementById('present').click();
  };
  document.getElementById('present').onclick = () => {
    const host = document.createElement('div');
    host.className = 'punch-full-screen-element punch-full-window-overlay';
    host.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;background:#000';
    const frame = document.createElement('iframe');
    frame.className = 'punch-present-iframe';
    frame.src = '/presentation/d/${DECK_ID}/present';
    frame.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;border:0';
    host.appendChild(frame);
    document.body.appendChild(host);
    host.requestFullscreen?.().catch(() => {});
    frame.onload = () => frame.contentWindow.focus();
  };
</script>`;

const VIEWER = `<!doctype html><title>Present</title>
<body style="margin:0;background:#000;overflow:hidden">
<div class="punch-viewer-content"><div class="punch-viewer-svgpage-svgcontainer" id="box" style="position:absolute"></div></div>
<script>
  const SLIDES = ${JSON.stringify(SLIDES)};
  const shapesFor = ${shapesFor.toString()};
  const PH = ${JSON.stringify(PH)};
  let i = Math.max(0, SLIDES.indexOf((parent.location.hash.match(/slide=id\\.(\\w+)/) || [])[1]));
  function fit() {
    const W = innerWidth, H = innerHeight;
    let w = W, h = W * 9 / 16;
    if (h > H) { h = H; w = H * 16 / 9; }
    Object.assign(document.getElementById('box').style, { left: (W - w) / 2 + 'px', top: (H - h) / 2 + 'px', width: w + 'px', height: h + 'px' });
  }
  function show() {
    const id = SLIDES[i];
    document.getElementById('box').innerHTML = '<svg viewBox="0 0 1600 900" style="display:block;width:100%;height:100%"><g id="' + id + '"><g id="' + id + '-bg"><rect width="1600" height="900" fill="#1f1f1f"/></g>' + shapesFor(id, '') + '</g></svg>';
    parent.history.replaceState(null, '', '#slide=id.' + id);
  }
  window.advanced = 0;
  window.keysSeen = [];
  window.clicks = 0;
  addEventListener('mousedown', () => window.clicks++);
  addEventListener('keydown', (e) => {
    window.keysSeen.push(e.key);
    if (e.key === 'ArrowRight') { i = Math.min(SLIDES.length - 1, i + 1); show(); }
    else if (e.key === 'ArrowLeft') { i = Math.max(0, i - 1); show(); }
    else if (e.key.toLowerCase() === 't') window.advanced++; // a key Slides would have seen
  });
  addEventListener('resize', fit);
  fit(); show();
</script>`;

const DECK = {
  v: 1,
  presentationId: DECK_ID,
  joinBase: 'https://tally.example/',
  slides: {
    s2: { kind: 'question', index: 2, type: 'mc', text: 'When was this guy the most jacked man on earth?', options: ['1901', '1955', '1978', 'Last Tuesday'], correct: 0, seconds: 30, display: 'bars', place: { shapeId: 'ph1', x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, reveal: { show: ['after1'], hide: ['before1'] } },
    s3: { kind: 'leaderboard', index: 3, top: 5, final: true },
    s4: { kind: 'join', index: 4 },
    s5: { kind: 'question', index: 5, type: 'tf', text: 'Placed by hand', correct: 1, seconds: 10, place: { x: 0.06, y: 0.34, w: 0.88, h: 0.58 } },
    // Votes shown on the slide, over two photos. The places kept with the pins are stale on purpose: the live shapes must win.
    s6: { kind: 'question', index: 6, type: 'poll', text: 'Who wins?', options: ['A', 'B'], seconds: 30, display: 'pins', pins: [{ shapeId: 'pa6', x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { shapeId: 'pb6', x: 0.5, y: 0.5, w: 0.1, h: 0.1 }], place: { x: 0.5, y: 0.05, w: 0.45, h: 0.14 } },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out: ${label}`);
    await sleep(100);
  }
}

const profile = await mkdtemp(path.join(tmpdir(), 'tally-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  viewport: { width: 1280, height: 720 },
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--no-default-browser-check'],
});
const results = [];
const pass = (what, detail = '') => results.push(`  ok  ${what}${detail ? `  (${detail})` : ''}`);
let phone = null;
let failed = null;

try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(worker.url()).host;
  pass('extension loads and its service worker starts', `id ${extId.slice(0, 8)}…`);
  await worker.evaluate((deck) => chrome.storage.local.set({ [`tally.deck.${deck.presentationId}`]: deck }), DECK);
  await worker.evaluate(() => chrome.storage.local.set({ 'tally.welcomed': Date.now() })); // the first-run disclosure, agreed to

  await context.route('https://docs.google.com/**', (route) => {
    const url = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html', body: url.pathname.endsWith('/present') ? VIEWER : EDITOR });
  });

  const page = context.pages()[0] || (await context.newPage());
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s2`);
  await until(() => page.evaluate(() => document.documentElement.dataset.tally), 10000, 'content script starts');
  pass('content script starts on the deck page');

  const status = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const on = (e) => {
            if (e.data?.t !== 'popquiz:dev-status') return;
            removeEventListener('message', on);
            resolve(e.data);
          };
          addEventListener('message', on);
          postMessage({ t: 'popquiz:dev', do: 'status' }, location.origin);
          setTimeout(() => resolve(null), 2000);
        }),
    );

  const before = await status();
  assert.equal(before.presentationId, DECK_ID);
  assert.equal(before.editor.slideId, 's2');
  assert.equal(before.editor.index, 2);
  const ph = before.editor.shapes.find((s) => s.id === 'ph1');
  assert.ok(ph, 'the editor reports the placeholder shape');
  for (const [k, want] of Object.entries({ x: PH.x / 1600, y: PH.y / 900, w: PH.w / 1600, h: PH.h / 900 })) assert.ok(Math.abs(ph[k] - want) < 0.01, `editor shape ${k}: ${ph[k]} vs ${want}`);
  pass('editor: selected slide, its number and its shapes are read', `placeholder at ${Math.round(ph.x * 100)}%, ${Math.round(ph.y * 100)}%`);

  // In the editor the module is drawn on the slide itself, over its placeholder.
  const overPlaceholder = () =>
    page.evaluate(() => {
      const f = document.getElementById('popquiz-preview');
      const g = document.getElementById('editor-ph1');
      if (!f || !g) return null;
      const a = f.getBoundingClientRect();
      const b = g.getBoundingClientRect();
      const order = [...document.getElementById('workspace').children].map((c) => c.id);
      return { off: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)), order, w: Math.round(a.width), h: Math.round(a.height), pointer: getComputedStyle(f).pointerEvents };
    });
  const drawn = await until(async () => { const o = await overPlaceholder(); return o && o.off < 1.5 ? o : null; }, 8000, 'preview drawn over the placeholder in the editor');
  assert.equal(drawn.order[0], 'pages', 'Tally draws above the pages');
  assert.equal(drawn.order.at(-1), 'handles', 'and below the selection handles');
  assert.ok(drawn.order.includes('popquiz-preview'));
  assert.equal(drawn.pointer, 'none');
  await until(() => page.evaluate(() => document.getElementById('popquiz-preview').shadowRoot.querySelectorAll('.tm-opt').length === 4), 5000, 'preview shows the four options');
  assert.equal(page.frames().filter((f) => f.url().startsWith('chrome-extension://')).length, 0, 'no extension frame is added to the editor');
  pass('editor: the real module is drawn on the slide, over its placeholder', `${drawn.w}×${drawn.h}, clicks pass through`);
  await page.waitForTimeout(800); // past the options' entrance
  await page.screenshot({ path: path.join(out, 'ext-e2e-editor.png') });

  // The same module is drawn, small, on each Tally slide's thumbnail in the filmstrip.
  const strip = () =>
    page.evaluate(() => {
      const host = document.getElementById('popquiz-thumbs');
      if (!host) return null;
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const off = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));
      const thumbs = [...host.shadowRoot.querySelectorAll('.thumb')].map(box);
      const ph = box(document.getElementById('filmstrip-slide-1-ph1'));
      const s5 = box(document.getElementById('filmstrip-slide-4-s5-bg'));
      const free = { x: s5.x + 0.06 * s5.w, y: s5.y + 0.34 * s5.h, w: 0.88 * s5.w, h: 0.58 * s5.h };
      return {
        count: thumbs.length,
        onPlaceholder: Math.min(...thumbs.map((t) => off(t, ph))),
        onFreePlace: Math.min(...thumbs.map((t) => off(t, free))),
        options: Math.max(...[...host.shadowRoot.querySelectorAll('.thumb')].map((t) => t.querySelectorAll('.tm-opt').length)),
        placeholderOpacity: getComputedStyle(document.getElementById('filmstrip-slide-1-ph1')).opacity,
        inScroller: host.parentElement.className,
        pointer: getComputedStyle(host).pointerEvents,
      };
    });
  const mini = await until(async () => { const t = await strip(); return t && t.count === 5 && t.onPlaceholder < 1.5 && t.onFreePlace < 1.5 && t.options === 4 ? t : null; }, 8000, 'modules drawn on the filmstrip thumbnails');
  assert.equal(mini.inScroller, 'punch-filmstrip-scroll', 'the miniatures live in the box the filmstrip scrolls in');
  assert.equal(mini.placeholderOpacity, '0', "the placeholder's own fill is hidden on the thumbnail too");
  assert.equal(mini.pointer, 'none');
  assert.deepEqual((await status()).thumbs.map((t) => t.slideId).sort(), ['s2', 's3', 's4', 's5', 's6'], 'one for each Tally slide, none for the ordinary one');
  // Scrolled, they are still on their thumbnails at once: no waiting for the next look.
  const scrolled = await page.evaluate(() => {
    const sc = document.querySelector('.punch-filmstrip-scroll');
    sc.scrollTop = 70;
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const ph = box(document.getElementById('filmstrip-slide-1-ph1'));
    const offs = [...document.getElementById('popquiz-thumbs').shadowRoot.querySelectorAll('.thumb')].map(box).map((t) => Math.max(Math.abs(t.x - ph.x), Math.abs(t.y - ph.y)));
    sc.scrollTop = 0;
    return { moved: sc.scrollHeight > sc.clientHeight, off: Math.min(...offs) };
  });
  assert.ok(scrolled.moved && scrolled.off < 1.5, `the miniature scrolls with its thumbnail: ${JSON.stringify(scrolled)}`);
  pass('filmstrip: each Tally slide’s thumbnail carries its module, on its placeholder, and scrolls with the strip', `${mini.count} thumbnails`);

  // A slide's recorded number goes stale when slides are moved; the PDF fallback
  // places questions by it. The filmstrip's thumbnails put it right.
  const s5 = SLIDES.indexOf('s5') + 1;
  const stale = await worker.evaluate((id) => chrome.storage.local.get(`tally.deck.${id}`).then((o) => { const d = o[`tally.deck.${id}`]; d.slides.s5.index = 99; return chrome.storage.local.set({ [`tally.deck.${id}`]: d }); }), DECK_ID);
  await until(async () => (await worker.evaluate((id) => chrome.storage.local.get(`tally.deck.${id}`), DECK_ID))[`tally.deck.${DECK_ID}`].slides.s5.index === s5, 4000, 'a stale slide number is put right from the filmstrip');
  pass('filmstrip: a Tally slide’s recorded number follows it when slides are moved', `s5 back to ${s5}`);

  await page.evaluate(() => window.moveShape(-60));
  await until(async () => { const o = await overPlaceholder(); return o && o.off < 1.5; }, 3000, 'preview follows the shape');
  await until(async () => (await status()).slides.s2.place.x < 0.03, 4000, 'moved position saved');
  await page.evaluate(() => window.moveShape(60));
  await until(async () => Math.abs((await status()).slides.s2.place.x - 0.06) < 0.005, 4000, 'position saved again');
  pass('editor: move the placeholder and the module follows; the new position is saved');

  // Reveal shapes are ghosted in the editor when they would be absent, and tagged.
  const ghost = () => page.evaluate(() => ({ before: getComputedStyle(document.getElementById('editor-before1')).opacity, after: getComputedStyle(document.getElementById('editor-after1')).opacity, tags: [...(document.getElementById('popquiz-marks')?.children || [])].map((c) => c.textContent) }));
  await until(async () => { const g = await ghost(); return g.after === '0.25' && g.before === '1' && g.tags.length === 2; }, 4000, 'voting view in the editor');
  await worker.evaluate(() => chrome.storage.local.set({ 'tally.ui': { previewPhase: 'reveal' } }));
  await until(async () => { const g = await ghost(); return g.after === '1' && g.before === '0.25'; }, 4000, 'result view in the editor');
  await worker.evaluate(() => chrome.storage.local.set({ 'tally.ui': { previewPhase: 'voting' } }));
  pass('editor: reveal shapes are tagged, and ghosted to match the Voting or Result view');

  // Selecting a shape on the canvas is reported, so the panel can offer it.
  assert.equal((await status()).editor.selected, null);
  await page.evaluate(() => window.selectShape('title1'));
  await until(async () => (await status()).editor.selected === 'title1', 3000, 'selected shape reported');
  await page.evaluate(() => window.selectShape(null));
  pass('editor: the shape selected on the canvas is recognised');

  // On 15 Oct 2026 Slides redrew its selection (round handles, pills on the
  // edges) and the outline above stopped being recognised. Tally also works out
  // the selection from where a press lands, so what Google draws does not matter.
  await page.evaluate(() => { document.getElementById('handles').innerHTML = '<circle cx="12" cy="12" r="6" fill="#fff" stroke="#0b57d0"/>'; });
  const centre = (id) => page.evaluate((i) => { const r = document.getElementById(`editor-${i}`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, id);
  const selectedNow = async () => (await status()).editor.selected;
  let at = await centre('after1');
  await page.mouse.click(at.x, at.y);
  await until(async () => (await selectedNow()) === 'after1', 3000, 'a pressed shape is reported as selected');
  await page.keyboard.press('Escape');
  await until(async () => (await selectedNow()) === null, 3000, 'Escape clears it');
  at = await centre('title1');
  await page.mouse.click(at.x, at.y);
  await until(async () => (await selectedNow()) === 'title1', 3000, 'another press, another shape');
  const corner = await page.evaluate(() => { const r = document.getElementById('workspace').getBoundingClientRect(); return { x: r.right - 6, y: r.bottom - 6 }; });
  await page.mouse.click(corner.x, corner.y);
  await until(async () => (await selectedNow()) === null, 3000, 'a press on empty canvas clears it');

  // And the whole way: the panel offers the pressed shape, and marks it to arrive at the reveal.
  const sidePanel = await context.newPage();
  await sidePanel.setViewportSize({ width: 420, height: 900 }); // the side panel's size, so its preview keeps to the top
  await sidePanel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await page.bringToFront();
  at = await centre('title1');
  await page.mouse.click(at.x, at.y);
  const offer = sidePanel.getByRole('button', { name: 'Show it only at the reveal' });
  await until(() => offer.count().then((n) => n === 1), 6000, 'the panel offers the pressed shape');
  await offer.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await offer.click();
  await until(async () => ((await worker.evaluate((id) => chrome.storage.local.get(`tally.deck.${id}`), DECK_ID))[`tally.deck.${DECK_ID}`]?.slides?.s2?.reveal?.show || []).includes('title1'), 4000, 'title1 is set to arrive at the reveal');
  await sidePanel.close();
  await page.bringToFront();
  await worker.evaluate((id) => chrome.storage.local.get(`tally.deck.${id}`).then((o) => { const d = o[`tally.deck.${id}`]; d.slides.s2.reveal.show = d.slides.s2.reveal.show.filter((x) => x !== 'title1'); return chrome.storage.local.set({ [`tally.deck.${id}`]: d }); }), DECK_ID);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.getElementById('handles').innerHTML = ''; window.canvasPresses = 0; });
  pass('editor: a pressed shape counts as selected whatever Google draws, and the panel marks it to arrive at the reveal');

  // A module not tied to a shape is dragged and resized on the slide itself.
  await page.evaluate(() => window.openSlide('s5'));
  const freeBox = () => page.evaluate(() => { const r = document.getElementById('popquiz-preview')?.getBoundingClientRect(); return r && document.getElementById('popquiz-preview').hasAttribute('data-free') ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; });
  const b0 = await until(freeBox, 4000, 'free-placed preview');
  await page.mouse.move(b0.x + b0.w / 2, b0.y + b0.h / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.w / 2 - 20, b0.y + b0.h / 2 - 45, { steps: 6 });
  await page.mouse.up();
  await until(async () => { const pl = (await status()).slides.s5.place; return Math.abs(pl.x - 0.035) < 0.004 && Math.abs(pl.y - 0.24) < 0.004; }, 4000, 'dragged position saved');
  const b1 = await freeBox();
  await page.mouse.move(b1.x + b1.w, b1.y + b1.h);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.w - 240, b1.y + b1.h - 45, { steps: 6 });
  await page.mouse.up();
  const sized = await until(async () => { const pl = (await status()).slides.s5.place; return Math.abs(pl.w - 0.58) < 0.004 && Math.abs(pl.h - 0.48) < 0.004 ? pl : null; }, 4000, 'resized size saved');
  assert.equal(await page.evaluate(() => window.canvasPresses), 0, 'presses on the module never reach the canvas underneath');
  pass('editor: a hand-placed module is dragged and resized on the slide; Slides never sees the drag', `now ${Math.round(sized.w * 100)}% × ${Math.round(sized.h * 100)}% at ${Math.round(sized.x * 100)}%, ${Math.round(sized.y * 100)}%`);
  await page.screenshot({ path: path.join(out, 'ext-e2e-editor-free.png') });

  // Votes shown on the slide: each pinned option is drawn over its own photo, wherever the photo is now.
  await page.evaluate(() => window.openSlide('s6'));
  const overPhotos = (root, ids) =>
    page.evaluate(([root, ids]) => {
      const host = document.getElementById(root);
      const pins = host ? [...host.shadowRoot.querySelectorAll('.tm-pin')] : [];
      if (pins.length !== ids.length) return null;
      return Math.max(...pins.map((p, i) => { const a = p.getBoundingClientRect(); const b = document.getElementById(ids[i]).getBoundingClientRect(); return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)); }));
    }, [root, ids]);
  await until(async () => { const off = await overPhotos('popquiz-preview', ['editor-pa6', 'editor-pb6']); return off !== null && off < 1.5; }, 6000, 'pins over the photos in the editor');
  await until(async () => { const off = await overPhotos('popquiz-thumbs', ['filmstrip-slide-5-pa6', 'filmstrip-slide-5-pb6']); return off !== null && off < 1.5; }, 6000, 'pins over the photos on the thumbnail');
  await until(async () => { const p = (await status()).slides.s6.pins[1]; return Math.abs(p.x - PHOTOS.pb6.x / 1600) < 0.005 && Math.abs(p.h - PHOTOS.pb6.h / 900) < 0.005; }, 4000, 'where the photos are is kept with the pins');
  assert.equal(await page.evaluate(() => document.getElementById('popquiz-preview').shadowRoot.querySelectorAll('.tm-opt').length), 0, 'every option is out on the slide, none in the box');
  pass('editor: votes shown on the slide sit over each option’s photo, on the slide and on its thumbnail; the photos’ places are saved');
  await page.screenshot({ path: path.join(out, 'ext-e2e-pins.png') });

  await page.evaluate(() => window.openSlide('s1'));
  await until(() => page.evaluate(() => !document.getElementById('popquiz-preview')), 3000, 'no preview on an ordinary slide');
  await page.evaluate(() => window.openSlide('s2'));
  await until(async () => { const o = await overPlaceholder(); return o && o.off < 1.5; }, 4000, 'preview back on the question slide');
  pass('editor: an ordinary slide shows nothing; the question slide shows its module again');

  await page.click('#present');
  await until(() => page.evaluate(() => !!document.querySelector('.punch-full-screen-element > #popquiz-stage')), 10000, 'stage mounted in the full-screen element');
  assert.equal(await page.evaluate(() => !!document.getElementById('popquiz-preview')), false, 'the editor preview is removed when the slideshow starts');
  const fullscreen = await page.evaluate(() => document.fullscreenElement?.className || null);
  pass('slideshow detected; stage mounted inside the full-screen element', fullscreen ? 'element is truly full screen' : 'full screen not granted in this run');

  const stage = await until(() => context.pages().flatMap((p) => p.frames()).find((f) => f.url().includes('/stage/index.html')), 10000, 'stage frame');
  const viewer = await until(() => page.frames().find((f) => f.url().endsWith('/present')), 5000, 'viewer frame');
  await until(() => stage.evaluate(() => window.tally?.engine?.s?.cur === 's2' && window.tally.engine.phase() === 'open').catch(() => false), 15000, 'engine on slide s2, question open');
  pass('stage runs as an extension page: engine started, question opened on arrival');

  await until(() => stage.evaluate(() => window.tally.engine.link === 'live'), 15000, 'relay link from inside the extension');
  pass('relay connects from inside the extension page');

  // In Presenter view the panel stays open beside the slideshow, and that
  // window can be on the projector or shared to a call: it shows nothing of the quiz.
  const covered = await context.newPage();
  await covered.setViewportSize({ width: 420, height: 900 });
  await covered.goto(`chrome-extension://${extId}/panel/panel.html`);
  await page.bringToFront();
  await until(() => covered.evaluate(() => !document.getElementById('presenting').hidden && document.querySelector('main').hidden && document.getElementById('tabs').hidden), 6000, 'the panel steps aside while the slideshow runs');
  await covered.close();
  await page.bringToFront();
  pass('side panel: while the slideshow runs it shows nothing of the quiz');

  // Is the module drawn where the placeholder is?
  const want = await viewer.evaluate(() => {
    const r = document.getElementById('ph1').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, hidden: getComputedStyle(document.getElementById('ph1')).visibility };
  });
  const got = await until(
    () =>
      stage.evaluate(() => {
        const el = document.getElementById('module');
        const r = el.getBoundingClientRect();
        return el.classList.contains('on') && r.width > 10 ? { x: r.left, y: r.top, w: r.width, h: r.height, options: document.querySelectorAll('.tm-opt').length } : null;
      }),
    5000,
    'module placed',
  );
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(got[k] - want[k]) < 2.5, `module ${k}: ${got[k]} vs placeholder ${want[k]}`);
  assert.equal(got.options, 4);
  pass('module is drawn exactly over the placeholder shape', `${Math.round(got.w)}×${Math.round(got.h)} at ${Math.round(got.x)},${Math.round(got.y)}`);
  assert.equal(want.hidden, 'hidden');
  pass('the placeholder shape itself is hidden during the show');
  const vis = () => viewer.evaluate(() => ({ before: getComputedStyle(document.getElementById('before1')).visibility, after: getComputedStyle(document.getElementById('after1')).visibility }));
  assert.deepEqual(await vis(), { before: 'visible', after: 'hidden' });
  pass('while voting: the reveal photo is hidden, the before photo shows');

  // A phone joins over the real relay and answers.
  const room = await stage.evaluate(() => window.tally.engine.s.room);
  phone = new Player({ transport: liveTransport() });
  phone.open(room);
  phone.setName('E2E');
  await until(() => phone.screen() === 'question', 10000, 'phone sees the question');
  phone.answer(0);
  await until(() => phone.confirmed(), 6000, 'answer confirmed');
  await until(() => stage.evaluate(() => window.tally.engine.view().answered === 1), 3000, 'answer on the stage');
  pass('a phone joins over the relay, answers, and the stage counts it');
  await page.screenshot({ path: path.join(out, 'ext-e2e-voting.png') });

  // The hotkey: T ends the question early. It must not reach the slideshow.
  // A click on the slide must pass straight through the stage to the
  // slideshow beneath it, which also gives that frame the keyboard, as in Slides.
  await page.mouse.click(640, 200);
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(640, 200);
    return `${el?.tagName}.${el?.className || el?.id}`;
  });
  const landed = await viewer.evaluate(() => ({ clicks: window.clicks, focus: document.hasFocus() }));
  assert.ok(landed.clicks === 1, `a click passes through the stage to the slideshow (hit ${hit}, ${JSON.stringify(landed)})`);
  if (!landed.focus) await viewer.evaluate(() => window.focus());
  const keys = page.keyboard;
  await keys.press('t');
  await until(() => stage.evaluate(() => window.tally.engine.phase() === 'reveal'), 4000, 'T reveals');
  await until(() => phone.screen() === 'result', 4000, 'phone shows the result');
  await until(async () => { const v = await vis(); return v.before === 'hidden' && v.after === 'visible'; }, 1500, 'photos swap at the reveal');
  pass('at the reveal: the reveal photo arrives and the before photo leaves');
  assert.equal(await viewer.evaluate(() => window.advanced), 0, 'the T key was kept from the slideshow');
  assert.deepEqual(await viewer.evaluate(() => window.keysSeen), [], 'no key reached the slideshow');
  pass('clicks pass through the stage; T reveals the answer on screen and phone; Slides never sees the key');
  await sleep(900);
  await page.screenshot({ path: path.join(out, 'ext-e2e-reveal.png') });

  // Advancing the slideshow moves Tally with it.
  await keys.press('ArrowRight');
  await until(() => stage.evaluate(() => window.tally.engine.s.cur === 's3' && window.tally.engine.phase() === 'leaderboard'), 4000, 'follows to the leaderboard');
  await until(() => phone.screen() === 'leaderboard', 4000, 'phone follows');
  // It is the final one: its podium starts covered, and the phone is told nothing until T uncovers it.
  assert.equal(phone.snap.hold, true, 'the phone is held while the podium is covered');
  assert.equal(await stage.evaluate(() => document.querySelectorAll('.tm-pod-open').length), 0);
  await keys.press('t');
  await until(() => phone.snap.lb?.[phone.pid], 4000, 'T uncovers the podium and the phone hears its place');
  assert.equal(await stage.evaluate(() => document.querySelector('.tm-pod-1.tm-pod-open .tm-pod-name')?.textContent), phone.name, 'the winner is on the podium');
  assert.equal(await viewer.evaluate(() => window.advanced), 0, 'T on the final leaderboard never reached the slideshow');
  assert.equal(phone.snap.lb[phone.pid][1], 1, 'the phone has one correct answer');
  pass('next slide: the leaderboard follows on screen and phone', `phone is ${phone.snap.lb[phone.pid][0]} with ${phone.snap.lb[phone.pid][1]} correct`);
  await sleep(900);
  await page.screenshot({ path: path.join(out, 'ext-e2e-board.png') });

  await keys.press('ArrowRight');
  await until(() => stage.evaluate(() => window.tally.engine.phase() === 'join' && !!document.querySelector('.tm-qr-svg')), 4000, 'join slide with QR');
  pass('join slide draws its QR code');

  // On to the slide whose votes are shown over two photos: in the show, over the photos as they are drawn there.
  await keys.press('ArrowRight');
  await keys.press('ArrowRight');
  await until(() => stage.evaluate(() => window.tally.engine.s.cur === 's6' && document.querySelectorAll('.tm-pin').length === 2), 5000, 'pins in the show');
  const photos = await viewer.evaluate(() => ['pa6', 'pb6'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, shown: getComputedStyle(document.getElementById(id)).visibility }; }));
  const drawnPins = await stage.evaluate(() => [...document.querySelectorAll('.tm-pin')].map((p) => { const r = p.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }));
  photos.forEach((want, i) => { for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(drawnPins[i][k] - want[k]) < 2.5, `pin ${i} ${k}: ${drawnPins[i][k]} vs photo ${want[k]}`); assert.equal(want.shown, 'visible', 'a photo with votes over it stays in view'); });
  await until(() => phone.snap?.q?.id === 's6' && phone.screen() === 'question', 6000, 'the phone has this question');
  phone.answer(1);
  await until(() => stage.evaluate(() => { const p = document.querySelectorAll('.tm-pin')[1]; return p.querySelector('.tm-pin-num').textContent === '1' && p.querySelector('.tm-pin-fill').getBoundingClientRect().height > p.getBoundingClientRect().height * 0.9; }), 6000, 'a vote raises the column over its photo');
  pass('slideshow: votes are drawn over each option’s photo and rise as phones vote', `${Math.round(drawnPins[1].w)}×${Math.round(drawnPins[1].h)} at ${Math.round(drawnPins[1].x)},${Math.round(drawnPins[1].y)}`);
  await page.screenshot({ path: path.join(out, 'ext-e2e-pins-show.png') });

  // Leaving the slideshow removes the stage; starting again resumes the session.
  await page.evaluate(() => {
    document.exitFullscreen?.().catch(() => {});
    document.querySelector('.punch-full-screen-element').remove();
  });
  await until(async () => !(await status()).presenting, 4000, 'stage removed with the slideshow');
  await page.click('#present');
  const stage2 = await until(() => context.pages().flatMap((p) => p.frames()).find((f) => f.url().includes('/stage/index.html') && f !== stage && !f.isDetached()), 10000, 'stage again');
  await until(() => stage2.evaluate(() => window.tally?.engine?.s?.room).catch(() => null), 10000, 'engine again');
  const again = await stage2.evaluate(() => ({ room: window.tally.engine.s.room, players: window.tally.engine.view().playerCount, q: window.tally.engine.s.q.s2?.status }));
  assert.deepEqual(again, { room, players: 1, q: 'closed' });
  pass('slideshow closed and reopened: same room, same player, same results');

  // The same deck's slideshow opened in a second window must not start a
  // second engine. It stands by, and takes over if the first one closes.
  const second = await context.newPage();
  await second.goto(`https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s2`);
  await until(() => second.evaluate(() => document.documentElement.dataset.tally), 10000, 'content script in the second window');
  await second.click('#present');
  const stageB = await until(() => second.frames().find((f) => f.url().includes('/stage/index.html')), 10000, 'second stage');
  await until(() => stageB.evaluate(() => window.tallyStandingBy === true).catch(() => false), 8000, 'second stage stands by');
  assert.equal(await stageB.evaluate(() => !!window.tally), false, 'no second engine was started');
  assert.match(await stageB.evaluate(() => document.getElementById('hud').textContent), /standing by/);
  await page.close(); // the first window goes away
  await until(() => stageB.evaluate(() => window.tally?.engine?.s?.room).catch(() => null), 12000, 'second stage takes over');
  assert.equal(await stageB.evaluate(() => window.tally.engine.s.room), room, 'and carries on the same room');
  pass('a second window on the same deck stands by, then takes over the same room when the first closes');

  // Presenter view: the keyboard is in the notes window, a blank page no
  // content script can reach. T pressed there must still reveal the answer.
  const pv = await context.newPage();
  await pv.goto(`https://docs.google.com/presentation/d/${DECK_ID}/edit#slide=id.s5`);
  await until(() => pv.evaluate(() => document.documentElement.dataset.tally), 10000, 'content script, presenter view tab');
  await second.close(); // it holds the engine; this tab needs it
  const known = new Set(context.pages());
  await pv.click('#presenter');
  await until(() => pv.evaluate(() => !!window.notesWindow), 8000, 'notes window written');
  const notes = await until(() => context.pages().find((p) => !known.has(p)), 8000, 'notes window');
  const stagePv = await until(() => pv.frames().find((f) => f.url().includes('/stage/index.html')), 10000, 'stage, presenter view tab');
  await until(() => stagePv.evaluate(() => window.tally?.engine?.s?.cur === 's5').catch(() => false), 15000, 'engine on s5');
  await stagePv.evaluate(() => window.tally.engine.rerun());
  await until(() => stagePv.evaluate(() => window.tally.engine.phase() === 'open'), 5000, 's5 open');
  await notes.locator('#qa').click();
  await notes.keyboard.press('t');
  await sleep(700);
  assert.equal(await stagePv.evaluate(() => window.tally.engine.phase()), 'open', 'typing a T into a text box in the notes window is not a hotkey');
  await notes.locator('button').click();
  await sleep(1000); // a T in the first moments of a question is taken as a double press
  await notes.keyboard.press('t');
  await until(() => stagePv.evaluate(() => window.tally.engine.phase() === 'reveal'), 5000, 'T in the notes window reveals');
  pass('Presenter view: T pressed in the notes window reveals the answer; typing in a text box there does not');

  // The side panel page opens inside the extension without errors.
  const panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(String(e)));
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await sleep(1200);
  assert.deepEqual(panelErrors, []);
  pass('side panel page opens inside the extension without errors');

  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), [], 'no errors on the deck page');
  pass('no errors logged on the deck page');
} catch (e) {
  failed = e;
  try {
    const page = context.pages()[0];
    const dump = await page.evaluate(() => ({ hash: location.hash, focus: document.activeElement?.tagName, fs: !!document.fullscreenElement, stage: !!document.getElementById('popquiz-stage') }));
    const frames = page.frames().map((f) => f.url().replace(/^chrome-extension:\/\/[a-z]+/, 'ext:'));
    const v = page.frames().find((f) => f.url().endsWith('/present'));
    const seen = v ? await v.evaluate(() => ({ keys: window.keysSeen, hasFocus: document.hasFocus(), shown: document.querySelector('svg g')?.id })) : null;
    console.log('debug', JSON.stringify(dump), JSON.stringify(frames), JSON.stringify(seen));
  } catch {}
}

console.log(results.join('\n'));
if (failed) console.log(`\nFAILED: ${failed.message}`);
else console.log(`\nall ${results.length} checks passed. Screenshots in test/.out/`);
phone?.leave();
await context.close();
await rm(profile, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
