// Pop Quiz's own relay: its rules (relay/src/rules.js), and the client that
// talks to it (CloudflareTransport), against a fake socket and a fake clock.
// The real thing, end to end, is `wrangler dev` plus test/sim-live.mjs; see
// relay/README.md.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, roomFromPath, originAllowed, Bucket, refuse, audience } from '../relay/src/rules.js';
import { CloudflareTransport } from '../app/shared/transport.js';
import { makeRoomCode, LIMITS, EV } from '../app/shared/protocol.js';
import { normaliseDeck } from '../app/shared/deck.js';
import { makeRoom } from './helpers.mjs';

test('the relay takes every room code the app can make, in either case, and nothing else', () => {
  for (let i = 0; i < 500; i++) {
    const code = makeRoomCode();
    assert.equal(roomFromPath(`/room/${code}`), code);
    assert.equal(roomFromPath(`/room/${code.toLowerCase()}/`), code);
  }
  for (const bad of ['/room/AEIO', '/room/KXT', '/room/KXTRB', '/room/KX1R', '/room/', '/rooms/KXTR', '/room/KXTR/x']) assert.equal(roomFromPath(bad), null, bad);
});

test('origins: a lone * lets anything in; otherwise exact or patterned, and no origin is no entry', () => {
  assert.ok(originAllowed(undefined, '*'));
  assert.ok(originAllowed('https://evil.example', ' * '));
  const list = 'https://tally-quiz.vercel.app, chrome-extension://*,http://192.168.*';
  assert.ok(originAllowed('https://tally-quiz.vercel.app', list));
  assert.ok(originAllowed('chrome-extension://abcdefghijklmnop', list));
  assert.ok(originAllowed('http://192.168.1.20:8790', list));
  assert.ok(!originAllowed('https://tally-quiz.vercel.app.evil.example', list), 'an exact entry is exact');
  assert.ok(!originAllowed('https://evil.example', list));
  assert.ok(!originAllowed(null, list), 'a request with no Origin is not a browser');
  assert.ok(!originAllowed('https://tally-quiz.vercel.app', ''), 'an empty list lets nobody in');
});

test('a socket gets its burst, then its steady rate, and a dry bucket counts what it drops', () => {
  const b = new Bucket({ burst: 3, perSecond: 2 }, 0);
  assert.deepEqual([b.take(0), b.take(0), b.take(0), b.take(0)], [true, true, true, false]);
  assert.equal(b.dropped, 1);
  assert.equal(b.take(400), false, 'not yet a whole token');
  assert.equal(b.take(500), true, 'half a second at two a second');
  assert.equal(b.dropped, 0, 'a message that gets through clears the count');
  assert.equal(new Bucket({ burst: 3, perSecond: 2 }, 0).take(60000) && true, true);
});

test('the rate limit leaves a busy phone and a busy presenter well clear', () => {
  // A phone at its busiest: a hello and an answer repeated every retry, for a minute.
  const phone = new Bucket(RULES.phoneRate, 0);
  for (let t = 0; t < 60000; t += 1400 / 2) assert.ok(phone.take(t), `phone refused at ${t}`);
  // The presenter: a routine snapshot at every throttle gap, plus a burst of
  // phase changes sent at once, as a question opens, closes and reveals.
  const host = new Bucket(RULES.presenterRate, 0);
  for (let i = 0; i < 10; i++) assert.ok(host.take(0));
  for (let t = 0; t < 60000; t += 600) assert.ok(host.take(t), `presenter refused at ${t}`);
});

test('a message must be a JSON object with a short event name, and under the cap in UTF-8 bytes', () => {
  const ok = JSON.stringify({ event: 'answer', payload: { pid: 'abc' } });
  assert.equal(refuse(ok, 1000), null);
  assert.equal(refuse('ping', 1000), 'not JSON');
  assert.equal(refuse('[1,2]', 1000), 'not an object');
  assert.equal(refuse('{"payload":1}', 1000), 'no event');
  assert.equal(refuse(JSON.stringify({ event: 'x'.repeat(33) }), 1000), 'no event');
  assert.equal(refuse(new ArrayBuffer(4), 1000), 'not text');
  assert.equal(refuse(JSON.stringify({ event: 'a', payload: 'x'.repeat(2000) }), 1000), 'too big');
  // 330 letters that take three bytes each: short by length, too big in bytes.
  const wide = JSON.stringify({ event: 'a', payload: '語'.repeat(330) });
  assert.ok(wide.length < 1000);
  assert.equal(refuse(wide, 1000), 'too big');
});

test('the caps fit the biggest messages the game sends', async () => {
  // An open-answer reveal in a full room, every card as long as it can be: the
  // biggest snapshot there is.
  const deck = normaliseDeck({ presentationId: 't', slides: { join: { kind: 'join', index: 1 }, q: { kind: 'question', index: 2, type: 'open', text: 'Q'.repeat(600), seconds: 10 } } });
  const room = await makeRoom({ players: LIMITS.players, deck });
  room.engine.setSlide('q');
  room.clock.advance(700);
  room.phones.forEach((p) => p.answer('w'.repeat(LIMITS.open)));
  room.clock.advance(14000);
  assert.equal(room.engine.phase(), 'reveal');
  room.sent.length = 0;
  room.engine.broadcast(true);
  const snap = JSON.stringify({ event: EV.STATE, payload: room.sent[0].payload });
  assert.ok(snap.length > RULES.phoneBytes, 'a reveal this big is why the presenter has a cap of its own');
  assert.equal(refuse(snap, RULES.presenterBytes), null);
  // A phone's longest message: an open answer in a script of three bytes a letter.
  const answer = JSON.stringify({ event: EV.ANSWER, payload: { pid: 'abcdefghij', name: 'n'.repeat(LIMITS.name), q: 'q@1', w: '語'.repeat(LIMITS.open), t: 1 } });
  assert.equal(refuse(answer, RULES.phoneBytes), null);
});

test('a phone is heard by the presenter alone; the presenter by everyone else', () => {
  const [host, a, b] = ['host', 'a', 'b'];
  const everyone = [host, a, b];
  assert.deepEqual(audience(a, 'phone', everyone, [host], 'presenter'), [host]);
  assert.deepEqual(audience(host, 'presenter', everyone, [host], 'presenter'), [a, b]);
  assert.deepEqual(audience(a, 'phone', everyone, [host], 'all'), [host, b], "route 'all' is plain broadcast");
  assert.deepEqual(audience(a, 'phone', [a, b], [], 'presenter'), [], 'no presenter, nobody to hear');
});

// ---- the client ------------------------------------------------------------

class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.made.push(this);
  }
  send(s) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
  }
  // What the server does:
  opened() {
    this.readyState = 1;
    this.onopen?.();
  }
  says(data) {
    this.onmessage?.({ data });
  }
  dropped(code = 1006, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function rig(opts = {}) {
  FakeSocket.made = [];
  mock.timers.reset();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1_000_000 });
  const t = new CloudflareTransport({ url: 'ws://relay.test/', WebSocket: FakeSocket, rand: () => 0.5, ...opts });
  const statuses = [];
  const heard = [];
  const troubles = [];
  t.onStatus((s) => statuses.push(s));
  t.onMessage((e, p) => heard.push([e, p]));
  t.trouble = (w) => troubles.push(w);
  return { t, statuses, heard, troubles, last: () => FakeSocket.made.at(-1) };
}

test('the client opens /room/<ROOM>, the presenter says so, and it is live once the socket opens', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, statuses, last } = rig({ presenter: true });
  t.open('kxtr');
  assert.equal(last().url, 'ws://relay.test/room/KXTR?role=presenter');
  assert.equal(t.send(EV.STATE, { a: 1 }), false, 'nothing goes before the socket is open');
  last().opened();
  assert.deepEqual(statuses, ['live']);
  assert.equal(t.send(EV.STATE, { a: 1 }), true);
  assert.deepEqual(JSON.parse(last().sent[0]), { event: 'state', payload: { a: 1 } });
  t.close();
  const phone = rig();
  phone.t.open('KXTR');
  assert.equal(phone.last().url, 'ws://relay.test/room/KXTR', 'a phone carries no role');
  phone.t.close();
});

test('messages arrive as event and payload; pongs and junk are swallowed', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, heard, last } = rig();
  t.open('KXTR');
  last().opened();
  last().says(JSON.stringify({ event: 'state', payload: { seq: 4 } }));
  last().says('pong');
  last().says('not json');
  last().says('{"payload":1}');
  assert.deepEqual(heard, [['state', { seq: 4 }]]);
  t.close();
});

test('a dropped socket comes back on its own, after an uneven wait that stretches', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, statuses, last } = rig();
  t.open('KXTR');
  last().opened();
  last().dropped();
  assert.equal(t.status, 'down');
  assert.equal(FakeSocket.made.length, 1);
  mock.timers.tick(1049); // first wait: 1 s times 1.05 (rand 0.5)
  assert.equal(FakeSocket.made.length, 1);
  mock.timers.tick(2);
  assert.equal(FakeSocket.made.length, 2);
  assert.equal(t.status, 'connecting');
  last().dropped(); // fails again before opening
  mock.timers.tick(2000);
  assert.equal(FakeSocket.made.length, 2, 'the second wait is longer');
  mock.timers.tick(200);
  assert.equal(FakeSocket.made.length, 3);
  last().opened();
  assert.equal(t.status, 'live');
  assert.deepEqual(statuses, ['live', 'down', 'connecting', 'down', 'connecting', 'live']);
  t.close();
});

test('a full room is waited out for longer', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, last, troubles } = rig();
  t.open('KXTR');
  last().opened();
  last().dropped(4003, 'room full');
  assert.match(troubles[0], /4003: room full/);
  mock.timers.tick(9000);
  assert.equal(FakeSocket.made.length, 1);
  mock.timers.tick(2000);
  assert.equal(FakeSocket.made.length, 2);
  t.close();
});

test('the presenter pings, and rebuilds a link that has gone silent', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, last, troubles } = rig({ presenter: true });
  t.open('KXTR');
  const first = last();
  first.opened();
  mock.timers.tick(2000);
  assert.deepEqual(first.sent, ['ping']);
  first.says('pong');
  mock.timers.tick(6000);
  assert.equal(FakeSocket.made.length, 1, 'a pong six seconds ago keeps it');
  mock.timers.tick(2000);
  assert.equal(FakeSocket.made.length, 2, 'silent for more than echoMs: rebuilt');
  assert.equal(first.onmessage, null, 'the old socket is cut loose');
  assert.match(troubles[0], /no pong/);
  t.close();
});

test('a socket the relay closed is taken as gone even when no close event comes', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, last } = rig();
  t.open('KXTR');
  last().opened();
  last().readyState = 2; // the close frame came; the end of the connection did not
  mock.timers.tick(10000);
  assert.equal(t.status, 'down');
  mock.timers.tick(1100);
  assert.equal(FakeSocket.made.length, 2);
  t.close();
});

test('a socket that never opens is given up on and tried again', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t } = rig();
  t.open('KXTR');
  mock.timers.tick(4900);
  assert.equal(t.status, 'connecting');
  mock.timers.tick(200);
  assert.equal(t.status, 'down', 'a hung handshake is given up on after five seconds, not a whole ping later');
  mock.timers.tick(2000);
  assert.equal(FakeSocket.made.length, 2);
  t.close();
});

test('reset builds a fresh socket at once; close stops every retry', (ctx) => {
  ctx.after(() => mock.timers.reset());
  const { t, last } = rig();
  t.open('KXTR');
  last().opened();
  t.reset();
  assert.equal(FakeSocket.made.length, 2);
  assert.equal(FakeSocket.made[0].readyState, 3, 'the old one is closed');
  last().dropped();
  t.close();
  mock.timers.tick(60000);
  assert.equal(FakeSocket.made.length, 2);
  assert.equal(t.status, 'down');
});
