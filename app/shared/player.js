// The phone's side of the conversation, with no screen attached.
//
// It joins a room, repeats itself until the presenter's snapshot proves it was
// heard, and turns each snapshot into one of a handful of screens. The phone
// page draws what this says; the simulated players in the tests run this very
// class, so the tests exercise what the phones will do.

import { PROTOCOL, EV, TIMING, makeId, cleanName, cleanWord, wordKey, cleanTyped, cleanOpen, answerKey, normaliseRoom, isChoice, cleanChoice, cleanNumber, cleanRanking } from './protocol.js';

// One run of one question. Re-running a question gives it a new key, so an
// answer to the earlier run is never mistaken for an answer to this one.
const qkey = (q) => `${q.id}@${q.at || 0}`;

export class Player {
  constructor({ transport, memory, now = () => Date.now(), timers, rand = Math.random }) {
    this.transport = transport;
    this.memory = memory || { load: () => null, save: () => {} };
    this.now = now;
    this.rand = rand;
    this.nextTryAt = 0;
    this.timers = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
    const saved = this.memory.load() || {};
    this.pid = typeof saved.pid === 'string' && /^[a-z0-9]{6,24}$/.test(saved.pid) ? saved.pid : makeId(rand);
    this.name = cleanName(saved.name);
    this.room = normaliseRoom(saved.room);
    this.sid = saved.sid || null;
    this.picks = saved.picks && typeof saved.picks === 'object' ? saved.picks : {}; // question run -> what I sent
    this.snap = null;
    this.link = 'connecting';
    this.lastSnapAt = 0;
    this.lastNow = 0; // presenter clock on the newest snapshot seen
    this.offsets = []; // recent (presenter clock - my clock) samples
    this.pending = null; // answer sent, not yet confirmed
    this.seen = {}; // question run -> when it first appeared on this phone (this phone's clock)
    this.choosing = null; // { key, set }: options ticked on a several-answers question, not yet locked in
    this.listeners = new Set();
    this.tick = null;
    this.resetAt = 0;
    this.resets = 0;
    this.lastHello = 0;
    this.helloTries = 0;
    this.openedAt = 0;
    this.alive = false;

    transport.onMessage((event, payload) => {
      if (event === EV.STATE) this.onSnapshot(payload);
    });
    transport.onStatus?.((status) => {
      if (status === 'live') this.hello(true);
      this.refresh();
    });
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  remember() {
    this.memory.save({ pid: this.pid, name: this.name, room: this.room, sid: this.sid, picks: this.picks });
  }

  // ---- joining -------------------------------------------------------------

  open(room) {
    const next = normaliseRoom(room);
    if (next.length !== 4) return false;
    if (next !== this.room) {
      this.room = next;
      this.snap = null;
      this.sid = null;
      this.picks = {};
      this.pending = null;
      this.lastNow = 0;
    }
    this.alive = true;
    this.lastSnapAt = 0;
    this.openedAt = this.now();
    this.resets = 0;
    this.nextTryAt = 0;
    this.helloTries = 0;
    this.remember();
    this.transport.open(this.room);
    this.loop();
    this.refresh();
    return true;
  }

  setName(name) {
    const clean = cleanName(name);
    if (!clean) return false;
    this.name = clean;
    this.remember();
    this.hello(true);
    this.refresh();
    return true;
  }

  leave() {
    this.alive = false;
    this.timers.clear(this.tick);
    this.transport.close?.();
  }

  // Out of this room and back to the code. For a phone sent to a room nobody is
  // in, by a code mistyped or misheard: without this, even a reload returns it
  // to the same empty room.
  leaveRoom() {
    this.leave();
    this.room = '';
    this.snap = null;
    this.sid = null;
    this.picks = {};
    this.pending = null;
    this.remember();
    this.refresh();
  }

  // Repeated until a snapshot lists me. Brisk while the presenter is there to
  // hear it; slowing right down when the room is silent, so a pocketful of
  // waiting phones never floods the relay.
  hello(force) {
    const t = this.now();
    const gap = this.away() || !this.snap ? Math.min(10000, TIMING.retryMs * 2 ** Math.min(this.helloTries, 3)) : TIMING.retryMs;
    if (!force && t - this.lastHello < gap) return;
    this.lastHello = t;
    this.helloTries = force ? 0 : this.helloTries + 1;
    this.transport.send(EV.HELLO, { pid: this.pid, name: this.name || undefined });
  }

  // ---- answering -----------------------------------------------------------

  // `late` is for autoLock alone: it may send in the moment after the clock
  // has run out, while the presenter still takes answers.
  answer(value, late = false) {
    const q = this.snap?.q;
    if (!q || (!late && this.screen() !== 'question')) return false;
    // What I am sending: a number, a pick (or a list of picks), or a word.
    // A put-in-order answer is a list too, but its order is the point: it is not sorted.
    const pick = q.type === 'num' ? { n: cleanNumber(value, q) } : q.type === 'rank' ? { c: cleanRanking(value, q.opts.length) } : isChoice(q.type) ? { c: q.multi ? cleanChoice(value, q.opts.length) : Math.round(+value) } : q.type === 'text' ? { w: cleanTyped(value) } : q.type === 'open' ? { w: cleanOpen(value) } : { w: cleanWord(value) };
    // A word that is only punctuation is no word to the presenter, who would refuse it.
    if (q.type === 'num' ? pick.n === null : q.type === 'rank' ? !pick.c : isChoice(q.type) ? (q.multi ? !pick.c : !(pick.c >= 0 && pick.c < q.opts.length)) : !pick.w || !(q.type === 'text' ? answerKey(pick.w) : q.type === 'open' ? /[\p{L}\p{N}]/u.test(pick.w) : wordKey(pick.w))) return false;
    this.picks[qkey(q)] = pick.n ?? pick.c ?? pick.w;
    // How long it took, by this phone's own clock, from the question appearing here.
    const seen = this.seen[qkey(q)];
    this.pending = { key: qkey(q), q: q.id, ...pick, ...(seen ? { t: Math.max(0, this.now() - seen) } : {}), sentAt: 0 };
    this.remember();
    this.sendPending();
    this.refresh();
    return true;
  }

  // Where several answers are right: tap an option to tick it, tap again to
  // untick it, then lock in. Nothing is sent until then. If the clock is about
  // to run out on a phone that has ticked something, autoLock() locks it in.
  // Putting in order works the same way, and the order of the taps is the order
  // of the placings: the first tapped is 1st. Taking one out moves the rest up.
  toggle(i) {
    const q = this.snap?.q;
    i = Math.round(+i);
    if (!(q?.multi || q?.type === 'rank') || this.screen() !== 'question' || !(i >= 0 && i < q.opts.length)) return false;
    if (this.choosing?.key !== qkey(q)) this.choosing = { key: qkey(q), set: [] };
    const at = this.choosing.set.indexOf(i);
    if (at < 0) this.choosing.set.push(i);
    else this.choosing.set.splice(at, 1);
    this.refresh();
    return true;
  }

  chosen() {
    const q = this.snap?.q;
    return (q && this.choosing?.key === qkey(q) && this.choosing.set) || [];
  }

  // A choice with one right answer, a true/false or a poll: tap an option to
  // choose it, tap another to change your mind, then lock in. Nothing is sent
  // until then, so a stray tap while scrolling costs nothing. As with the
  // others, a choice not locked in is locked in as the clock runs out.
  select(i) {
    const q = this.snap?.q;
    i = Math.round(+i);
    if (!q || q.multi || !isChoice(q.type) || this.screen() !== 'question' || !(i >= 0 && i < q.opts.length)) return false;
    this.choosing = { key: qkey(q), set: [i] };
    this.refresh();
    return true;
  }

  // Guess the number: the slider's value is mine to change until I lock in.
  setGuess(value) {
    const q = this.snap?.q;
    const n = q?.type === 'num' && this.screen() === 'question' ? cleanNumber(value, q) : null;
    if (n === null) return false;
    this.choosing = { key: qkey(q), n };
    return true;
  }

  guess() {
    const q = this.snap?.q;
    return q && this.choosing?.key === qkey(q) && typeof this.choosing.n === 'number' ? this.choosing.n : null;
  }

  lockIn(late = false) {
    const q = this.snap?.q;
    if (q?.type === 'num') return this.guess() === null ? false : this.answer(this.guess(), late);
    const set = this.chosen();
    if (!set.length) return false;
    return this.answer(q?.multi || q?.type === 'rank' ? set : set[0], late);
  }

  // Chosen, never locked in, and the clock is about to run out or has only
  // just done so: lock it in, so nobody loses a turn to a button. The window is
  // wide on purpose. A phone's timers do not land to the millisecond, and the
  // presenter takes an answer for a moment after the buzzer; one sent later
  // than that is simply not counted.
  autoLock() {
    const s = this.snap;
    const q = s?.q;
    if (!q || (s.ph !== 'open' && s.ph !== 'locking')) return false;
    if (this.pending || this.confirmed() || this.picks[qkey(q)] !== undefined) return false;
    const left = this.remaining();
    if (left === null || left > 600) return false;
    return this.lockIn(true);
  }

  sendPending() {
    const p = this.pending;
    if (!p) return;
    p.sentAt = this.now();
    this.transport.send(EV.ANSWER, { pid: this.pid, name: this.name, q: p.q, c: p.c, w: p.w, n: p.n, t: p.t });
  }

  // ---- snapshots -----------------------------------------------------------

  onSnapshot(snap) {
    if (!snap || snap.v !== PROTOCOL || normaliseRoom(snap.room) !== this.room) return;
    const t = this.now();
    if (snap.sid !== this.sid) {
      // A new session in the same room: nothing I remember applies.
      this.sid = snap.sid;
      this.picks = {};
      this.pending = null;
      this.remember();
    } else if (snap.now < this.lastNow) {
      return; // arrived out of order; a newer one is already showing
    }
    this.lastNow = snap.now;
    this.lastSnapAt = t;
    this.resets = 0;
    this.nextTryAt = 0;
    this.offsets.push(snap.now - t);
    if (this.offsets.length > 12) this.offsets.shift();
    this.snap = snap;

    if (this.listed()) this.helloTries = 0;
    else if (this.name) this.hello(false);

    // Keep repeating my answer until the presenter lists me as heard. Rebuilt
    // from memory, so it survives this page being reloaded mid-question.
    const q = snap.q;
    if (q && snap.ph === 'open' && !this.seen[qkey(q)]) this.seen[qkey(q)] = t;
    if (q && (snap.ph === 'open' || snap.ph === 'locking')) {
      const key = qkey(q);
      const mine = this.picks[key];
      if (snap.ans?.includes(this.pid) || mine === undefined) {
        this.pending = null;
      } else if (this.pending?.key !== key) {
        this.pending = { key, q: q.id, ...(q.type === 'num' ? { n: mine } : isChoice(q.type) || q.type === 'rank' ? { c: mine } : { w: mine }), sentAt: 0 };
        this.sendPending();
      }
    } else {
      this.pending = null;
    }
    this.refresh();
  }

  // The least-delayed snapshot gives the truest reading of the presenter's
  // clock, so take the largest recent sample.
  offset() {
    return this.offsets.length ? Math.max(...this.offsets) : 0;
  }

  // Milliseconds left on the presenter's clock, or null if there is no timer.
  remaining() {
    const ends = this.snap?.q?.ends;
    if (!ends) return null;
    return Math.max(0, ends - (this.now() + this.offset()));
  }

  confirmed() {
    const q = this.snap?.q;
    return !!q && !!this.snap.ans?.includes(this.pid);
  }

  myPick() {
    const q = this.snap?.q;
    if (!q) return null;
    // Once the result is out, only what the presenter counted is mine. An answer
    // that arrived too late, or never, is no answer, and must not show as right.
    if (this.snap.rv) return this.snap.rv.pick?.[this.pid] ?? null;
    return this.picks[qkey(q)] ?? null;
  }

  // Silence from the presenter. A room that has never produced a snapshot
  // gets less patience than one that has: a bad connection is the likelier
  // cause, and rebuilding it is cheap.
  away() {
    if (!this.alive) return false;
    if (this.lastSnapAt) return this.now() - this.lastSnapAt > TIMING.awayMs;
    return this.now() - this.openedAt > TIMING.firstSnapMs;
  }

  listed() {
    return !!this.snap?.ps?.includes(this.pid);
  }

  // One word for what the phone should be showing.
  screen() {
    if (!this.room) return 'code';
    if (!this.name) return 'name';
    const s = this.snap;
    if (!s) return this.away() ? 'away' : 'connecting';
    if (this.away()) return 'away';
    switch (s.ph) {
      case 'armed':
        return 'ready';
      case 'open': {
        if (this.pending || this.confirmed() || this.picks[qkey(s.q)] !== undefined) return 'locked';
        const left = this.remaining();
        return left !== null && left <= 0 ? 'locked' : 'question';
      }
      case 'locking':
        return 'locked';
      case 'reveal':
        return 'result';
      case 'leaderboard':
        return 'leaderboard';
      default:
        return 'waiting';
    }
  }

  // ---- housekeeping --------------------------------------------------------

  // Twice a second: repeat anything unconfirmed, and if the presenter has gone
  // quiet, rebuild the connection with a growing gap between attempts.
  loop() {
    this.timers.clear(this.tick);
    if (!this.alive) return;
    this.tick = this.timers.set(() => {
      const t = this.now();
      if (this.pending && t - this.pending.sentAt >= TIMING.retryMs) this.sendPending();
      this.autoLock();
      if (this.name && !this.listed()) this.hello(false);
      if (this.away()) this.recover(t);
      this.refresh();
      this.loop();
    }, 500);
  }

  // The presenter has gone quiet, so rebuild the connection. The timing is
  // deliberately uneven. Load tests showed that a whole room reopening its
  // sockets in the same instant can leave the relay unsettled, so each phone
  // waits a random moment before its first try and stretches every later wait
  // by a random amount: a room that lost the presenter together does not all
  // come back together.
  //
  // (A gentler first step, rejoining the room on the same socket, was tried
  // and removed: no test ever showed it curing anything, and one showed it
  // costing a phone six seconds. One proven step beats two with one unproven.)
  recover(t) {
    if (!this.nextTryAt) this.nextTryAt = t + this.rand() * 1500;
    if (t < this.nextTryAt) return;
    const attempt = this.resets++;
    const wait = Math.min(30000, 4000 * 2 ** Math.min(attempt, 3));
    this.nextTryAt = t + wait * (0.75 + this.rand() * 0.6);
    this.resetAt = t;
    this.transport.reset?.();
  }

  // Call when the phone wakes or the page comes back to the front.
  wake() {
    if (!this.alive) return;
    const quietFor = this.now() - (this.lastSnapAt || 0);
    if (quietFor > 3500) {
      this.resetAt = this.now();
      this.transport.reset?.();
    } else {
      this.hello(true);
    }
  }

  refresh() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('[tally] listener failed', e);
      }
    }
  }
}
