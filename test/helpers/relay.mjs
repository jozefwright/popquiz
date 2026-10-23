// The live tests' connection to a relay: whatever config.js says, unless the
// environment names one.
//
//   POPQUIZ_RELAY=cloudflare POPQUIZ_RELAY_URL=ws://127.0.0.1:8787 node test/sim-live.mjs 25
import { makeTransport } from '../../app/shared/relay.js';

const kind = process.env.POPQUIZ_RELAY || undefined;
const url = process.env.POPQUIZ_RELAY_URL || undefined;
if (kind === 'cloudflare' && !url) throw new Error('POPQUIZ_RELAY=cloudflare needs POPQUIZ_RELAY_URL (ws://127.0.0.1:8787 for wrangler dev)');

// The Cloudflare relay turns away a socket with no Origin, which is what Node's
// WebSocket opens, so test sockets say they come from a laptop's local server
// (one of the relay's allowed origins).
if (typeof process !== 'undefined' && globalThis.WebSocket && !globalThis.WebSocket.popquizOrigin) {
  const Native = globalThis.WebSocket;
  globalThis.WebSocket = class extends Native {
    static popquizOrigin = true;
    constructor(address, protocols) {
      super(address, { protocols, headers: { Origin: 'http://localhost:8790' } });
    }
  };
}

export const relayName =kind === 'cloudflare' ? `cloudflare at ${url}` : 'the configured relay';
export const liveTransport = (opts = {}) => makeTransport({ kind, url, ...opts });
