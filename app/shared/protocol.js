// The wire contract between the presenter (source of truth) and the phones.
//
// One broadcast channel per room. The presenter sends full snapshots, so a
// phone that missed anything is put right by the very next message. Phones
// send three small events and repeat them until a snapshot confirms receipt.

export const PROTOCOL = 1;

export const EV = {
  STATE: 'state', // presenter -> phones: the whole visible state
  HELLO: 'hello', // phone -> presenter: I am here (or back); send me a snapshot
  ANSWER: 'answer', // phone -> presenter: my answer to the open question
};

// The relay throttles a project that talks too much (seen in load tests when
// two runs overlapped), so traffic is kept lean: one snapshot per phase change,
// answers acknowledged in batches, and a slow heartbeat to fill silence.
export const TIMING = {
  heartbeatMs: 2000, // presenter repeats the snapshot after this much silence
  throttleMs: 600, // minimum gap between routine snapshots (answer receipts)
  graceMs: 1200, // answers landing this long after the buzzer still count (remote phones are a few hundred ms behind)
  doublePressMs: 1500, // a T that ends a question this soon after it opened is taken as a double press
  retryMs: 1400, // phone repeats an unconfirmed answer this often
  awayMs: 5000, // phone treats the presenter as gone after this silence
  firstSnapMs: 3500, // a fresh connection that hears nothing this long is rebuilt
  echoMs: 6500, // presenter rebuilds its link if it stops hearing itself
  staleSessionMs: 12 * 60 * 60 * 1000, // a session older than this starts fresh
};

export const LIMITS = { name: 18, word: 22, typed: 40, open: 140, accepts: 8, options: 12, optionText: 600, questionText: 600, points: 10, unit: 12, players: 150 };
// An option's letter, wherever it is shown: on the slide, the phones and the panel.
export const LETTERS = 'ABCDEFGHIJKL';

// Consonants only, so a room code can never spell anything.
export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export function makeRoomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export function normaliseRoom(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

// Every channel is prefixed `tally-` so it can never collide with the channels
// of the game that shares this relay.
export function channelName(room) {
  return 'tally-' + normaliseRoom(room).toLowerCase();
}

export function makeId(rand = Math.random) {
  let s = '';
  while (s.length < 10) s += Math.floor(rand() * 36).toString(36);
  return s;
}

export function cleanName(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.name);
}

export function cleanWord(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.word);
}

// Word-cloud entries that differ only by case or trailing punctuation count
// as the same word.
export function wordKey(s) {
  return cleanWord(s).toLowerCase().replace(/[.,!?;:'"]+$/g, '').replace(/^['"]+/g, '');
}

export const QTYPES = ['mc', 'tf', 'poll', 'cloud', 'num', 'rank', 'text', 'open'];
export const isScored = (type) => type === 'mc' || type === 'tf' || type === 'num' || type === 'text';
export const isChoice = (type) => type === 'mc' || type === 'tf' || type === 'poll';
// Type the answer. What a phone typed, made safe: one line, at most 40 characters.
// An open answer: a sentence, shown on the slide as a card of its own.
export function cleanOpen(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.open);
}

// Open answers go up on a big screen, so the commonest swear words are masked
// before they get there: the first letter stays, the rest become dots. A
// safety catch, not a filter; the presenter can also hide any card outright.
const RUDE = ['fuck', 'fucking', 'fucker', 'fucked', 'shit', 'shitty', 'bullshit', 'cunt', 'bitch', 'bastard', 'dick', 'dickhead', 'cock', 'prick', 'twat', 'wanker', 'arsehole', 'asshole', 'arse', 'piss', 'pissed', 'slut', 'whore', 'motherfucker', 'bollocks', 'tosser'];
const RUDE_RE = new RegExp(`\\b(${RUDE.join('|')})\\b`, 'gi');
export function maskRude(s) {
  return String(s ?? '').replace(RUDE_RE, (w) => w[0] + '•'.repeat(w.length - 1));
}

export function cleanTyped(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.typed);
}

// Two typed answers are the same answer once case, accents, punctuation,
// spaces and a leading "the", "a" or "an" are set aside: "The Beatles",
// "beatles" and "Beatles!" all match.
export function answerKey(s) {
  return cleanTyped(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/\s+/g, '');
}

// How many slips a typed answer may have and still count, by the length of the
// accepted answer: none for short words and numbers (Iran is not Iraq, 1969 is
// not 1968), one for most words, two for long ones. Australia allows one, so
// Austria, two away, does not count.
export const slipsAllowed = (key) => (/^\d+$/.test(key) || key.length < 5 ? 0 : key.length <= 10 ? 1 : 2);

// Letters added, dropped, changed or swapped with a neighbour, counting each as
// one slip; gives up once past `cap`.
function slips(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      best = Math.min(best, d[i][j]);
    }
    if (best > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

// Whether a typed answer is one of the accepted answers, near enough.
export function isAccepted(typed, accepts) {
  const k = answerKey(typed);
  if (!k) return false;
  return (accepts || []).some((a) => {
    const r = answerKey(a);
    if (!r) return false;
    const cap = slipsAllowed(r);
    return k === r || (cap > 0 && slips(k, r, cap) <= cap);
  });
}

// A question whose options are typed in the panel: a choice, a poll, or a put-in-order round.
export const ownsOptions = (type) => type === 'mc' || type === 'poll' || type === 'rank';
// Whether a slide's answers win points. A put-in-order round does only when its
// right order has been entered: then a phone wins a point for every item it
// placed exactly where the right order has it.
export const scores = (cfg) => isScored(cfg?.type) || (cfg?.type === 'rank' && Array.isArray(cfg.rightOrder) && cfg.rightOrder.length > 0);
export const orderHits = (order, right) => (Array.isArray(order) && Array.isArray(right) ? right.filter((c, at) => order[at] === c).length : 0);

// A choice question may have more than one right answer. Its settings then
// carry `multi` and list them in `corrects`; a phone sends its answer as a list,
// and it is right only if it picks exactly those, no more and no fewer.
export const rightAnswers = (cfg) => (cfg.multi && cfg.corrects?.length ? cfg.corrects : [cfg.correct]);
export const sameChoice = (a, b) => {
  const x = [].concat(a);
  const y = [].concat(b);
  return x.length === y.length && x.every((i) => y.includes(i));
};
// A list of picks off the wire or out of a file, made safe: whole numbers,
// each a real option, none twice, in order. Null if there is nothing left.
export function cleanChoice(value, count) {
  const list = (Array.isArray(value) ? value : [value]).map((n) => (typeof n === 'number' ? Math.round(n) : NaN));
  const kept = [...new Set(list.filter((n) => Number.isFinite(n) && n >= 0 && n < count))].sort((a, b) => a - b);
  return kept.length && kept.length === new Set(list).size ? kept : null;
}

// Put in order. Each phone sends its order, first to last: the list of options
// in the order tapped. Made safe here: whole numbers, each a real option, none
// twice, the order kept. Null if it is empty, or anything in it is not an option.
export function cleanRanking(value, count) {
  if (!Array.isArray(value)) return null;
  const list = value.map((n) => (typeof n === 'number' ? Math.round(n) : NaN));
  const kept = [...new Set(list.filter((n) => Number.isFinite(n) && n >= 0 && n < count))];
  return kept.length && kept.length === list.length ? kept : null;
}

// The room's order: every phone places the items 1st, 2nd, 3rd and so on, each
// item's places are added up, and the lowest total comes first (the same as
// ordering by average place). An order that stops short gives the items it left
// out the places that were left, shared evenly, so it weighs the same as a full
// one. Equal totals share a place. Totals are whole numbers or halves.
export function combineOrders(cards, count) {
  const totals = new Array(count).fill(0);
  let n = 0;
  for (const card of cards) {
    const order = cleanRanking(card, count);
    if (!order) continue;
    n++;
    const shared = order.length < count ? (order.length + 1 + count) / 2 : 0;
    for (let i = 0; i < count; i++) totals[i] += shared;
    order.forEach((c, p) => {
      totals[c] += p + 1 - shared;
    });
  }
  const sorted = totals.map((_, i) => i).sort((a, b) => totals[a] - totals[b] || a - b);
  const places = new Array(count).fill(1);
  sorted.forEach((c, k) => {
    places[c] = k > 0 && totals[c] === totals[sorted[k - 1]] ? places[sorted[k - 1]] : k + 1;
  });
  return { totals, places, cards: n };
}

export const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};
export const showTotal = (t) => (Number.isInteger(t) ? String(t) : t.toFixed(1));

// A put-in-order round's two results, as the slide names them: the room's, then
// the right order. Either can be renamed on the slide ("The office", "The experts").
export const RESULT_NAMES = { room: 'The room', answer: 'The right order' };
export const resultName = (cfg, who) => cfg?.names?.[who] || RESULT_NAMES[who];
// "The room’s", "The experts’".
export const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);
// The headings at the reveal: "The room’s order", then "The right order", or,
// renamed, "The office’s order" and "The experts’ order".
export const roomHeading = (cfg) => `${possessive(resultName(cfg, 'room'))} order`;
export const answerHeading = (cfg) => (cfg?.names?.answer ? `${possessive(cfg.names.answer)} order` : RESULT_NAMES.answer);
// Where the room put an item, under its right place: "room 2nd", "office 2nd".
export const underName = (name) => name.replace(/^the\s+/i, '');

// A put-in-order round shown on the slide: each item has a label that says its
// place, put by hand wherever that item is on the slide (dragged in the
// editor), as a share of the slide. A label not yet moved waits in a row along
// the bottom. One pinned to a shape (as before labels could be dragged) keeps
// the place it was last seen at.
// A label put by hand is saved as a pin on a shape of this name, which no slide
// has: a copy of Tally from before labels keeps a pin it cannot find where it
// was last seen, so it keeps these too, rather than dropping them and saving.
export const TAG_SHAPE = 'tally-tag';
export function tagRect(cfg, i) {
  const p = cfg.pins?.[i];
  if (p && [p.x, p.y, p.w, p.h].every(Number.isFinite) && p.w > 0 && p.h > 0) return { x: p.x, y: p.y, w: p.w, h: p.h };
  const n = Math.max(1, cfg.options.length);
  const w = Math.min(0.13, 0.9 / n - 0.01);
  const h = Math.min(0.13, w * 1.4);
  const step = n > 1 ? (0.9 - w) / (n - 1) : 0;
  return { x: n > 1 ? 0.05 + i * step : 0.5 - w / 2, y: 0.82 - h, w, h };
}

// Guess the number. Everyone slides to a number; the closest guess wins three
// points, the next closest two, the next one. People the same distance out
// share a place, so two who are equally close both take the three.
export const NEAREST = [3, 2, 1];

// A guess off the wire or off a slider, made safe for a question's range: a
// real number, inside it, on one of its steps. Null if it is not a number.
export function cleanNumber(value, { min, max, step }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const snapped = min + Math.round((Math.min(max, Math.max(min, value)) - min) / step) * step;
  return +Math.min(max, snapped).toFixed(6);
}

// Who won what: [player, guess] pairs in, player -> 3, 2 or 1 out.
export function nearest(guesses, answer) {
  const off = (n) => +Math.abs(n - answer).toFixed(6);
  const places = [...new Set(guesses.map(([, n]) => off(n)))].sort((a, b) => a - b).slice(0, NEAREST.length);
  const won = new Map();
  for (const [pid, n] of guesses) {
    const place = places.indexOf(off(n));
    if (place >= 0) won.set(pid, NEAREST[place]);
  }
  return won;
}

// A number as it is shown: no trailing noise, and its unit after it.
export const showNumber = (n, unit = '') => `${+(+n).toFixed(4)}${unit ? ` ${unit}` : ''}`;

// How a question worth more than one point is announced, on the slide and on phones.
export const worthLabel = (points) => (points === 2 ? 'Double points' : points === 3 ? 'Triple points' : `${points}× points`);
export const pointsWord = (n) => (n === 1 ? 'point' : 'points');
