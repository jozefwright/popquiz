// A whole talk, over the real relay. One presenter engine and a room of
// simulated phones run the full running order: join, an opening word cloud,
// scored questions with leaderboards between them, two polls, and a closing
// cloud. The short load test proves a burst; this proves the length.
//
// It also behaves badly on purpose, the way a real room does: a few phones
// join late, a few drop their connection mid-talk and come back, and one
// reloads its page during a question.
//
//   node test/soak.mjs            25 phones, 14 questions, 15 s clocks, back to back (~5 min)
//   node test/soak.mjs 25 8       the same with 8 s clocks
//   node test/soak.mjs 25 15 45   with 45 s of talking after each question (~17 min, a real talk's length)
import { Engine } from '../app/shared/engine.js';
import { Player } from '../app/shared/player.js';
import { liveTransport, relayName } from './helpers/relay.mjs';
import { normaliseDeck } from '../app/shared/deck.js';
import { isChoice, isScored } from '../app/shared/protocol.js';

const N = Math.max(4, +process.argv[2] || 25);
const SECONDS = Math.max(4, +process.argv[3] || 15);
const TALK = Math.max(2.5, +process.argv[4] || 2.5); // seconds spent on each ordinary slide
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const troubles = {};
const timeline = []; // every hiccup, with the second it happened
const T0 = Date.now();
const at = () => Math.round((Date.now() - T0) / 1000);
const relay = (presenter) => {
  const t = liveTransport({ presenter });
  t.trouble = (what) => {
    troubles[what] = (troubles[what] || 0) + 1;
    if (presenter) timeline.push(`${at()}s presenter: ${what}`);
  };
  return t;
};

// A long quiz's shape: 14 questions, leaderboards after 7 and 11, two clouds.
const order = ['join', 'cloud1'];
const slides = { join: { kind: 'join' }, cloud1: { kind: 'question', type: 'cloud', text: 'First word?', seconds: SECONDS } };
for (let i = 1; i <= 12; i++) {
  const id = `q${i}`;
  if (i === 9 || i === 10) slides[id] = { kind: 'question', type: 'poll', text: `Poll ${i}`, options: ['A', 'B', 'C', 'D'], seconds: SECONDS };
  else if (i === 3) slides[id] = { kind: 'question', type: 'tf', text: `True or false ${i}`, correct: 1, seconds: SECONDS };
  else slides[id] = { kind: 'question', type: 'mc', text: `Question ${i}`, options: ['one', 'two', 'three', 'four'], correct: i % 4, seconds: SECONDS };
  order.push(id);
  order.push(`talk${i}`); // an ordinary slide: the presenter explains the answer
  if (i === 7) { slides.board1 = { kind: 'leaderboard', top: 5 }; order.push('board1'); }
  if (i === 11) { slides.board2 = { kind: 'leaderboard', top: 5 }; order.push('board2'); }
}
slides.final = { kind: 'leaderboard', top: 5, final: true };
slides.cloud2 = { kind: 'question', type: 'cloud', text: 'First word, now?', seconds: SECONDS };
order.push('final', 'cloud2');
const deck = normaliseDeck({ presentationId: 'soak', slides });

let saved = null;
const engine = new Engine({ deck, store: { load: async () => saved, save: (s) => (saved = s) }, transport: relay(true) });
await engine.start();
engine.setSlide('join');
const started = Date.now();
console.log(`room ${engine.s.room} on ${relayName}: ${N} phones, ${order.filter((id) => slides[id]?.kind === 'question').length} questions, ${SECONDS}s clocks`);

const report = { phones: N, questions: [], resets: 0, reloads: 0, maxConfirmMs: 0, missed: [] };
const WORDS = ['oily', 'huge', 'Arnold', 'orange', 'steroids', 'tan', 'veins', 'protein'];
const phones = [];

function makePhone(i, memory) {
  const transport = relay(false);
  const realReset = transport.reset.bind(transport);
  let self = null;
  const realRejoin = transport.rejoin.bind(transport);
  const quiet = () => (self?.lastSnapAt ? ((Date.now() - self.lastSnapAt) / 1000).toFixed(1) : '?');
  transport.reset = () => {
    report.resets++;
    timeline.push(`${at()}s phone ${i + 1} reconnected after ${quiet()}s of silence (link was ${transport.status})`);
    realReset();
  };
  transport.rejoin = () => {
    report.resets++;
    timeline.push(`${at()}s phone ${i + 1} rejoined the room after ${quiet()}s of silence`);
    realRejoin();
  };
  const p = new Player({ transport, memory });
  self = p;
  p.i = i;
  p.memoryBox = memory;
  let planned = '';
  p.onChange(() => {
    const q = p.snap?.q;
    if (!q || p.screen() !== 'question') return;
    const run = `${q.id}@${q.at}`;
    if (planned === run) return;
    planned = run;
    // People answer through the first two-thirds of the clock, a few very late.
    const span = (q.dur || SECONDS * 1000) * (i % 9 === 0 ? 0.93 : 0.65);
    setTimeout(() => {
      if (p.screen() !== 'question') return;
      p.sentAt = Date.now();
      p.answer(isChoice(q.type) ? (i + q.id.length) % q.opts.length : WORDS[i % WORDS.length]);
    }, 500 + Math.random() * span);
  });
  return p;
}
const memoryFor = () => {
  const box = { data: null };
  return { box, load: () => box.data, save: (d) => (box.data = JSON.parse(JSON.stringify(d))) };
};

// Most of the room joins over the first twenty seconds; three arrive late.
const late = new Set([N - 1, N - 2, N - 3]);
for (let i = 0; i < N; i++) {
  if (late.has(i)) continue;
  const p = makePhone(i, memoryFor());
  phones[i] = p;
  p.open(engine.s.room);
  p.setName(`Phone ${i + 1}`);
  await sleep(350);
}

async function until(test, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (test()) return true;
    await sleep(60);
  }
  return false;
}

let failed = null;
try {
  if (!(await until(() => engine.view().playerCount === N - late.size, 20000))) throw new Error(`only ${engine.view().playerCount} of ${N - late.size} joined`);
  let questionNumber = 0;
  for (const id of order) {
    engine.setSlide(id);
    const cfg = slides[id];
    if (!cfg) {
      await sleep(TALK * 1000); // an ordinary slide: the presenter is talking
      continue;
    }
    if (cfg.kind !== 'question') {
      await sleep(3000);
      continue;
    }
    questionNumber++;

    // Trouble, spread through the talk.
    if (questionNumber === 2) for (const i of late) { // latecomers walk in during question 2
      const p = makePhone(i, memoryFor());
      phones[i] = p;
      p.open(engine.s.room);
      p.setName(`Phone ${i + 1}`);
    }
    if (questionNumber === 5) {
      timeline.push(`${at()}s TEST cuts the connection of phones 2, 3 and 4`);
      for (const i of [1, 2, 3]) phones[i].transport.teardown(); // three phones lose their connection, silently
    }
    if (questionNumber === 8) { // one phone reloads its page mid-question
      const old = phones[4];
      setTimeout(() => {
        old.leave();
        const again = makePhone(4, old.memoryBox);
        phones[4] = again;
        again.open(engine.s.room);
        report.reloads++;
      }, SECONDS * 400);
    }

    const present = () => phones.filter(Boolean);
    const sawIt = await until(() => present().filter((p) => p.snap?.q?.id === id).length >= present().length - 3, 6000);
    await until(() => engine.phase() === 'reveal', SECONDS * 1000 + 6000);
    const closedAt = Date.now();
    // Strict: every phone must be showing the result. A phone that is mid-
    // reconnect at this moment is counted against the run, not excused.
    const resultOnAll = await until(() => present().every((p) => p.screen() === 'result'), 5000);
    const notOnResult = present().filter((p) => p.screen() !== 'result').map((p) => `phone ${p.i + 1} on "${p.screen()}"`);
    if (notOnResult.length) timeline.push(`${at()}s reveal of ${id} missing on: ${notOnResult.join(', ')}`);
    const q = engine.s.q[id];
    const answered = Object.keys(q.answers).length;
    // Every phone that believes its answer went in must be in the tally.
    const believed = present().filter((p) => p.picks && Object.keys(p.picks).some((k) => k.startsWith(`${id}@${q.openedAt}`)));
    const lost = believed.filter((p) => !q.answers[p.pid]);
    report.questions.push({ id, type: cfg.type, players: engine.view().playerCount, answered, lost: lost.length, sawIt, resultOnAll, revealLagMs: Date.now() - closedAt });
    if (lost.length) report.missed.push(`${id}: ${lost.map((p) => `phone ${p.i + 1}`).join(', ')}`);
    await sleep(1800);
  }
  const board = engine.leaderboard();
  report.winner = `${board[0].name} with ${board[0].score} of ${order.filter((id) => slides[id]?.kind === 'question' && isScored(slides[id].type)).length}`;
  report.players = engine.view().playerCount;
} catch (e) {
  failed = e;
}

report.minutes = +((Date.now() - started) / 60000).toFixed(1);
report.relayTrouble = troubles;
report.snapshotsSent = engine.seq;
const qs = report.questions;
const summary = {
  minutes: report.minutes,
  players: report.players,
  questionsRun: qs.length,
  answersCounted: qs.reduce((a, q) => a + q.answered, 0),
  answersLost: qs.reduce((a, q) => a + q.lost, 0),
  questionsEveryPhoneSaw: qs.filter((q) => q.sawIt).length,
  revealsOnEveryPhone: qs.filter((q) => q.resultOnAll).length,
  fewestAnswersOnAQuestion: Math.min(...qs.map((q) => q.answered)),
  connectionRebuilds: report.resets,
  pageReloads: report.reloads,
  snapshotsSent: report.snapshotsSent,
  relayTrouble: report.relayTrouble,
  winner: report.winner,
};
console.log(JSON.stringify(summary, null, 2));
if (report.missed.length) console.log('lost answers:', report.missed.join(' | '));
console.log('hiccups, in order:\n  ' + (timeline.join('\n  ') || 'none'));
const ok = !failed && summary.answersLost === 0 && summary.revealsOnEveryPhone === qs.length && summary.players === N;
console.log(failed ? `FAILED: ${failed.message}` : ok ? 'soak passed' : 'soak finished with problems (see above)');
for (const p of phones) p?.leave();
engine.stop();
setTimeout(() => process.exit(ok ? 0 : 1), 400);
