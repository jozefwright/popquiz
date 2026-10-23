import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../app/shared/engine.js';
import { Player } from '../app/shared/player.js';
import { TIMING, EV, LIMITS, LETTERS, combineOrders, cleanRanking, tagRect, TAG_SHAPE, resultName, roomHeading, answerHeading, underName, isAccepted, answerKey, slipsAllowed } from '../app/shared/protocol.js';
import { normaliseDeck, normaliseSlide, newSlide } from '../app/shared/deck.js';
import { makeRoom, memoryStore, phoneMemory, seeded, DECK } from './helpers.mjs';

const names = (room) => Object.values(room.engine.s.players).map((p) => p.name);

test('phones join, and two people with one name are told apart', async () => {
  const room = await makeRoom();
  room.addPhone('Sam');
  room.addPhone('sam');
  room.addPhone('  Mo   Khan  ');
  room.clock.advance(1000);
  assert.deepEqual(names(room).sort(), ['Mo Khan', 'Sam', 'sam 2']);
  for (const p of room.phones) {
    assert.ok(p.snap.ps.includes(p.pid), 'each phone sees itself listed');
    assert.equal(p.screen(), 'waiting');
  }
});

test('a phone with no name is not a player', async () => {
  const room = await makeRoom();
  const p = room.addPhone('');
  room.clock.advance(1000);
  assert.equal(p.screen(), 'name');
  assert.equal(room.engine.view().playerCount, 0);
});

test('a question opens on arrival, locks at the buzzer and reveals just after', async () => {
  const room = await makeRoom({ players: 4 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  assert.equal(engine.phase(), 'open');
  for (const p of phones) assert.equal(p.screen(), 'question');

  assert.ok(phones[0].answer(0));
  clock.advance(2000);
  assert.ok(phones[1].answer(2));
  clock.advance(300);
  assert.equal(phones[0].screen(), 'locked');
  assert.ok(phones[0].confirmed());
  assert.equal(engine.view().answered, 2);

  clock.advance(15000 - 2600 + 10);
  assert.equal(engine.phase(), 'locking');
  for (const p of phones) assert.equal(p.screen(), 'locked');

  clock.advance(TIMING.graceMs + 300);
  assert.equal(engine.phase(), 'reveal');
  const v = engine.view();
  assert.equal(v.correct, 0);
  assert.deepEqual(v.counts, [1, 0, 1, 0]);
  for (const p of phones) assert.equal(p.screen(), 'result');
  assert.equal(phones[0].snap.rv.correct, 0);
  assert.equal(phones[0].myPick(), 0);
  assert.equal(phones[1].myPick(), 2);
  assert.equal(phones[2].myPick(), null);
});

test('the right answer never goes over the air before the reveal', async () => {
  const room = await makeRoom({ players: 3 });
  const { engine, clock, phones, sent } = room;
  engine.setSlide('q1');
  clock.advance(500);
  phones[0].answer(0);
  clock.advance(14000);
  const early = sent.filter((m) => m.event === EV.STATE && m.payload.ph !== 'reveal');
  assert.ok(early.length > 3);
  for (const m of early) {
    assert.equal(m.payload.rv, undefined);
    assert.ok(!JSON.stringify(m.payload).includes('"correct"'));
  }
});

test('the first answer stands and a second is ignored', async () => {
  const room = await makeRoom({ players: 1 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  phones[0].answer(1);
  clock.advance(300);
  engine.receive(EV.ANSWER, { pid: phones[0].pid, name: 'P1', q: 'q1', c: 0 });
  assert.equal(engine.s.q.q1.answers[phones[0].pid].c, 1);
  assert.equal(phones[0].answer(0), false, 'the phone will not offer a second go');
});

test('an answer in the grace window counts; one after it does not', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(15000 + 300);
  engine.receive(EV.ANSWER, { pid: phones[0].pid, name: 'P1', q: 'q1', c: 0 });
  assert.ok(engine.s.q.q1.answers[phones[0].pid], 'in flight at the buzzer still lands');
  clock.advance(TIMING.graceMs);
  engine.receive(EV.ANSWER, { pid: phones[1].pid, name: 'P2', q: 'q1', c: 0 });
  assert.equal(engine.s.q.q1.answers[phones[1].pid], undefined);
});

test('junk from the network is ignored', async () => {
  const room = await makeRoom({ players: 1 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  const pid = phones[0].pid;
  for (const bad of [null, 'x', {}, { pid: 5 }, { pid: '<script>' }, { pid, q: 'q1', c: 99 }, { pid, q: 'q1', c: -1 }, { pid, q: 'q1', c: 'NaN' }, { pid, q: 'nope', c: 0 }]) {
    engine.receive(EV.ANSWER, bad);
  }
  engine.receive('made-up-event', { pid });
  assert.deepEqual(engine.s.q.q1.answers, {});
});

test('score is correct answers, and speed breaks a tie', async () => {
  const room = await makeRoom({ players: 4 });
  const { engine, clock, phones } = room;
  const [a, b, c, d] = phones;

  engine.setSlide('q1'); // correct: 0
  clock.advance(1000);
  a.answer(0);
  clock.advance(3000);
  b.answer(0);
  c.answer(1);
  clock.advance(15000);

  engine.setSlide('q2'); // true/false, correct: 1
  clock.advance(500);
  b.answer(1);
  clock.advance(4000);
  a.answer(1);
  d.answer(1);
  clock.advance(12000);

  engine.setSlide('board');
  clock.advance(500);
  const board = engine.view().board;
  // a: 2 right in 1.0s + 4.5s; b: 2 right in 4.0s + 0.5s; d: 1; c: 0
  assert.deepEqual(board.map((r) => [r.name, r.score]), [['P2', 2], ['P1', 2], ['P4', 1], ['P3', 0]]);
  assert.ok(board[0].ms < board[1].ms);
  assert.equal(a.screen(), 'leaderboard');
  assert.deepEqual(a.snap.lb[a.pid], [2, 2]);
  assert.deepEqual(a.snap.top, [['P2', 2], ['P1', 2], ['P4', 1]]);
});

test('a question worth double scores two, and phones are told so', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, points: 2 }, poll: { ...DECK.slides.poll, points: 5 } } });
  const room = await makeRoom({ players: 2, deck });
  const { engine, clock, phones } = room;
  const [a, b] = phones;

  engine.setSlide('q1'); // correct: 0, worth two
  clock.advance(1000);
  assert.equal(a.snap.q.pts, 2);
  a.answer(0);
  b.answer(1);
  clock.advance(17000);
  assert.deepEqual(a.snap.lb[a.pid], [1, 2]);

  engine.setSlide('q2'); // true/false, correct: 1, worth one
  clock.advance(500);
  assert.equal(a.snap.q.pts, undefined);
  a.answer(0);
  b.answer(1);
  clock.advance(12000);

  engine.setSlide('poll'); // a poll scores nobody, whatever it is set to
  clock.advance(500);
  assert.equal(a.snap.q.pts, undefined);
  a.answer(0);
  clock.advance(25000);

  engine.setSlide('board');
  clock.advance(500);
  // One right answer each. Without the double they would tie, and b was quicker.
  assert.deepEqual(engine.view().board.map((r) => [r.name, r.score]), [['P1', 2], ['P2', 1]]);
});

test('points are a whole number from one to the limit, and one is not stored', () => {
  const slide = (points) => normaliseDeck({ ...DECK, slides: { q: { ...DECK.slides.q1, points } } }).slides.q;
  const worth = (points) => slide(points).points ?? 1;
  assert.equal(worth(undefined), 1);
  assert.equal(worth(0), 1);
  assert.equal(worth(-3), 1);
  assert.equal(worth('lots'), 1);
  // One point is not written down, so a deck with no doubled question is unchanged by this.
  assert.equal('points' in slide(1), false);
  assert.deepEqual(slide(1), DECK.slides.q1);
  assert.equal(worth(2), 2);
  assert.equal(worth(2.6), 3);
  assert.equal(worth(99), LIMITS.points);
});

// q1 with A and C both right.
const SEVERAL = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, multi: true, corrects: [2, 0] } } });

test('several right answers: right only when exactly those are picked', async () => {
  const room = await makeRoom({ players: 4, deck: SEVERAL });
  const { engine, clock, phones } = room;
  const [a, b, c, d] = phones;

  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.multi, true, 'phones are told several may be picked');
  a.toggle(0);
  a.toggle(1);
  a.toggle(1); // changed their mind
  a.toggle(2);
  assert.deepEqual(a.chosen(), [0, 2]);
  assert.equal(engine.view().answered, 0, 'nothing is sent until it is locked in');
  a.lockIn();
  b.toggle(0);
  b.lockIn(); // one of the two
  c.toggle(2);
  c.toggle(0);
  c.lockIn(); // both, ticked in the other order
  d.toggle(0);
  d.toggle(1);
  d.toggle(2);
  d.lockIn(); // both, and one too many
  clock.advance(1000);
  assert.equal(a.screen(), 'locked');
  assert.deepEqual(a.myPick(), [0, 2]);
  assert.equal(a.toggle(1), false, 'a locked answer stands');
  assert.equal(a.snap.rv, undefined, 'the right answers do not go over the air before the reveal');
  assert.equal(engine.view().correct, null);

  clock.advance(15000);
  assert.equal(engine.phase(), 'reveal');
  assert.deepEqual(engine.view().correct, [0, 2]);
  assert.deepEqual(engine.view().counts, [4, 1, 3, 0], 'each tick is counted');
  assert.deepEqual(a.snap.rv.correct, [0, 2]);
  assert.deepEqual(a.snap.rv.pick[b.pid], [0]);

  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.map((r) => [r.name, r.score]).sort(), [['P1', 1], ['P2', 0], ['P3', 1], ['P4', 0]]);
});

test('ticked but never locked in: it is locked in as the clock runs out', async () => {
  const room = await makeRoom({ players: 2, deck: SEVERAL });
  const { engine, clock, phones } = room;
  const [a, b] = phones;
  engine.setSlide('q1'); // 15 seconds
  clock.advance(2000);
  a.toggle(2);
  a.toggle(0);
  b.toggle(1);
  b.toggle(1); // ticked, then unticked: nothing to send
  clock.advance(12000);
  assert.equal(engine.view().answered, 0, 'still theirs to change with a second to go');
  clock.advance(1000 + TIMING.graceMs + 100);
  assert.equal(engine.phase(), 'reveal');
  assert.deepEqual(engine.s.q.q1.answers[a.pid].c, [0, 2]);
  assert.equal(engine.s.q.q1.answers[b.pid], undefined);
  assert.deepEqual(a.snap.lb[a.pid], [1, 1]);
});

test('several right answers: junk is ignored, and one bare pick counts as one tick', async () => {
  const room = await makeRoom({ players: 2, deck: SEVERAL });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  const [pid, old] = phones.map((p) => p.pid);
  for (const bad of [{ pid, q: 'q1', c: [] }, { pid, q: 'q1', c: [9] }, { pid, q: 'q1', c: [0, 9] }, { pid, q: 'q1', c: ['0'] }, { pid, q: 'q1', c: [null] }, { pid, q: 'q1', c: 'x' }, { pid, q: 'q1' }]) {
    engine.receive(EV.ANSWER, bad);
  }
  assert.deepEqual(engine.s.q.q1.answers, {});
  // A phone still on the page from before this knows only how to send one number.
  engine.receive(EV.ANSWER, { pid: old, q: 'q1', c: 2 });
  engine.receive(EV.ANSWER, { pid, q: 'q1', c: [2, 0, 2] });
  assert.deepEqual(engine.s.q.q1.answers[old].c, [2]);
  assert.deepEqual(engine.s.q.q1.answers[pid].c, [0, 2], 'in order, each once');
});

test('several right answers are kept only where they are set, and only on a choice question', () => {
  const slide = (patch) => normaliseDeck({ ...DECK, slides: { q: { ...DECK.slides.q1, ...patch } } }).slides.q;
  assert.deepEqual(slide({ multi: true, corrects: [2, 0, 2] }).corrects, [0, 2]);
  assert.equal(slide({ multi: true, corrects: [2, 0] }).correct, 0, 'the first of them is also the one right answer an older copy shows');
  assert.deepEqual(slide({ multi: true, corrects: [1, 9] }).corrects, [1], 'one pointing at an option since removed is dropped');
  assert.deepEqual(slide({ multi: true, corrects: [], correct: 3 }).corrects, [3], 'with none ticked, the one right answer stands');
  assert.deepEqual(slide({ multi: true }).corrects, [0]);
  assert.equal(slide({ multi: true, corrects: [1], type: 'tf' }).multi, undefined);
  assert.equal(slide({ multi: true, corrects: [1], type: 'poll' }).multi, undefined);
  // Not set: nothing is written down, so a deck without one is unchanged by this.
  assert.deepEqual(slide({ multi: false, corrects: [1, 2] }), DECK.slides.q1);
  assert.deepEqual(slide({}), DECK.slides.q1);
});

test('a leaderboard starts from the standings the last one showed, and names the fastest since', async () => {
  const room = await makeRoom({ players: 3 });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;

  engine.setSlide('q1'); // correct: 0
  clock.advance(1000);
  a.answer(0);
  clock.advance(3000);
  b.answer(1);
  clock.advance(13000);

  engine.setSlide('board');
  clock.advance(500);
  let v = engine.view();
  assert.equal(v.before, null, 'the first leaderboard of a session has nothing to start from');
  assert.deepEqual([v.fastest.name, v.fastest.ms], ['P1', 1000]);
  assert.deepEqual(v.board.map((r) => [r.name, r.score]), [['P1', 1], ['P2', 0], ['P3', 0]]);

  engine.setSlide('q2'); // true/false, correct: 1
  clock.advance(2000);
  c.answer(1);
  clock.advance(500);
  b.answer(1);
  clock.advance(12000);
  engine.setSlide('join'); // other slides in between change nothing
  clock.advance(500);

  engine.setSlide('board');
  clock.advance(500);
  v = engine.view();
  assert.deepEqual(v.before, { [a.pid]: [1, 1], [b.pid]: [2, 0], [c.pid]: [3, 0] }, 'as the last leaderboard showed them');
  assert.deepEqual(v.board.map((r) => [r.name, r.rank, r.score]), [['P1', 1, 1], ['P3', 2, 1], ['P2', 3, 1]]);
  assert.deepEqual([v.fastest.name, v.fastest.ms], ['P3', 2000], 'the quickest scoring answer since then, not of the whole session');
  assert.equal(v.podium, null);

  // Looked at again with nothing played in between, nobody has moved.
  engine.setSlide('join');
  engine.setSlide('board');
  v = engine.view();
  assert.deepEqual(v.before, { [a.pid]: [1, 1], [c.pid]: [2, 1], [b.pid]: [3, 1] });
  assert.equal(v.fastest, null);
});

test('the final leaderboard uncovers a place a press, and phones are told nothing until it is done', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, board: { ...DECK.slides.board, final: true } } });
  const room = await makeRoom({ players: 4, deck });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  a.answer(0);
  clock.advance(1000);
  b.answer(0);
  clock.advance(15000);
  engine.setSlide('q2');
  clock.advance(1000);
  a.answer(1);
  clock.advance(15000);

  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().podium, { size: 3, shown: 0 });
  assert.equal(a.screen(), 'leaderboard');
  assert.equal(a.snap.hold, true);
  assert.deepEqual([a.snap.lb, a.snap.top], [{}, []], 'no placings go over the air while the podium is covered');

  engine.advance();
  clock.advance(300);
  assert.equal(engine.view().podium.shown, 1);
  assert.equal(c.snap.hold, true, 'not even to the player just uncovered');
  engine.advance();
  engine.advance();
  clock.advance(300);
  assert.equal(engine.view().podium.shown, 3);
  assert.equal(a.snap.hold, undefined);
  assert.deepEqual(a.snap.lb[a.pid], [1, 2]);
  assert.deepEqual(a.snap.top.map(([name]) => name), ['P1', 'P2', 'P3']);
  engine.advance(); // a fourth press does nothing
  assert.equal(engine.view().podium.shown, 3);

  engine.rerun(); // covered again, for a rehearsal
  clock.advance(300);
  assert.equal(engine.view().podium.shown, 0);
  assert.equal(a.snap.hold, true);

  // Come back to it later and it starts covered.
  engine.advance();
  engine.setSlide('join');
  engine.setSlide('board');
  assert.equal(engine.view().podium.shown, 0);
});

test('a podium is as big as the room: two players, two places', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, board: { ...DECK.slides.board, final: true } } });
  const room = await makeRoom({ players: 2, deck });
  room.engine.setSlide('board');
  room.clock.advance(300);
  assert.deepEqual(room.engine.view().podium, { size: 2, shown: 0 });
  room.engine.advance();
  room.engine.advance();
  room.clock.advance(300);
  assert.equal(room.phones[0].snap.hold, undefined);
});

test('an option can be pinned to a shape on the slide; the pins are kept only where there are some', () => {
  const slide = (patch) => normaliseDeck({ ...DECK, slides: { q: { ...DECK.slides.poll, ...patch } } }).slides.q;
  const pinned = slide({ display: 'pins', pins: [{ shapeId: 'photoA', x: 0.1, y: 0.2, w: 0.2, h: 0.6 }, null, { shapeId: 'photoC', x: 2, y: -1, w: 0, h: 0.5 }, { shapeId: '', x: 0, y: 0, w: 1, h: 1 }, { shapeId: 'extra' }] });
  assert.equal(pinned.display, 'pins');
  assert.deepEqual(pinned.pins, [{ shapeId: 'photoA', x: 0.1, y: 0.2, w: 0.2, h: 0.6 }, null, { shapeId: 'photoC', x: 1, y: 0, w: 0.02, h: 0.5 }, null], 'one per option, kept inside the slide');
  assert.equal('pins' in slide({ display: 'pins', pins: [null, null] }), false);
  assert.deepEqual(slide({}), DECK.slides.poll, 'a question without any reads as it always did');
});

// A guess-the-number question: 0 to 100 kg, the answer 38.
const NUMBER = normaliseDeck({ ...DECK, slides: { ...DECK.slides, num: { kind: 'question', index: 8, type: 'num', text: 'How much weight?', min: 0, max: 100, step: 1, answer: 38, unit: 'kg', seconds: 15 } } });

test('guess the number: the closest wins three, the next two, the next one, and equal guesses share', async () => {
  const room = await makeRoom({ players: 6, deck: NUMBER });
  const { engine, clock, phones } = room;
  const [a, b, c, d, e] = phones;

  engine.setSlide('num');
  clock.advance(1000);
  assert.deepEqual([a.snap.q.type, a.snap.q.min, a.snap.q.max, a.snap.q.step, a.snap.q.unit], ['num', 0, 100, 1, 'kg']);
  assert.equal(JSON.stringify(a.snap).includes('38'), false, 'the answer is nowhere in what phones are sent');
  a.answer(38);
  clock.advance(500);
  b.answer(40);
  c.answer(36); // as far out as b, the other way
  d.answer(30);
  e.answer(60); // sixth phone never answers
  clock.advance(1000);
  assert.equal(a.screen(), 'locked');
  assert.equal(a.myPick(), 38);
  assert.equal(engine.view().answered, 5);
  assert.deepEqual(engine.view().guesses, [], 'guesses stay off the big screen while it is open');
  assert.equal(engine.view().answer, null);
  assert.equal(a.snap.rv, undefined);

  clock.advance(15000);
  const v = engine.view();
  assert.equal(v.phase, 'reveal');
  assert.equal(v.answer, 38);
  assert.deepEqual(v.guesses.map((g) => [g.n, g.points]).sort((x, y) => x[0] - y[0]), [[30, 1], [36, 2], [38, 3], [40, 2], [60, 0]]);
  assert.deepEqual(v.closest.map((w) => [w.name, w.n, w.points]), [['P1', 38, 3], ['P2', 40, 2], ['P3', 36, 2], ['P4', 30, 1]]);
  assert.equal(a.snap.rv.answer, 38);
  assert.deepEqual([a.snap.rv.pick[b.pid], a.snap.rv.won[b.pid], a.snap.rv.won[e.pid]], [40, 2, undefined]);
  assert.equal(a.screen(), 'result');

  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.map((r) => [r.name, r.score]), [['P1', 3], ['P2', 2], ['P3', 2], ['P4', 1], ['P5', 0], ['P6', 0]]);
  assert.equal(engine.view().fastest.name, 'P1', 'the quickest guess that won anything');
});

test('guess the number: worth double doubles all three places', async () => {
  const deck = normaliseDeck({ ...NUMBER, slides: { ...NUMBER.slides, num: { ...NUMBER.slides.num, points: 2 } } });
  const room = await makeRoom({ players: 3, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('num');
  clock.advance(500);
  phones[0].answer(39);
  phones[1].answer(50);
  phones[2].answer(10);
  clock.advance(16000);
  assert.deepEqual(engine.ranks(), { [phones[0].pid]: [1, 6], [phones[1].pid]: [2, 4], [phones[2].pid]: [3, 2] });
});

test('guess the number: a guess is kept to the range and its steps, junk is ignored, and a slider left alone sends nothing', async () => {
  const room = await makeRoom({ players: 3, deck: NUMBER });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('num');
  clock.advance(300);
  for (const bad of [{ pid: a.pid, q: 'num', n: 'x' }, { pid: a.pid, q: 'num', n: null }, { pid: a.pid, q: 'num', n: NaN }, { pid: a.pid, q: 'num', n: Infinity }, { pid: a.pid, q: 'num' }, { pid: a.pid, q: 'num', c: 2 }, { pid: a.pid, q: 'q1', n: 5 }]) engine.receive(EV.ANSWER, bad);
  assert.deepEqual(engine.s.q.num.answers, {});
  engine.receive(EV.ANSWER, { pid: a.pid, q: 'num', n: 500 });
  assert.equal(engine.s.q.num.answers[a.pid].n, 100, 'kept inside the range');

  // The slider is theirs to move until they lock in; the clock running out locks in what it shows.
  b.setGuess(37.4);
  b.setGuess(41.6);
  assert.equal(b.guess(), 42, 'on a step');
  assert.equal(engine.view().answered, 1, 'moving the slider sends nothing');
  clock.advance(16500);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.s.q.num.answers[b.pid].n, 42, 'locked in as the clock ran out');
  assert.equal(engine.s.q.num.answers[c.pid], undefined, 'a phone that never touched it has no guess');
  assert.equal(c.screen(), 'result');
});

test('guess the number: set to show them, guesses reach the big screen as they come in', async () => {
  const deck = normaliseDeck({ ...NUMBER, slides: { ...NUMBER.slides, num: { ...NUMBER.slides.num, live: 'tally' } } });
  const room = await makeRoom({ players: 2, deck });
  room.engine.setSlide('num');
  room.clock.advance(300);
  room.phones[0].answer(12);
  room.clock.advance(300);
  assert.deepEqual(room.engine.view().guesses, [{ n: 12 }], 'the guess, without what it is worth');
  assert.equal(room.engine.view().answer, null);
});

test('a number question always has a range with its answer inside it, and only a number question carries one', () => {
  const slide = (patch) => normaliseDeck({ ...DECK, slides: { q: { kind: 'question', index: 1, type: 'num', text: 'N', ...patch } } }).slides.q;
  assert.deepEqual([slide({}).min, slide({}).max, slide({}).step, slide({}).answer, slide({}).unit, slide({}).options], [0, 100, 1, 0, '', []]);
  const odd = slide({ min: 50, max: 20, step: -3, answer: 900, unit: '  kilograms and more  ' });
  assert.deepEqual([odd.min, odd.max, odd.step, odd.answer, odd.unit], [50, 900, 1, 900, 'kilograms an'], 'the range stretches to hold the answer; the answer is never moved');
  assert.deepEqual([slide({ min: 10, max: 20, answer: 4 }).min, slide({ min: 10, max: 20, answer: 4 }).answer], [4, 4]);
  assert.deepEqual([slide({ min: '10', max: '20', step: '0.5', answer: '12.5' }).answer, slide({ min: '10', max: '20', step: '0.5' }).step], [12.5, 0.5], 'numbers typed into the panel');
  assert.equal(slide({ step: 500 }).step, 1, 'a step wider than the range is no step at all');
  assert.equal('answer' in DECK.slides.q1, false);
  assert.equal('min' in normaliseDeck({ ...DECK, slides: { q: { ...DECK.slides.q1, min: 3, max: 9, answer: 4 } } }).slides.q, false);
});

test('a slide can do without parts of its top row; what is switched off is kept only where something is', () => {
  const slide = (hide) => normaliseDeck({ ...DECK, slides: { q: { ...DECK.slides.q1, hide } } }).slides.q;
  assert.deepEqual(slide({ join: true, count: false, clock: true, bogus: true }).hide, { join: true, clock: true });
  assert.deepEqual(slide({ count: true }).hide, { count: true });
  for (const none of [undefined, null, {}, { join: false }, 'join', { join: 'yes' }]) assert.deepEqual(slide(none), DECK.slides.q1);
});

test('options typed for a choice survive the question being tried as something else', () => {
  const norm = (q) => normaliseDeck({ ...DECK, slides: { q } }).slides.q;
  const OPTS = ['Symmetry', 'How much you bench', 'Conditioning', 'Your playlist'];
  const made = norm({ ...DECK.slides.q1, options: OPTS, correct: 2 });
  assert.equal('spare' in made, false, 'a choice carries nothing spare');

  // As the panel does it: change the type, and on the way back offer blank options.
  const asTf = norm({ ...made, type: 'tf' });
  assert.deepEqual([asTf.options, asTf.correct], [['True', 'False'], 0]);
  assert.deepEqual(asTf.spare, { options: OPTS, correct: 2 }, 'what was typed is kept');
  const tfFalse = norm({ ...asTf, correct: 1 }); // and it stays kept while the true/false is worked on
  assert.deepEqual(tfFalse.spare, { options: OPTS, correct: 2 });
  const back = norm({ ...tfFalse, type: 'mc', options: ['', '', '', ''] });
  assert.deepEqual([back.options, back.correct, 'spare' in back], [OPTS, 2, false], 'and comes back, with which was right');

  // Through a word cloud and a number as well, and back as a poll.
  const viaNum = norm({ ...norm({ ...norm({ ...made, type: 'cloud' }), type: 'num' }), type: 'poll', options: ['', '', '', ''] });
  assert.deepEqual(viaNum.options, OPTS);

  // Several right answers and pins come back too.
  const rich = norm({ ...DECK.slides.q1, options: OPTS, multi: true, corrects: [0, 2], display: 'pins', pins: [{ shapeId: 'a', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, null, null, null] });
  const richBack = norm({ ...norm({ ...rich, type: 'tf' }), type: 'mc', options: ['', '', '', ''] });
  assert.deepEqual([richBack.options, richBack.multi, richBack.corrects, richBack.pins[0].shapeId], [OPTS, true, [0, 2], 'a']);

  // New options typed after the change of mind win; the old ones are let go.
  const fresh = norm({ ...asTf, type: 'mc', options: ['Yes', 'No', '', ''] });
  assert.deepEqual([fresh.options, 'spare' in fresh], [['Yes', 'No', '', ''], false]);
  // A true/false made from nothing has nothing to keep.
  assert.equal('spare' in norm({ ...DECK.slides.q2 }), false);
  assert.equal('spare' in norm({ ...DECK.slides.q1, options: ['', '', '', ''], type: 'tf' }), false);
});

test('a question can have up to twelve options, each with its own letter, and the twelfth can be the answer', async () => {
  const twelve = Array.from({ length: 13 }, (_, i) => `Competitor ${i + 1}`);
  assert.equal(LIMITS.options, 12);
  assert.ok(LETTERS.length >= LIMITS.options, 'a letter for every option');
  assert.equal(LETTERS.slice(0, 12), 'ABCDEFGHIJKL');
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, options: twelve, correct: 11 } } });
  assert.equal(deck.slides.q1.options.length, 12, 'a thirteenth is not kept');
  assert.equal(deck.slides.q1.options[11], 'Competitor 12');
  assert.equal(deck.slides.q1.correct, 11);

  const room = await makeRoom({ players: 3, deck });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.opts.length, 12, 'phones get all twelve');
  assert.equal(a.answer(11), true);
  assert.equal(b.answer(6), true);
  assert.equal(c.answer(12), false, 'there is no thirteenth');
  clock.advance(15000 + TIMING.graceMs);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.view().counts.length, 12);
  assert.equal(engine.view().counts[11], 1);
  assert.equal(engine.view().counts[6], 1);
  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.map((r) => [r.name, r.score]).sort(), [['P1', 1], ['P2', 0], ['P3', 0]]);
});

test('put in order: each phone places the items, the places are added up, and the lowest total comes first', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, type: 'rank', text: 'Biggest first', options: ['Jupiter', 'Saturn', 'Neptune', 'Earth'] } } });
  assert.equal(deck.slides.q1.type, 'rank');
  assert.deepEqual(deck.slides.q1.options, ['Jupiter', 'Saturn', 'Neptune', 'Earth'], 'a put-in-order round keeps its items');
  const room = await makeRoom({ players: 4, deck });
  const { engine, clock, phones } = room;
  const [a, b, c, d] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.type, 'rank');

  // The order of the taps is the order of the places; taking one out moves the rest up.
  a.toggle(1);
  a.toggle(0);
  a.toggle(3);
  a.toggle(0); // changed their mind about Jupiter
  a.toggle(0);
  a.toggle(2);
  assert.deepEqual(a.chosen(), [1, 3, 0, 2]);
  a.toggle(3);
  assert.deepEqual(a.chosen(), [1, 0, 2], 'Earth out, and Jupiter and Neptune move up a place');
  a.toggle(3);
  assert.equal(engine.view().answered, 0, 'nothing is sent until it is locked in');
  a.lockIn(); // Saturn, Jupiter, Neptune, Earth
  b.toggle(1);
  b.toggle(2);
  b.toggle(0);
  b.toggle(3);
  b.lockIn(); // Saturn, Neptune, Jupiter, Earth
  c.toggle(0);
  c.toggle(1);
  c.lockIn(); // Jupiter, Saturn, and stopped there
  clock.advance(1000);
  assert.equal(a.screen(), 'locked');
  assert.deepEqual(a.myPick(), [1, 0, 2, 3]);
  assert.equal(engine.view().verdict, null, 'the totals are kept back while the round is open');
  assert.equal(a.snap.rv, undefined);

  clock.advance(15000);
  assert.equal(engine.phase(), 'reveal');
  const v = engine.view().verdict;
  // Jupiter 2+3+1, Saturn 1+1+2, Neptune 3+2+3.5, Earth 4+4+3.5: what c left out shares 3rd and 4th.
  assert.deepEqual(v.totals, [6, 4, 8.5, 11.5]);
  assert.deepEqual(v.places, [2, 1, 3, 4], 'the lowest total comes first');
  assert.equal(v.cards, 3, 'a phone that answered nothing is not counted');
  assert.deepEqual(a.snap.rv.places, [2, 1, 3, 4]);
  assert.deepEqual(a.snap.rv.pick[c.pid], [0, 1]);
  assert.equal(d.myPick(), null);

  engine.setSlide('board');
  clock.advance(500);
  assert.ok(engine.view().board.every((r) => r.score === 0), 'with no right order it scores nobody');
});

test('put in order against the right order: a point for each item in the right place, shown on the second T', async () => {
  const deck = normaliseDeck({
    ...DECK,
    slides: {
      ...DECK.slides,
      q1: { ...DECK.slides.q1, type: 'rank', text: 'Biggest first', options: ['Jupiter', 'Saturn', 'Neptune', 'Earth'], rightOrder: [1, 0, 3, 2], points: 2 },
      orderBoard: { kind: 'leaderboard', index: 9, top: 5, only: 'rank' },
    },
  });
  assert.deepEqual(deck.slides.q1.rightOrder, [1, 0, 3, 2]);
  assert.equal(deck.slides.orderBoard.only, 'rank');
  const room = await makeRoom({ players: 3, deck });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.pts, 2, 'phones are told it is worth double');
  for (const i of [1, 0, 3, 2]) a.toggle(i); // exactly the right order
  a.lockIn();
  for (const i of [1, 2, 3, 0]) b.toggle(i); // Saturn 1st and Earth 3rd match
  b.lockIn();
  for (const i of [0, 1]) c.toggle(i); // stopped after two, neither in its right place
  c.lockIn();
  clock.advance(20000 + TIMING.graceMs);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.view().verdict.rightOrder, null, 'first the room’s order: the right one is held back');
  assert.equal(a.snap.rv.rightOrder, undefined);
  assert.equal(a.snap.lb, undefined, 'and nobody is told their standing yet');
  engine.advance(); // T
  clock.advance(300);
  assert.deepEqual(engine.view().verdict.rightOrder, [1, 0, 3, 2], 'the second T shows the right order');
  assert.deepEqual(a.snap.rv.rightOrder, [1, 0, 3, 2]);
  assert.equal(a.snap.q.right, 'The right order', 'and the phone is told what to call it');
  assert.deepEqual(a.snap.rv.won, { [a.pid]: 8, [b.pid]: 4 });
  assert.ok(a.snap.lb[a.pid]);
  engine.advance(); // T again does nothing more
  assert.equal(engine.phase(), 'reveal');

  engine.setSlide('orderBoard');
  clock.advance(500);
  const ordered = engine.view().board.map((r) => [r.name, r.score]);
  assert.deepEqual(ordered, [['P1', 8], ['P2', 4], ['P3', 0]], 'a board of the put-in-order rounds alone');
  assert.equal(engine.view().before, null);
  assert.equal(engine.view().fastest, null);
  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.find((r) => r.name === 'P1').score, 8, 'and the main leaderboard counts it too');
});

test('put in order: points count even if the right order is never shown, and a round with none scores nobody', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, type: 'rank', options: ['A', 'B', 'C'], rightOrder: [2, 1, 0] }, q2: { ...DECK.slides.q2, type: 'rank', options: ['A', 'B', 'C'] } } });
  assert.equal(deck.slides.q2.rightOrder, undefined);
  const room = await makeRoom({ players: 1, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(1000);
  for (const i of [2, 1, 0]) phones[0].toggle(i);
  phones[0].lockIn();
  clock.advance(20000 + TIMING.graceMs);
  engine.setSlide('q2'); // moved on without pressing T
  clock.advance(1000);
  for (const i of [0, 1, 2]) phones[0].toggle(i);
  phones[0].lockIn();
  clock.advance(20000 + TIMING.graceMs);
  engine.setSlide('board');
  clock.advance(500);
  assert.equal(engine.view().board[0].score, 3, 'three matched on the first round; the second scores nobody');
  assert.equal(normaliseSlide({ kind: 'question', type: 'mc', options: ['a', 'b'], rightOrder: [1, 0] }).rightOrder, undefined, 'only a put-in-order round carries a right order');
  assert.equal(normaliseSlide({ kind: 'question', type: 'rank', options: ['a', 'b'], rightOrder: [0, 0] }).rightOrder, undefined, 'and a junk one is dropped');
  assert.deepEqual(normaliseSlide({ kind: 'question', type: 'rank', options: ['a', 'b'], judges: [1, 0] }).rightOrder, [1, 0], 'a deck from Tally, which called it judges, is read the same');
});

test('a board of the put-in-order rounds alone says when none has been played and scored', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, type: 'rank', options: ['A', 'B', 'C'], rightOrder: [2, 1, 0], start: 'key' }, orderBoard: { kind: 'leaderboard', index: 9, top: 5, only: 'rank' } } });
  const room = await makeRoom({ players: 2, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(engine.phase(), 'armed', 'set to wait for T');
  engine.setSlide('orderBoard'); // moved on without starting it
  clock.advance(500);
  assert.equal(engine.view().played, 0, 'nothing played yet');
  assert.equal(engine.view().board.length, 2, 'the players are still listed');
  engine.setSlide('q1');
  clock.advance(500);
  engine.advance(); // T
  clock.advance(1000);
  for (const i of [2, 1, 0]) phones[0].toggle(i);
  phones[0].lockIn();
  clock.advance(20000 + TIMING.graceMs);
  engine.setSlide('orderBoard');
  clock.advance(500);
  assert.equal(engine.view().played, 1);
  assert.deepEqual(engine.view().board.map((r) => r.score), [3, 0]);
  engine.setSlide('board');
  clock.advance(500);
  assert.equal(engine.view().played, null, 'a full board does not ask');
});

test('a put-in-order round’s two results can be named for the slide, and fall back to the room and the right order', async () => {
  const plain = normaliseSlide({ kind: 'question', type: 'rank', options: ['A', 'B'] });
  assert.equal(plain.names, undefined);
  assert.equal(roomHeading(plain), 'The room’s order');
  assert.equal(answerHeading(plain), 'The right order');
  assert.equal(`${underName(resultName(plain, 'room'))} 2nd`, 'room 2nd', 'unnamed, as it always said');
  const named = normaliseSlide({ ...plain, names: { room: '  The   office ', answer: 'The experts', extra: 'x' } });
  assert.deepEqual(named.names, { room: 'The office', answer: 'The experts' }, 'tidied, and nothing else kept');
  assert.equal(roomHeading(named), 'The office’s order');
  assert.equal(answerHeading(named), 'The experts’ order');
  assert.equal(`${underName(resultName(named, 'room'))} 2nd`, 'office 2nd');
  assert.deepEqual(normaliseSlide({ ...plain, names: { room: 'The office', answer: '' } }).names, { room: 'The office' }, 'one left empty falls back');
  assert.deepEqual(normaliseSlide({ ...plain, names: { judges: 'Olympia judges' } }).names, { answer: 'Olympia judges' }, 'Tally’s name for it is read the same');
  assert.equal(normaliseSlide({ ...plain, names: { room: '', answer: ' ' } }).names, undefined, 'both empty: no names kept');
  assert.equal(normaliseSlide({ kind: 'question', type: 'mc', options: ['a', 'b'], names: { room: 'X' } }).names, undefined, 'only a put-in-order round has them');
  assert.equal(normaliseSlide({ ...plain, names: { room: 'x'.repeat(60) } }).names.room.length, 24, 'short enough for the slide');
});

test('type the answer: near enough counts, and near misses that change the answer do not', () => {
  const ok = (typed, ...accepts) => isAccepted(typed, accepts);
  assert.ok(ok('Canberra', 'Canberra'));
  assert.ok(ok('canbera', 'Canberra'), 'a letter dropped');
  assert.ok(ok('Canbrera', 'Canberra'), 'two letters swapped is one slip');
  assert.ok(ok('the beatles', 'The Beatles') && ok('Beatles!', 'The Beatles'), 'case, punctuation and a leading "the" are set aside');
  assert.ok(ok('Café', 'cafe') && ok('newzealand', 'New Zealand') && ok('salt & pepper', 'salt and pepper'));
  assert.ok(ok('NZ', 'New Zealand', 'NZ'), 'any listed answer counts');
  assert.ok(ok('Leonard da Vinchi', 'Leonardo da Vinci'), 'two slips on a long answer');
  assert.ok(!ok('Austria', 'Australia'), 'two slips on a nine-letter answer is a different country');
  assert.ok(!ok('Iraq', 'Iran') && !ok('Mers', 'Mars'), 'short words must be exact');
  assert.ok(!ok('1968', '1969'), 'and so must numbers');
  assert.ok(!ok('', 'x') && !ok('?!', 'x') && !ok('Canberra', ''), 'nothing typed, or nothing accepted, matches nothing');
  assert.equal(answerKey('  The  Last Supper. '), 'lastsupper');
  assert.deepEqual(['Iran', 'Paris', 'Australia', 'Leonardo da Vinci', '1969'].map((a) => slipsAllowed(answerKey(a))), [0, 1, 1, 2, 0]);
});

test('type the answer: kept back until the reveal, then right answers score, grouped as they were typed', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { kind: 'question', index: 2, type: 'text', text: 'Capital of Australia?', accepts: ['Canberra', ' canberra ', '', 'ACT'], seconds: 30, points: 2 } } });
  assert.deepEqual(deck.slides.q1.accepts, ['Canberra', '', 'ACT'], 'tidied: the same answer twice is dropped, a blank row is kept for the panel');
  assert.deepEqual(deck.slides.q1.options, []);
  const room = await makeRoom({ players: 4, deck });
  const { engine, clock, phones } = room;
  const [a, b, c, d] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.type, 'text');
  assert.equal(a.snap.q.pts, 2, 'phones are told it is worth double');
  assert.equal(JSON.stringify(a.snap).includes('Canberra'), false, 'the answer never goes to the phones before the reveal');
  assert.equal(a.answer('?!'), false, 'only punctuation is not an answer');
  assert.ok(a.answer('Canberra'));
  assert.ok(b.answer('canbera'));
  assert.ok(c.answer('Sydney, I think'));
  clock.advance(1000);
  assert.equal(engine.view().answered, 3);
  assert.deepEqual(engine.view().typed, [], 'nothing typed shows while it is open');
  assert.equal(engine.view().correct, null);
  assert.equal(a.snap.rv, undefined);

  clock.advance(30000 + TIMING.graceMs);
  assert.equal(engine.phase(), 'reveal');
  const v = engine.view();
  assert.equal(v.correct, 'Canberra', 'the first answer that counts is the one shown');
  assert.equal(v.gotIt, 2);
  assert.deepEqual(v.typed.map((g) => [g.w, g.n, g.ok]).sort(), [['Canberra', 1, true], ['Sydney, I think', 1, false], ['canbera', 1, true]]);
  assert.equal(a.snap.rv.answer, 'Canberra');
  assert.deepEqual(a.snap.rv.won, { [a.pid]: 2, [b.pid]: 2 });
  assert.equal(d.myPick(), null);

  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.map((r) => r.score).sort(), [0, 0, 2, 2]);
});

test('type the answer: a longer line than a word cloud allows, and only on its own type', async () => {
  const long = 'The Treaty of Waitangi, 1840';
  assert.ok(long.length > LIMITS.word && long.length <= LIMITS.typed);
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { kind: 'question', index: 2, type: 'text', accepts: [long], seconds: 0 } } });
  const room = await makeRoom({ players: 1, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(500);
  assert.ok(phones[0].answer(long));
  clock.advance(TIMING.doublePressMs + 500); // a T this soon after opening is taken as a double press
  engine.advance(); // T ends it
  clock.advance(TIMING.graceMs + 500);
  assert.equal(engine.view().gotIt, 1, 'the whole line arrived and matched');
  assert.equal(normaliseSlide({ kind: 'question', type: 'mc', options: ['a', 'b'], accepts: ['a'] }).accepts, undefined, 'only a typed question keeps accepted answers');
});

test('a put-in-order round’s place labels: a row along the bottom until dragged, and kept by a save', async () => {
  const cfg = normaliseSlide({ kind: 'question', type: 'rank', display: 'pins', options: ['A', 'B', 'C', 'D'] });
  const row = cfg.options.map((_, i) => tagRect(cfg, i));
  assert.ok(row.every((r) => r.y === row[0].y && r.w > 0.05 && r.h > 0.05), 'in a row, each big enough to read');
  assert.ok(row.every((r, i) => i === 0 || r.x >= row[i - 1].x + row[i - 1].w), 'side by side, not on top of each other');
  assert.ok(row.every((r) => r.x >= 0 && r.x + r.w <= 1 && r.y >= 0 && r.y + r.h <= 1), 'all on the slide');
  const many = normaliseSlide({ kind: 'question', type: 'rank', display: 'pins', options: Array.from({ length: 12 }, (_, i) => `C${i}`) });
  const twelve = many.options.map((_, i) => tagRect(many, i));
  assert.ok(twelve.every((r, i) => r.x + r.w <= 1 && (i === 0 || r.x >= twelve[i - 1].x + twelve[i - 1].w - 1e-9)), 'twelve still fit side by side');
  const dragged = normaliseSlide({ ...cfg, pins: [null, { shapeId: TAG_SHAPE, x: 0.6, y: 0.2, w: 0.1, h: 0.12 }, null, null] });
  assert.deepEqual(dragged.pins[1], { shapeId: TAG_SHAPE, x: 0.6, y: 0.2, w: 0.1, h: 0.12 }, 'a dragged label survives the deck being cleaned');
  assert.deepEqual(tagRect(dragged, 1), { x: 0.6, y: 0.2, w: 0.1, h: 0.12 });
  assert.deepEqual(tagRect(dragged, 0), row[0], 'the others stay in the row');
  assert.deepEqual(normaliseSlide({ ...dragged, type: 'rank' }).pins, dragged.pins, 'and cleaning it twice changes nothing');
});

test('put in order: equal totals share a place, and an order with junk in it is refused', async () => {
  assert.deepEqual(combineOrders([[0, 1], [1, 0]], 2), { totals: [3, 3], places: [1, 1], cards: 2 });
  assert.deepEqual(combineOrders([[2, 0, 1], [0, 2, 1]], 3).places, [1, 3, 1]);
  assert.deepEqual(combineOrders([], 3), { totals: [0, 0, 0], places: [1, 1, 1], cards: 0 });
  assert.deepEqual(cleanRanking([2, 0, 1], 3), [2, 0, 1], 'the order is kept');
  assert.equal(cleanRanking([0, 0], 3), null, 'nothing placed twice');
  assert.equal(cleanRanking([0, 5], 3), null);
  assert.equal(cleanRanking([], 3), null);
  assert.equal(cleanRanking(1, 3), null);

  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, type: 'rank', options: ['A', 'B', 'C'] } } });
  const room = await makeRoom({ players: 1, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(engine.accept({ pid: phones[0].pid, q: 'q1', c: [0, 0] }), false);
  assert.equal(engine.accept({ pid: phones[0].pid, q: 'q1', c: [2, 1] }), true);
});

test('put in order: the items typed survive the slide being tried as something else', () => {
  const typed = normaliseSlide({ kind: 'question', type: 'rank', options: ['Jupiter', 'Saturn', 'Neptune'] });
  const asTf = normaliseSlide({ ...typed, type: 'tf' });
  assert.deepEqual(asTf.options, ['True', 'False']);
  const back = normaliseSlide({ ...asTf, type: 'rank' });
  assert.deepEqual(back.options, ['Jupiter', 'Saturn', 'Neptune']);
});

test('one answer: tap to choose, change your mind, lock in; a choice not locked in is locked in at the buzzer', async () => {
  const room = await makeRoom({ players: 3 });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.select(1), true);
  assert.equal(a.select(DECK.slides.q1.correct), true, 'a change of mind');
  assert.deepEqual(a.chosen(), [DECK.slides.q1.correct]);
  clock.advance(500);
  assert.equal(engine.view().answered, 0, 'nothing is sent until it is locked in');
  assert.equal(a.lockIn(), true);
  assert.equal(a.select(2), false, 'once locked in, it stands');
  b.select(3); // chose, never locked in
  clock.advance(1000);
  assert.equal(engine.view().answered, 1);
  assert.equal(c.lockIn(), false, 'nothing chosen, nothing to lock in');
  clock.advance(DECK.slides.q1.seconds * 1000 + TIMING.graceMs);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.s.q.q1.answers[a.pid].c, DECK.slides.q1.correct, 'the answer locked in is the last one chosen');
  assert.equal(engine.s.q.q1.answers[b.pid]?.c, 3, 'the chosen one is locked in as the clock runs out');
  assert.equal(engine.s.q.q1.answers[c.pid], undefined);
});

test('a poll counts votes and scores nobody', async () => {
  const room = await makeRoom({ players: 3 });
  const { engine, clock, phones } = room;
  engine.setSlide('poll');
  clock.advance(300);
  phones[0].answer(3);
  phones[1].answer(3);
  phones[2].answer(1);
  clock.advance(21000);
  const v = engine.view();
  assert.equal(v.phase, 'reveal');
  assert.deepEqual(v.counts, [0, 1, 0, 2]);
  assert.equal(v.correct, null);
  assert.equal(phones[0].snap.rv.correct, null);
  assert.ok(engine.leaderboard().every((r) => r.score === 0));
});

test('a word cloud groups the same word and stays open until the slide moves', async () => {
  const room = await makeRoom({ players: 4 });
  const { engine, clock, phones } = room;
  engine.setSlide('cloud');
  clock.advance(300);
  phones[0].answer('Oily');
  phones[1].answer('oily!');
  phones[2].answer('  Arnold ');
  assert.equal(phones[3].answer('   '), false);
  clock.advance(60000);
  assert.equal(engine.phase(), 'open', 'no timer, so it waits for the presenter');
  assert.deepEqual(engine.view().words, [{ w: 'Oily', n: 2 }, { w: 'Arnold', n: 1 }]);
  engine.setSlide('q1');
  assert.equal(engine.s.q.cloud.status, 'closed');
});

test('flicking past a question nobody answered does not burn it', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(800);
  engine.setSlide('q2');
  clock.advance(800);
  engine.setSlide('join');
  assert.equal(engine.s.q.q1.status, 'idle');
  assert.equal(engine.s.q.q2.status, 'idle');
  clock.advance(60000);
  assert.equal(engine.phase(), 'join', 'no stray timer fires later');

  engine.setSlide('q1');
  clock.advance(300);
  assert.equal(engine.phase(), 'open');
  phones[0].answer(0);
  clock.advance(300);
  engine.setSlide('q2');
  assert.equal(engine.s.q.q1.status, 'closed', 'answered, so leaving ends it');
  engine.setSlide('q1');
  clock.advance(300);
  assert.equal(engine.phase(), 'reveal', 'coming back shows the result, not a new round');
  assert.equal(phones[1].screen(), 'result');
});

test('a question whose clock ran out on an empty room runs again, and never shows its answer on the way in', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  const [a, b] = phones;

  // The presenter lands on the question before anyone is ready. Nobody answers.
  engine.setSlide('q1');
  clock.advance(17000);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.view().answered, 0);

  engine.setSlide('join');
  clock.advance(500);
  engine.setSlide('q1');
  clock.advance(300);
  assert.equal(engine.phase(), 'open', 'it runs again');
  assert.equal(engine.view().correct, null, 'the big screen does not show the answer');
  assert.equal(a.screen(), 'question');
  assert.equal(a.snap.rv, undefined, 'and neither does the phone');

  // Played properly this time, it is finished, and going back shows its result.
  a.answer(0);
  b.answer(1);
  clock.advance(16000);
  assert.equal(engine.phase(), 'reveal');
  engine.setSlide('join');
  clock.advance(500);
  engine.setSlide('q1');
  clock.advance(300);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.view().answered, 2);
  assert.equal(a.screen(), 'result');
});

test('a question left finished and empty by an earlier run is not shown as finished', async () => {
  const room = await makeRoom({ players: 1 });
  const { engine, clock, phones } = room;
  engine.setSlide('join');
  // As a session saved before this was fixed would hold it.
  engine.s.q.keyed = { status: 'closed', openedAt: 1, endsAt: 2, closedAt: 3, answers: {} };
  engine.setSlide('keyed');
  clock.advance(300);
  assert.equal(engine.phase(), 'armed', 'it waits for T like any question set to');
  assert.equal(phones[0].screen(), 'ready');
  engine.advance();
  clock.advance(300);
  assert.equal(engine.phase(), 'open');
  clock.advance(5000 + TIMING.graceMs + 100);
  assert.equal(engine.phase(), 'reveal', 'and when the clock runs out the answer shows');
  assert.equal(engine.view().correct, 1);
});

test('a question made new starts on arrival with a 20-second clock; one already in a deck keeps how it was set', () => {
  const fresh = normaliseSlide(newSlide('question'));
  assert.equal(fresh.start, 'auto', 'nothing to explain: it starts when the slide appears');
  assert.equal(fresh.seconds, 20);
  assert.equal(DECK.slides.q1.start, 'auto');
  assert.equal(DECK.slides.keyed.start, 'key');
});

test('key-start waits for the hotkey, which also skips to the reveal', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  engine.setSlide('keyed');
  clock.advance(5000);
  assert.equal(engine.phase(), 'armed');
  assert.equal(phones[0].screen(), 'ready');
  engine.advance();
  clock.advance(300);
  assert.equal(engine.phase(), 'open');
  phones[0].answer(1);
  clock.advance(300);
  engine.advance(); // a second press straight after the first: taken as a double press
  clock.advance(300);
  assert.equal(engine.phase(), 'open', 'a question just started is not ended by a double press');
  clock.advance(1500);
  engine.advance();
  clock.advance(300);
  assert.equal(engine.phase(), 'locking', 'T ends the clock, as the buzzer does');
  assert.equal(phones[0].screen(), 'locked');
  clock.advance(TIMING.graceMs);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(phones[0].screen(), 'result');
});

test('T ending a question early still takes the answers on their way, and locks in what phones have chosen', async () => {
  const room = await makeRoom({ players: 3, deck: SEVERAL });
  const { engine, clock, phones } = room;
  const [a, b, c] = phones;
  engine.setSlide('q1');
  clock.advance(3000);
  a.toggle(0);
  a.toggle(2); // ticked, not locked in
  b.toggle(1);
  b.lockIn();
  engine.advance(); // T, before anyone else has locked in
  clock.advance(TIMING.graceMs + 200);
  assert.equal(engine.phase(), 'reveal');
  assert.deepEqual(engine.s.q.q1.answers[a.pid]?.c, [0, 2], 'the phone that had ticked is locked in as the clock ends');
  assert.ok(engine.s.q.q1.answers[b.pid]);
  assert.equal(engine.s.q.q1.answers[c.pid], undefined);
  engine.advance(); // and pressing T again on a finished question does nothing
  assert.equal(engine.phase(), 'reveal');
});

test('a phone that answered too late is told it did not answer, not that it was right', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  const [a] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  // Its answer is lost on the way: it never reaches the presenter.
  room.hub.drop = () => true;
  a.answer(DECK.slides.q1.correct);
  clock.advance(DECK.slides.q1.seconds * 1000 + TIMING.graceMs + 500);
  room.hub.drop = null;
  clock.advance(3000);
  assert.equal(engine.phase(), 'reveal');
  assert.equal(engine.s.q.q1.answers[a.pid], undefined);
  assert.equal(a.myPick(), null, 'what the phone remembers sending is not what counted');
});

test('speed is timed by the phone, from the question appearing on it, so a slow network does not cost a remote player', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  const [near, far] = phones;
  engine.setSlide('q1');
  clock.advance(300);
  near.answer(DECK.slides.q1.correct);
  clock.advance(1);
  // The far phone's answer took a long way round: told 300 ms by the phone, seen here later.
  engine.receive(EV.ANSWER, { pid: far.pid, name: far.name, q: 'q1', c: DECK.slides.q1.correct, t: 250 });
  clock.advance(DECK.slides.q1.seconds * 1000 + TIMING.graceMs);
  const ms = (p) => engine.s.q.q1.answers[p.pid].ms;
  assert.equal(ms(far), 250, 'the phone said 250 ms; that is what counts');
  assert.ok(ms(near) <= 300, 'and the near phone timed itself too');
});

test('a phone cannot claim to have taken longer than the presenter saw', async () => {
  const room = await makeRoom({ players: 1 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(2000);
  engine.receive(EV.ANSWER, { pid: phones[0].pid, name: phones[0].name, q: 'q1', c: 0, t: 99999 });
  assert.ok(engine.s.q.q1.answers[phones[0].pid].ms <= 2000);
});

test('a word that is only punctuation is not sent, so a phone never sits on "Sending"', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, type: 'cloud', seconds: 0 } } });
  const room = await makeRoom({ players: 1, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(500);
  assert.equal(phones[0].answer('?!'), false);
  assert.equal(phones[0].answer('...'), false);
  assert.equal(phones[0].answer('Oily'), true);
});

test('a lossy network loses no answers: phones repeat until heard', async () => {
  const rand = seeded(42);
  const room = await makeRoom({ rand });
  const { engine, clock, hub } = room;
  hub.drop = () => rand() < 0.45; // nearly half of every message vanishes
  for (let i = 0; i < 25; i++) room.addPhone(`Player ${i + 1}`);
  clock.advance(12000);
  assert.equal(engine.view().playerCount, 25, 'everyone gets in despite the losses');

  engine.setSlide('q1');
  clock.advance(1500);
  let asked = 0;
  for (const p of room.phones) {
    if (p.screen() === 'question') {
      p.answer(Math.floor(rand() * 4));
      asked++;
    }
    clock.advance(200);
  }
  clock.advance(15000);
  assert.equal(engine.phase(), 'reveal');
  assert.ok(asked >= 23, `most phones saw the question in time (${asked})`);
  assert.equal(Object.keys(engine.s.q.q1.answers).length, asked, 'every answer given was counted');
});

test('reloading the presenter mid-question loses nothing', async () => {
  const store = memoryStore();
  const room = await makeRoom({ players: 5, store });
  const { clock, hub, phones } = room;
  room.engine.setSlide('q1');
  clock.advance(1000);
  phones[0].answer(0);
  phones[1].answer(1);
  clock.advance(1000);
  const before = { room: room.engine.s.room, sid: room.engine.s.sid, endsAt: room.engine.s.q.q1.endsAt };
  room.engine.stop(); // the tab reloads

  clock.advance(1500);
  phones[2].answer(0); // sent into the void; the phone keeps repeating it

  const engine = new Engine({ deck: DECK, store, transport: hub.transport(), now: clock.now, timers: clock.timers, rand: room.rand });
  await engine.start();
  engine.setSlide('q1'); // the host reports the same slide again
  clock.advance(2500);
  assert.equal(engine.s.room, before.room);
  assert.equal(engine.s.sid, before.sid);
  assert.equal(engine.s.q.q1.endsAt, before.endsAt, 'the clock was not restarted');
  assert.equal(engine.view().playerCount, 5);
  assert.equal(Object.keys(engine.s.q.q1.answers).length, 3, 'two saved, one caught on the retry');
  assert.equal(phones[2].screen(), 'locked');
  assert.ok(phones[2].confirmed());

  clock.advance(15000);
  assert.equal(engine.phase(), 'reveal');
  assert.deepEqual(engine.view().counts, [2, 1, 0, 0]);
});

test('if the buzzer went while the presenter was down, waiting answers still land', async () => {
  const store = memoryStore();
  const room = await makeRoom({ players: 3, store });
  const { clock, hub, phones } = room;
  room.engine.setSlide('q1');
  clock.advance(13000);
  room.engine.stop();
  clock.advance(500);
  phones[0].answer(0); // in time, but nobody is listening
  clock.advance(4000); // buzzer passes while down

  const engine = new Engine({ deck: DECK, store, transport: hub.transport(), now: clock.now, timers: clock.timers, rand: room.rand });
  await engine.start();
  clock.advance(2000);
  assert.ok(engine.s.q.q1.answers[phones[0].pid], 'the repeated answer is accepted in the catch-up window');
  clock.advance(1500);
  assert.equal(engine.phase(), 'reveal');
});

test('a question whose clock ran out on an empty room while the slideshow was closed runs again, and does not show its answer', async () => {
  const store = memoryStore();
  const room = await makeRoom({ players: 3, store });
  const { clock, hub } = room;
  room.engine.setSlide('q1');
  clock.advance(3000);
  room.engine.stop(); // the slideshow is closed with nobody having answered
  clock.advance(30000);
  const engine = new Engine({ deck: DECK, store, transport: hub.transport(), now: clock.now, timers: clock.timers, rand: room.rand });
  await engine.start();
  clock.advance(3000);
  assert.equal(engine.phase(), 'open', 'it runs again from the top');
  assert.equal(engine.view().correct, null);
});

test('a room stays the same room as long as it is in use, however long ago it opened', async () => {
  const store = memoryStore();
  const room = await makeRoom({ players: 2, store });
  const { clock, hub } = room;
  const code = room.engine.s.room;
  for (let h = 0; h < 14; h++) {
    clock.advance(60 * 60 * 1000); // an hour at a time, the room in use throughout
    room.engine.setSlide(h % 2 ? 'q1' : 'join');
  }
  room.engine.stop();
  clock.advance(60 * 1000);
  const engine = new Engine({ deck: DECK, store, transport: hub.transport(), now: clock.now, timers: clock.timers, rand: room.rand });
  await engine.start();
  assert.equal(engine.s.room, code, '14 hours after it opened, but used a minute ago: the same room');
  engine.stop();
  clock.advance(13 * 60 * 60 * 1000);
  const later = new Engine({ deck: DECK, store, transport: hub.transport(), now: clock.now, timers: clock.timers, rand: room.rand });
  await later.start();
  assert.notEqual(later.s.room, code, 'left unused for 13 hours: a fresh one');
});

test('reloading a phone mid-question keeps its answer and its place', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, hub } = room;
  const memory = phoneMemory();
  const phone = room.addPhone('Reloader', memory);
  clock.advance(600);
  engine.setSlide('q1');
  clock.advance(500);
  hub.drop = (event) => event === EV.ANSWER; // the answer never arrives
  phone.answer(2);
  clock.advance(300);
  phone.leave(); // page reloads before it was confirmed
  hub.drop = null;

  const again = new Player({ transport: hub.transport(), memory, now: clock.now, timers: clock.timers });
  assert.equal(again.pid, phone.pid);
  assert.equal(again.name, 'Reloader');
  again.open(engine.s.room);
  clock.advance(2500);
  assert.equal(again.screen(), 'locked');
  assert.equal(engine.s.q.q1.answers[phone.pid].c, 2, 'the remembered answer was sent again');
  assert.equal(engine.view().playerCount, 3, 'same person, not a new one');
});

test('a phone that loses the presenter says so, then recovers', async () => {
  const room = await makeRoom({ players: 1 });
  const { engine, clock, phones } = room;
  const p = phones[0];
  let resets = 0;
  p.transport.reset = () => resets++;
  p.transport.online = false;
  clock.advance(TIMING.awayMs + 1500);
  assert.equal(p.screen(), 'away');
  assert.ok(resets >= 1, 'it tries rebuilding the connection');
  p.transport.online = true;
  clock.advance(TIMING.heartbeatMs + 200);
  assert.equal(p.screen(), 'waiting');
  assert.equal(engine.view().playerCount, 1);
});

test('re-running a question clears it and lets everyone answer again', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  phones[0].answer(3);
  clock.advance(16000);
  assert.equal(engine.phase(), 'reveal');
  engine.rerun();
  clock.advance(300);
  assert.equal(engine.phase(), 'open');
  assert.equal(engine.view().answered, 0);
  assert.equal(phones[0].screen(), 'question');
  assert.ok(phones[0].answer(0));
  clock.advance(16000);
  assert.deepEqual(engine.view().counts, [1, 0, 0, 0]);
});

test('correcting the answer key corrects the scores', async () => {
  const room = await makeRoom({ players: 2 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  phones[0].answer(0);
  phones[1].answer(2);
  clock.advance(16000);
  assert.equal(engine.leaderboard()[0].name, 'P1');
  const fixed = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, correct: 2 } } });
  engine.setDeck(fixed);
  assert.equal(engine.leaderboard()[0].name, 'P2');
});

test('a long option reaches the phone whole, and only the limit cuts it', async () => {
  const long = 'Moving weight to make one muscle work as hard as it can, slowly and under control. '.repeat(3).trim();
  assert.ok(long.length > 120 && long.length < LIMITS.optionText);
  const over = 'x'.repeat(LIMITS.optionText + 50);
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { ...DECK.slides.q1, text: over, options: [long, over, 'C', 'D'] } } });
  assert.equal(deck.slides.q1.options[0], long);
  assert.equal(deck.slides.q1.options[1].length, LIMITS.optionText);
  assert.equal(deck.slides.q1.text.length, LIMITS.questionText);
  const room = await makeRoom({ players: 1, deck });
  room.engine.setSlide('q1');
  room.clock.advance(300);
  assert.equal(room.phones[0].screen(), 'question');
  assert.equal(room.phones[0].snap.q.opts[0], long);
});

test('a new session opens a new room with nobody in it', async () => {
  const room = await makeRoom({ players: 3 });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(300);
  phones[0].answer(0);
  clock.advance(16000);
  const old = engine.s.room;
  engine.newSession();
  clock.advance(500);
  assert.notEqual(engine.s.room, old);
  assert.equal(engine.view().playerCount, 0);
  assert.deepEqual(engine.s.q.q1?.answers ?? {}, {});
  clock.advance(TIMING.awayMs + 1000);
  assert.equal(phones[0].screen(), 'away', 'rehearsal phones are left behind, not carried in');
});

test('a session left over from another day is not reused', async () => {
  const store = memoryStore();
  const room = await makeRoom({ players: 2, store });
  const old = room.engine.s.sid;
  room.engine.stop();
  room.clock.advance(TIMING.staleSessionMs + 1000);
  const engine = new Engine({ deck: DECK, store, transport: room.hub.transport(), now: room.clock.now, timers: room.clock.timers, rand: room.rand });
  await engine.start();
  assert.notEqual(engine.s.sid, old);
  assert.equal(engine.view().playerCount, 0);
});

test('a slide Tally knows nothing about is simply idle', async () => {
  const room = await makeRoom({ players: 1 });
  room.engine.setSlide('some-ordinary-slide');
  room.clock.advance(300);
  assert.equal(room.engine.phase(), 'idle');
  assert.equal(room.phones[0].screen(), 'waiting');
  room.engine.setSlide(null);
  assert.equal(room.engine.view().kind, 'none');
});

test('open answer: kept back until the reveal, then a card each, in the order they came, rude words masked', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { kind: 'question', index: 2, type: 'open', text: 'Best thing this week?', options: ['x', 'y'], seconds: 0 } } });
  assert.deepEqual(deck.slides.q1.options, [], 'an open answer has no options');
  assert.equal(deck.slides.q1.byline, undefined, 'names are off unless asked for');
  const room = await makeRoom({ players: 4, deck });
  const { engine, clock, phones } = room;
  const [a, b, c, d] = phones;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.equal(a.snap.q.type, 'open');
  assert.equal(a.answer('?!'), false, 'only punctuation is not an answer');
  const long = 'A sentence that runs on for a good while, much longer than a word cloud word or a typed answer would ever be allowed to be.';
  assert.ok(long.length > LIMITS.typed && long.length <= LIMITS.open);
  assert.ok(a.answer('Friday drinks'));
  clock.advance(300);
  assert.ok(b.answer(long));
  clock.advance(300);
  assert.ok(c.answer('The fucking printer works'));
  clock.advance(1000);
  assert.equal(engine.view().answered, 3);
  assert.deepEqual(engine.view().cards, [], 'nothing shows while it is open');

  engine.advance(); // T: reveal
  clock.advance(TIMING.graceMs + 500);
  assert.equal(engine.phase(), 'reveal');
  const cards = engine.view().cards;
  assert.deepEqual(cards.map((x) => x.w), ['Friday drinks', long, 'The f•••••• printer works'], 'in the order they came, masked');
  assert.equal(cards[0].by, undefined, 'no names');
  assert.equal(a.snap.rv.pick[a.pid], 'Friday drinks', 'each phone can show its own answer');
  assert.equal(engine.view().correct, null, 'nothing is right or wrong');

  engine.hideCard('q1', b.pid);
  clock.advance(200);
  assert.deepEqual(engine.view().cards.map((x) => x.w), ['Friday drinks', 'The f•••••• printer works'], 'a hidden card is taken off');
  assert.equal(d.myPick(), null);

  engine.setSlide('board');
  clock.advance(500);
  assert.deepEqual(engine.view().board.map((r) => r.score), [0, 0, 0, 0], 'it scores nobody');
});

test('open answer: shown as they come when the slide says so, with names when asked', async () => {
  const deck = normaliseDeck({ ...DECK, slides: { ...DECK.slides, q1: { kind: 'question', index: 2, type: 'open', text: 'Shout-outs?', live: 'tally', byline: true, seconds: 0 } } });
  const room = await makeRoom({ players: 2, deck });
  const { engine, clock, phones } = room;
  engine.setSlide('q1');
  clock.advance(1000);
  assert.ok(phones[0].answer('Thanks for the cake'));
  clock.advance(1000);
  const [card] = engine.view().cards;
  assert.equal(card.w, 'Thanks for the cake', 'it shows before the reveal');
  assert.equal(card.by, engine.s.players[phones[0].pid].name);
});
