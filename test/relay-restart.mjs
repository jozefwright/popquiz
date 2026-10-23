// What does the relay do when a session starts soon after another ended?
//
// The soak test found that a room which starts seconds after a previous room
// has emptied is unstable: phones stay connected but stop hearing the
// presenter, over and over. This script measures that directly, in three
// arrangements, so the cause can be told apart from the cure:
//
//   control   a room starts on a relay that has been quiet for minutes
//   alone     a presenter connects with nobody else, leaves, and is back two
//             seconds later; then the room joins. (Stop the slideshow, start
//             it again: the thing most likely to happen on the day.)
//   room      a full room connects, everyone leaves, and everyone is back two
//             seconds later. (Two test runs back to back.)
//   guarded   as `alone`, but with one extra connection held open throughout,
//             the way the extension can hold one while a deck is open.
//   blip      a room starts cold, then every phone's connection is cut in the
//             same instant after the first question. (The venue's Wi-Fi drops.)
//
//   node test/relay-restart.mjs control|alone|room|guarded|blip [phones]
import { RealtimeClient } from '../app/vendor/realtime.js';
import { RELAY } from '../app/shared/config.js';
import { Engine } from '../app/shared/engine.js';
import { Player } from '../app/shared/player.js';
import { liveTransport } from './helpers/relay.mjs';
import { normaliseDeck } from '../app/shared/deck.js';
import { channelName } from '../app/shared/protocol.js';

const mode = process.argv[2] || 'control';
const N = +process.argv[3] || 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const at = () => ((Date.now() - T0) / 1000).toFixed(0);
const events = [];
const deck = normaliseDeck({
  presentationId: 'restart',
  slides: {
    join: { kind: 'join' },
    q1: { kind: 'question', type: 'mc', text: 'One', options: ['a', 'b', 'c', 'd'], correct: 0, seconds: 12 },
    q2: { kind: 'question', type: 'mc', text: 'Two', options: ['a', 'b', 'c', 'd'], correct: 1, seconds: 12 },
    q3: { kind: 'question', type: 'mc', text: 'Three', options: ['a', 'b', 'c', 'd'], correct: 2, seconds: 12 },
  },
});
let saved = null;
const store = { load: async () => saved, save: (s) => (saved = JSON.parse(JSON.stringify(s))) };

function presenter() {
  const transport = liveTransport({ presenter: true });
  transport.trouble = (what) => events.push(`${at()}s presenter: ${what}`);
  return new Engine({ deck, store, transport });
}

let resets = 0; // full reconnects
let rejoins = 0; // gentler: left and rejoined the room on the same socket
let lastDeafAt = 0;
function phone(i, room) {
  const transport = liveTransport();
  const realReset = transport.reset.bind(transport);
  const realRejoin = transport.rejoin.bind(transport);
  const p = new Player({ transport });
  const note = (what) => {
    lastDeafAt = Date.now();
    if (resets + rejoins <= 14) events.push(`${at()}s phone ${i + 1} went ${((Date.now() - p.lastSnapAt) / 1000).toFixed(1)}s without hearing the presenter: ${what}`);
  };
  transport.reset = () => {
    resets++;
    note('reconnects');
    realReset();
  };
  transport.rejoin = () => {
    rejoins++;
    note('rejoins the room');
    realRejoin();
  };
  let planned = '';
  p.onChange(() => {
    const q = p.snap?.q;
    if (!q || p.screen() !== 'question' || planned === `${q.id}@${q.at}`) return;
    planned = `${q.id}@${q.at}`;
    setTimeout(() => p.screen() === 'question' && p.answer(i % 4), 500 + Math.random() * 7000);
  });
  p.open(room);
  p.setName(`Phone ${i + 1}`);
  return p;
}

// One extra connection to the relay that does nothing but stay open.
// Always a Supabase one: the property it tests (a project torn down when its
// last connection leaves) is Supabase's. The Cloudflare relay has no project.
let guard = null;
if (mode === 'guarded') {
  guard = new RealtimeClient(RELAY.url, { params: { apikey: RELAY.key }, heartbeatIntervalMs: 10000 });
  const ch = guard.channel(channelName('KEEP'), { config: { broadcast: { self: false } } });
  await new Promise((res) => ch.subscribe((s) => s === 'SUBSCRIBED' && res()));
  await sleep(1500);
}

// The earlier visit, which then leaves.
if (mode !== 'control') {
  const first = presenter();
  await first.start();
  first.setSlide('join');
  const early = [];
  if (mode === 'room') {
    for (let i = 0; i < N; i++) {
      early.push(phone(i, first.s.room));
      await sleep(150);
    }
  }
  await sleep(9000);
  for (const p of early) p.leave();
  first.stop();
  events.push(`${at()}s the first visit leaves (${mode === 'room' ? `presenter and ${N} phones` : 'presenter alone'})`);
  await sleep(2000);
  resets = 0;
  rejoins = 0;
  events.length = 1;
}

// The session that matters.
const engine = presenter();
await engine.start();
engine.setSlide('join');
events.push(`${at()}s the session starts, room ${engine.s.room}`);
const phones = [];
for (let i = 0; i < N; i++) {
  phones.push(phone(i, engine.s.room));
  await sleep(300);
}
const waitFor = async (test, ms) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (test()) return true;
    await sleep(60);
  }
  return false;
};
// Every phone listed by the presenter. (Not a head count: in `room` mode the
// session resumes, so the first visit's phones are still on its list.)
const allIn = await waitFor(() => phones.every((p) => p.snap?.ps?.includes(p.pid)), 25000);
const questions = [];
for (const id of ['q1', 'q2', 'q3']) {
  engine.setSlide(id);
  await waitFor(() => engine.phase() === 'reveal', 20000);
  const onResult = await waitFor(() => phones.every((p) => p.screen() === 'result'), 5000);
  const q = engine.s.q[id];
  const believed = phones.filter((p) => Object.keys(p.picks).some((k) => k.startsWith(`${id}@`)));
  questions.push({ id, answered: Object.keys(q.answers).length, lost: believed.filter((p) => !q.answers[p.pid]).length, revealOnEveryPhone: onResult });
  engine.setSlide('join');
  if (mode === 'blip' && id === 'q1') {
    events.push(`${at()}s every phone's connection is cut at once`);
    resets = 0;
    rejoins = 0;
    const cutAt = Date.now();
    // Supabase: drop the client's socket. Cloudflare: drop it silently, as a
    // Wi-Fi drop would, leaving the phone to notice the presenter has gone.
    for (const p of phones) (p.transport.client ? p.transport.client.disconnect() : p.transport.teardown());
    const back = await waitFor(() => phones.every((p) => p.lastSnapAt > cutAt + 500), 60000);
    events.push(`${at()}s ${back ? `all ${N} phones are hearing the presenter again, ${((Date.now() - cutAt) / 1000).toFixed(1)}s after the cut` : 'NOT every phone came back within a minute'}`);
  }
  await sleep(6000);
}

const summary = {
  mode,
  phones: N,
  everyoneJoined: allIn,
  timesAPhoneRejoined: rejoins,
  timesAPhoneReconnected: resets,
  quietForTheLastSeconds: lastDeafAt ? Math.round((Date.now() - lastDeafAt) / 1000) : 'never deaf',
  presenterRebuilds: events.filter((e) => /^\d+s presenter:/.test(e)).length,
  answersLost: questions.reduce((a, q) => a + q.lost, 0),
  revealsOnEveryPhone: `${questions.filter((q) => q.revealOnEveryPhone).length} of ${questions.length}`,
  answered: questions.map((q) => q.answered),
};
console.log(JSON.stringify(summary));
console.log('  ' + events.slice(0, 12).join('\n  '));
const expected = mode === 'blip' ? N : 0; // in a blip every phone must reconnect exactly once
const clean = allIn && rejoins + resets <= expected && summary.answersLost === 0 && questions.every((q) => q.revealOnEveryPhone);
console.log(clean ? `${mode}: clean` : `${mode}: UNSTABLE`);
for (const p of phones) p.leave();
engine.stop();
guard?.disconnect();
setTimeout(() => process.exit(0), 400);
