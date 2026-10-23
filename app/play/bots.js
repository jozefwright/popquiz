// Pretend players, for rehearsing alone: the panel's "Practise with pretend
// players" in the slideshow, or `/play/?bots=24` in the backup player. Each is
// a real Player on its own connection, answering after a human sort of pause:
// every kind of question, so a rehearsal shows every kind of result.

import { Player } from '../shared/player.js';
import { makeTransport } from '../shared/relay.js';
import { isChoice } from '../shared/protocol.js';

const NAMES = ['Alex', 'Sam', 'Jordan', 'Riley', 'Aroha', 'Tane', 'Priya', 'Liam', 'Mele', 'Hana', 'Oscar', 'Ruby', 'Wiremu', 'Isla', 'Kai', 'Zoe', 'Nikau', 'Ella', 'Sione', 'Maya', 'Finn', 'Anika', 'Leo', 'Tui', 'Jess', 'Ari', 'Nina', 'Theo', 'Ivy', 'Max'];
// What a pretend player writes for an open answer.
const LINES = ['Finally fixed the coffee machine', 'Shipped it on time', 'Friday drinks', 'A whole week without a fire drill', 'Nobody booked a meeting over lunch', 'Found a parking spot by the door', 'The new starter brought baked goods', 'Inbox zero, briefly', 'My plant is still alive', 'Got the joke in the all-hands'];
const WORDS = ['coffee', 'fun', 'teamwork', 'pizza', 'yes', 'Friday', 'coffee', 'sleep', 'growth', 'fun', 'snacks', 'music', 'coffee', 'sunshine', 'focus', 'pizza', 'fun', 'family', 'weekend', 'coffee'];

let bots = [];

// A pretend typed answer: mostly right, some with a slip, the rest a guess.
function typed(accepts) {
  const right = accepts[0];
  const roll = Math.random();
  if (!right || roll > 0.75) return WORDS[Math.floor(Math.random() * WORDS.length)];
  if (roll > 0.55 && right.length >= 5) {
    const at = 1 + Math.floor(Math.random() * (right.length - 2));
    return right.slice(0, at) + right.slice(at + 1); // a letter dropped
  }
  return Math.random() < 0.5 ? right.toLowerCase() : right;
}

export function clearBots() {
  for (const b of bots) b.leave();
  bots = [];
}

// `peek`, where given, says a question's accepted answers, so pretend players
// can get a typed answer right. Given only by the presenter's own page, for
// practice: real phones are never told.
export function spawnBots(count, room, relay, peek = null) {
  clearBots();
  for (let i = 0; i < count; i++) {
    const transport = makeTransport({ local: relay === 'local' });
    const bot = new Player({ transport });
    const keen = 0.25 + Math.random() * 0.6; // how far through the clock this one tends to answer
    const sharp = Math.random(); // how often it leans to the first option
    let planned = null;
    bot.onChange(() => {
      const q = bot.snap?.q;
      if (!q || bot.screen() !== 'question') return;
      const run = `${q.id}@${q.at}`;
      if (planned === run) return;
      planned = run;
      const window = q.dur || 12000;
      setTimeout(() => {
        const now = bot.snap?.q;
        if (!now || `${now.id}@${now.at}` !== run || bot.screen() !== 'question') return; // that run is over
        const n = q.opts?.length || 0;
        const any = () => Math.floor(Math.random() * n);
        if (q.type === 'num') bot.answer(q.min + (q.max - q.min) * (0.2 + 0.6 * (Math.random() + Math.random()) / 2)); // gathered about the middle
        else if (q.type === 'rank') bot.answer([...Array(n).keys()].sort(() => Math.random() - 0.5)); // an order, every item placed
        else if (isChoice(q.type) && q.multi) bot.answer([...new Set([any(), any()])]);
        else if (isChoice(q.type)) bot.answer(Math.random() < sharp * 0.6 ? 0 : any());
        else if (q.type === 'text') bot.answer(typed(peek?.(q.id) || []));
        else if (q.type === 'open') bot.answer(LINES[Math.floor(Math.random() * LINES.length)]);
        else bot.answer(WORDS[Math.floor(Math.random() * WORDS.length)]);
      }, 600 + Math.random() * window * keen);
    });
    setTimeout(() => {
      bot.open(room);
      bot.setName(NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ''));
    }, 150 * i);
    bots.push(bot);
  }
  return bots;
}
