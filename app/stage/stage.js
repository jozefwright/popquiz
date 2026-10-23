// The stage: the engine plus the big-screen drawing, in one page.
//
// It runs inside an iframe that a host lays over the slide. The host is the
// extension's content script on Google Slides, or the PDF fallback player; the
// stage cannot tell them apart and does not need to. The host says which slide
// is showing and where it sits; the stage does everything else.
//
//   host -> stage   { t: 'tally:slide', slideId, slide: {x,y,w,h}, shapes: {id: {x,y,w,h}}, fill }
//                   { t: 'tally:key', key: 'advance' | 'rerun' | 'new-session' }
//   stage -> host   { t: 'tally:ready' }
//                   { t: 'tally:state', room, phase, kind, players, link }
//
// `slide` is in pixels of this page. `shapes` are fractions of the slide.

import { BRAND } from '../shared/brand.js';
import { DEFAULT_JOIN_BASE } from '../shared/config.js';
import { Engine } from '../shared/engine.js';
import { makeTransport } from '../shared/relay.js';
import { store, KEYS, sessionStore } from '../shared/store.js';
import { normaliseDeck } from '../shared/deck.js';
import { mountModule } from './modules.js';

const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
const presentationId = params.get('pid') || 'demo';
const relayMode = params.get('relay') === 'local' ? 'local' : 'live';

const $slide = document.getElementById('slide');
const $module = document.getElementById('module');
const $hud = document.getElementById('hud');

let deck = normaliseDeck(await store.get(KEYS.deck(presentationId)), presentationId);
let settings = (await store.get(KEYS.settings)) || {};
let host = { slideId: null, slide: null, shapes: {} };
let slideFill = null; // the showing slide's background colour, if plain
let hostSpoke = false; // until the host names a slide, the saved one stands
let lastHostSlide;

// On a web page the phone client lives one folder up from the stage. Inside
// the extension there is no such place, so the address must be set.
function joinBase() {
  // With the local relay, messages never leave this browser, so the only
  // phone page that can hear them is the one served from here.
  if (relayMode === 'local' && location.protocol.startsWith('http')) return new URL('../', location.href).href;
  if (deck.joinBase) return deck.joinBase;
  if (settings.joinBase) return settings.joinBase;
  if (DEFAULT_JOIN_BASE) return DEFAULT_JOIN_BASE;
  if (location.protocol.startsWith('http')) return new URL('../', location.href).href;
  return '';
}

// One engine per deck. Two stages running the same session would each count
// answers and each tell the phones something different. The browser's own
// lock decides which stage runs; any other shows a notice and stands by, and
// takes over by itself if the first one closes.
const lockName = `tally-stage-${presentationId}`;
const mine = await new Promise((resolve) => {
  if (!navigator.locks) return resolve(true);
  navigator.locks.request(lockName, { ifAvailable: true }, (lock) => {
    resolve(!!lock);
    return lock ? new Promise(() => {}) : undefined; // held until this page goes away
  });
});
if (!mine) {
  window.tallyStandingBy = true;
  $hud.hidden = false;
  $hud.dataset.level = 'soft';
  $hud.textContent = `${BRAND} is running this deck in another window. This one is standing by.`;
  parent.postMessage({ t: 'tally:standing-by' }, '*');
  await navigator.locks.request(lockName, () => location.reload()); // the other one closed: start for real
}

const transport = makeTransport({ presenter: true, local: relayMode === 'local', trouble: (what) => console.warn('[tally] relay:', what) });

const engine = new Engine({ deck, store: sessionStore(presentationId), transport });
const module = mountModule($module, { joinBase: joinBase(), joinHint: deck.showJoin, onHide: (pid) => engine.s && engine.hideCard(engine.s.cur, pid) });

// Where an open answer's cards sit, for the host. This page lets every click
// through to the slide beneath, so the host catches a click that lands on a
// card and passes it back here as a card to take off the screen.
let lastCards = '';
function reportCards() {
  const cards = [...$module.querySelectorAll('.tm-card[data-pid]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { pid: el.dataset.pid, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const packed = JSON.stringify(cards);
  if (packed === lastCards) return;
  lastCards = packed;
  parent.postMessage({ t: 'tally:cards', cards }, '*');
}

function place() {
  const s = host.slide;
  if (s) Object.assign($slide.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.w}px`, height: `${s.h}px` });
  else Object.assign($slide.style, { left: '0', top: '0', width: '100%', height: '100%' });
  const cfg = engine.cfg(engine.s?.cur);
  if (!cfg) {
    $module.classList.remove('on');
    return;
  }
  // The live position of the placeholder shape wins; the stored one is the
  // fallback for hosts that cannot see shapes (the PDF player).
  const live = cfg.place.shapeId && host.shapes?.[cfg.place.shapeId];
  const p = live || cfg.place;
  Object.assign($module.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` });
  $module.classList.add('on');
  // Options whose votes are shown out on the slide: the same rule, live or stored.
  module.place(p, (cfg.pins || []).map((pin) => pin && (host.shapes?.[pin.shapeId] || pin)));
}

let lastReport = '';

function render() {
  if (!engine.s) return;
  const view = engine.view();
  place();
  module.update(view);

  const down = view.link === 'down';
  const waiting = view.link === 'connecting';
  $hud.hidden = !(down || waiting || botsUp);
  $hud.dataset.level = down ? 'hard' : botsUp && !waiting ? 'practice' : 'soft';
  $hud.textContent = down ? `${BRAND}: connection down, reconnecting` : waiting ? `${BRAND}: connecting` : `Practice game · ${botsUp} pretend players`;

  const report = JSON.stringify({ t: 'tally:state', room: view.room, phase: view.phase, kind: view.kind, players: view.playerCount, link: view.link, slideId: view.slideId });
  if (report !== lastReport) {
    lastReport = report;
    parent.postMessage(JSON.parse(report), '*');
  }
}

function frame() {
  module.tick(Date.now());
  reportCards();
  requestAnimationFrame(frame);
}

window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
  const m = e.data;
  if (m.t === 'tally:slide') {
    host = { slideId: m.slideId || null, slide: m.slide || null, shapes: m.shapes || {} };
    hostSpoke = true;
    if ((m.fill || null) !== slideFill) {
      slideFill = m.fill || null;
      module.setContext({ slideFill });
    }
    if (!engine.s) return;
    // A new slide goes to the engine. The same slide again is only geometry
    // (a resize, a shape that moved), so it is drawn and nothing is sent.
    if (host.slideId !== lastHostSlide || engine.s.cur !== host.slideId) {
      lastHostSlide = host.slideId;
      engine.setSlide(host.slideId);
    } else {
      render();
    }
  } else if (m.t === 'tally:hide' && engine.s && typeof m.pid === 'string') {
    engine.hideCard(engine.s.cur, m.pid);
  } else if (m.t === 'tally:key' && engine.s) {
    if (m.key === 'advance') engine.advance();
    else if (m.key === 'rerun') engine.rerun();
    else if (m.key === 'new-session') engine.newSession();
  }
});

let refitTimer = 0;
new ResizeObserver(() => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => module.refit(), 60);
}).observe($module);

store.watch(KEYS.deck(presentationId), (raw) => {
  deck = normaliseDeck(raw, presentationId);
  engine.setDeck(deck);
  module.setContext({ joinBase: joinBase(), joinHint: deck.showJoin });
});
store.watch(KEYS.settings, (raw) => {
  settings = raw || {};
  module.setContext({ joinBase: joinBase() });
});
// A session with a different id can only have come from the side panel
// starting a fresh one. Reload to pick it up cleanly.
store.watch(KEYS.session(presentationId), (raw) => {
  if (raw?.sid && engine.s && raw.sid !== engine.s.sid) location.reload();
});

// Practice: pretend players, so a deck can be rehearsed alone. Set from the
// panel's Present card, never on unless asked for, and named on the screen
// while it is on, so it cannot be left on by mistake on the day.
const practiceKey = `tally.practice.${presentationId}`;
let practice = (await store.get(practiceKey)) || null;
let botsUp = 0;
async function syncPractice() {
  const want = Math.min(40, Math.max(0, practice?.bots || 0));
  if (want === botsUp || !engine.s) return;
  const { spawnBots, clearBots } = await import('../play/bots.js');
  if (want) spawnBots(want, engine.s.room, relayMode, (id) => engine.cfg(id)?.accepts || []);
  else clearBots();
  botsUp = want;
  render();
}
store.watch(practiceKey, (raw) => {
  practice = raw || null;
  syncPractice();
});

engine.onChange(render);
await engine.start();
syncPractice();
if (hostSpoke) {
  lastHostSlide = host.slideId;
  engine.setSlide(host.slideId);
}
render();
requestAnimationFrame(frame);
document.fonts?.ready.then(() => module.refit());
parent.postMessage({ t: 'tally:ready' }, '*');

// For the dev harness and for poking at a live talk from the console.
window.tally = { engine, get deck() { return deck; } };
