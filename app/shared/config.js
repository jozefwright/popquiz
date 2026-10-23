// Fixed wiring for Pop Quiz.
//
// The old stopgap relay (Supabase Realtime broadcast on another project) is
// retired: Pop Quiz runs on its own relay, relay/ in this repo, since 23
// October 2026. RELAY stays as the shape a Supabase relay would take, empty,
// so a fork that wants one can fill it in.
export const RELAY = null; // { url: 'wss://<project>.supabase.co/realtime/v1', key: '<publishable key>' }

// Where phones go to join: the phone page's public home, app/ served by
// Cloudflare (deploy/play). A deck can name a different address under
// Joining in the side panel's Quiz tab.
export const DEFAULT_JOIN_BASE = 'https://play.popquiz.fun/';

// Where each deck's shared copy lives, so the same quiz is there on every
// device that opens the deck (see shared/sync.js and api/deck.js).
// Off until Pop Quiz has a sharing service of its own: pointed at Tally's, a
// development copy could save over the quizzes Tally's own users rely on.
export const DEFAULT_SYNC_BASE = '';

// Which relay carries messages: 'cloudflare' (Pop Quiz's own, relay/ in this
// repo, live at relay.popquiz.fun) or 'supabase' (needs RELAY above).
// Everything that opens a connection goes through makeTransport() in
// shared/relay.js, so this one line moves the presenter, phones, pretend
// players and tests together.
export const RELAY_KIND = 'cloudflare';
export const CF_RELAY_URL = 'wss://relay.popquiz.fun';
