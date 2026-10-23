// The public demo: a game that runs itself, for people who want to try Pop
// Quiz before installing anything. The big screen is the real stage, six
// pretend players make it a room, and the slides move on by themselves.
//
// It plays two ways:
//   - On a laptop, it is the big screen and nothing else: a real room on the
//     real relay, with a QR code your own phone scans to join, as in a game.
//   - On a phone (or with ?mode=here), the big screen and the phone page sit
//     side by side in this one browser, on the local relay, with no server.

import { store, KEYS } from '../shared/store.js';
import { normaliseDeck } from '../shared/deck.js';
import { spawnBots, clearBots } from '../play/bots.js';
import { DEMO_SITE_DECK, DEMO_ID, ORDER } from './deck.js';

const BOTS = 6;
const query = new URLSearchParams(location.search);
const ua = navigator.userAgent || '';
const onPhone = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const here = query.get('mode') === 'here' || onPhone;
const relay = here ? 'local' : 'live';
document.body.classList.add(here ? 'here-mode' : 'screen-mode');
const $ = (id) => document.getElementById(id);
const $stage = $('stage');
const $screen = $('screen');
const $phone = $('phone');
const $status = $('status');
const $again = $('again');

let ready = false;
let state = {};
let step = -1;
let since = 0; // when the current slide went up
let revealedAt = 0;
let podium = 0;
let room = '';
let finished = false;

const send = (m) => ready && $stage.contentWindow.postMessage(m, location.origin);
const rect = () => {
  const r = $screen.getBoundingClientRect();
  return { x: 0, y: 0, w: Math.round(r.width), h: Math.round(r.height) };
};

function show(i) {
  step = i;
  since = Date.now();
  revealedAt = 0;
  podium = 0;
  send({ t: 'tally:slide', slideId: ORDER[i], slide: rect(), shapes: {}, fill: '#ffffff' });
  $screen.dataset.slide = ORDER[i];
}

function say(text) {
  $status.textContent = text;
}

// Once a second: move the game on when the slide has done its job.
function conduct() {
  if (!ready || step < 0 || finished) return;
  const id = ORDER[step];
  const kind = DEMO_SITE_DECK.slides[id].kind;
  const up = (Date.now() - since) / 1000;
  const others = Math.max(0, (state.players || 0) - BOTS);

  if (kind === 'join') {
    if (others > 0 && up > 3) return show(step + 1);
    if (here) {
      if (up > 30) return show(step + 1);
      say(others ? 'You’re in. Starting…' : 'Pick a nickname on the phone to join.');
    } else {
      // On the big screen, wait for a real phone: that's the point.
      say(others ? 'You’re in. Starting…' : 'Scan the code with your phone’s camera to join.');
    }
    return;
  }
  if (kind === 'question') {
    if (state.phase === 'armed' && up > 1.5) send({ t: 'tally:key', key: 'advance' });
    if (state.phase === 'reveal') {
      if (!revealedAt) revealedAt = Date.now();
      const left = Math.ceil(7 - (Date.now() - revealedAt) / 1000);
      say(`Question ${step} of ${ORDER.length - 2} · next in ${Math.max(0, left)}`);
      if (left <= 0) show(step + 1);
    } else say(`Question ${step} of ${ORDER.length - 2} · answer on ${here ? 'the' : 'your'} phone`);
    return;
  }
  if (kind === 'leaderboard') {
    if (podium < 3 && up > 2 + podium * 2.2) {
      podium++;
      send({ t: 'tally:key', key: 'advance' });
    }
    say(podium < 3 ? 'And the podium…' : 'That’s the game.');
    if (podium >= 3 && up > 11) {
      finished = true;
      $again.hidden = false;
    }
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== $stage.contentWindow || !e.data) return;
  if (e.data.t === 'tally:ready') {
    ready = true;
    send({ t: 'tally:key', key: 'new-session' });
    show(0);
  } else if (e.data.t === 'tally:state') {
    state = e.data;
    if (state.room && state.room !== room) {
      room = state.room;
      if (here) $phone.src = `../index.html?relay=local&as=demo&r=${encodeURIComponent(room)}`;
      spawnBots(BOTS, room, relay);
    }
  }
});

new ResizeObserver(() => step >= 0 && send({ t: 'tally:slide', slideId: ORDER[step], slide: rect(), shapes: {}, fill: '#ffffff' })).observe($screen);
setInterval(conduct, 1000);

// On the big screen the room lives on the real relay. Some networks (work
// ones especially) block new sites or live connections; if the relay can't be
// reached in a few seconds, play here instead and say why.
if (!here) {
  setTimeout(() => {
    if (state.link !== 'live') location.replace(`${location.pathname}?mode=here&why=network`);
  }, 9000);
}
if (query.get('why') === 'network') {
  const note = document.createElement('p');
  note.className = 'why';
  note.textContent = 'This network blocked the live room, so the demo plays on this screen instead: the big screen and a phone, side by side. On another network (or your phone’s data) the big screen and your real phone can play together.';
  document.querySelector('main').before(note);
}

$again.querySelector('button').addEventListener('click', () => {
  finished = false;
  $again.hidden = true;
  clearBots();
  room = '';
  send({ t: 'tally:key', key: 'new-session' });
  show(0);
});

await store.set(KEYS.deck(DEMO_ID), normaliseDeck(DEMO_SITE_DECK, DEMO_ID));
$stage.src = `../stage/index.html#pid=${DEMO_ID}&relay=${relay}`;
