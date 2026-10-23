// What the sharing service does with each deck's quiz, with no storage in it.
//
// The real service (api/deck.js, a Vercel Function over a Blob store) and the
// local stand-in (scripts/serve.mjs, over files) both call these, so the two
// cannot drift, and the rules can be tested on their own.
//
// Two rules were added after 14 Oct 2026, when a copy of Tally from before
// several settings existed read a quiz, dropped what it did not know and saved
// over the shared copy:
//
//   1. A copy that is out of date cannot save. Every save says the number of
//      the quiz format it writes (SCHEMA in sync.js). One that says nothing, or
//      a number below the highest that has saved this quiz, is refused.
//   2. Earlier versions are kept. The version a save replaces is set aside, at
//      most once every few minutes, so a bad save can be undone from the panel.

import { normaliseDeck } from './deck.js';
import { SCHEMA } from './sync.js';

// No copy below this may save at all. Copies from before 0.3.0 never said a
// number, and those are the ones that did the damage.
export const FLOOR = 3;
export const HISTORY_GAP = 5 * 60 * 1000; // an earlier version is kept at most this often
export const HISTORY_MAX = 60;

// What a device is given when it asks for a deck's quiz.
export const shown = (stored) => ({ rev: stored.rev, updatedAt: stored.updatedAt, schema: stored.schema || 0, deck: stored.deck });

// A save. `current` is what is stored now (or null), `body` what was sent.
// Returns the answer to give, and on success `next` to store and `keep`: the
// version being replaced, if it is time to set one aside (else null).
export function save({ id, current, body, now, rand = Math.random }) {
  if (!body?.deck || typeof body.deck !== 'object') return { status: 400, body: { error: 'no deck' } };
  const least = Math.max(FLOOR, current?.schema || 0);
  if (!Number.isInteger(body.client) || body.client < least) return { status: 426, body: { error: 'out of date', schema: least } };
  // The other way about: this service is older than the copy saving to it, and
  // would drop the newer settings itself. Better to say so than to save less.
  if (body.client > SCHEMA) return { status: 503, body: { error: 'the sharing service is behind this copy of Pop Quiz', schema: SCHEMA } };
  if (current && !body.force && body.baseRev !== current.rev) return { status: 409, body: shown(current) };
  const due = !!current && (body.keep === true || now - (current.historyAt || 0) >= HISTORY_GAP);
  const next = {
    rev: `${now.toString(36)}-${rand().toString(36).slice(2, 8)}`,
    updatedAt: now,
    schema: body.client,
    historyAt: due ? now : current?.historyAt || 0,
    deck: normaliseDeck({ ...body.deck, presentationId: id }, id), // stored in the cleaned-up form, whatever was sent
  };
  return { status: 200, body: { rev: next.rev, updatedAt: next.updatedAt }, next, keep: due ? { rev: current.rev, updatedAt: current.updatedAt, schema: current.schema || 0, deck: current.deck } : null };
}

// The earlier versions of one deck's quiz, newest first.
export function remember(history, version) {
  const versions = Array.isArray(history?.versions) ? history.versions : [];
  return { versions: [version, ...versions.filter((v) => v.rev !== version.rev)].slice(0, HISTORY_MAX) };
}

// What the panel lists: when each was saved and how much was in it, not the quizzes themselves.
export function listed(history) {
  return (Array.isArray(history?.versions) ? history.versions : []).map((v) => {
    const slides = Object.values(v.deck?.slides || {});
    return { rev: v.rev, updatedAt: v.updatedAt, slides: slides.length, questions: slides.filter((s) => s.kind === 'question').length };
  });
}

export const version = (history, rev) => (Array.isArray(history?.versions) ? history.versions : []).find((v) => v.rev === rev) || null;
