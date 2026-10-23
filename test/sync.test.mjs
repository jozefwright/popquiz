import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, fingerprint } from '../app/shared/sync.js';
import { normaliseDeck } from '../app/shared/deck.js';

const deckWith = (text, extra = {}) => normaliseDeck({ presentationId: 'd', slides: { s1: { kind: 'question', type: 'mc', text, options: ['a', 'b'], correct: 0 }, ...extra } }, 'd');
const empty = normaliseDeck(null, 'd');
const remoteOf = (deck, rev, updatedAt = 1000) => ({ rev, updatedAt, deck });
const syncedAt = (deck, rev) => ({ rev, mark: fingerprint(deck), dirtyAt: 0 });

test('the fingerprint ignores key order and notices any change', () => {
  const a = deckWith('one');
  const shuffled = JSON.parse(JSON.stringify(a, Object.keys(a).reverse().concat(['slides', 's1', 'kind', 'type', 'text', 'options', 'correct', 'place', 'x', 'y', 'w', 'h', 'theme', 'reveal', 'show', 'hide', 'style'])));
  assert.equal(fingerprint(JSON.parse(JSON.stringify(a))), fingerprint(a));
  assert.notEqual(fingerprint(deckWith('two')), fingerprint(a));
  assert.ok(shuffled);
});

test('a slide’s number and the deck’s title are housekeeping: a renumbered old copy cannot win over newer work', () => {
  const friday = deckWith('Friday');
  const renumbered = JSON.parse(JSON.stringify(friday));
  renumbered.slides.s1.index = 17;
  renumbered.title = 'Renamed deck';
  assert.equal(fingerprint(renumbered), fingerprint(friday), 'neither counts as an edit');
  // The old copy noticed a slide move after the shared copy moved on. It takes the shared copy.
  const weekend = remoteOf(deckWith('Weekend'), 'r2', 5000);
  const d = decide({ local: renumbered, state: { ...syncedAt(friday, 'r1'), dirtyAt: 9000 }, remote: weekend });
  assert.equal(d.do, 'adopt');
  // A leaderboard's own title is content, and still counts.
  const board = deckWith('x', { s2: { kind: 'leaderboard', title: 'Head judge' } });
  const retitled = JSON.parse(JSON.stringify(board));
  retitled.slides.s2.title = 'So far';
  assert.notEqual(fingerprint(retitled), fingerprint(board));
});

test('nothing anywhere: nothing to do', () => {
  assert.equal(decide({ local: empty, state: null, remote: null }).do, 'nothing');
});

test('a quiz here and no shared copy: send it up', () => {
  assert.equal(decide({ local: deckWith('one'), state: null, remote: null }).do, 'push');
});

test('a new device with nothing, and a shared copy: take it', () => {
  const d = decide({ local: empty, state: null, remote: remoteOf(deckWith('one'), 'r1') });
  assert.equal(d.do, 'adopt');
  assert.equal(d.keep, undefined, 'there was nothing here to keep aside');
});

test('both the same: settle, send nothing', () => {
  const deck = deckWith('one');
  const d = decide({ local: deck, state: null, remote: remoteOf(deck, 'r1') });
  assert.equal(d.do, 'nothing');
  assert.equal(d.settle, true);
});

test('changed here, shared copy untouched: send it up', () => {
  const was = deckWith('one');
  assert.equal(decide({ local: deckWith('two'), state: { ...syncedAt(was, 'r1'), dirtyAt: 5000 }, remote: remoteOf(was, 'r1') }).do, 'push');
});

test('untouched here, shared copy changed on another device: take it', () => {
  const was = deckWith('one');
  const d = decide({ local: was, state: syncedAt(was, 'r1'), remote: remoteOf(deckWith('two'), 'r2', 9000) });
  assert.equal(d.do, 'adopt');
  assert.equal(d.keep, undefined);
});

test('changed on both: the later edit wins and the other is kept aside', () => {
  const was = deckWith('one');
  const mine = deckWith('mine');
  const theirs = deckWith('theirs');
  const later = decide({ local: mine, state: { ...syncedAt(was, 'r1'), dirtyAt: 9000 }, remote: remoteOf(theirs, 'r2', 5000) });
  assert.equal(later.do, 'push');
  assert.deepEqual(later.overwrote, theirs);
  const earlier = decide({ local: mine, state: { ...syncedAt(was, 'r1'), dirtyAt: 3000 }, remote: remoteOf(theirs, 'r2', 5000) });
  assert.equal(earlier.do, 'adopt');
  assert.deepEqual(earlier.keep, mine);
});

test('a deck emptied here does not wipe the shared copy', () => {
  const was = deckWith('one');
  assert.equal(decide({ local: empty, state: syncedAt(was, 'r1'), remote: remoteOf(deckWith('two'), 'r2') }).do, 'adopt');
});

// ---- an out-of-date copy, and earlier versions --------------------------------

import { SCHEMA } from '../app/shared/sync.js';
import { save, shown, remember, listed, version, FLOOR, HISTORY_GAP, HISTORY_MAX } from '../app/shared/shelf.js';

test('a shared copy saved by a newer Tally is neither taken nor written over', () => {
  const mine = deckWith('mine');
  const newer = { ...remoteOf(deckWith('theirs'), 'r9'), schema: SCHEMA + 1 };
  assert.deepEqual(decide({ local: mine, state: syncedAt(mine, 'r1'), remote: newer }), { do: 'outdated' });
  assert.deepEqual(decide({ local: deckWith('edited here'), state: { ...syncedAt(mine, 'r1'), dirtyAt: 5000 }, remote: newer }), { do: 'outdated' }, 'not even with changes of its own');
  assert.deepEqual(decide({ local: empty, state: null, remote: newer }), { do: 'outdated' }, 'nor on a device that has nothing');
  // One saved by this Tally, or an older one, is handled as ever.
  assert.equal(decide({ local: mine, state: syncedAt(mine, 'r1'), remote: { ...remoteOf(deckWith('theirs'), 'r9'), schema: SCHEMA } }).do, 'adopt');
});

const body = (deck, extra = {}) => ({ deck, client: SCHEMA, ...extra });
const stored = (deck, extra = {}) => ({ rev: 'r1', updatedAt: 1000, schema: SCHEMA, historyAt: 0, deck, ...extra });

test('the service refuses a save from a copy of Tally that is out of date', () => {
  const now = 10 * HISTORY_GAP;
  // A copy from before 0.3.0 says no number at all. This is the one that did the damage.
  const old = save({ id: 'd', current: stored(deckWith('good')), body: { deck: deckWith('mangled'), baseRev: 'r1' }, now });
  assert.deepEqual([old.status, old.body.error, old.next], [426, 'out of date', undefined]);
  assert.equal(save({ id: 'd', current: null, body: { deck: deckWith('first') }, now }).status, 426, 'even on a quiz nobody has saved yet');
  assert.equal(save({ id: 'd', current: null, body: body(deckWith('x'), { client: FLOOR - 1 }), now }).status, 426);
  assert.equal(save({ id: 'd', current: null, body: body(deckWith('x'), { client: '3' }), now }).status, 426, 'a number, not something like one');
  // Once a newer copy has saved a quiz, an older one cannot, though it is itself allowed elsewhere.
  const ahead = stored(deckWith('newer'), { schema: SCHEMA + 2 });
  assert.deepEqual([save({ id: 'd', current: ahead, body: body(deckWith('older'), { baseRev: 'r1' }), now }).status, save({ id: 'd', current: ahead, body: body(deckWith('older'), { baseRev: 'r1' }), now }).body.schema], [426, SCHEMA + 2]);
  // And a service older than the copy saving to it says so, where it would have dropped the newer settings.
  assert.equal(save({ id: 'd', current: null, body: body(deckWith('x'), { client: SCHEMA + 1 }), now }).status, 503);
});

test('a save in order is stored, and one from a stale copy of the quiz is sent back', () => {
  const now = 10 * HISTORY_GAP;
  const first = save({ id: 'd', current: null, body: body(deckWith('first')), now, rand: () => 0.5 });
  assert.equal(first.status, 200);
  assert.deepEqual([first.next.schema, first.next.updatedAt, first.next.deck.presentationId, first.keep], [SCHEMA, now, 'd', null]);
  assert.equal(first.body.rev, first.next.rev);
  const stale = save({ id: 'd', current: stored(deckWith('theirs')), body: body(deckWith('mine'), { baseRev: 'r0' }), now });
  assert.deepEqual([stale.status, stale.body.rev, stale.body.deck.slides.s1.text, stale.next], [409, 'r1', 'theirs', undefined]);
  assert.equal(save({ id: 'd', current: stored(deckWith('theirs')), body: body(deckWith('mine'), { baseRev: 'r0', force: true }), now }).status, 200);
  assert.deepEqual(Object.keys(shown(stored(deckWith('a'), { historyAt: 5 }))), ['rev', 'updatedAt', 'schema', 'deck'], 'what a device is given');
});

test('the version a save replaces is set aside, but not on every keystroke', () => {
  const start = 100 * HISTORY_GAP;
  // Nothing set aside yet: the first save over it keeps it.
  const a = save({ id: 'd', current: stored(deckWith('v1')), body: body(deckWith('v2'), { baseRev: 'r1' }), now: start });
  assert.deepEqual([a.keep.rev, a.keep.deck.slides.s1.text, a.next.historyAt], ['r1', 'v1', start]);
  // A minute later: too soon for another.
  const b = save({ id: 'd', current: a.next, body: body(deckWith('v3'), { baseRev: a.next.rev }), now: start + 60000 });
  assert.deepEqual([b.keep, b.next.historyAt], [null, start]);
  // Unless it is asked for, as the panel does before bringing an earlier version back.
  assert.equal(save({ id: 'd', current: a.next, body: body(deckWith('v3'), { baseRev: a.next.rev, keep: true }), now: start + 60000 }).keep.deck.slides.s1.text, 'v2');
  // After the gap, the next save keeps what it replaces again.
  const c = save({ id: 'd', current: b.next, body: body(deckWith('v4'), { baseRev: b.next.rev }), now: start + HISTORY_GAP + 1 });
  assert.equal(c.keep.deck.slides.s1.text, 'v3');
  assert.equal(save({ id: 'd', current: null, body: body(deckWith('v1')), now: start }).keep, null, 'a first save replaces nothing');
});

test('earlier versions are listed newest first, capped, and can be fetched one at a time', () => {
  let history = null;
  for (let i = 1; i <= HISTORY_MAX + 5; i++) history = remember(history, { rev: `r${i}`, updatedAt: i * 1000, schema: SCHEMA, deck: deckWith(`v${i}`, i % 2 ? {} : { s2: { kind: 'join' } }) });
  assert.equal(history.versions.length, HISTORY_MAX);
  const list = listed(history);
  assert.deepEqual(list[0], { rev: `r${HISTORY_MAX + 5}`, updatedAt: (HISTORY_MAX + 5) * 1000, slides: 1, questions: 1 });
  assert.deepEqual([list[1].slides, list[1].questions], [2, 1]);
  assert.equal('deck' in list[0], false, 'the list carries no quizzes');
  assert.equal(version(history, 'r10').deck.slides.s1.text, 'v10');
  assert.equal(version(history, 'r1'), null, 'the oldest have gone');
  assert.equal(version(null, 'r1'), null);
  assert.deepEqual(listed(null), []);
  assert.equal(remember(history, history.versions[3]).versions.length, HISTORY_MAX, 'the same version is not kept twice');
});

// ---- what a laptop fetches ------------------------------------------------------

import { readFileSync } from 'node:fs';
import { list } from '../scripts/files.mjs';

test('the published file list is current, and the version is the same wherever it is written', async () => {
  const app = new URL('../app/', import.meta.url);
  assert.equal(readFileSync(new URL('files.txt', app), 'utf8'), await list(), 'app/files.txt is out of date. Run: npm run files');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', app), 'utf8')).version;
  assert.equal(JSON.parse(readFileSync(new URL('version.json', app), 'utf8')).version, manifest, 'app/version.json must say what the manifest says');
  const names = (await list()).trim().split('\n').map((l) => l.split('  ')[1]);
  for (const need of ['manifest.json', 'background.js', 'content.js', 'panel/panel.js', 'ext/host.js', 'shared/engine.js', 'stage/modules.js', 'vendor/fonts.css', 'vendor/bricolage-latin.woff2', 'vendor/figtree-latin.woff2', 'icons/128.png', 'version.json']) assert.ok(names.includes(need), `${need} is part of the plugin`);
  for (const not of ['api/deck.js', 'package.json', 'vercel.json', 'files.txt', 'get/popquiz.sh']) assert.equal(names.includes(not), false, `${not} is the website's, not the plugin's`);
});
