// The real sharing function, app/api/deck.js, run here against a stand-in for
// its store. The rules it applies are tested in sync.test.mjs; this is the part
// that only the live site otherwise runs: fetching, storing, and what it costs.
import test from 'node:test';
import assert from 'node:assert/strict';
import module from 'node:module';
import { SCHEMA } from '../app/shared/sync.js';

const canHook = typeof module.registerHooks === 'function';
if (canHook) {
  const fake = new URL('./helpers/fake-blob.mjs', import.meta.url).href;
  module.registerHooks({ resolve: (specifier, context, next) => (specifier === '@vercel/blob' ? { url: fake, shortCircuit: true } : next(specifier, context)) });
}

const ID = 'API_TEST_0123456789_abcdefghij';
const at = (extra = '') => `https://tally-quiz.vercel.app/api/deck?id=${ID}${extra}`;
const deck = (text) => ({ title: 'Api', slides: { a: { kind: 'join', index: 1 }, b: { kind: 'question', index: 2, type: 'mc', text, options: ['One', 'Two'], correct: 1, points: 2 } } });
const send = (api, body) => api.PUT(new Request(at(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

test('the sharing function: saves, refuses, keeps earlier versions, and what each costs the store', { skip: canHook ? false : 'this Node cannot stand in for the store' }, async () => {
  const api = await import('../app/api/deck.js');
  const { ops, files } = await import('./helpers/fake-blob.mjs');
  const spent = async (fn) => { const was = { ...ops }; const out = await fn(); return { out, looks: ops.looks - was.looks, saves: ops.saves - was.saves }; };

  assert.equal((await api.OPTIONS()).status, 204);
  assert.equal((await api.GET(new Request('https://tally-quiz.vercel.app/api/deck?id=short'))).status, 400);
  assert.equal((await api.GET(new Request(at()))).status, 404, 'nothing shared yet');

  // A copy of Tally from before 0.3.0 says no format number, and is turned away without a save.
  const old = await spent(() => send(api, { deck: deck('From an old copy') }));
  assert.equal(old.out.status, 426);
  assert.equal(old.saves, 0);
  assert.equal(files.size, 0);

  const first = await spent(() => send(api, { deck: deck('First'), client: SCHEMA, baseRev: null }));
  assert.equal(first.out.status, 200);
  assert.deepEqual([first.looks, first.saves], [1, 1], 'a first save is one look and one save');
  const rev1 = (await first.out.json()).rev;

  const look = await spent(() => api.GET(new Request(at())));
  const shown = await look.out.json();
  assert.deepEqual([look.out.status, look.looks, look.saves], [200, 1, 0], 'a look is one look');
  assert.deepEqual([shown.rev, shown.schema, shown.deck.slides.b.text, shown.deck.slides.b.points], [rev1, SCHEMA, 'First', 2]);
  assert.equal(look.out.headers.get('access-control-allow-origin'), '*');

  // The second save replaces the first, and the first is set aside: two looks, two saves.
  const second = await spent(() => send(api, { deck: deck('Second'), client: SCHEMA, baseRev: rev1 }));
  assert.equal(second.out.status, 200);
  assert.deepEqual([second.looks, second.saves], [2, 2]);
  const rev2 = (await second.out.json()).rev;

  // A third, straight after: nothing is set aside this soon, so one look and one save.
  const third = await spent(() => send(api, { deck: deck('Third'), client: SCHEMA, baseRev: rev2 }));
  assert.deepEqual([third.out.status, third.looks, third.saves], [200, 1, 1]);

  // A save from a stale copy of the quiz is sent back what is there, and stores nothing.
  const stale = await spent(() => send(api, { deck: deck('Stale'), client: SCHEMA, baseRev: rev1 }));
  assert.equal(stale.out.status, 409);
  assert.equal(stale.saves, 0);
  assert.equal((await stale.out.json()).deck.slides.b.text, 'Third');

  const history = await (await api.GET(new Request(at('&history=1')))).json();
  assert.deepEqual(history.versions.map((v) => [v.rev, v.questions]), [[rev1, 1]]);
  const was = await api.GET(new Request(at(`&rev=${rev1}`)));
  assert.equal((await was.json()).deck.slides.b.text, 'First');
  assert.equal((await api.GET(new Request(at('&rev=never')))).status, 404);

  assert.equal((await send(api, { deck: deck('Too new'), client: SCHEMA + 1, baseRev: null })).status, 503, 'a newer Tally than the service is asked to wait');
  assert.deepEqual([...files.keys()].sort(), [`decks/${ID}.history.json`, `decks/${ID}.json`]);
});
