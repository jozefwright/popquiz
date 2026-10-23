// Sharing a deck's quiz between devices.
//
// Each Chrome profile keeps its own working copy of a deck's quiz, and that
// copy is always the one in use: nothing here is ever waited on. Alongside it
// there is one shared copy per deck, filed under the deck's own id, which
// every device pulls when the deck is opened and pushes to after a change.
//
// The rule when two copies disagree is deliberately simple, because one
// person uses this: whichever was changed more recently wins, and the loser
// is kept so nothing is ever silently thrown away.
//
// This file is the decision only. It does no network and no storage, so it
// can be tested on its own. background.js does the fetching.

// A fingerprint of a deck's content. Key order must not matter, or two copies
// of the same quiz saved by different code paths would look different.
// Housekeeping is left out: each slide's number, which Tally keeps in step with
// the filmstrip, and the deck's title, which it copies from the page. Neither
// is an edit to the quiz. Counted as one, a laptop holding an old copy that had
// merely noticed a slide move would look freshly edited, and win a conflict
// against newer work from another device.
export function fingerprint(deck) {
  const d = deck || {};
  const content = { ...d, title: undefined, slides: d.slides && typeof d.slides === 'object' ? Object.fromEntries(Object.entries(d.slides).map(([id, s]) => [id, s && typeof s === 'object' ? { ...s, index: undefined } : s])) : d.slides };
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
  };
  const text = stable(content);
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `${text.length.toString(36)}-${a.toString(36)}-${b.toString(36)}`;
}

export const hasQuiz = (deck) => !!deck?.slides && Object.keys(deck.slides).length > 0;

// The number of the quiz format this copy reads and writes. RAISE IT whenever a
// slide gains a setting that a copy from before would not know: a copy that
// reads a quiz drops what it does not know, and if it then saved, the setting
// would be gone from every device. (That happened on 14 Oct 2026: a copy from
// before double points turned a Number question into an empty Choice.) The
// sharing service keeps the highest number that has saved each quiz and refuses
// a save from any copy below it; see shared/shelf.js.
//   1  to 9 Oct 2026    choice, true/false, poll, words
//   2  0.2.0, 14 Oct    points, several right answers, number, pins, the top row, kept answers
//   3  0.3.0            the first to say its number when it saves
//   4  0.3.1, 15 Oct    up to 12 options (a copy before this keeps only the first 6), and ranking rounds
//   5  0.3.2, 16 Oct    a ranking round's right order, and a leaderboard of those rounds only
//   6  0.4.0, 20 Oct    Pop Quiz: the right order saved as `rightOrder` and its name as
//                       `names.answer` (Tally's `judges`, still read)
// Not raised for 0.3.4's place labels, saved as pins a copy from before keeps,
// nor for 0.3.5's names for a ranking round's two results: a copy from before
// drops the names and the slide falls back to its own, losing nothing scored.
export const SCHEMA = 6;

// What to do, given:
//   local   this profile's deck (may have no slides)
//   state   what this profile remembers of the last sync:
//           { rev, mark, dirtyAt }  rev = the shared copy's revision then,
//           mark = the local fingerprint then, dirtyAt = when local first
//           changed after that (0 if it has not)
//   remote  the shared copy as just fetched: { rev, updatedAt, deck } or null
//
// Returns { do, keep? } where do is:
//   'nothing'  the two agree, or there is nothing anywhere
//   'push'     send local up
//   'adopt'    take the shared copy; `keep` is the local copy being replaced,
//              if it held changes of its own
//   'outdated' the shared copy was saved by a newer Tally than this one. This
//              copy would drop what it does not know, so it neither takes it
//              nor sends anything, and says it needs updating
export function decide({ local, state, remote }) {
  const mark = fingerprint(local);
  const s = state || {};
  const localChanged = mark !== s.mark; // since the last sync
  if (!remote) return hasQuiz(local) ? { do: 'push' } : { do: 'nothing' };
  if ((remote.schema || 0) > SCHEMA) return { do: 'outdated' };
  const remoteChanged = remote.rev !== s.rev; // since the last sync
  if (fingerprint(remote.deck) === mark) return { do: 'nothing', settle: true };
  if (!remoteChanged) return localChanged ? { do: 'push' } : { do: 'nothing' };
  // The shared copy has moved on.
  if (!localChanged || !hasQuiz(local)) return { do: 'adopt' };
  // Both changed. The more recent edit wins; the other is kept aside.
  const localAt = s.dirtyAt || 0;
  return localAt > (remote.updatedAt || 0) ? { do: 'push', overwrote: remote.deck } : { do: 'adopt', keep: local };
}

export const DECK_ID = /^[A-Za-z0-9_-]{20,90}$/;
export const MAX_BYTES = 256 * 1024;
