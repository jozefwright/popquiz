// A talk over Google Meet, simulated. 25 phones, each its own device (iPhone
// and Android profiles: screen, touch, user agent), answer a talk-shaped quiz
// over the real relay. Some are in the room on the office Wi-Fi; the rest are
// remote, on home Wi-Fi or 4G, with real delays and jitter on every message.
// The presenter's laptop is slowed four times over, as if Meet were sharing
// its screen.
//
// The room misbehaves the way a real one does: one phone loses its connection
// for a while, one is locked in a pocket and frozen, one joins late, one
// reloads mid-question, and the presenter's own page reloads mid-poll.
//
// Every question type is played through the phones' own buttons. The answers
// are scored here, independently of Tally, and the slide, every phone and the
// leaderboard are checked against that.
//
//   node test/meet-sim.mjs        about six minutes. Leave three minutes after
//                                 any other test that uses the relay.
//
// What it cannot do: run Safari's own engine (the iPhone profiles run on
// Chrome's), or reproduce Meet's video. Phones never depend on the video: the
// question, options and clock all reach them over the relay.
import { chromium, devices } from 'playwright-core';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out', 'meet');
await mkdir(out, { recursive: true });
const executablePath = findChrome();
const PORT = 8798;
const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s`, ...a);

// ---- the quiz: every kind of slide, the shape of a real team quiz ------------

const PLANETS = ['Jupiter', 'Saturn', 'Neptune', 'Earth', 'Mars'];
const CITIES = ['Auckland', 'Sydney', 'Tokyo', 'London', 'Paris', 'Berlin', 'Toronto', 'Chicago', 'Lima', 'Canberra', 'Nairobi', 'Oslo'];
const box = { x: 0.04, y: 0.3, w: 0.92, h: 0.66 };
const Q = (index, cfg) => ({ kind: 'question', index, start: 'auto', place: box, ...cfg });
const SLIDES = {
  join: { kind: 'join', index: 1 },
  q1: Q(2, { type: 'mc', text: 'Which of these is a fruit?', options: ['Carrot', 'Potato', 'Tomato', 'Lettuce'], correct: 2, points: 2, seconds: 15, start: 'key' }),
  q2: Q(3, { type: 'num', text: 'How many keys on a piano?', min: 0, max: 100, step: 1, answer: 88, unit: 'keys', seconds: 15 }),
  q3: Q(4, { type: 'mc', text: 'When did the first moon landing happen?', options: ['1959', '1969', '1979', 'Last Tuesday'], correct: 1, seconds: 12 }),
  q4: Q(5, { type: 'tf', text: 'A group of flamingos is called a flamboyance', correct: 0, seconds: 12 }),
  q5: Q(6, { type: 'mc', text: 'Which of these are planets?', options: ['Venus', 'Pluto', 'Mercury', 'The Moon', 'The Sun'], multi: true, corrects: [0, 2], seconds: 15 }),
  board1: { kind: 'leaderboard', index: 7, top: 5 },
  q6: Q(8, { type: 'poll', text: 'Cats or dogs?', options: ['Cats', 'Dogs'], seconds: 15 }),
  q7: Q(9, { type: 'mc', text: 'Which is the capital of Australia?', options: CITIES, correct: 9, seconds: 15 }),
  q8: Q(10, { type: 'rank', text: 'Most moons first', options: PLANETS, seconds: 20, rightOrder: [1, 0, 2, 4, 3], points: 2 }),
  q9: Q(11, { type: 'rank', text: 'Order them on the photo', options: PLANETS.slice(0, 4), seconds: 15, rightOrder: [3, 0, 1, 2], display: 'pins', place: { x: 0.04, y: 0.06, w: 0.92, h: 0.16 }, pins: [0, 1, 2, 3].map((k) => ({ shapeId: `p${k}`, x: 0.06 + k * 0.23, y: 0.3, w: 0.2, h: 0.62 })) }),
  orderBoard: { kind: 'leaderboard', index: 12, top: 5, only: 'rank', title: 'Best at putting things in order' },
  q10: Q(13, { type: 'cloud', text: 'Your week, in one word', seconds: 12 }),
  final: { kind: 'leaderboard', index: 14, top: 5, final: true, title: 'Quiz champion' },
};
const ORDER = Object.keys(SLIDES);
const WORDS = ['Busy', 'Good', 'Tired', 'Great', 'Long', 'Fun', 'Calm', 'Hectic'];

// ---- the room ------------------------------------------------------------------

const NAMES = ['Alex', 'Sam', 'Jordan', 'Aroha', 'Tane', 'Priya', 'Liam', 'Mele', 'Riley', 'Hana', 'Oscar', 'Ana', 'Ruby', 'Jack', 'Isla', 'Noah', 'Mia', 'Leo', 'Zara', 'Kai', 'Ella', 'Finn', 'Nia', 'Theo', 'Wiremu'];
const ROOM = { where: 'room Wi-Fi', lag: 25, jitter: 20 };
const HOME = { where: 'remote, home Wi-Fi', lag: 90, jitter: 60 };
const MOBILE = { where: 'remote, 4G', lag: 220, jitter: 180 };
const PHONES = NAMES.map((name, i) => ({ name, i, ...(i < 12 ? ROOM : i < 19 ? HOME : MOBILE) }));
// The awkward ones.
PHONES[24] = { ...PHONES[24], where: 'remote, joins late', late: 'q4' };
PHONES[23] = { ...PHONES[23], where: 'remote, 4G, drops out', outage: { q: 'q7', at: 3000, for: 12000 } };
PHONES[18] = { ...PHONES[18], where: 'remote, home Wi-Fi, phone locked', stall: { q: 'q2', at: 1000, for: 15000 } };
PHONES[5] = { ...PHONES[5], where: 'room Wi-Fi, reloads mid-question', reload: 'q5' };
const DEVICES = ['iPhone 13', 'iPhone SE', 'Pixel 7', 'iPhone 14 Pro Max', 'Galaxy S9+', 'iPhone 12'];
const PRESENTER_NET = { lag: 30, jitter: 20 };

// Each phone's choices, fixed so a run can be repeated: whether it answers,
// how long it takes, and what it picks.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function plan(phone, qid) {
  const cfg = SLIDES[qid];
  const r = rng(phone.i * 1000 + ORDER.indexOf(qid) * 17 + 3);
  const skip = r() < (cfg.type === 'cloud' ? 0.15 : 0.06);
  const after = 1500 + r() * (cfg.seconds * 1000 - 5000);
  const n = cfg.options?.length || 0;
  const pickOne = () => (Number.isInteger(cfg.correct) && cfg.type !== 'poll' && r() < 0.55 ? cfg.correct : Math.floor(r() * n));
  let value;
  if (cfg.type === 'num') value = Math.round(15 + r() * 60);
  else if (cfg.type === 'cloud') value = WORDS[Math.floor(r() * WORDS.length)];
  else if (cfg.type === 'rank') {
    const order = [...Array(n).keys()].sort(() => r() - 0.5);
    value = r() < 0.25 ? order.slice(0, 2 + Math.floor(r() * (n - 2))) : order; // some cards stop short
  } else if (cfg.multi) value = r() < 0.5 ? [...cfg.corrects] : [...new Set([Math.floor(r() * n), Math.floor(r() * n)])];
  else value = pickOne();
  return { skip, after, value };
}

// ---- the network between each device and the relay -----------------------------
//
// Installed before any page script. Every WebSocket frame, in and out, is held
// for the device's delay plus a random share of its jitter, in order (it is a
// TCP stream: frames arrive late, never shuffled or lost). On cue a device can
// drop out (its sockets close and new ones fail until it is back) or stall (a
// locked phone: nothing moves, then everything arrives at once).
function network(cfg) {
  const P = (window.__net = { lag: cfg.lag, jitter: cfg.jitter, down: false, stallUntil: 0, recv: [], sent: [], opened: 0 });
  const Native = window.WebSocket;
  const hold = (last) => {
    const now = Date.now();
    let at = now + P.lag + Math.random() * P.jitter;
    if (P.stallUntil > now) at = Math.max(at, P.stallUntil + P.lag);
    return Math.max(at, last + 1);
  };
  const all = new Set();
  class Net extends Native {
    constructor(url, protocols) {
      super(P.down ? 'ws://127.0.0.1:9/' : url, protocols);
      P.opened++;
      all.add(this);
      this._in = 0;
      this._out = 0;
      this._fns = new Set();
      this._on = null;
      super.addEventListener('close', () => all.delete(this));
      super.addEventListener('message', (e) => {
        const data = e.data;
        // Broadcasts come as binary frames; the relay's own housekeeping as text.
        if (typeof data !== 'string' || data.includes('"broadcast"')) P.recv.push(Date.now());
        this._in = hold(this._in);
        setTimeout(() => {
          const ev = new MessageEvent('message', { data });
          this._on?.call(this, ev);
          for (const fn of this._fns) fn.call(this, ev);
        }, this._in - Date.now());
      });
    }
    set onmessage(fn) {
      this._on = fn;
    }
    get onmessage() {
      return this._on;
    }
    addEventListener(type, fn, opts) {
      if (type === 'message') this._fns.add(fn);
      else super.addEventListener(type, fn, opts);
    }
    removeEventListener(type, fn, opts) {
      if (type === 'message') this._fns.delete(fn);
      else super.removeEventListener(type, fn, opts);
    }
    send(data) {
      if (typeof data !== 'string' || data.includes('"broadcast"')) P.sent.push(Date.now());
      this._out = hold(this._out);
      setTimeout(() => this.readyState === 1 && Native.prototype.send.call(this, data), this._out - Date.now());
    }
  }
  window.WebSocket = Net;
  window.__drop = (ms) => {
    P.down = true;
    for (const s of [...all]) s.close();
    setTimeout(() => (P.down = false), ms);
  };
  window.__stall = (ms) => (P.stallUntil = Date.now() + ms);
  // What this page shows, and when: every change of screen, with the time.
  window.__trail = JSON.parse(sessionStorage.getItem('__trail') || '[]');
  setInterval(() => {
    const p = window.tally?.player;
    const e = document.getElementById('stage')?.contentWindow?.tally?.engine;
    let key = null;
    if (p) key = `${p.screen()}|${p.snap?.q?.id || p.snap?.ph || ''}`;
    else if (e?.s) key = `${e.phase()}|${e.s.cur || ''}`;
    if (key && key !== window.__trail.at(-1)?.key) {
      window.__trail.push({ key, t: Date.now() });
      try {
        sessionStorage.setItem('__trail', JSON.stringify(window.__trail));
      } catch {}
    }
  }, 30);
}

// ---- set up ------------------------------------------------------------------------

const server = spawn(process.execPath, [path.join(here, '..', 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  if (await fetch(`${base}/`).then((r) => r.ok, () => false)) break;
  await sleep(100);
}
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });
const errors = [];
const problems = [];
const fail = (what) => {
  problems.push(what);
  log(`PROBLEM: ${what}`);
};

const deckId = `MEET_SIM_${Date.now().toString(36)}_0123456789`;
const put = await fetch(`${base}/api/deck?id=${deckId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client: 5, deck: { title: 'Meet sim', slides: SLIDES } }) });
if (put.status !== 200) throw new Error(`the stand-in refused the deck: ${put.status}`);

const presenter = await browser.newContext({ viewport: { width: 1280, height: 720 } });
await presenter.addInitScript(network, PRESENTER_NET);
const maker = await presenter.newPage();
await maker.setContent(`<style>@page{size:1600px 900px;margin:0}body{margin:0}section{width:1600px;height:900px;background:#141414;color:#ff4f26;font:900 72px sans-serif;page-break-after:always;box-sizing:border-box;padding:60px}</style>${ORDER.map((k) => `<section>${k.toUpperCase()}</section>`).join('')}`);
const pdfPath = path.join(out, 'deck.pdf');
await maker.pdf({ path: pdfPath, width: '1600px', height: '900px', printBackground: true });
await maker.close();

const stage = await presenter.newPage();
stage.on('pageerror', (e) => errors.push(`presenter: ${e}`));
await stage.goto(`${base}/play/?setup`);
await stage.evaluate(async () => {
  localStorage.removeItem('tally.player');
  await new Promise((r) => {
    const d = indexedDB.deleteDatabase('tally-player');
    d.onsuccess = d.onerror = d.onblocked = r;
  });
});
await stage.reload();
await stage.setInputFiles('#pdf-file', pdfPath);
await stage.waitForFunction((n) => window.tallyPlayer?.pages === n, ORDER.length, { timeout: 20000 });
await stage.fill('#deck-link', `https://docs.google.com/presentation/d/${deckId}/edit`);
await stage.click('#deck-fetch');
await stage.waitForFunction(() => /quiz slides?\b/.test(document.getElementById('deck-state').textContent), null, { timeout: 8000 });
await stage.click('.go');
const engine = (fn, arg) => stage.evaluate(([f, a]) => new Function('e', 'a', `return (${f})(e, a)`)(document.getElementById('stage').contentWindow.tally.engine, a), [fn.toString(), arg]);
await stage.waitForFunction((id) => document.getElementById('stage').contentWindow.tally?.deck?.presentationId === id, deckId, { timeout: 15000 });
await stage.waitForFunction(() => document.getElementById('stage').contentWindow.tally.engine.phase() === 'join', null, { timeout: 15000 });
// The laptop is busy sharing its screen to Meet.
const slow = async () => (await presenter.newCDPSession(stage)).send('Emulation.setCPUThrottlingRate', { rate: 4 });
await slow();
const room = await engine((e) => e.s.room);
log(`presenter up: room ${room}, laptop slowed 4x, relay link ${await engine((e) => e.link || '?')}`);

const phase = () => engine((e) => e.phase());
const waitPhase = async (want, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await phase().catch(() => null)) === want) return true;
    await sleep(100);
  }
  throw new Error(`the presenter never reached ${want}`);
};
const press = (key) => stage.keyboard.press(key);

async function openPhone(phone) {
  const device = { ...devices[DEVICES[phone.i % DEVICES.length]] };
  delete device.defaultBrowserType;
  const context = await browser.newContext({ ...device });
  await context.addInitScript(network, { lag: phone.lag, jitter: phone.jitter });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${phone.name}: ${e}`));
  phone.context = context;
  phone.page = page;
  phone.device = DEVICES[phone.i % DEVICES.length];
  await page.goto(`${base}/?r=${room}&as=${phone.name}`);
  await page.waitForSelector('#name', { timeout: 20000 });
  const typedAt = Date.now();
  await page.fill('#name', phone.name);
  await page.keyboard.press('Enter');
  // In the room: the phone is past its name, and the presenter lists it. (A
  // phone joining mid-question goes straight to the question.)
  await page.waitForFunction(() => window.tally?.player && !['code', 'name', 'connecting'].includes(window.tally.player.screen()), null, { timeout: 30000 });
  phone.inAt = Date.now() - typedAt;
  await page.waitForFunction(() => window.tally.player.listed(), null, { timeout: 60000 });
  phone.listedAt = Date.now() - typedAt;
  phone.pid = await page.evaluate(() => window.tally.player.pid);
  phone.joinedAt = Date.now();
}

// ---- play -------------------------------------------------------------------------------

const answers = {}; // qid -> phone name -> { value, at }
let orderBoard = null; // the put-in-order-only board, as shown
const opens = {}; // qid -> the time the presenter opened it
const reveals = {};
const views = {}; // qid -> the presenter's view at the reveal

async function play(phone, qid) {
  const cfg = SLIDES[qid];
  const page = phone.page;
  const mine = plan(phone, qid);
  const seen = await page.waitForFunction((id) => window.tally?.player?.screen() === 'question' && window.tally.player.snap?.q?.id === id, qid, { timeout: (cfg.seconds + 10) * 1000 }).then(() => true, () => false);
  if (!seen) return; // never saw it: its network was down, or it was late
  if (phone.reload === qid) {
    // Taps something, then reloads the page, then answers properly.
    if (cfg.multi) await page.locator('button.opt').nth(1).tap().catch(() => {});
    await sleep(800);
    await page.reload();
    await page.waitForFunction((id) => window.tally?.player?.screen() === 'question' && window.tally.player.snap?.q?.id === id, qid, { timeout: 15000 }).catch(() => {});
    phone.reloaded = await page.evaluate(() => window.tally.player.screen());
  }
  if (mine.skip) return;
  await sleep(mine.after);
  if ((await page.evaluate(() => window.tally.player.screen())) !== 'question') return; // too slow
  const tap = (i) => page.locator('button.opt').nth(i).tap();
  if (cfg.type === 'num') {
    await page.evaluate((v) => {
      const s = document.querySelector('.num-slider');
      s.value = String(v);
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }, mine.value);
    await page.locator('button.go').tap();
  } else if (cfg.type === 'cloud') {
    await page.fill('#word', mine.value);
    await page.locator('button.go').tap();
  } else if (cfg.multi || cfg.type === 'rank') {
    for (const i of mine.value) await tap(i);
    await page.locator('button.go').tap();
  } else {
    await tap(mine.value);
    // Then lock in, if the clock has not run out first: a choice made in the
    // last moment is locked in by the phone itself as the clock runs out.
    if ((await page.evaluate(() => window.tally.player.screen())) === 'question') await page.locator('button.go').tap({ timeout: 3000 }).catch(() => {});
  }
  (answers[qid] ||= {})[phone.name] = { value: mine.value, at: Date.now() };
}

// Join: the room fills while the join slide is up.
const onTime = PHONES.filter((p) => !p.late);
log(`${onTime.length} phones joining: ${[...new Set(onTime.map((p) => p.where))].join(', ')}`);
await Promise.all(onTime.map((p, k) => sleep(k * 250).then(() => openPhone(p))));
const joined = await engine((e) => Object.keys(e.s.players).length);
const listing = onTime.map((p) => p.listedAt).sort((a, b) => a - b);
log(`${joined} joined; from typing a name to being on the presenter's list: median ${(listing[listing.length >> 1] / 1000).toFixed(1)}s, slowest ${(listing.at(-1) / 1000).toFixed(1)}s`);
if (joined !== onTime.length) fail(`${onTime.length - joined} phones did not get into the room`);
await sleep(2000);

for (const qid of ORDER.slice(1)) {
  const cfg = SLIDES[qid];
  await press('ArrowRight');
  if (cfg.kind === 'leaderboard') {
    await waitPhase('leaderboard');
    await sleep(3500);
    if (cfg.final) for (let k = 0; k < 3; k++) {
      await press('t');
      await sleep(2500);
    }
    if (cfg.only) orderBoard = await engine((e) => e.view().board.map((r) => ({ pid: r.pid, score: r.score })));
    log(`${qid}: leaderboard up${cfg.only ? ' (put-in-order rounds only)' : ''}`);
    continue;
  }
  if (cfg.start === 'key') {
    await waitPhase('armed');
    await sleep(2500);
    await press('t');
  }
  await waitPhase('open');
  opens[qid] = Date.now();
  log(`${qid} (${cfg.type}${cfg.multi ? ', several right' : ''}${cfg.options?.length > 6 ? `, ${cfg.options.length} options` : ''}) open`);
  const late = PHONES.filter((p) => p.late === qid);
  const going = PHONES.filter((p) => p.page && !p.late);
  for (const p of going) {
    if (p.outage?.q === qid) setTimeout(() => p.page.evaluate((ms) => window.__drop(ms), p.outage.for).then(() => log(`${p.name} drops out for ${p.outage.for / 1000}s`)), p.outage.at);
    if (p.stall?.q === qid) setTimeout(() => p.page.evaluate((ms) => window.__stall(ms), p.stall.for).then(() => log(`${p.name}'s phone is locked for ${p.stall.for / 1000}s`)), p.stall.at);
  }
  if (qid === 'q6') {
    // The presenter's own page reloads mid-poll.
    setTimeout(async () => {
      log('presenter page reloads');
      await stage.goto(`${base}/play/`); // the fallback's own address: what a reload of it would show
      await stage.waitForFunction(() => document.getElementById('stage')?.contentWindow?.tally?.engine?.s?.room, null, { timeout: 20000 });
      await slow();
      const after = await engine((e) => ({ room: e.s.room, players: Object.keys(e.s.players).length, phase: e.phase(), cur: e.s.cur }));
      log(`presenter back: room ${after.room}, ${after.players} players, ${after.cur} ${after.phase}`);
      if (after.room !== room) fail(`the room changed after the presenter reloaded (${room} to ${after.room})`);
    }, 4000);
  }
  // One phone's trouble in this harness is noted, not allowed to stop the talk.
  const safely = (p, job) => job.catch((e) => fail(`${p.name} (${p.where}) on ${qid}: ${String(e.message).split('\n')[0]}`));
  const work = going.map((p) => safely(p, play(p, qid)));
  for (const p of late) {
    work.push(
      safely(
        p,
        (async () => {
          await openPhone(p);
          p.late = null;
          log(`${p.name} joins late, during ${qid}`);
          await play(p, qid);
        })(),
      ),
    );
  }
  await Promise.all(work);
  await waitPhase('reveal', (cfg.seconds + 20) * 1000);
  reveals[qid] = Date.now();
  views[qid] = await engine((e, id) => ({ answers: e.s.q[id]?.answers || {}, view: e.view() }), qid);
  log(`${qid}: revealed, ${Object.keys(views[qid].answers).length} answers in`);
  if (cfg.rightOrder) {
    // The room's order first, then T for the right one.
    await sleep(2500);
    await press('t');
    await sleep(2500);
    views[qid].shownOrder = await engine((e) => e.view().verdict?.rightOrder || null);
    views[qid].phones = {};
    for (const p of PHONES.filter((x) => x.page)) views[qid].phones[p.pid] = await p.page.evaluate(() => ({ h1: document.querySelector('h1')?.textContent || '', worth: document.querySelector('.worth')?.textContent || '' })).catch(() => null);
    log(`${qid}: the right order shown`);
  }
  await sleep(4000);
}
await sleep(1500);

// ---- check -------------------------------------------------------------------------------

const byPid = Object.fromEntries(PHONES.map((p) => [p.pid, p]));
const trails = {};
for (const p of PHONES) trails[p.name] = await p.page.evaluate(() => window.__trail).catch(() => []);
const nets = {};
for (const p of PHONES) nets[p.name] = await p.page.evaluate(() => ({ recv: window.__net.recv, sent: window.__net.sent, opened: window.__net.opened })).catch(() => ({ recv: [], sent: [], opened: 0 }));
// The presenter's relay link lives in the stage's frame. (Counted from its reload on.)
nets.presenter = await stage.evaluate(() => { const n = document.getElementById('stage').contentWindow.__net; return { recv: n.recv, sent: n.sent, opened: n.opened }; });

// 1. Every answer a phone sent arrived, unless it was off the network when the clock ran out.
const lost = [];
for (const [qid, sent] of Object.entries(answers)) {
  const got = views[qid].answers;
  for (const [name, a] of Object.entries(sent)) {
    const p = PHONES.find((x) => x.name === name);
    if (got[p.pid]) continue;
    const offline = p.outage?.q === qid || p.stall?.q === qid;
    lost.push(`${qid} ${name} (${p.where})${offline ? ', offline at the time' : ''}`);
    if (!offline) fail(`${name}'s answer to ${qid} never arrived (${p.where})`);
  }
}

// 2. Scores, worked out here from the answers that arrived.
const same = (a, b) => [].concat(a).length === [].concat(b).length && [].concat(a).every((x) => [].concat(b).includes(x));
const expected = Object.fromEntries(PHONES.map((p) => [p.pid, 0]));
const right = {}; // qid -> pid -> right?
const ordering = {}; // pid -> points won on put-in-order rounds
for (const qid of ORDER) {
  const cfg = SLIDES[qid];
  if (cfg.kind !== 'question' || !views[qid]) continue;
  const got = Object.entries(views[qid].answers);
  right[qid] = {};
  if (cfg.type === 'mc' || cfg.type === 'tf') {
    for (const [pid, a] of got) {
      const ok = cfg.multi ? same(a.c, cfg.corrects) : a.c === cfg.correct;
      right[qid][pid] = ok;
      if (ok) expected[pid] += cfg.points || 1;
    }
  }
  if (cfg.type === 'rank' && cfg.rightOrder) {
    // A point for each item in its right place, times the slide's points.
    for (const [pid, a] of got) {
      const hits = cfg.rightOrder.filter((c, at) => a.c[at] === c).length;
      right[qid][pid] = hits;
      expected[pid] += hits * (cfg.points || 1);
      ordering[pid] = (ordering[pid] || 0) + hits * (cfg.points || 1);
    }
    if (JSON.stringify(views[qid].shownOrder) !== JSON.stringify(cfg.rightOrder)) fail(`${qid}: after T the right order was not shown`);
    for (const [pid, said] of Object.entries(views[qid].phones || {})) {
      if (!said) continue;
      const won = right[qid][pid] ? right[qid][pid] * (cfg.points || 1) : 0;
      if (said.h1 !== 'The right order') fail(`${byPid[pid]?.name}'s phone did not show the right order on ${qid} (it said "${said.h1}")`);
      else if (won && said.worth !== `+${won} ${won === 1 ? 'point' : 'points'}`) fail(`${byPid[pid]?.name}'s phone says "${said.worth}" for ${qid}; worked out here: +${won}`);
    }
  }
  if (cfg.type === 'num') {
    const offs = [...new Set(got.map(([, a]) => Math.abs(a.n - cfg.answer)))].sort((x, y) => x - y).slice(0, 3);
    for (const [pid, a] of got) {
      const k = offs.indexOf(Math.abs(a.n - cfg.answer));
      if (k >= 0) expected[pid] += [3, 2, 1][k] * (cfg.points || 1); // worth more multiplies all three places
    }
  }
}
const board = await engine((e) => e.leaderboard().map((r) => ({ pid: r.pid, score: r.score, rank: r.rank })));
for (const r of orderBoard || []) if (r.score !== (ordering[r.pid] || 0)) fail(`on the put-in-order board ${byPid[r.pid]?.name} has ${r.score}; worked out here: ${ordering[r.pid] || 0}`);
if (!orderBoard) fail('the put-in-order board never showed');
for (const r of board) if (r.score !== expected[r.pid]) fail(`${byPid[r.pid]?.name} scored ${r.score}; worked out here: ${expected[r.pid]}`);
for (let k = 1; k < board.length; k++) if (board[k].score > board[k - 1].score) fail('the leaderboard is out of order');

// 3. The put-in-order rounds, worked out here.
for (const qid of ['q8', 'q9']) {
  const n = SLIDES[qid].options.length;
  const totals = new Array(n).fill(0);
  for (const a of Object.values(views[qid].answers)) {
    const shared = a.c.length < n ? (a.c.length + 1 + n) / 2 : 0;
    for (let i = 0; i < n; i++) totals[i] += a.c.includes(i) ? a.c.indexOf(i) + 1 : shared;
  }
  const v = views[qid].view.verdict;
  if (!v || totals.some((t, i) => t !== v.totals[i])) fail(`${qid}'s totals are ${JSON.stringify(v?.totals)}; worked out here: ${JSON.stringify(totals)}`);
  const best = Math.min(...totals);
  if (v && totals.some((t, i) => (t === best) !== (v.places[i] === 1))) fail(`${qid}'s winner is not the lowest total`);
}

// 4. What each phone showed: when the question reached it, when the answer did, and its last word on the leaderboard.
const reach = {}; // where -> [ms]
const reveal = {};
for (const p of PHONES) {
  for (const qid of Object.keys(opens)) {
    const t = trails[p.name];
    const q = t.find((x) => (x.key.startsWith('question|') || x.key.startsWith('locked|')) && x.key.endsWith(`|${qid}`));
    const r = t.find((x) => x.key.startsWith('result|') && x.key.endsWith(`|${qid}`));
    const off = p.outage?.q === qid || p.stall?.q === qid || (p.where.includes('late') && ORDER.indexOf(qid) <= ORDER.indexOf('q4'));
    if (q && !off) (reach[p.where.split(',').slice(0, 2).join(',')] ||= []).push(q.t - opens[qid]);
    if (r && !off) (reveal[p.where.split(',').slice(0, 2).join(',')] ||= []).push(r.t - reveals[qid]);
    if (!q && !off && p.joinedAt < opens[qid]) fail(`${p.name} (${p.where}) never showed ${qid}`);
    if (!r && !off && p.joinedAt < opens[qid]) fail(`${p.name} (${p.where}) never showed the result of ${qid}`);
  }
  // The result screens of scored choice questions say right or wrong correctly: checked at the end on the last one, q7.
  const says = await p.page.evaluate(() => ({ h1: document.querySelector('h1')?.textContent || '', p: document.querySelector('#app p')?.textContent || '' }));
  const row = board.find((r) => r.pid === p.pid);
  const shown = says.h1 === 'You won' ? 1 : +(says.h1.match(/(\d+)/) || [])[1];
  const points = +(says.p.match(/(\d+) points?/) || [])[1];
  p.final = `${says.h1} / ${says.p}`;
  if (!row || shown !== row.rank || points !== row.score) fail(`${p.name}'s phone says "${says.h1}, ${says.p}"; the leaderboard has rank ${row?.rank}, ${row?.score} points`);
}

// 5. The relay's load: every broadcast delivered to any device, per second.
const all = Object.values(nets).flatMap((n) => n.recv);
const bySecond = new Map();
for (const t of all) bySecond.set(Math.floor(t / 1000), (bySecond.get(Math.floor(t / 1000)) || 0) + 1);
const perSecond = [...bySecond.values()].sort((a, b) => b - a);
const sentAll = Object.values(nets).flatMap((n) => n.sent).length;

const pct = (list, q) => {
  if (!list?.length) return '-';
  const s = [...list].sort((a, b) => a - b);
  return `${(s[Math.min(s.length - 1, Math.floor(q * s.length))] / 1000).toFixed(2)}s`;
};
console.log('\n== The room ==');
for (const p of PHONES) console.log(`  ${p.name.padEnd(8)} ${p.device.padEnd(18)} ${p.where.padEnd(34)} in ${(p.listedAt / 1000).toFixed(1)}s   ${p.final}${p.reloaded ? `  (after its reload: ${p.reloaded})` : ''}`);
console.log('\n== How long a question took to reach the phones, from the presenter opening it ==');
for (const [where, list] of Object.entries(reach)) console.log(`  ${where.padEnd(28)} median ${pct(list, 0.5)}  95% ${pct(list, 0.95)}  slowest ${pct(list, 1)}   (${list.length} arrivals)`);
console.log('\n== How long the answer took to show on the phones, from the reveal ==');
for (const [where, list] of Object.entries(reveal)) console.log(`  ${where.padEnd(28)} median ${pct(list, 0.5)}  95% ${pct(list, 0.95)}  slowest ${pct(list, 1)}`);
console.log('\n== Answers ==');
for (const qid of Object.keys(views)) console.log(`  ${qid.padEnd(4)} ${SLIDES[qid].type.padEnd(5)} sent ${String(Object.keys(answers[qid] || {}).length).padStart(2)}, arrived ${String(Object.keys(views[qid].answers).length).padStart(2)}${SLIDES[qid].type === 'rank' ? `   verdict ${JSON.stringify(views[qid].view.verdict?.totals)}` : ''}`);
console.log(`  not arrived: ${lost.length ? lost.join('; ') : 'none'}`);
console.log('\n== Best at putting in order (those rounds only), against the scores worked out here ==');
for (const r of (orderBoard || []).slice(0, 3)) console.log(`  ${byPid[r.pid]?.name.padEnd(8)} ${r.score} (here: ${ordering[r.pid] || 0})`);
console.log('\n== Leaderboard (top 5), against the scores worked out here ==');
for (const r of board.slice(0, 5)) console.log(`  ${r.rank}. ${byPid[r.pid]?.name.padEnd(8)} ${r.score} (here: ${expected[r.pid]})`);
console.log('\n== The relay ==');
console.log(`  broadcasts sent by all devices: ${sentAll}; delivered to devices: ${all.length}`);
console.log(`  deliveries in the busiest second: ${perSecond[0] || 0}; 10th busiest: ${perSecond[9] || 0}; seconds over 100: ${perSecond.filter((n) => n > 100).length}`);
console.log(`  sockets opened: presenter ${nets.presenter.opened}, phones ${PHONES.reduce((n, p) => n + nets[p.name].opened, 0)} (one each, plus reconnects)`);
console.log(`\npage errors: ${errors.length ? errors.join(' | ') : 'none'}`);
console.log(problems.length ? `\n${problems.length} PROBLEMS:\n  ${problems.join('\n  ')}` : '\nno problems');
await writeFile(path.join(out, 'run.json'), JSON.stringify({ opens, reveals, answers, views, board, expected, trails, problems, errors }, null, 1));
await stage.screenshot({ path: path.join(out, 'presenter-final.png') });
await PHONES[0].page.screenshot({ path: path.join(out, 'phone-final.png') });
await browser.close();
server.kill();
process.exit(problems.length || errors.length ? 1 : 0);
