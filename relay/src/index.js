// Pop Quiz's own relay: a Cloudflare Worker in front of one Durable Object per
// room. It does what Supabase Realtime broadcast did for us and nothing more:
// every message a socket sends goes to the others in its room, as it came.
// Quiz state still lives in the presenter's browser; the relay stores nothing.
//
//   wss://<relay>/room/<ROOM>                  a phone
//   wss://<relay>/room/<ROOM>?role=presenter   the presenter's stage
//
// Each room's sockets are held with the WebSocket Hibernation API, so a room
// that goes quiet (a presenter talking over an ordinary slide for a while)
// stops costing anything while every socket stays open. A literal "ping" is
// answered "pong" by Cloudflare itself without waking the room: that is the
// liveness check the presenter used to get from hearing its own broadcasts.

import { DurableObject } from 'cloudflare:workers';
import { RULES, roomFromPath, originAllowed, Bucket, refuse, audience } from './rules.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('Pop Quiz relay\n', { headers: { 'content-type': 'text/plain' } });
    if (!url.pathname.startsWith('/room/')) return new Response('Not found\n', { status: 404 });
    const room = roomFromPath(url.pathname);
    if (!room) return new Response('No such room\n', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket\n', { status: 426 });
    // Checked here, before the room is touched, so a refused page costs one
    // Worker request and no Durable Object at all.
    if (!originAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) return new Response('Origin not allowed\n', { status: 403 });
    // New connections per address per minute. Generous, because a whole office
    // shares one address and joins at once; it only stops a flood. The limit
    // is Cloudflare's own, counted at the edge, so it costs no room either.
    if (env.JOINS) {
      const { success } = await env.JOINS.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!success) return new Response('Too many connections, slow down\n', { status: 429, headers: { 'Retry-After': '30' } });
    }
    // One object per room, named by its code: everyone who asks for KXTR,
    // anywhere, reaches the same object. It is made near whoever asks first,
    // which is almost always the presenter.
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
    return stub.fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.route = env.ROUTE === 'all' ? 'all' : 'presenter';
    // Answered by the runtime, not by this code, and not billed.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // In memory only. A room that hibernates loses these and starts them
    // afresh, which is harmless: it only hibernates when nobody is sending.
    this.buckets = new Map();
    this.heard = new Map();
    this.peak = 0;
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role') === 'presenter' ? 'presenter' : 'phone';
    const now = Date.now();
    const same = this.ctx.getWebSockets(role);
    const cap = role === 'presenter' ? RULES.presenters : RULES.phones;
    const room = same.length - (same.length >= cap ? this.evictQuiet(same, now, same.length - cap + 1) : 0);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (room >= cap) {
      // Accepted only to be closed with a reason the client can read: a
      // refused upgrade reaches a browser as a bare error, and a full room is
      // worth saying so, so the phone can wait longer before trying again.
      // The standard accept(), not the hibernating one, because only it
      // finishes the close: a hibernating socket closed from here, outside
      // its own events, sends the close frame but (under wrangler dev at
      // least) never ends the connection, so the client never hears 'close'.
      // It keeps the room awake only for the instant it is open.
      server.accept();
      server.close(4003, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const firstPresenter = role === 'presenter' && this.ctx.getWebSockets('presenter').length === 0;
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, at: now });
    this.count(role, firstPresenter);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, text) {
    const now = Date.now();
    this.heard.set(ws, now);
    const { role } = ws.deserializeAttachment() || { role: 'phone' };
    let bucket = this.buckets.get(ws);
    if (!bucket) this.buckets.set(ws, (bucket = new Bucket(role === 'presenter' ? RULES.presenterRate : RULES.phoneRate, now)));
    if (!bucket.take(now)) {
      // Dropped, not queued: every message in this protocol is repeated by
      // its sender until it is confirmed, so a dropped one is sent again.
      if (bucket.dropped >= RULES.strikes) ws.close(1008, 'too many messages');
      return;
    }
    const why = refuse(text, role === 'presenter' ? RULES.presenterBytes : RULES.phoneBytes);
    if (why === 'too big') return ws.close(1009, 'message too big');
    if (why) return;
    for (const peer of audience(ws, role, [...this.ctx.getWebSockets('presenter'), ...this.ctx.getWebSockets('phone')], this.ctx.getWebSockets('presenter'), this.route)) {
      try {
        peer.send(text);
      } catch {
        // A peer mid-close. It will be gone from the list next time.
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    this.forget(ws);
    // From compatibility date 2026-04-07 the runtime answers the close frame
    // itself; closing here as well is harmless and keeps older dates right.
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    this.forget(ws);
  }

  forget(ws) {
    this.buckets.delete(ws);
    this.heard.delete(ws);
  }

  // When a room is at its cap, sockets that have said nothing for a while
  // (not a message, not a ping) are taken for phones that went to sleep or
  // walked out of range, and closed to make room. Without this, a room that
  // had 150 phones through it over a long day could fill with ghosts. (If a
  // ghost wakes, it has the close frame but, under wrangler dev, never the
  // end of the connection; the client treats a closing socket as gone.)
  evictQuiet(sockets, now, want) {
    let gone = 0;
    for (const ws of sockets) {
      if (gone >= want) break;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
      const last = Math.max(ws.deserializeAttachment()?.at || 0, pinged, this.heard.get(ws) || 0);
      if (now - last < RULES.quietMs) continue;
      try {
        ws.close(4001, 'gone quiet');
      } catch {}
      this.forget(ws);
      gone++;
    }
    return gone;
  }

  // TODO(counting): anonymous numbers for Jozef, with nothing stored and
  // nothing that names a room or a person. Two are worth having: games
  // started (a presenter arriving in an empty room) and peak phones in a
  // room. The cheapest home is Workers Analytics Engine, which is a write-only
  // counter on Cloudflare's side, not storage of ours: add a binding named
  // STATS in wrangler.toml and this starts writing. Until then it does
  // nothing. `peak` lives in memory, so a room that hibernates and wakes
  // starts its peak again; good enough for a rough count.
  count(role, firstPresenter) {
    const phones = this.ctx.getWebSockets('phone').length;
    const rose = phones > this.peak;
    if (rose) this.peak = phones;
    if (!this.env.STATS) return;
    if (firstPresenter) this.env.STATS.writeDataPoint({ blobs: ['game'], doubles: [1] });
    else if (role === 'phone' && rose && phones % 10 === 0) this.env.STATS.writeDataPoint({ blobs: ['peak'], doubles: [phones] });
  }
}
