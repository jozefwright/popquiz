// Test rig: a clock the tests control, a store that lives in memory, and a
// room full of simulated phones running the real Player class.
import { Engine } from '../app/shared/engine.js';
import { Player } from '../app/shared/player.js';
import { MemoryHub } from '../app/shared/transport.js';
import { normaliseDeck } from '../app/shared/deck.js';

export class FakeClock {
  constructor(start = 1_800_000_000_000) {
    this.t = start;
    this.queue = [];
    this.id = 0;
    this.now = () => this.t;
    this.timers = {
      set: (fn, ms) => {
        const h = ++this.id;
        this.queue.push({ h, at: this.t + Math.max(0, ms || 0), fn });
        return h;
      },
      clear: (h) => {
        this.queue = this.queue.filter((x) => x.h !== h);
      },
    };
  }

  // Runs every timer due within the next `ms`, in order, moving time as it goes.
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      const due = this.queue.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.h - b.h)[0];
      if (!due) break;
      this.queue = this.queue.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
  }
}

export function memoryStore(initial = null) {
  const box = { data: initial };
  return {
    box,
    load: async () => (box.data ? JSON.parse(JSON.stringify(box.data)) : null),
    save: (s) => {
      box.data = JSON.parse(JSON.stringify(s));
    },
  };
}

// mulberry32. A plain LCG is not good enough here: phones retry on a fixed
// beat, and an LCG sampled at a fixed stride repeats itself, which shows up as
// one unlucky phone losing nine sends in a row.
export function seeded(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DECK = normaliseDeck({
  presentationId: 'test',
  slides: {
    join: { kind: 'join', index: 1 },
    q1: { kind: 'question', index: 2, type: 'mc', text: 'When?', options: ['1901', '1955', '1978', 'Last Tuesday'], correct: 0, seconds: 15 },
    q2: { kind: 'question', index: 3, type: 'tf', text: 'Tested?', correct: 1, seconds: 10 },
    poll: { kind: 'question', index: 4, type: 'poll', text: 'Who wins?', options: ['A', 'B', 'C', 'D'], seconds: 20 },
    cloud: { kind: 'question', index: 5, type: 'cloud', text: 'First word?', seconds: 0 },
    keyed: { kind: 'question', index: 6, type: 'mc', text: 'Keyed', options: ['x', 'y'], correct: 1, seconds: 5, start: 'key' },
    board: { kind: 'leaderboard', index: 7, top: 5 },
  },
});

export async function makeRoom({ players = 0, deck = DECK, store = memoryStore(), clock = new FakeClock(), hub = new MemoryHub(), rand = seeded() } = {}) {
  const sent = [];
  const transport = hub.transport();
  const realSend = transport.send;
  transport.send = (event, payload) => {
    sent.push({ event, payload: JSON.parse(JSON.stringify(payload)) });
    return realSend(event, payload);
  };
  const engine = new Engine({ deck, store, transport, now: clock.now, timers: clock.timers, rand });
  await engine.start();
  const phones = [];
  const room = { engine, clock, hub, store, sent, phones, transport, deck, rand };
  room.addPhone = (name, memory) => {
    const p = new Player({ transport: hub.transport(), memory, now: clock.now, timers: clock.timers, rand });
    p.open(engine.s.room);
    if (name) p.setName(name);
    phones.push(p);
    return p;
  };
  for (let i = 0; i < players; i++) room.addPhone(`P${i + 1}`);
  clock.advance(600);
  return room;
}

export function phoneMemory(initial = null) {
  const box = { data: initial };
  return { box, load: () => box.data, save: (d) => (box.data = JSON.parse(JSON.stringify(d))) };
}
