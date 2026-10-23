// The relay's rules, kept apart from the Worker so the unit tests can run them
// in plain Node (test/relay.test.mjs) without Cloudflare's runtime.
//
// Room codes come from the same file the presenter makes them with, so the
// relay can never disagree with the app about what a room is.

import { CODE_ALPHABET, LIMITS } from '../../app/shared/protocol.js';

export const RULES = {
  // Phones are counted against the game's own cap. The presenter's sockets are
  // counted separately, so a full room can never lock its own presenter out.
  phones: LIMITS.players,
  presenters: 4,
  // A phone's messages are small (an open answer is 140 characters), so 16 KB
  // is generous. The presenter's are not: an open-answer reveal carries every
  // phone's card, measured at 19 KB for 100 phones and 28 KB for 150, and up
  // to three times that if every card is in a script that takes three bytes a
  // letter. Capped at 16 KB, the reveal would never reach a big room.
  phoneBytes: 16 * 1024,
  presenterBytes: 128 * 1024,
  // Token buckets. A phone repeats a hello or an unconfirmed answer every 1.4 s
  // (TIMING.retryMs), so it sends one or two a second at its busiest; four a
  // second sustained, twenty in a burst, is double that with room to spare.
  // The presenter's sends do not grow with the room (receipts are batched,
  // TIMING.throttleMs), but a phase change is sent at once, so it gets more.
  phoneRate: { burst: 20, perSecond: 4 },
  presenterRate: { burst: 60, perSecond: 15 },
  // A socket that keeps sending after its bucket is dry is not a phone having
  // a bad moment, so after this many dropped messages it is shut.
  strikes: 200,
  // A socket that has sent nothing, not even a ping, for this long is taken
  // for dead when a newcomer needs its place. Phones ping every 10 s.
  quietMs: 25000,
  eventChars: 32,
};

const CODE = new RegExp(`^[${CODE_ALPHABET}]{4}$`);

// A room as the presenter made it: four of the consonants, in any case. The
// app's normaliseRoom is looser (it strips anything that is not a letter, for
// a code typed by a person), but nothing reaches the relay except a code the
// app has already tidied, so anything else is a scanner and is turned away.
export function roomFromPath(pathname) {
  const m = /^\/room\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  const room = m[1].toUpperCase();
  return CODE.test(room) ? room : null;
}

// ALLOWED_ORIGINS is a comma-separated list, each entry an exact origin or a
// pattern with `*` standing for anything ("chrome-extension://*",
// "http://192.168.*"). A lone `*` lets everything in, for wrangler dev.
//
// An Origin header is a speed bump, not a lock: it stops another website's
// page from using the relay, but anything that is not a browser can send
// whatever Origin it likes. A request with no Origin at all is not a browser,
// so outside dev it is turned away.
export function originAllowed(origin, list) {
  const entries = String(list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.includes('*')) return true;
  if (!origin) return false;
  return entries.some((e) => (e.includes('*') ? wildcard(e).test(origin) : e === origin));
}

function wildcard(pattern) {
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

// One bucket per socket. Lives in memory only: if the room hibernates, every
// bucket starts full again when it wakes, which costs nothing, because a room
// only hibernates when nobody is sending.
export class Bucket {
  constructor({ burst, perSecond }, now = Date.now()) {
    this.burst = burst;
    this.perMs = perSecond / 1000;
    this.tokens = burst;
    this.at = now;
    this.dropped = 0;
  }

  take(now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.at) * this.perMs);
    this.at = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.dropped = 0;
      return true;
    }
    this.dropped++;
    return false;
  }
}

// A message off the wire, checked: a JSON object with a short event name.
// Returns why it was refused, or null if it may go on. The relay forwards the
// text exactly as it came, so this is a check, not a rewrite.
export function refuse(text, maxBytes) {
  if (typeof text !== 'string') return 'not text';
  // Length counts UTF-16 units; UTF-8 can be up to three bytes for each, so
  // the exact (and dearer) count is only made when it could matter.
  if (text.length > maxBytes) return 'too big';
  if (text.length * 3 > maxBytes && new TextEncoder().encode(text).length > maxBytes) return 'too big';
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'not an object';
  if (typeof msg.event !== 'string' || !msg.event || msg.event.length > RULES.eventChars) return 'no event';
  return null;
}

// Who hears a message. The presenter is the only one that listens to phones
// (the engine reads hellos and answers; a phone reads nothing but snapshots),
// so with route 'presenter' a phone's message goes to the presenter alone.
// That turns a room's traffic from every phone hearing every other phone,
// which grows with the square of the room, into a straight line. Route 'all'
// is the plain broadcast the Supabase relay gives, kept as a switch.
export function audience(from, role, everyone, presenters, route) {
  const pool = role === 'phone' && route === 'presenter' ? presenters : everyone;
  return pool.filter((ws) => ws !== from);
}
