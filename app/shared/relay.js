// The one place a connection to the relay is made. Stage, phone page, pretend
// players and the live tests all ask here, so switching relays is a change to
// config.js and nothing else.
//
//   makeTransport()                          a phone, on the configured relay
//   makeTransport({ presenter: true })       the presenter's stage
//   makeTransport({ local: true })           BroadcastChannel, no network
//   makeTransport({ kind, url })             a test choosing the relay itself

import { RealtimeClient } from '../vendor/realtime.js';
import { RELAY, RELAY_KIND, CF_RELAY_URL } from './config.js';
import { RelayTransport, CloudflareTransport, LocalTransport } from './transport.js';

export function makeTransport({ presenter = false, local = false, kind = RELAY_KIND, url = CF_RELAY_URL, trouble = null } = {}) {
  let t;
  if (local) t = new LocalTransport();
  else if ((kind || RELAY_KIND) === 'cloudflare' && (url || CF_RELAY_URL)) t = new CloudflareTransport({ url: url || CF_RELAY_URL, presenter });
  else if (RELAY) t = new RelayTransport({ RealtimeClient, url: RELAY.url, key: RELAY.key, presenter });
  else throw new Error('No relay configured: set CF_RELAY_URL (or RELAY for Supabase) in shared/config.js');
  if (trouble && !local) t.trouble = trouble;
  return t;
}
