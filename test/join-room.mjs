// Sends simulated phones into a live room over the real relay, for checking a
// real slideshow without rounding up real people.
//   node test/join-room.mjs KXTR 8        eight phones into room KXTR for 90s
import { Player } from '../app/shared/player.js';
import { liveTransport } from './helpers/relay.mjs';
import { isChoice } from '../app/shared/protocol.js';

const room = process.argv[2];
const count = +process.argv[3] || 6;
const seconds = +process.argv[4] || 90;
if (!room) throw new Error('usage: node test/join-room.mjs ROOM [phones] [seconds]');
const NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Aroha', 'Tane', 'Priya', 'Liam', 'Mele', 'Hana', 'Oscar', 'Ruby'];
const log = (who, what) => console.log(`${new Date().toISOString().slice(14, 23)} ${who.padEnd(8)} ${what}`);

const phones = [];
for (let i = 0; i < count; i++) {
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : '');
  const p = new Player({ transport: liveTransport() });
  let last = '';
  let planned = '';
  p.onChange(() => {
    const screen = p.screen();
    if (screen !== last) {
      last = screen;
      const extra = screen === 'result' && p.snap.lb ? ` rank ${p.snap.lb[p.pid]?.[0]}, ${p.snap.lb[p.pid]?.[1]} correct` : '';
      log(name, screen + extra);
    }
    const q = p.snap?.q;
    if (screen === 'question' && q && planned !== `${q.id}@${q.at}`) {
      planned = `${q.id}@${q.at}`;
      setTimeout(() => p.answer(isChoice(q.type) ? i % q.opts.length : ['oily', 'huge', 'Arnold', 'orange'][i % 4]), 800 + i * 450);
    }
  });
  p.open(room);
  p.setName(name);
  phones.push(p);
  await new Promise((r) => setTimeout(r, 200));
}
setTimeout(() => {
  for (const p of phones) p.leave();
  setTimeout(() => process.exit(0), 300);
}, seconds * 1000);
