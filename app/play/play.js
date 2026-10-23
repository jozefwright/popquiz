// The fallback player, and the test bench.
//
// It shows the deck from an exported PDF and lays the same stage over it that
// the extension lays over Google Slides. If the extension ever misbehaves,
// the talk runs from here with the same room, the same phones and the same
// scores. With nothing loaded it plays a demo deck, which is how Tally is
// developed without touching a real presentation.
//
// The PDF and the quiz config are kept in this browser, so a reload mid-talk
// comes back to the same slide.

import * as pdfjs from '../vendor/pdf.min.mjs';
import { store, KEYS } from '../shared/store.js';
import { DEFAULT_SYNC_BASE } from '../shared/config.js';
import { normaliseDeck, slideIdForIndex } from '../shared/deck.js';
import { DEMO_DECK, DEMO_PAGES } from './demo.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

const query = new URLSearchParams(location.search);
const relay = query.get('relay') === 'local' ? 'local' : 'live';
const $ = (id) => document.getElementById(id);
const $show = $('show');
const $slide = $('slide');
const $canvas = $('page');
const $mock = $('mock');
const $stage = $('stage');
const $setup = $('setup');

const PLAYER_KEY = 'tally.player';

// ---- a tiny IndexedDB shelf for the PDF ------------------------------------

function shelf() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('tally-player', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function shelfGet(key) {
  const db = await shelf();
  return new Promise((resolve, reject) => {
    const req = db.transaction('files').objectStore('files').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function shelfPut(key, value) {
  const db = await shelf();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    if (value === null) tx.objectStore('files').delete(key);
    else tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- state -----------------------------------------------------------------

let saved = (await store.get(PLAYER_KEY)) || {};
let presentationId = saved.presentationId || DEMO_DECK.presentationId;
let deck = null;
let demo = true;
let pdf = null;
let pdfName = saved.pdfName || '';
let pages = DEMO_PAGES;
let aspect = 16 / 9;
let page = Math.max(1, +saved.page || 1);
let stageReady = false;
let roomInfo = null;
let renderJob = 0;

async function loadDeck() {
  const raw = await store.get(KEYS.deck(presentationId));
  demo = !raw || presentationId === DEMO_DECK.presentationId;
  if (demo) {
    presentationId = DEMO_DECK.presentationId;
    await store.set(KEYS.deck(presentationId), normaliseDeck(DEMO_DECK, presentationId));
    deck = normaliseDeck(DEMO_DECK, presentationId);
  } else {
    deck = normaliseDeck(raw, presentationId);
  }
}

async function loadPdf() {
  try {
    const data = await shelfGet('pdf');
    if (!data) {
      pdf = null;
      pages = demo ? DEMO_PAGES : Math.max(1, ...Object.values(deck.slides).map((s) => s.index || 1));
      aspect = 16 / 9;
      return;
    }
    pdf = await pdfjs.getDocument({ data: data.slice(0) }).promise;
    pages = pdf.numPages;
    const first = await pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    aspect = vp.width / vp.height;
  } catch (e) {
    console.error('[tally] could not open the PDF', e);
    pdf = null;
  }
}

function remember() {
  store.set(PLAYER_KEY, { presentationId, page, pdfName });
}

// ---- drawing the slide -----------------------------------------------------

function slideRect() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  let w = W;
  let h = W / aspect;
  if (h > H) {
    h = H;
    w = H * aspect;
  }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h) };
}

function currentSlideId() {
  return slideIdForIndex(deck, page) || `page-${page}`;
}

async function drawPage() {
  const job = ++renderJob;
  const r = slideRect();
  Object.assign($slide.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  $('where').textContent = `${page} / ${pages}`;
  if (!pdf) {
    $canvas.hidden = true;
    $mock.hidden = false;
    const cfg = deck.slides[slideIdForIndex(deck, page)];
    const raw = DEMO_DECK.slides[slideIdForIndex(deck, page)];
    const heading = demo ? (raw ? raw.title : page === 1 ? 'The Friday quiz' : 'An ordinary slide') : cfg?.text || (cfg ? '' : `Slide ${page}`);
    const sub = demo && !raw ? (page === 1 ? 'Demo deck. Arrow keys to move.' : 'Phones show a waiting screen here.') : '';
    $mock.replaceChildren();
    if (heading) $mock.append(Object.assign(document.createElement('h2'), { textContent: heading }));
    if (sub) $mock.append(Object.assign(document.createElement('p'), { textContent: sub }));
    $mock.append(Object.assign(document.createElement('div'), { className: 'num', textContent: String(page) }));
    return;
  }
  $mock.hidden = true;
  $canvas.hidden = false;
  const p = await pdf.getPage(page);
  if (job !== renderJob) return;
  const base = p.getViewport({ scale: 1 });
  const scale = (r.w / base.width) * Math.min(2, window.devicePixelRatio || 1);
  const vp = p.getViewport({ scale });
  // Draw off-screen and swap, so the old slide stays up until the new one is whole.
  const off = document.createElement('canvas');
  off.width = Math.round(vp.width);
  off.height = Math.round(vp.height);
  await p.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
  if (job !== renderJob) return;
  const place = deck.slides[slideIdForIndex(deck, page)]?.place;
  if (place?.shapeId) paintOut(off, place);
  $canvas.width = off.width;
  $canvas.height = off.height;
  $canvas.getContext('2d').drawImage(off, 0, 0);
}

// A quiz tied to a shape sits where that shape is, and a slideshow hides the
// shape. A PDF cannot: the shape is printed into the page. So it is painted
// out here, in the colour of the page around it. If the page around it is not
// one flat colour (a photo, say) there is no honest colour to use, and the
// page is left alone.
function paintOut(canvas, place) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const x = place.x * W;
  const y = place.y * H;
  const w = place.w * W;
  const h = place.h * H;
  const out = Math.max(6, Math.round(W * 0.008)); // clear of the shape's outline
  const tally = new Map();
  let taken = 0;
  for (const f of [0.08, 0.22, 0.36, 0.5, 0.64, 0.78, 0.92]) {
    for (const [px, py] of [[x + w * f, y - out], [x + w * f, y + h + out], [x - out, y + h * f], [x + w + out, y + h * f]]) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const d = ctx.getImageData(Math.round(px), Math.round(py), 1, 1).data;
      const key = `${d[0] >> 2},${d[1] >> 2},${d[2] >> 2}`; // near-identical shades count as one
      const seen = tally.get(key) || { n: 0, rgb: [d[0], d[1], d[2]] };
      seen.n++;
      tally.set(key, seen);
      taken++;
    }
  }
  const most = [...tally.values()].sort((a, b) => b.n - a.n)[0];
  if (!most || most.n < taken * 0.6) return;
  const edge = Math.max(2, Math.round(W * 0.002)); // the outline straddles the shape's edge
  ctx.fillStyle = `rgb(${most.rgb.join(',')})`;
  ctx.fillRect(Math.floor(x - edge), Math.floor(y - edge), Math.ceil(w + edge * 2), Math.ceil(h + edge * 2));
}

function tellStage() {
  if (!stageReady) return;
  $stage.contentWindow.postMessage({ t: 'tally:slide', slideId: currentSlideId(), slide: slideRect(), shapes: {} }, location.origin);
}

function go(to) {
  const next = Math.min(pages, Math.max(1, to));
  if (next === page) return;
  page = next;
  remember();
  drawPage();
  tellStage();
}

function key(name) {
  if (stageReady) $stage.contentWindow.postMessage({ t: 'tally:key', key: name }, location.origin);
}

// ---- the stage -------------------------------------------------------------

let mounts = 0;
function mountStage() {
  stageReady = false;
  // The stage reads its deck once, as it loads. An address that changed only
  // after the # would not load it again, and the old deck would carry on
  // playing. The counter before the # makes every mount a real load.
  $stage.src = `../stage/index.html?mount=${++mounts}#pid=${encodeURIComponent(presentationId)}&relay=${relay}`;
}

// An open answer's cards, as the stage last reported them. The stage lets
// clicks through to this page, so a click on a card is caught here and passed
// back as a card to take off the screen; any other click moves on as before.
let cards = [];
function cardAt(e) {
  if (!cards.length) return null;
  const r = $stage.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  return cards.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) || null;
}
for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
  window.addEventListener(
    type,
    (e) => {
      if (e.button !== 0) return;
      const card = cardAt(e);
      if (!card) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'click' && stageReady) $stage.contentWindow.postMessage({ t: 'tally:hide', pid: card.pid }, location.origin);
    },
    true,
  );
}

window.addEventListener('message', (e) => {
  if (e.source !== $stage.contentWindow || !e.data) return;
  if (e.data.t === 'tally:cards') {
    cards = Array.isArray(e.data.cards) ? e.data.cards : [];
    return;
  }
  if (e.data.t === 'tally:ready') {
    stageReady = true;
    tellStage();
  } else if (e.data.t === 'tally:state') {
    const moved = roomInfo?.room !== e.data.room;
    roomInfo = e.data;
    describeRoom();
    if (moved) fillRoom();
  }
});

// `?bots=24` fills the room with simulated players, for rehearsing alone.
async function fillRoom() {
  const count = Math.min(60, Math.max(0, +query.get('bots') || 0));
  if (!count || !roomInfo?.room) return;
  const { spawnBots } = await import('./bots.js');
  spawnBots(count, roomInfo.room, relay, (id) => deck?.slides?.[id]?.accepts || []);
}

// ---- setup -----------------------------------------------------------------

function describeRoom() {
  const el = $('room-state');
  el.replaceChildren();
  if (!roomInfo) {
    el.textContent = 'Connecting.';
    return;
  }
  const code = Object.assign(document.createElement('b'), { textContent: roomInfo.room });
  el.append('Room ', code, ` · ${roomInfo.players} ${roomInfo.players === 1 ? 'player' : 'players'} · relay ${roomInfo.link}`);
}

function describeSetup() {
  $('pdf-state').textContent = pdf ? `${pdfName || 'PDF'} · ${pages} pages` : 'No PDF loaded. The demo slides will play.';
  const n = Object.keys(deck.slides).length;
  $('deck-state').textContent = demo ? 'No quiz loaded. The demo quiz will play.' : `${deck.title || 'Quiz'} · ${n} quiz ${n === 1 ? 'slide' : 'slides'}`;
  describeRoom();
}

function openSetup() {
  describeSetup();
  if (!$setup.open) $setup.showModal();
}

$('pdf-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await shelfPut('pdf', await file.arrayBuffer());
  pdfName = file.name;
  await loadPdf();
  page = Math.min(page, pages);
  remember();
  describeSetup();
  drawPage();
  tellStage();
});

$('deck-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    const id = String(raw.presentationId || `imported-${Date.now()}`);
    await store.set(KEYS.deck(id), normaliseDeck(raw, id));
    presentationId = id;
    await loadDeck();
    if (!pdf) await loadPdf();
    remember();
    mountStage();
    describeSetup();
    drawPage();
  } catch (err) {
    $('deck-state').textContent = `That file would not open: ${err.message}`;
  }
});

// The quiz, straight from the deck's shared copy: no file to carry about.
async function useDeck(raw, id) {
  await store.set(KEYS.deck(id), normaliseDeck(raw, id));
  presentationId = id;
  await loadDeck();
  if (!pdf) await loadPdf();
  remember();
  mountStage();
  describeSetup();
  drawPage();
}

$('deck-fetch').addEventListener('click', async () => {
  const typed = $('deck-link').value.trim();
  const id = (typed.match(/\/presentation\/d\/([A-Za-z0-9_-]{20,})/) || typed.match(/^([A-Za-z0-9_-]{20,})$/) || [])[1];
  if (!id) {
    $('deck-state').textContent = 'That does not look like a Google Slides link.';
    return;
  }
  // Opened as Tally's own page, this laptop's copy of the quiz is already here,
  // and it is the one the slideshow uses. Take it as it is, rather than write
  // the shared copy over it (which may be behind it, and carries older slide numbers).
  if (location.protocol === 'chrome-extension:') {
    const own = await store.get(KEYS.deck(id));
    if (own?.slides && Object.keys(own.slides).length) {
      await useDeck(own, id);
      return;
    }
  }
  $('deck-state').textContent = 'Fetching…';
  try {
    // On the public site the shared copy is next door; anywhere else, ask the public one.
    const base = location.protocol.startsWith('http') && query.get('sync') !== 'public' ? new URL('../api/deck', location.href).href : DEFAULT_SYNC_BASE;
    const res = await fetch(`${base}?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.status === 404) throw new Error('no quiz has been shared for that deck yet');
    if (!res.ok) throw new Error(`the shared copy answered ${res.status}`);
    const shared = await res.json();
    await useDeck(shared.deck, id);
  } catch (err) {
    $('deck-state').textContent = `Could not load it: ${err.message}`;
  }
});

$('new-session').addEventListener('click', () => {
  // Opened as Tally's own page, this is the real room: clearing it is no small thing.
  if (confirm('Start a fresh session? Everyone in the room now and every score is cleared, and a new code opens.')) key('new-session');
});

$('forget').addEventListener('click', async () => {
  await shelfPut('pdf', null);
  await store.remove(PLAYER_KEY);
  location.reload();
});

$('setup-form').addEventListener('submit', () => {
  $show.focus();
});

// ---- keys and clicks: the same ones a slideshow uses -----------------------

let nudgeTimer = 0;
function nudge() {
  $show.classList.add('nudge');
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => $show.classList.remove('nudge'), 2200);
}

window.addEventListener('keydown', (e) => {
  if ($setup.open || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter') go(page + 1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') go(page - 1);
  else if (k === 'Home') go(1);
  else if (k === 'End') go(pages);
  else if (k === 't' || k === 'T') key('advance');
  else if (k === 'R') key('rerun');
  else if (k === 'f' || k === 'F') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  else if (k === 's' || k === 'S') openSetup();
  else return;
  e.preventDefault();
});

$show.addEventListener('click', () => go(page + 1));
window.addEventListener('mousemove', nudge);
window.addEventListener('resize', () => {
  drawPage();
  tellStage();
});

// ---- start -----------------------------------------------------------------

await loadDeck();
await loadPdf();
page = Math.min(page, pages);
mountStage();
await drawPage();
if (query.has('setup') || (!pdf && !demo)) openSetup();

window.tallyPlayer = { go, get page() { return page; }, get pages() { return pages; }, stage: $stage };
