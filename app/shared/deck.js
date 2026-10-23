// The deck config: which slides are Tally slides, what they ask, how they look.
// Authored in the side panel, read by the stage. Plain JSON, so it can be
// exported from the extension and imported into the PDF fallback unchanged.

import { LIMITS, QTYPES, cleanChoice, cleanRanking, ownsOptions, cleanTyped, answerKey } from './protocol.js';

export const DECK_VERSION = 1;

// Defaults are Pop Quiz's own look (BRAND.md): ink on white cards, Slide Amber
// for the accent and the right answer, ink outlines with a hard shadow (`edge`),
// and cream behind the phones (`paper`). The type is Bricolage Grotesque
// (shared/fonts.js), which ships with the extension, so it works inside Slides
// with no network.
export const DEFAULT_THEME = {
  font: 'Bricolage Grotesque',
  text: '#1a1a1a',
  accent: '#f9ab00',
  card: '#ffffff',
  cardText: '#1a1a1a',
  correct: '#f9ab00',
  edge: '#1a1a1a', // outline and hard shadow on cards; 'none' for none
  paper: '#fff6dc', // behind the phones
  ground: 'transparent', // behind the whole module
  radius: 14, // option corners, in thousandths of the module width
  uppercase: false,
  weight: 800,
};
export const FONT_CHOICES = [
  'Bricolage Grotesque',
  'Figtree',
  'Helvetica Neue',
  'Arial',
  'Georgia',
  'Impact',
  'Courier New',
  'system-ui',
];

export const DISPLAYS = ['bars', 'pie', 'table', 'numbers', 'pins'];
// What a question's top row is made of, each of which a slide may do without.
export const HIDEABLE = ['join', 'count', 'clock'];

// Where a module sits when no placeholder shape has been picked: the lower
// two-thirds of the slide, inside comfortable margins.
export const DEFAULT_PLACE = { x: 0.06, y: 0.34, w: 0.88, h: 0.58 };
export const FULL_PLACE = { x: 0.04, y: 0.05, w: 0.92, h: 0.9 };

export function emptyDeck(presentationId = '') {
  return { v: DECK_VERSION, presentationId, title: '', theme: { ...DEFAULT_THEME }, joinBase: '', showJoin: true, slides: {} };
}

export function newSlide(kind, patch = {}) {
  if (kind === 'join') {
    return { kind, index: 0, place: { ...FULL_PLACE }, headline: 'Join the quiz', style: {}, ...patch };
  }
  if (kind === 'leaderboard') {
    return { kind, index: 0, place: { ...FULL_PLACE }, title: 'Leaderboard', top: 5, final: false, style: {}, ...patch };
  }
  return {
    kind: 'question',
    index: 0,
    place: { ...DEFAULT_PLACE },
    type: 'mc',
    text: '',
    options: ['', '', '', ''],
    correct: 0,
    seconds: 20,
    display: 'bars',
    showText: false, // the slide itself usually carries the question
    live: 'count', // while voting: 'count' (n answered) or 'tally' (live split)
    // 'auto' starts on arrival, which needs nothing explained; 'key' waits for T
    // (in More options), for a presenter who wants to talk first.
    start: 'auto',
    // Shapes on the slide that change with the reveal: `show` are hidden until
    // the answer is shown (the photo that gives it away), `hide` leave at it.
    reveal: { show: [], hide: [] },
    style: {},
    ...patch,
  };
}

// Guess the number: the range a phone's slider runs over, its step, the right
// answer and the unit it is shown with. Always a sane range with the answer in it.
function normaliseNumber(raw) {
  const or = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : fallback);
  let min = or(raw.min, 0);
  let max = or(raw.max, 100);
  if (max <= min) max = min + 100;
  // The range stretches to hold the answer; the answer itself is never moved.
  const answer = or(raw.answer, min);
  min = Math.min(min, answer);
  max = Math.max(max, answer);
  let step = or(raw.step, 1);
  if (!(step > 0) || step > max - min) step = 1;
  const unit = String(raw.unit ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, LIMITS.unit);
  return { min, max, step, answer, unit };
}

// What a choice question would lose by being made something else: its options
// as typed, which was right, and where they were pinned. Null unless something
// was really typed (blank options, or a true/false's own two, are nothing to keep).
function spareOf(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.options)) return null;
  const options = o.options.slice(0, LIMITS.options).map((x) => String(x ?? '').slice(0, LIMITS.optionText));
  if (!options.some((x) => x.trim()) || options.join() === 'True,False') return null;
  const inRange = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < options.length;
  const out = { options, correct: inRange(o.correct) ? o.correct : 0 };
  if (o.multi && Array.isArray(o.corrects) && o.corrects.some(inRange)) Object.assign(out, { multi: true, corrects: o.corrects.filter(inRange) });
  if (Array.isArray(o.pins) && o.pins.some(Boolean)) out.pins = options.map((_, i) => normalisePin(o.pins[i]));
  return out;
}

function normalisePin(p) {
  if (!p || typeof p !== 'object' || typeof p.shapeId !== 'string' || !p.shapeId) return null;
  const part = (v, least = 0) => Math.min(1, Math.max(least, +v || 0));
  return { shapeId: p.shapeId.slice(0, 80), x: part(p.x), y: part(p.y), w: part(p.w, 0.02), h: part(p.h, 0.02) };
}

function cleanIds(list, not) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((id) => typeof id === 'string' && id && id !== not))].slice(0, 12);
}

const clamp01 = (n, d) => (Number.isFinite(+n) ? Math.min(1, Math.max(0, +n)) : d);

export function normalisePlace(p, fallback = DEFAULT_PLACE) {
  const o = p && typeof p === 'object' ? p : {};
  const out = {
    x: clamp01(o.x, fallback.x),
    y: clamp01(o.y, fallback.y),
    w: clamp01(o.w, fallback.w),
    h: clamp01(o.h, fallback.h),
  };
  if (out.w < 0.05) out.w = fallback.w;
  if (out.h < 0.05) out.h = fallback.h;
  if (typeof o.shapeId === 'string' && o.shapeId) out.shapeId = o.shapeId;
  return out;
}

// Makes any stored or imported slide config safe to run. Never throws: a
// malformed slide degrades to something harmless rather than stopping a talk.
export function normaliseSlide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'join') {
    const s = newSlide('join');
    return {
      ...s,
      index: +raw.index || 0,
      place: normalisePlace(raw.place, FULL_PLACE),
      headline: String(raw.headline ?? s.headline).slice(0, 80),
      style: cleanStyle(raw.style),
    };
  }
  if (raw.kind === 'leaderboard') {
    const s = newSlide('leaderboard');
    return {
      ...s,
      index: +raw.index || 0,
      place: normalisePlace(raw.place, FULL_PLACE),
      title: String(raw.title ?? s.title).slice(0, 60),
      top: Math.min(25, Math.max(1, Math.round(+raw.top) || s.top)),
      final: !!raw.final,
      // Counting only the put-in-order rounds, for naming who ordered best. Kept only when so.
      ...(raw.only === 'rank' ? { only: 'rank' } : {}),
      style: cleanStyle(raw.style),
    };
  }
  if (raw.kind !== 'question') return null;
  const s = newSlide('question');
  const type = QTYPES.includes(raw.type) ? raw.type : 'mc';
  // Options typed for a choice or a poll are not lost by trying the question as
  // something else. Made a true/false, a word cloud or a number, it keeps them
  // (with which was right, and where they were pinned) in `spare`; made a choice
  // or a poll again with nothing typed, it gets them back.
  const ownOptions = ownsOptions(type);
  const typed = spareOf(raw);
  const kept = spareOf(raw.spare);
  const spare = ownOptions ? null : typed || kept;
  const src = ownOptions && !typed && kept ? { ...raw, multi: undefined, corrects: undefined, pins: undefined, ...kept } : raw;
  let options = Array.isArray(src.options) ? src.options.map((o) => String(o ?? '').slice(0, LIMITS.optionText)) : s.options;
  if (type === 'tf') options = ['True', 'False'];
  if (type === 'cloud' || type === 'num' || type === 'text' || type === 'open') options = [];
  options = options.slice(0, LIMITS.options);
  let correct = Math.round(+src.correct);
  if (!Number.isFinite(correct) || correct < 0 || correct >= options.length) correct = 0;
  // Several right answers, on a choice question only. Kept, like points, only
  // when it is so. `correct` then holds the first of them, so a copy of Tally
  // from before this still has one right answer to show.
  const multi = type === 'mc' && !!src.multi;
  // One that points at an option since removed is dropped; the rest stand.
  const listed = multi && Array.isArray(src.corrects) ? src.corrects.filter((n) => typeof n === 'number' && Math.round(n) >= 0 && Math.round(n) < options.length) : [];
  const corrects = multi ? cleanChoice(listed, options.length) || [correct] : null;
  if (multi) correct = corrects[0];
  const seconds = Math.min(600, Math.max(0, Math.round(+raw.seconds) || 0));
  // Parts of the module's top row switched off for this slide: the join line,
  // the count of answers, the clock. Kept only where something is.
  const hidden = HIDEABLE.filter((k) => raw.hide && typeof raw.hide === 'object' && raw.hide[k] === true);
  // Votes shown on the slide itself: for each option, the shape its votes rise
  // over and where that shape was last seen (for hosts that cannot see shapes).
  // Kept only where an option has one.
  const pins = Array.isArray(src.pins) ? options.map((_, i) => normalisePin(src.pins[i])) : [];
  // What a right answer is worth. Kept only when it is more than one, so a deck
  // with no such question is the same deck to a copy of Tally from before this.
  const points = Math.min(LIMITS.points, Math.max(1, Math.round(+raw.points) || 1));
  // A put-in-order round's right order, first to last. Kept only where entered.
  // A deck from Tally calls it `judges`, and is read the same.
  const rightOrder = type === 'rank' ? cleanRanking(raw.rightOrder ?? raw.judges, options.length) : null;
  // What the slide calls a put-in-order round's two results ("The office", "The
  // experts"). Kept only where typed; otherwise "The room" and "The right order".
  const names = type === 'rank' ? cleanNames(raw.names) : null;
  // Type the answer: the answers that count, the first being the one shown at
  // the reveal. Kept, even empty, on that type only.
  const accepts = type === 'text' ? cleanAccepts(raw.accepts) : null;
  // An open answer's cards carry who wrote them only when asked to.
  const byline = type === 'open' && raw.byline === true;
  return {
    ...s,
    index: +raw.index || 0,
    place: normalisePlace(raw.place, DEFAULT_PLACE),
    type,
    text: String(raw.text ?? '').slice(0, LIMITS.questionText),
    options,
    correct,
    ...(multi ? { multi: true, corrects } : {}),
    ...(hidden.length ? { hide: Object.fromEntries(hidden.map((k) => [k, true])) } : {}),
    ...(type === 'num' ? normaliseNumber(raw) : {}),
    ...(pins.some(Boolean) ? { pins } : {}),
    ...(spare ? { spare } : {}),
    ...(points > 1 ? { points } : {}),
    ...(rightOrder ? { rightOrder } : {}),
    ...(names ? { names } : {}),
    ...(accepts ? { accepts } : {}),
    ...(byline ? { byline } : {}),
    seconds: raw.seconds === undefined ? s.seconds : seconds,
    display: DISPLAYS.includes(raw.display) ? raw.display : 'bars',
    showText: !!raw.showText,
    live: raw.live === 'tally' ? 'tally' : 'count',
    start: raw.start === 'key' ? 'key' : 'auto',
    reveal: (() => {
      const place = normalisePlace(raw.place, DEFAULT_PLACE);
      const show = cleanIds(raw.reveal?.show, place.shapeId);
      return { show, hide: cleanIds(raw.reveal?.hide, place.shapeId).filter((id) => !show.includes(id)) };
    })(),
    style: cleanStyle(raw.style),
  };
}

// Accepted answers off a file or the panel: one line each, none the same answer
// twice (by how they are matched), at most eight. A blank one is kept, as the
// panel's row waiting to be typed in; it matches nothing.
function cleanAccepts(raw) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const t = cleanTyped(v);
    const k = answerKey(t);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(k ? t : '');
    if (out.length >= LIMITS.accepts) break;
  }
  return out;
}

export const NAME_LIMIT = 24;

function cleanNames(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const one = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
  const out = {};
  if (one(raw.room)) out.room = one(raw.room);
  // Tally called the second result `judges`.
  if (one(raw.answer ?? raw.judges)) out.answer = one(raw.answer ?? raw.judges);
  return Object.keys(out).length ? out : null;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function cleanStyle(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['text', 'accent', 'card', 'cardText', 'correct']) {
    if (typeof raw[k] === 'string' && HEX.test(raw[k])) out[k] = raw[k];
  }
  if (typeof raw.ground === 'string' && (raw.ground === 'transparent' || HEX.test(raw.ground))) out.ground = raw.ground;
  if (typeof raw.edge === 'string' && (raw.edge === 'none' || HEX.test(raw.edge))) out.edge = raw.edge;
  if (typeof raw.paper === 'string' && HEX.test(raw.paper)) out.paper = raw.paper;
  // Mona Sans came with the agency's deck and no longer ships: a deck still
  // naming it takes the standard type.
  if (typeof raw.font === 'string' && raw.font.trim() && raw.font.trim() !== 'Mona Sans') out.font = raw.font.replace(/["';{}<>]/g, '').trim().slice(0, 60);
  if (Number.isFinite(+raw.radius) && raw.radius !== '' && raw.radius !== null) out.radius = Math.min(60, Math.max(0, +raw.radius));
  if (typeof raw.uppercase === 'boolean') out.uppercase = raw.uppercase;
  if (Number.isFinite(+raw.weight) && raw.weight) out.weight = Math.min(900, Math.max(300, Math.round(+raw.weight / 100) * 100));
  return out;
}

export function normaliseDeck(raw, presentationId = '') {
  const d = emptyDeck(presentationId);
  if (!raw || typeof raw !== 'object') return d;
  d.presentationId = String(raw.presentationId || presentationId || '');
  d.title = String(raw.title || '').slice(0, 120);
  d.theme = { ...DEFAULT_THEME, ...cleanStyle(raw.theme) };
  d.joinBase = typeof raw.joinBase === 'string' ? raw.joinBase.trim().slice(0, 200) : '';
  d.showJoin = raw.showJoin !== false; // a small "join at ... code ..." line on question slides
  if (raw.slides && typeof raw.slides === 'object') {
    for (const [id, slide] of Object.entries(raw.slides)) {
      const n = normaliseSlide(slide);
      if (n) d.slides[id] = n;
    }
  }
  return d;
}

// Theme for one slide: the deck theme with that slide's overrides on top.
// How light a colour is, 0 to 1, as contrast is measured (WCAG).
function luminance(hex) {
  const rgb = channels(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// A hex colour's red, green and blue, 0 to 1. Three, six or eight digits (the
// last two, transparency, are ignored); null for anything else.
function channels(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) return null;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

// A colour for words on a ground: the colour itself where it reads (3:1, the
// bar for large type), otherwise the text colour. Amber headings on cream
// would not read; on a dark ground they would.
export function readableOn(colour, ground, fallback) {
  const [a, b] = [luminance(colour), luminance(ground)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05) >= 3 ? colour : fallback;
}

// How far apart two colours are for reading, as WCAG's contrast ratio (1 to 21).
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Readable text on a colour: ink or white, whichever stands out more from it.
export function textOn(hex) {
  if (!channels(hex)) return '#ffffff';
  return contrast('#1a1a1a', hex) >= contrast('#ffffff', hex) ? '#1a1a1a' : '#ffffff';
}

export function themeFor(deck, slide) {
  return { ...DEFAULT_THEME, ...(deck?.theme || {}), ...(slide?.style || {}) };
}

export function joinUrl(base, room) {
  const b = String(base || '').trim();
  if (!b) return '';
  const sep = b.includes('?') ? '&' : '?';
  return `${b}${sep}r=${room}`;
}

// For the fallback player, which knows page numbers and not Google's slide ids.
export function slideIdForIndex(deck, index) {
  for (const [id, s] of Object.entries(deck?.slides || {})) if (s.index === index) return id;
  return null;
}
