// A stand-in for the engine's view, with made-up players and votes, so a
// module can be drawn before any quiz has run. Used by the side panel's
// preview and by the preview drawn on the slide in the Slides editor.

import { isChoice, isScored, rightAnswers, nearest, cleanNumber, combineOrders } from '../shared/protocol.js';
import { themeFor } from '../shared/deck.js';

const NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Aroha', 'Tane', 'Priya', 'Liam'];
const BOARD = ['Aroha', 'Jordan', 'Alex', 'Tane', 'Priya', 'Liam', 'Mele', 'Riley', 'Hana', 'Oscar'];
const WORDS = [['Busy', 6], ['Good', 4], ['Tired', 3], ['Great', 2], ['Hectic', 2], ['Calm', 1], ['Fun', 1]];
const OPEN = [
  ['Finally fixed the coffee machine', 'Sam'],
  ['Shipped the new site on time!', 'Alex'],
  ['Friday drinks', 'Jordan'],
  ['My dog learned to open the fridge', 'Priya'],
  ['Nobody booked a meeting over lunch', 'Mo'],
  ['A whole week without a fire drill', 'Lee'],
];
const SPREAD = [9, 4, 7, 3, 2, 1];
// Made-up guesses for a number question: how far from the answer, as a share of the range.
const OFF = [-0.27, -0.2, -0.15, -0.11, -0.08, -0.06, -0.06, -0.04, -0.02, -0.02, 0.01, 0.01, 0.03, 0.05, 0.05, 0.08, 0.12, 0.18, 0.26];

// `phase` is 'voting' or 'reveal'. `now` fixes the clock, so a preview shows a
// countdown part-way through rather than one that runs out while you watch.
export function mockView(deck, cfg, { phase = 'voting', room = 'KXTR', slideId = null, now = Date.now() } = {}) {
  const base = { room, sid: 'preview', link: 'live', slideId, kind: cfg.kind, cfg, theme: themeFor(deck, cfg), playerCount: 24, names: NAMES };
  if (cfg.kind === 'join') return { ...base, phase: 'join' };
  if (cfg.kind === 'leaderboard') {
    return { ...base, phase: 'leaderboard', board: BOARD.map((name, i) => ({ pid: `p${i}`, name, score: Math.max(0, 9 - Math.ceil(i * 0.8)), ms: 0, rank: i + 1 })), played: cfg.only ? 1 : null, before: null, fastest: null, podium: cfg.final ? { size: 3, shown: 3 } : null };
  }
  const reveal = phase === 'reveal';
  if (cfg.type === 'num') {
    const said = OFF.map((f) => cleanNumber(cfg.answer + f * (cfg.max - cfg.min), cfg));
    const won = nearest(said.map((n, i) => [i, n]), cfg.answer);
    const worth = cfg.points || 1;
    return {
      ...base,
      phase: reveal ? 'reveal' : 'open',
      openedAt: now - 6000,
      endsAt: cfg.seconds > 0 ? now + cfg.seconds * 600 : null,
      answered: said.length,
      counts: [],
      words: [],
      correct: null,
      guesses: reveal ? said.map((n, i) => ({ n, points: (won.get(i) || 0) * worth })) : cfg.live === 'tally' ? said.map((n) => ({ n })) : [],
      answer: reveal ? cfg.answer : null,
      closest: reveal ? said.map((n, i) => ({ name: NAMES[i % NAMES.length], n, points: (won.get(i) || 0) * worth })).filter((w) => w.points).sort((a, b) => b.points - a.points) : [],
    };
  }
  if (cfg.type === 'rank') {
    // Made-up orders: most agree, each with one pair swapped.
    const n = cfg.options.length;
    const liked = cfg.options.map((_, i) => i).sort((a, b) => ((a * 5 + 1) % n) - ((b * 5 + 1) % n));
    const cards = Array.from({ length: 19 }, (_, k) => {
      const card = liked.slice();
      const at = k % Math.max(1, n - 1);
      [card[at], card[at + 1]] = [card[at + 1], card[at]];
      return card.filter((c) => c !== undefined);
    });
    return {
      ...base,
      phase: reveal ? 'reveal' : 'open',
      openedAt: now - 6000,
      endsAt: cfg.seconds > 0 ? now + cfg.seconds * 600 : null,
      answered: reveal ? 19 : 13,
      counts: [],
      words: [],
      correct: null,
      // Where a right order is set, the preview's Result shows it, to check it against.
      verdict: reveal || cfg.live === 'tally' ? { ...combineOrders(cards, n), rightOrder: reveal && cfg.rightOrder?.length ? cfg.rightOrder : null } : null,
    };
  }
  if (cfg.type === 'open') {
    // A handful of answers, long and short, as a room sends them.
    const cards = OPEN.map(([w, by], i) => ({ pid: `m${i}`, w, ...(cfg.byline ? { by } : {}) }));
    return {
      ...base,
      phase: reveal ? 'reveal' : 'open',
      openedAt: now - 6000,
      endsAt: cfg.seconds > 0 ? now + cfg.seconds * 600 : null,
      answered: reveal ? cards.length : 4,
      counts: [],
      words: [],
      correct: null,
      cards: reveal || cfg.live === 'tally' ? cards : [],
    };
  }
  if (cfg.type === 'text') {
    // Most got it, a couple guessed: the shape of a typical reveal.
    const answer = cfg.accepts?.find((a) => a.trim()) || null;
    const typed = [...(answer ? [{ w: answer, n: 14, ok: true }] : []), { w: 'No idea', n: 3, ok: false }, { w: 'Pass', n: 2, ok: false }];
    return {
      ...base,
      phase: reveal ? 'reveal' : 'open',
      openedAt: now - 6000,
      endsAt: cfg.seconds > 0 ? now + cfg.seconds * 600 : null,
      answered: reveal ? 19 : 13,
      counts: [],
      words: [],
      correct: reveal ? answer : null,
      typed: reveal ? typed : [],
      gotIt: reveal ? (answer ? 14 : 0) : null,
    };
  }
  const rights = isScored(cfg.type) ? rightAnswers(cfg) : [];
  const counts = isChoice(cfg.type) ? cfg.options.map((_, i) => (rights.includes(i) ? 11 : SPREAD[i % SPREAD.length])) : [];
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    ...base,
    phase: reveal ? 'reveal' : 'open',
    openedAt: now - 6000,
    endsAt: cfg.seconds > 0 ? now + cfg.seconds * 600 : null,
    answered: isChoice(cfg.type) ? (reveal ? total : Math.round(total * 0.7)) : 19,
    counts: reveal ? counts : counts.map((n) => Math.round(n * 0.7)),
    words: cfg.type === 'cloud' ? WORDS.map(([w, n]) => ({ w, n })) : [],
    correct: reveal && isScored(cfg.type) ? (cfg.multi ? rights : cfg.correct) : null,
  };
}
