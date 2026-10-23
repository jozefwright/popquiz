// Transports: how messages get between the presenter and the phones.
//
// RelayTransport rides Supabase Realtime broadcast (see config.js for the hard
// rule on that project). CloudflareTransport rides Pop Quiz's own relay
// (relay/ in this repo). LocalTransport uses a BroadcastChannel between tabs of
// one browser, for building and testing with no network. MemoryHub wires
// engines and fake phones together inside one process for the unit tests.
//
// All of them share one small shape:
//   open(room)  send(event, payload)  onMessage(fn)  onStatus(fn)  reset()  close()
// Status is 'connecting', 'live' or 'down'. Nothing outside this file should
// construct one: makeTransport() in relay.js picks the relay from config.js.

import { channelName, normaliseRoom, TIMING } from './protocol.js';

export class RelayTransport {
  // `presenter` turns on two checks that a phone does not need, because a
  // phone can simply watch for the presenter's heartbeat. The presenter has
  // nobody to watch, so it asks the relay to acknowledge every send and it
  // listens for its own messages coming back round. Either going quiet means
  // the link is dead in a way the socket has not noticed, and it is rebuilt.
  constructor({ RealtimeClient, url, key, presenter = false, echoMs = 6500 }) {
    this.RealtimeClient = RealtimeClient;
    this.url = url;
    this.key = key;
    this.confirm = presenter;
    this.echo = presenter;
    this.echoMs = echoMs;
    this.tag = Math.random().toString(36).slice(2, 10);
    this.lastEchoAt = 0;
    this.lastSendAt = 0;
    this.watch = null;
    this.client = null;
    this.channel = null;
    this.room = null;
    this.status = 'connecting';
    this.messageFns = [];
    this.statusFns = [];
    this.failures = 0;
    this.generation = 0;
    this.trouble = null; // set to a function to hear what the relay complains about
  }

  onMessage(fn) {
    this.messageFns.push(fn);
  }

  onStatus(fn) {
    this.statusFns.push(fn);
  }

  setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }

  open(room) {
    this.room = room;
    this.connect();
  }

  // Tears the socket down and builds a fresh one. The cure for a connection
  // that is truly dead, as on a phone waking from sleep.
  reset() {
    if (this.room) this.connect();
  }

  // Leaves the room and joins it again on the SAME socket. Tried first when a
  // connected phone stops hearing the presenter. Load tests showed that a
  // crowd of sockets closing and reopening together can leave the relay
  // unsettled for minutes; rejoining keeps the socket, so it adds no such churn.
  rejoin() {
    const client = this.client;
    const old = this.channel;
    if (!client || !old || !this.room) return this.reset();
    const gen = ++this.generation;
    this.setStatus('connecting');
    this.channel = null;
    // The old channel must be fully gone before a new one is made: asked for
    // the same room too soon, the client hands back the old one, still leaving,
    // and the rejoin hangs. (Seen in the soak test: six seconds lost.)
    Promise.resolve()
      .then(() => client.removeChannel(old))
      .catch(() => {})
      .then(() => {
        if (gen !== this.generation || this.client !== client) return;
        this.channel = this.subscribe(client, gen);
      });
  }

  connect() {
    const gen = ++this.generation;
    this.teardown();
    this.setStatus('connecting');
    this.failures = 0;
    const client = new this.RealtimeClient(this.url, { params: { apikey: this.key }, heartbeatIntervalMs: 10000 });
    this.client = client;
    this.channel = this.subscribe(client, gen);
    if (this.echo) {
      this.watch = setInterval(() => {
        if (gen !== this.generation || this.status !== 'live') return;
        const t = Date.now();
        const sendingLately = t - this.lastSendAt < this.echoMs;
        if (sendingLately && t - this.lastEchoAt > this.echoMs) {
          this.trouble?.('no echo: rebuilding the link');
          this.connect();
        }
      }, 1500);
    }
  }

  subscribe(client, gen) {
    const channel = client.channel(channelName(this.room), { config: { broadcast: { self: this.echo, ack: this.confirm } } });
    channel.on('broadcast', { event: '*' }, (msg) => {
      if (gen !== this.generation) return;
      if (this.echo && msg.payload?._o === this.tag) {
        this.lastEchoAt = Date.now();
        return;
      }
      for (const fn of this.messageFns) fn(msg.event, msg.payload);
    });
    channel.on('system', {}, (msg) => {
      if (gen === this.generation && msg?.status && msg.status !== 'ok') this.trouble?.(`system: ${msg.message || msg.status}`);
    });
    channel.subscribe((state, err) => {
      if (gen !== this.generation) return;
      if (state === 'SUBSCRIBED') {
        this.failures = 0;
        this.lastEchoAt = Date.now();
        this.setStatus('live');
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        this.trouble?.(`${state}${err?.message ? `: ${err.message}` : ''}`);
        this.setStatus('down');
      }
    });
    return channel;
  }

  teardown() {
    const { client, channel } = this;
    clearInterval(this.watch);
    this.watch = null;
    this.client = null;
    this.channel = null;
    try {
      channel?.unsubscribe();
    } catch {}
    try {
      client?.disconnect();
    } catch {}
  }

  send(event, payload) {
    const channel = this.channel;
    if (!channel || this.status !== 'live') return false;
    const gen = this.generation;
    this.lastSendAt = Date.now();
    let result;
    try {
      result = channel.send({ type: 'broadcast', event, payload: this.echo ? { ...payload, _o: this.tag } : payload });
    } catch {
      result = Promise.resolve('error');
    }
    if (this.confirm) {
      Promise.resolve(result)
        .catch(() => 'error')
        .then((r) => {
          if (gen !== this.generation) return;
          if (r === 'ok') {
            this.failures = 0;
          } else if (++this.failures >= 2) {
            this.trouble?.(`sends not acknowledged (${r}): rebuilding the link`);
            this.connect();
          }
        });
    }
    return true;
  }

  close() {
    this.generation++;
    this.teardown();
    this.room = null;
    this.setStatus('down');
  }
}

// Pop Quiz's own relay: one plain WebSocket per room, to a Cloudflare Durable
// Object that passes each message to the others in the room (relay/README.md).
// Same shape and statuses as RelayTransport, so the engine and the phones
// cannot tell them apart.
//
// Two things differ underneath, both for the better:
// - The relay never sends a socket its own messages, so the presenter's old
//   check (listen for yourself coming back) has nothing to listen to. Instead
//   every socket sends a literal "ping" and Cloudflare answers "pong" without
//   waking the room. Silence for longer than `deadMs` means the link is dead
//   in a way the socket has not noticed, and it is rebuilt. The presenter
//   pings briskly, because it has nobody else to watch; a phone has the
//   presenter's heartbeat as well, so it pings slowly.
// - A dropped socket is rebuilt here, with an uneven backoff. Supabase's
//   client did that for RelayTransport; a bare WebSocket does not, and a room
//   that lost the Wi-Fi together must not come back in the same instant
//   (docs/SLIDES.md, "What the relay taught us").
export class CloudflareTransport {
  constructor({ url, presenter = false, WebSocket: WS = globalThis.WebSocket, pingMs = presenter ? 2000 : 10000, deadMs = presenter ? TIMING.echoMs : 25000, rand = Math.random }) {
    this.base = String(url || '').replace(/\/+$/, '');
    this.presenter = presenter;
    this.WS = WS;
    this.pingMs = pingMs;
    this.deadMs = deadMs;
    this.rand = rand;
    this.ws = null;
    this.room = null;
    this.status = 'connecting';
    this.messageFns = [];
    this.statusFns = [];
    this.generation = 0;
    this.tries = 0; // reconnects since the link was last live
    this.lastHeardAt = 0;
    this.watch = null;
    this.retry = null;
    this.trouble = null; // set to a function to hear what the relay complains about
  }

  onMessage(fn) {
    this.messageFns.push(fn);
  }

  onStatus(fn) {
    this.statusFns.push(fn);
  }

  setStatus(s) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusFns) fn(s);
  }

  open(room) {
    this.room = normaliseRoom(room);
    this.tries = 0;
    this.connect();
  }

  // Tears the socket down and builds a fresh one, at once.
  reset() {
    if (!this.room) return;
    this.tries = 0;
    this.connect();
  }

  // RelayTransport could leave and rejoin a room on the same socket. Here a
  // socket is a room, so there is nothing gentler than a fresh one.
  rejoin() {
    this.reset();
  }

  connect() {
    const gen = ++this.generation;
    this.teardown();
    this.setStatus('connecting');
    let ws;
    try {
      ws = new this.WS(`${this.base}/room/${this.room}${this.presenter ? '?role=presenter' : ''}`);
    } catch (e) {
      this.trouble?.(`cannot open: ${e?.message || e}`);
      this.down(gen);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.tries = 0;
      this.lastHeardAt = Date.now();
      this.setStatus('live');
    };
    ws.onmessage = (e) => {
      if (gen !== this.generation) return;
      this.lastHeardAt = Date.now();
      if (e.data === 'pong') return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.event !== 'string') return;
      for (const fn of this.messageFns) fn(msg.event, msg.payload);
    };
    ws.onclose = (e) => {
      if (gen !== this.generation) return;
      this.trouble?.(`closed ${e.code}${e.reason ? `: ${e.reason}` : ''}`);
      this.down(gen, e.code === 4003 ? 10000 : 0);
    };
    ws.onerror = () => {
      // Always followed by a close, which does the work.
    };
    const began = Date.now();
    this.watch = setInterval(() => {
      if (gen !== this.generation) return;
      if (this.status === 'connecting' && Date.now() - began > 10000) {
        this.trouble?.('no answer from the relay');
        this.down(gen);
        return;
      }
      if (this.status !== 'live') return;
      // Closed by the relay, but the connection never finished closing (a
      // room making space for a newcomer does this), so no close event came.
      if (ws.readyState > 1) {
        this.trouble?.('closed by the relay');
        this.down(gen);
        return;
      }
      if (Date.now() - this.lastHeardAt > this.deadMs) {
        this.trouble?.('no pong: rebuilding the link');
        this.tries = 0;
        this.connect();
        return;
      }
      try {
        ws.send('ping');
      } catch {}
    }, this.pingMs);
  }

  // The link is gone: say so, and try again after an uneven wait that
  // stretches with each failure (1 s, 2 s, 4 s, 8 s, then 15 s, each between
  // three-quarters and one-and-a-third of that). `floor` is for a full room,
  // which will not have space again in a second.
  down(gen, floor = 0) {
    this.teardown();
    this.setStatus('down');
    if (!this.room) return;
    const wait = Math.max(floor, Math.min(15000, 1000 * 2 ** Math.min(this.tries, 4))) * (0.75 + this.rand() * 0.6);
    this.tries++;
    this.retry = setTimeout(() => {
      if (gen === this.generation && this.room) this.connect();
    }, wait);
  }

  teardown() {
    const ws = this.ws;
    clearInterval(this.watch);
    clearTimeout(this.retry);
    this.watch = null;
    this.retry = null;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000);
    } catch {}
  }

  send(event, payload) {
    const ws = this.ws;
    if (!ws || this.status !== 'live' || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ event, payload }));
    } catch {
      return false;
    }
    return true;
  }

  close() {
    this.generation++;
    this.teardown();
    this.room = null;
    this.setStatus('down');
  }
}

export class LocalTransport {
  constructor() {
    this.bc = null;
    this.status = 'connecting';
    this.messageFns = [];
    this.statusFns = [];
  }

  onMessage(fn) {
    this.messageFns.push(fn);
  }

  onStatus(fn) {
    this.statusFns.push(fn);
  }

  open(room) {
    this.bc?.close();
    this.bc = new BroadcastChannel(channelName(room));
    this.bc.onmessage = (e) => {
      for (const fn of this.messageFns) fn(e.data.event, e.data.payload);
    };
    this.status = 'live';
    queueMicrotask(() => {
      for (const fn of this.statusFns) fn('live');
    });
  }

  reset() {}

  send(event, payload) {
    if (!this.bc) return false;
    this.bc.postMessage({ event, payload });
    return true;
  }

  close() {
    this.bc?.close();
    this.bc = null;
  }
}

// In-process relay for tests. `drop` simulates a lossy link: return true from
// it to lose a message.
export class MemoryHub {
  constructor() {
    this.rooms = new Map();
    this.drop = null;
    this.sent = 0;
  }

  transport() {
    const hub = this;
    const t = {
      room: null,
      status: 'connecting',
      online: true,
      messageFns: [],
      statusFns: [],
      onMessage(fn) {
        t.messageFns.push(fn);
      },
      onStatus(fn) {
        t.statusFns.push(fn);
      },
      open(room) {
        t.close();
        t.room = channelName(room);
        if (!hub.rooms.has(t.room)) hub.rooms.set(t.room, new Set());
        hub.rooms.get(t.room).add(t);
        t.status = 'live';
        for (const fn of t.statusFns) fn('live');
      },
      reset() {},
      send(event, payload) {
        if (!t.room || !t.online) return false;
        hub.sent++;
        const wire = JSON.stringify(payload); // nothing shares memory across the wire
        for (const peer of hub.rooms.get(t.room) || []) {
          if (peer === t || !peer.online) continue;
          if (hub.drop && hub.drop(event, t, peer)) continue;
          const copy = JSON.parse(wire);
          for (const fn of peer.messageFns) fn(event, copy);
        }
        return true;
      },
      close() {
        if (t.room) hub.rooms.get(t.room)?.delete(t);
        t.room = null;
      },
    };
    return t;
  }
}
