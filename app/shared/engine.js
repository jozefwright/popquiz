// The Tally engine: the presenter-side source of truth.
//
// It owns the room, the players, every answer and the clock. It knows nothing
// about Google Slides, the DOM or Supabase: the host tells it which slide is
// showing, a transport carries messages, a store keeps the session. That is
// what lets the extension, the PDF fallback and the tests run the same code.
//
// Every change is saved at once, so a reload mid-talk resumes where it was.

import { PROTOCOL, EV, TIMING, LIMITS, makeRoomCode, makeId, cleanName, cleanWord, wordKey, isScored, isChoice, rightAnswers, sameChoice, cleanChoice, cleanNumber, nearest, cleanRanking, combineOrders, scores, orderHits, answerHeading, cleanTyped, answerKey, isAccepted, cleanOpen, maskRude } from './protocol.js';
import { themeFor } from './deck.js';

const PID = /^[a-z0-9]{6,24}$/;

export function newSession(now, rand) {
  return { v: 1, sid: makeId(rand), room: makeRoomCode(rand), startedAt: now, players: {}, q: {}, cur: null };
}

function validSession(s) {
  return !!s && s.v === 1 && typeof s.room === 'string' && s.room.length === 4 && s.players && s.q && typeof s.sid === 'string';
}

// The right answer as the screen and the phones are told it at the reveal:
// a number, or a list where several are right.
// A typed question shows its first accepted answer that is not blank.
const shown = (cfg) => (cfg.type === 'text' ? cfg.accepts?.find((a) => answerKey(a)) ?? null : cfg.multi ? rightAnswers(cfg) : cfg.correct);

export class Engine {
  constructor({ deck, store, transport, now = () => Date.now(), timers, rand = Math.random }) {
    this.deck = deck;
    this.store = store;
    this.transport = transport;
    this.now = now;
    this.rand = rand;
    this.timers = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
    this.s = null;
    this.seq = 0;
    this.link = 'connecting';
    this.listeners = new Set();
    this.qTimers = [];
    this.beatTimer = null;
    this.sendTimer = null;
    this.lastSent = 0;
    this.started = false;
    this.catchUpFor = null; // question held open after a reload, see resumeTimers
  }

  // ---- lifecycle -----------------------------------------------------------

  async start() {
    let s = null;
    try {
      s = await this.store.load();
    } catch {
      s = null;
    }
    const t = this.now();
    // Stale by when it was last used, not when it began: a room opened the night
    // before must not reset itself when the slideshow is restarted mid-talk.
    if (!validSession(s) || t - (s.at || s.startedAt) > TIMING.staleSessionMs) s = newSession(t, this.rand);
    this.s = s;
    this.started = true;
    this.transport.onMessage((event, payload) => this.receive(event, payload));
    this.transport.onStatus?.((status) => {
      if (status === this.link) return;
      this.link = status;
      this.emit();
      if (status === 'live') this.broadcast(true);
    });
    this.transport.open(s.room);
    this.resumeTimers();
    this.beat();
    this.changed();
  }

  stop() {
    this.started = false;
    this.clearQTimers();
    this.timers.clear(this.beatTimer);
    this.timers.clear(this.sendTimer);
    this.transport.close?.();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setDeck(deck) {
    this.deck = deck;
    if (this.started) this.changed();
  }

  // Wipes players and scores and opens a new room. For the gap between a
  // rehearsal and the real thing.
  newSession() {
    this.clearQTimers();
    const cur = this.s?.cur ?? null;
    this.s = newSession(this.now(), this.rand);
    this.transport.open(this.s.room);
    this.s.cur = null;
    this.setSlide(cur);
  }

  // ---- the host drives the slide ------------------------------------------

  setSlide(id) {
    id = id || null;
    const s = this.s;
    if (id !== s.cur) {
      if (s.cur) this.leave(s.cur);
      s.cur = id;
      this.forgetUnplayed(id); // one left that way by a session saved before leave() did this
      this.arrive(id);
    }
    this.enter(id);
    this.changed(true);
  }

  cfg(id) {
    return (id && this.deck?.slides?.[id]) || null;
  }

  // A leaderboard shows who has moved since the last one was up, so each
  // remembers the standings it showed (see leave) and the next starts from
  // them. A final one starts with its podium covered.
  arrive(id) {
    if (this.cfg(id)?.kind !== 'leaderboard') return;
    const s = this.s;
    // A board of the put-in-order rounds alone has nothing of its own to move from.
    s.boardFrom = this.cfg(id).only ? null : s.boardSeen || null;
    s.boardFromAt = s.boardSeenAt || 0;
    s.podium = 0;
  }

  // How many places the final leaderboard uncovers, one press of T each.
  podiumSize() {
    return Math.min(3, Object.keys(this.s.players).length);
  }

  qstate(id) {
    return (this.s.q[id] ||= { status: 'idle', openedAt: 0, endsAt: null, closedAt: 0, answers: {} });
  }

  // Leaving a question nobody has answered puts it back as it was, so flicking
  // through the deck never burns a question. Leaving one with answers ends it.
  // One whose clock ran out on an empty room is put back too: with nobody's
  // answer in it there is no result, only the right answer, and arriving at it
  // again would show the room that before anyone had voted.
  leave(id) {
    if (this.cfg(id)?.kind === 'leaderboard') {
      if (this.cfg(id).only) return; // the next full board moves from the last full one
      this.s.boardSeen = this.ranks();
      this.s.boardSeenAt = this.now();
      return;
    }
    const q = this.s.q[id];
    if (!q) return;
    if (q.status === 'open') {
      if (Object.keys(q.answers).length === 0) {
        this.clearQTimers();
        this.catchUpFor = null;
        this.s.q[id] = { status: 'idle', openedAt: 0, endsAt: null, closedAt: 0, answers: {} };
      } else {
        this.close(id);
      }
    } else if (q.status === 'armed') {
      q.status = 'idle';
    } else {
      this.forgetUnplayed(id);
    }
  }

  forgetUnplayed(id) {
    const q = this.s.q[id];
    if (q?.status === 'closed' && Object.keys(q.answers).length === 0) this.s.q[id] = { status: 'idle', openedAt: 0, endsAt: null, closedAt: 0, answers: {} };
  }

  enter(id) {
    const cfg = this.cfg(id);
    if (!cfg || cfg.kind !== 'question') return;
    const q = this.qstate(id);
    if (q.status !== 'idle') return; // open: carry on. closed: show the result.
    if (cfg.start === 'key') q.status = 'armed';
    else this.open(id);
  }

  open(id) {
    const cfg = this.cfg(id);
    if (!cfg || cfg.kind !== 'question') return;
    const q = this.qstate(id);
    const t = this.now();
    q.status = 'open';
    q.openedAt = t;
    q.endsAt = cfg.seconds > 0 ? t + cfg.seconds * 1000 : null;
    q.closedAt = 0;
    q.answers = {};
    this.scheduleClose(id);
  }

  close(id) {
    const q = this.s.q[id];
    if (!q || q.status !== 'open') return;
    q.status = 'closed';
    q.closedAt = this.now();
    this.catchUpFor = null;
    this.clearQTimers();
  }

  clearQTimers() {
    for (const h of this.qTimers) this.timers.clear(h);
    this.qTimers = [];
  }

  scheduleClose(id) {
    this.clearQTimers();
    const q = this.s.q[id];
    if (!q || q.status !== 'open' || !q.endsAt) return;
    const t = this.now();
    // At the buzzer the screen locks; a moment later the result shows. The gap
    // lets answers already in flight arrive.
    const lockIn = Math.max(0, q.endsAt - t);
    const closeIn = Math.max(lockIn + TIMING.graceMs, 0);
    this.qTimers.push(this.timers.set(() => this.changed(true), lockIn));
    this.qTimers.push(
      this.timers.set(() => {
        if (this.s.cur === id) {
          this.close(id);
          this.changed(true);
        }
      }, closeIn),
    );
  }

  // After a reload: pick the clock back up. If the buzzer went while the
  // engine was down, hold the question open briefly so phones that are still
  // repeating their answer can land it.
  resumeTimers() {
    const id = this.s.cur;
    const q = id && this.s.q[id];
    if (!q || q.status !== 'open') return;
    if (!this.cfg(id)) return;
    if (q.endsAt && this.now() > q.endsAt) {
      this.clearQTimers();
      this.catchUpFor = id;
      this.qTimers.push(
        this.timers.set(() => {
          if (this.s.cur !== id) return;
          if (Object.keys(q.answers).length) this.close(id);
          else {
            // Nobody answered before the slideshow closed, and nothing came in
            // since: run it again, as leaving it would have, rather than show
            // its answer to the room.
            this.catchUpFor = null;
            this.s.q[id] = { status: 'idle', openedAt: 0, endsAt: null, closedAt: 0, answers: {} };
            this.enter(id);
          }
          this.changed(true);
        }, 2500),
      );
      return;
    }
    this.scheduleClose(id);
  }

  // ---- presenter controls --------------------------------------------------

  // The one hotkey. Armed -> start the clock. Open -> stop it and reveal.
  // On the final leaderboard each press uncovers a place: third, second, first.
  advance() {
    const id = this.s.cur;
    const cfg = this.cfg(id);
    if (cfg?.kind === 'leaderboard' && cfg.final) {
      if ((this.s.podium || 0) < this.podiumSize()) {
        this.s.podium = (this.s.podium || 0) + 1;
        this.changed(true);
      }
      return;
    }
    if (!cfg || cfg.kind !== 'question') return;
    const q = this.qstate(id);
    const t = this.now();
    // A put-in-order round with a right order: after the room's order, T shows
    // the right one, and what each phone won.
    if (q.status === 'closed' && cfg.type === 'rank' && scores(cfg)) {
      if (!q.orderShown) {
        q.orderShown = true;
        this.changed(true);
      }
      return;
    }
    if (q.status === 'armed' || q.status === 'idle') this.open(id);
    else if (q.status === 'open') {
      // A second press straight after the first (from the notes window, with
      // nothing on it to show the first one worked) would end a question that
      // has only just started. It is ignored.
      if (t - q.openedAt < TIMING.doublePressMs) return;
      if (q.endsAt && q.endsAt <= t) this.close(id); // already at the buzzer: reveal now
      else {
        // Ends the clock rather than closing outright, the same way the buzzer
        // does: phones lock in what they have chosen, and answers already on
        // their way still land.
        q.endsAt = t;
        this.scheduleClose(id);
      }
    }
    this.changed(true);
  }

  // Throws away a question's answers and runs it again. On the final
  // leaderboard it covers the podium again, for a rehearsal.
  rerun(id = this.s.cur) {
    const cfg = this.cfg(id);
    if (cfg?.kind === 'leaderboard' && cfg.final && id === this.s.cur) {
      this.s.podium = 0;
      this.changed(true);
      return;
    }
    if (!cfg || cfg.kind !== 'question') return;
    if (id === this.s.cur) this.clearQTimers();
    this.s.q[id] = { status: 'idle', openedAt: 0, endsAt: null, closedAt: 0, answers: {} };
    if (id === this.s.cur) this.enter(id);
    this.changed(true);
  }

  // ---- messages from phones ------------------------------------------------

  receive(event, p) {
    if (!this.started || !p || typeof p !== 'object') return;
    if (typeof p.pid !== 'string' || !PID.test(p.pid)) return;
    if (event === EV.HELLO) {
      this.upsertPlayer(p.pid, p.name);
      this.changed();
    } else if (event === EV.ANSWER) {
      this.upsertPlayer(p.pid, p.name);
      this.accept(p);
      this.changed();
    }
  }

  upsertPlayer(pid, rawName) {
    const s = this.s;
    const t = this.now();
    const have = s.players[pid];
    const name = cleanName(rawName);
    if (!name) {
      if (have) have.seenAt = t;
      return have || null;
    }
    if (have) {
      have.seenAt = t;
      if (have.raw !== name) {
        have.raw = name;
        have.name = this.uniqueName(name, pid);
      }
      return have;
    }
    if (Object.keys(s.players).length >= LIMITS.players) return null;
    s.players[pid] = { name: this.uniqueName(name, pid), raw: name, joinedAt: t, seenAt: t };
    return s.players[pid];
  }

  // Two Sams become "Sam" and "Sam 2", so the leaderboard can tell them apart.
  uniqueName(name, pid) {
    const taken = new Set();
    for (const [id, p] of Object.entries(this.s.players)) if (id !== pid) taken.add(p.name.toLowerCase());
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; n < 99; n++) {
      const candidate = `${name.slice(0, LIMITS.name - 3)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  accept(p) {
    const s = this.s;
    const id = s.cur;
    if (!id || p.q !== id) return false;
    const cfg = this.cfg(id);
    const q = s.q[id];
    if (!cfg || cfg.kind !== 'question' || !q || q.status !== 'open') return false;
    if (!s.players[p.pid]) return false;
    const t = this.now();
    if (q.endsAt && t > q.endsAt + TIMING.graceMs && this.catchUpFor !== id) return false;
    if (q.answers[p.pid]) return false; // first answer stands
    const limit = cfg.seconds > 0 ? cfg.seconds * 1000 : Infinity;
    // How long it took: as the phone timed it, from the moment the question
    // appeared on it to the tap, where it says. Timed here instead, the network
    // both ways is counted too, and a remote player loses every speed tie to
    // someone in the room. Never more than this end measured.
    const here = Math.max(0, t - q.openedAt);
    const told = Number.isFinite(p.t) && p.t >= 0 ? Math.round(p.t) : here;
    const ms = Math.min(limit, here, told);
    if (cfg.type === 'num') {
      const n = cleanNumber(p.n, cfg);
      if (n === null) return false;
      q.answers[p.pid] = { n, ms };
    } else if (cfg.type === 'rank') {
      // A phone's order: the items, first to last.
      const c = cleanRanking(p.c, cfg.options.length);
      if (!c) return false;
      q.answers[p.pid] = { c, ms };
    } else if (isChoice(cfg.type)) {
      // One pick, or a list of them where several answers are right.
      const c = cfg.multi ? cleanChoice(p.c, cfg.options.length) : Math.round(+p.c);
      if (cfg.multi ? !c : !Number.isFinite(c) || c < 0 || c >= cfg.options.length) return false;
      q.answers[p.pid] = { c, ms };
    } else if (cfg.type === 'open') {
      // An open answer: a sentence, shown as a card of its own.
      const w = cleanOpen(p.w);
      if (!w || !/[\p{L}\p{N}]/u.test(w)) return false;
      q.answers[p.pid] = { w, ms };
    } else if (cfg.type === 'text') {
      // A typed answer: a line, longer than a word cloud's word.
      const w = cleanTyped(p.w);
      if (!w || !answerKey(w)) return false;
      q.answers[p.pid] = { w, ms };
    } else {
      const w = cleanWord(p.w);
      if (!w || !wordKey(w)) return false;
      q.answers[p.pid] = { w, ms };
    }
    return true;
  }

  // An open answer's card taken off the big screen by the presenter. It stays
  // hidden for the rest of the session, and the phone that sent it is not told.
  hideCard(id, pid) {
    const cfg = this.cfg(id);
    const q = this.s.q[id];
    if (!cfg || cfg.type !== 'open' || !q?.answers[pid]) return;
    (q.hidden ||= {})[pid] = true;
    this.changed(true);
  }

  // ---- derived views -------------------------------------------------------

  counts(id) {
    const cfg = this.cfg(id);
    const q = this.s.q[id];
    const out = new Array(cfg?.options?.length || 0).fill(0);
    if (q) for (const a of Object.values(q.answers)) for (const c of [].concat(a.c)) if (Number.isInteger(c) && c < out.length) out[c]++;
    return out;
  }

  words(id) {
    const q = this.s.q[id];
    const map = new Map();
    if (q) {
      for (const a of Object.values(q.answers)) {
        if (!a.w) continue;
        const k = wordKey(a.w);
        const have = map.get(k);
        if (have) have.n++;
        else map.set(k, { w: a.w, n: 1 });
      }
    }
    return [...map.values()].sort((a, b) => b.n - a.n || a.w.localeCompare(b.w));
  }

  // Score is points: one for each right answer, or more where the question is
  // worth more. Ties go to whoever was quicker across the questions they got right. Worked out fresh each time from the answers and
  // the deck, so correcting an answer key corrects the scores.
  // `only` set to 'rank' counts the put-in-order rounds alone: who ordered best.
  leaderboard(only = null) {
    const s = this.s;
    const tally = new Map();
    for (const pid of Object.keys(s.players)) tally.set(pid, { score: 0, ms: 0 });
    for (const [id, q] of Object.entries(s.q)) {
      if (q.status !== 'closed') continue;
      const cfg = this.cfg(id);
      if (!cfg || cfg.kind !== 'question' || !scores(cfg)) continue;
      if (only && cfg.type !== only) continue;
      for (const [pid, points] of this.awards(cfg, q)) {
        const row = tally.get(pid);
        if (row) {
          row.score += points;
          row.ms += q.answers[pid].ms;
        }
      }
    }
    const rows = [...tally.entries()].map(([pid, r]) => ({ pid, name: s.players[pid].name, joinedAt: s.players[pid].joinedAt, ...r }));
    rows.sort((a, b) => b.score - a.score || a.ms - b.ms || a.joinedAt - b.joinedAt);
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    return rows;
  }

  // How many rounds of one type have finished with answers and points to give.
  // A board of the put-in-order rounds alone has nothing to rank before one has, and
  // says so rather than show a column of noughts.
  played(type) {
    let n = 0;
    for (const [id, q] of Object.entries(this.s.q)) {
      const cfg = this.cfg(id);
      if (q.status === 'closed' && Object.keys(q.answers).length && cfg?.kind === 'question' && cfg.type === type && scores(cfg)) n++;
    }
    return n;
  }

  // What each player won on one finished question: player -> points.
  awards(cfg, q) {
    const won = new Map();
    const worth = cfg.points || 1;
    if (cfg.type === 'rank') {
      // A point for each item placed exactly where the right order has it.
      for (const [pid, a] of Object.entries(q.answers)) {
        const hits = orderHits(a.c, cfg.rightOrder);
        if (hits) won.set(pid, hits * worth);
      }
      return won;
    }
    if (cfg.type === 'text') {
      // An answer typed near enough to one of the accepted answers wins.
      for (const [pid, a] of Object.entries(q.answers)) if (isAccepted(a.w, cfg.accepts)) won.set(pid, worth);
      return won;
    }
    if (cfg.type === 'num') {
      // The closest three distances win 3, 2 and 1, times what the question is worth.
      for (const [pid, points] of nearest(Object.entries(q.answers).map(([pid, a]) => [pid, a.n]), cfg.answer)) won.set(pid, points * worth);
      return won;
    }
    for (const [pid, a] of Object.entries(q.answers)) if (sameChoice(a.c, rightAnswers(cfg))) won.set(pid, worth);
    return won;
  }

  // The quickest answer that won points on any question finished since a
  // given moment: the leaderboard's "fastest finger".
  fastestSince(since) {
    const s = this.s;
    let best = null;
    for (const [id, q] of Object.entries(s.q)) {
      if (q.status !== 'closed' || q.closedAt <= since) continue;
      const cfg = this.cfg(id);
      if (!cfg || cfg.kind !== 'question' || !isScored(cfg.type)) continue;
      for (const pid of this.awards(cfg, q).keys()) {
        const ms = q.answers[pid].ms;
        if (s.players[pid] && (!best || ms < best.ms)) best = { pid, name: s.players[pid].name, ms };
      }
    }
    return best;
  }

  phase() {
    const id = this.s.cur;
    const cfg = this.cfg(id);
    if (!cfg) return 'idle';
    if (cfg.kind === 'join') return 'join';
    if (cfg.kind === 'leaderboard') return 'leaderboard';
    const q = this.s.q[id];
    if (!q || q.status === 'idle' || q.status === 'armed') return 'armed';
    if (q.status === 'closed') return 'reveal';
    return q.endsAt && this.now() >= q.endsAt ? 'locking' : 'open';
  }

  // Everything the big screen needs to draw the current slide.
  view() {
    const s = this.s;
    const id = s.cur;
    const cfg = this.cfg(id);
    const players = Object.values(s.players).sort((a, b) => a.joinedAt - b.joinedAt);
    const base = {
      room: s.room,
      sid: s.sid,
      link: this.link,
      slideId: id,
      kind: cfg?.kind || 'none',
      phase: this.phase(),
      cfg,
      theme: themeFor(this.deck, cfg),
      playerCount: players.length,
      names: players.map((p) => p.name),
    };
    if (!cfg) return base;
    if (cfg.kind === 'leaderboard') {
      const size = this.podiumSize();
      return {
        ...base,
        board: this.leaderboard(cfg.only),
        played: cfg.only ? this.played(cfg.only) : null,
        before: s.boardFrom || null, // pid -> [rank, score] when a leaderboard was last up
        fastest: cfg.only ? null : this.fastestSince(s.boardFromAt || 0),
        podium: cfg.final ? { size, shown: Math.min(size, s.podium || 0) } : null,
      };
    }
    if (cfg.kind !== 'question') return base;
    const q = this.qstate(id);
    const reveal = base.phase === 'reveal';
    return {
      ...base,
      openedAt: q.openedAt,
      endsAt: q.endsAt,
      answered: Object.keys(q.answers).length,
      counts: isChoice(cfg.type) ? this.counts(id) : [],
      words: cfg.type === 'cloud' ? this.words(id) : [],
      correct: reveal && isScored(cfg.type) ? shown(cfg) : null,
      ...(cfg.type === 'num' ? this.numberView(cfg, q, reveal) : {}),
      ...(cfg.type === 'text' ? this.typedView(cfg, q, reveal) : {}),
      ...(cfg.type === 'open' ? { cards: reveal || cfg.live === 'tally' ? this.cards(cfg, q) : [] } : {}),
      ...(cfg.type === 'rank' ? { verdict: reveal || cfg.live === 'tally' ? { ...this.verdict(cfg, q), rightOrder: reveal && q.orderShown ? cfg.rightOrder : null } : null } : {}),
    };
  }

  // The room's order: each item's total and place. Kept back until the reveal
  // unless the slide is set to show it live.
  verdict(cfg, q) {
    return combineOrders(Object.entries(q.answers).filter(([pid]) => this.s.players[pid]).map(([, a]) => a.c), cfg.options.length);
  }

  // Open answers, for the big screen, in the order they came in: rude words
  // masked, hidden cards left out, a name only where the slide asks for one.
  cards(cfg, q) {
    return Object.entries(q.answers)
      .filter(([pid, a]) => a.w && this.s.players[pid] && !q.hidden?.[pid])
      .sort((a, b) => a[1].ms - b[1].ms || a[0].localeCompare(b[0]))
      .map(([pid, a]) => ({ pid, w: maskRude(a.w), ...(cfg.byline ? { by: this.s.players[pid].name } : {}) }));
  }

  // Type the answer, for the big screen. What was typed is kept back until the
  // reveal (a right answer on the screen would give it away); then it comes
  // grouped, most typed first, each group marked right or not.
  typedView(cfg, q, reveal) {
    if (!reveal) return { typed: [], gotIt: null };
    const groups = new Map();
    for (const [pid, a] of Object.entries(q.answers)) {
      if (!this.s.players[pid]) continue;
      const k = answerKey(a.w);
      const g = groups.get(k) || { w: a.w, n: 0, ok: isAccepted(a.w, cfg.accepts) };
      g.n++;
      groups.set(k, g);
    }
    const typed = [...groups.values()].sort((a, b) => b.ok - a.ok || b.n - a.n || a.w.localeCompare(b.w));
    return { typed, gotIt: typed.reduce((t, g) => t + (g.ok ? g.n : 0), 0) };
  }

  // Guess the number, for the big screen. The guesses are kept back while the
  // question is open (unless it is set to show them live), so nobody is steered
  // by the crowd; the answer and who was closest come only with the reveal.
  numberView(cfg, q, reveal) {
    const s = this.s;
    const entries = Object.entries(q.answers).filter(([pid]) => s.players[pid]);
    if (!reveal) return { guesses: cfg.live === 'tally' ? entries.map(([, a]) => ({ n: a.n })) : [], answer: null, closest: [], correct: null };
    const won = this.awards(cfg, q);
    const guesses = entries.map(([pid, a]) => ({ n: a.n, points: won.get(pid) || 0 }));
    const closest = entries.filter(([pid]) => won.has(pid)).map(([pid, a]) => ({ name: s.players[pid].name, n: a.n, points: won.get(pid), ms: a.ms })).sort((a, b) => b.points - a.points || a.ms - b.ms);
    return { guesses, answer: cfg.answer, closest, correct: null };
  }

  // What goes over the air. Never carries the right answer before the reveal.
  snapshot() {
    const s = this.s;
    const id = s.cur;
    const cfg = this.cfg(id);
    const phase = this.phase();
    const th = themeFor(this.deck, cfg);
    const snap = {
      v: PROTOCOL,
      room: s.room,
      sid: s.sid,
      seq: ++this.seq,
      now: this.now(),
      n: Object.keys(s.players).length,
      ps: Object.keys(s.players), // a phone not listed here knows to say hello again
      ph: phase,
      th: { font: th.font, text: th.text, accent: th.accent, card: th.card, cardText: th.cardText, good: th.correct, upper: !!th.uppercase, edge: th.edge, bg: th.paper },
    };
    if (cfg?.kind === 'question') {
      const q = this.qstate(id);
      snap.q = { id, at: q.openedAt, type: cfg.type, text: cfg.text, opts: cfg.options, dur: cfg.seconds * 1000, ends: q.endsAt };
      // What a put-in-order round calls its right order, for the phone's result.
      if (cfg.type === 'rank') snap.q.right = answerHeading(cfg);
      if (scores(cfg) && cfg.points > 1) snap.q.pts = cfg.points;
      if (cfg.multi) snap.q.multi = true; // phones let several be picked, then locked in
      if (cfg.type === 'num') Object.assign(snap.q, { min: cfg.min, max: cfg.max, step: cfg.step, unit: cfg.unit }); // the slider's range; never the answer
      snap.ans = Object.keys(q.answers);
      if (phase === 'reveal') {
        if (isChoice(cfg.type)) {
          const pick = {};
          for (const [pid, a] of Object.entries(q.answers)) pick[pid] = a.c;
          snap.rv = { correct: isScored(cfg.type) ? shown(cfg) : null, counts: this.counts(id), pick };
        }
        if (cfg.type === 'rank') {
          const pick = {};
          for (const [pid, a] of Object.entries(q.answers)) pick[pid] = a.c;
          const v = this.verdict(cfg, q);
          snap.rv = { totals: v.totals, places: v.places, cards: v.cards, pick };
          // The right order and what each phone won, once T has shown them.
          if (q.orderShown && scores(cfg)) Object.assign(snap.rv, { rightOrder: cfg.rightOrder, won: Object.fromEntries(this.awards(cfg, q)) });
        }
        if (cfg.type === 'open') snap.rv = { pick: Object.fromEntries(Object.entries(q.answers).map(([pid, a]) => [pid, a.w])) };
        if (cfg.type === 'text') {
          const pick = {};
          for (const [pid, a] of Object.entries(q.answers)) pick[pid] = a.w;
          snap.rv = { answer: shown(cfg), pick, won: Object.fromEntries(this.awards(cfg, q)) };
        }
        if (cfg.type === 'num') {
          const pick = {};
          for (const [pid, a] of Object.entries(q.answers)) pick[pid] = a.n;
          snap.rv = { answer: cfg.answer, pick, won: Object.fromEntries(this.awards(cfg, q)) };
        }
        if (isScored(cfg.type) || (cfg.type === 'rank' && scores(cfg) && q.orderShown)) snap.lb = this.ranks();
      }
    } else if (cfg?.kind === 'leaderboard') {
      // While the final podium is still covered on the big screen, phones are
      // told nothing: a phone must not name the winner before the room sees it.
      const covered = !!cfg.final && (s.podium || 0) < this.podiumSize();
      const board = covered ? [] : this.leaderboard(cfg.only);
      snap.lb = {};
      for (const r of board) snap.lb[r.pid] = [r.rank, r.score];
      snap.top = board.slice(0, 3).map((r) => [r.name, r.score]);
      snap.final = !!cfg.final;
      if (covered) snap.hold = true;
    }
    return snap;
  }

  ranks() {
    const out = {};
    for (const r of this.leaderboard()) out[r.pid] = [r.rank, r.score];
    return out;
  }

  // ---- plumbing ------------------------------------------------------------

  emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('[tally] listener failed', e);
      }
    }
  }

  // `urgent` is for the moments the room must see together: a slide change,
  // the buzzer, the reveal. Everything else (receipts for answers and hellos)
  // waits its turn so the relay is never flooded.
  changed(urgent = false) {
    if (!this.s) return;
    this.s.at = this.now();
    try {
      this.store.save(this.s);
    } catch (e) {
      console.error('[tally] save failed', e);
    }
    this.emit();
    this.broadcast(urgent);
  }

  // Sends a snapshot now, or as soon as the throttle allows.
  broadcast(force) {
    if (!this.started) return;
    const t = this.now();
    const wait = force ? 0 : Math.max(0, this.lastSent + TIMING.throttleMs - t);
    if (wait === 0) {
      this.timers.clear(this.sendTimer);
      this.sendTimer = null;
      this.lastSent = t;
      this.transport.send(EV.STATE, this.snapshot());
      this.beat();
      return;
    }
    if (this.sendTimer) return;
    this.sendTimer = this.timers.set(() => {
      this.sendTimer = null;
      this.broadcast(true);
    }, wait);
  }

  // The heartbeat only fills silence: any send pushes the next beat back.
  beat() {
    this.timers.clear(this.beatTimer);
    if (!this.started) return;
    this.beatTimer = this.timers.set(() => this.broadcast(true), TIMING.heartbeatMs);
  }
}
