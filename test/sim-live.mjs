// Live load test over the real relay. One presenter engine and N simulated
// phones, each on its own socket, play two timed questions and a leaderboard.
// Broadcast only: nothing is written to the relay project's database.
//
//   npm run sim            30 phones
//   npm run sim -- 60      60 phones
import { Engine } from '../app/shared/engine.js';
import { Player } from '../app/shared/player.js';
import { liveTransport, relayName } from './helpers/relay.mjs';
import { normaliseDeck } from '../app/shared/deck.js';

const N = Math.max(1, +process.argv[2] || 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const troubles = {};
const relay = (presenter) => {
  return liveTransport({ presenter, trouble: (what) => (troubles[what] = (troubles[what] || 0) + 1) });
};

const deck = normaliseDeck({
  presentationId: 'sim',
  slides: {
    join: { kind: 'join' },
    q1: { kind: 'question', type: 'mc', text: 'Sim one', options: ['a', 'b', 'c', 'd'], correct: 2, seconds: 8 },
    q2: { kind: 'question', type: 'mc', text: 'Sim two', options: ['a', 'b', 'c', 'd'], correct: 0, seconds: 8 },
    board: { kind: 'leaderboard', top: 5 },
  },
});

let saved = null;
const engine = new Engine({ deck, store: { load: async () => saved, save: (s) => (saved = s) }, transport: relay(true) });
await engine.start();
engine.setSlide('join');
console.log(`room ${engine.s.room} on ${relayName}, ${N} phones joining over 3s`);

const phones = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const p = new Player({ transport: relay(false) });
  p.open(engine.s.room);
  p.setName(`Sim ${i + 1}`);
  phones.push(p);
  await sleep(3000 / N);
}

async function until(test, ms, label) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (test()) return Date.now() - start;
    await sleep(50);
  }
  throw new Error(`timed out: ${label}`);
}

const report = { phones: N };
try {
  await until(() => engine.view().playerCount === N && phones.every((p) => p.snap?.ps?.includes(p.pid)), 20000, 'everyone joined');
  report.joinedInMs = Date.now() - t0;

  for (const qid of ['q1', 'q2']) {
    engine.setSlide(qid);
    const opened = Date.now();
    const seen = await until(() => phones.every((p) => p.screen() === 'question'), 5000, `${qid} on every phone`);
    const confirmTimes = [];
    await Promise.all(
      phones.map(async (p, i) => {
        await sleep(200 + Math.random() * 5500);
        const sent = Date.now();
        p.answer(i % 4);
        await until(() => p.confirmed(), 6000, `${qid} confirm for phone ${i + 1}`);
        confirmTimes.push(Date.now() - sent);
      }),
    );
    await until(() => engine.phase() === 'reveal', 12000, `${qid} reveal`);
    await until(() => phones.every((p) => p.screen() === 'result'), 4000, `${qid} result on every phone`);
    const lateBy = Date.now() - engine.s.q[qid].closedAt;
    confirmTimes.sort((a, b) => a - b);
    report[qid] = {
      questionOnAllPhonesMs: seen,
      answersCounted: Object.keys(engine.s.q[qid].answers).length,
      confirmMedianMs: confirmTimes[Math.floor(confirmTimes.length / 2)],
      confirmWorstMs: confirmTimes.at(-1),
      resultOnAllPhonesWithinMs: lateBy,
      ranFor: Date.now() - opened,
    };
  }

  engine.setSlide('board');
  await until(() => phones.every((p) => p.screen() === 'leaderboard'), 4000, 'leaderboard on every phone');
  const board = engine.view().board;
  report.leader = `${board[0].name} with ${board[0].score}`;
  report.clockOffsetSpreadMs = Math.round(Math.max(...phones.map((p) => p.offset())) - Math.min(...phones.map((p) => p.offset())));
  report.ok = report.q1.answersCounted === N && report.q2.answersCounted === N;
} catch (e) {
  report.ok = false;
  report.error = e.message;
  report.playersIn = engine.view().playerCount;
  report.links = phones.reduce((m, p) => ((m[p.transport.status] = (m[p.transport.status] || 0) + 1), m), {});
}

if (Object.keys(troubles).length) report.relayTrouble = troubles;
console.log(JSON.stringify(report, null, 2));
for (const p of phones) p.leave();
engine.stop();
setTimeout(() => process.exit(report.ok ? 0 : 1), 400);
