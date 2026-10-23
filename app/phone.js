// The phone page. All the thinking is in shared/player.js; this file only
// draws whichever screen the player says it is on, and passes taps back.

import { Player } from './shared/player.js';
import { textOn, readableOn } from './shared/deck.js';
import { makeTransport } from './shared/relay.js';
import { isChoice, isScored, normaliseRoom, LIMITS, LETTERS, worthLabel, pointsWord, sameChoice, cleanNumber, showNumber, showTotal, orderHits, NEAREST } from './shared/protocol.js';

const query = new URLSearchParams(location.search);
const $app = document.getElementById('app');
const $room = document.getElementById('bar-room');
const $name = document.getElementById('bar-name');
const $link = document.getElementById('bar-link');

// `?as=anything` gives a tab its own identity, so several test phones can
// share one browser. Real phones never use it.
const memoryKey = `tally.me${query.get('as') ? `.${query.get('as')}` : ''}`;

const memory = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(memoryKey) || 'null');
    } catch {
      return null;
    }
  },
  save(me) {
    try {
      localStorage.setItem(memoryKey, JSON.stringify(me));
    } catch {}
  },
};

const transport = makeTransport({ local: query.get('relay') === 'local' });
const player = new Player({ transport, memory });

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

// ---- theme: follow the deck -----------------------------------------------

let themeKey = '';

function applyTheme(th) {
  if (!th) return;
  const key = JSON.stringify(th);
  if (key === themeKey) return;
  themeKey = key;
  const s = document.documentElement.style;
  s.setProperty('--text', th.text);
  s.setProperty('--accent', th.accent);
  s.setProperty('--card', th.card);
  s.setProperty('--card-text', th.cardText);
  s.setProperty('--good', th.good);
  s.setProperty('--font', `"${th.font}", "Bricolage Grotesque", system-ui, sans-serif`);
  s.setProperty('--case', th.upper ? 'uppercase' : 'none');
  s.setProperty('--on-accent', textOn(th.accent));
  s.setProperty('--on-good', textOn(th.good));
  // Behind it all: the deck's paper, or failing that whatever the text reads on.
  const bg = th.bg || (textOn(th.text) === '#ffffff' ? '#f6f6f6' : '#141414');
  s.setProperty('--bg', bg);
  // Headings in the accent, or the good colour, only where they read on the ground.
  s.setProperty('--accent-text', readableOn(th.accent, bg, th.text));
  s.setProperty('--good-text', readableOn(th.good, bg, th.text));
  const edged = !!th.edge && th.edge !== 'none';
  s.setProperty('--edge', edged ? th.edge : 'transparent');
  document.documentElement.toggleAttribute('data-edged', edged);
}

// ---- screens ---------------------------------------------------------------

function clock() {
  const fill = h('div', { class: 'clock-fill' });
  const num = h('div', { class: 'clock-num' });
  return { el: h('div', { class: 'clock' }, h('div', { class: 'clock-track' }, fill), num), fill, num };
}

let activeClock = null;

function screenCode() {
  const input = h('input', { class: 'code', id: 'code', inputmode: 'text', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '4', placeholder: '····', 'aria-label': 'Room code' });
  const err = h('div', { class: 'err' });
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        const room = normaliseRoom(input.value);
        if (room.length !== 4) {
          err.textContent = 'The code is four letters.';
          return;
        }
        query.set('r', room);
        history.replaceState(null, '', `?${query}`);
        player.open(room);
      },
    },
    h('label', { for: 'code', text: 'Code on the screen' }),
    input,
    err,
    h('button', { class: 'go', type: 'submit', text: 'Next' }),
  );
  return [h('div', { class: 'lockup' }, h('img', { src: 'icons/mark.svg', alt: '' }), 'Pop Quiz'), h('h1', { text: 'Join the quiz' }), form];
}

function screenName() {
  const input = h('input', { id: 'name', autocomplete: 'given-name', autocapitalize: 'words', spellcheck: 'false', maxlength: String(LIMITS.name), placeholder: 'Your name', enterkeyhint: 'go' });
  const err = h('div', { class: 'err' });
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (!player.setName(input.value)) err.textContent = 'Pop a name in first.';
        else wakeLock();
      },
    },
    h('label', { for: 'name', text: 'What do we call you?' }),
    input,
    err,
    h('button', { class: 'go', type: 'submit', text: "I'm in" }),
  );
  queueMicrotask(() => input.focus());
  return [h('h1', { text: 'Who are you?' }), form];
}

function screenWaiting() {
  return [h('h1', { text: `You're in, ${player.name}` }), h('p', null, 'Eyes on the big screen. This page moves by itself.'), h('p', { id: 'playing' })];
}

// The head count changes every time someone joins. It is written into the
// waiting screen in place, so a busy room does not redraw (and re-fade) the
// whole screen once per arrival.
function patchWaiting() {
  const el = document.getElementById('playing');
  if (!el) return;
  const n = player.snap?.n || 0;
  const text = n > 1 ? `${n} playing` : '';
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.replaceChildren(...(n > 1 ? [h('b', { text: String(n) }), ' playing'] : []));
}

// A question worth more than one point says so above it.
const worth = (q) => (q.pts > 1 ? h('div', { class: 'worth', text: worthLabel(q.pts) }) : null);

function screenReady() {
  const q = player.snap.q;
  return [h('h1', { text: 'Get ready' }), worth(q), q.text ? h('div', { class: 'q', text: q.text }) : null];
}

// The list of options. More than six get tighter rows, and two columns when
// none is long: A to F down the first, as on the slide. A few long ones (a
// sentence each) get smaller type, so the last of them is not below the screen.
function optsBox(q, rows) {
  const many = q.opts.length > 6;
  const longestWord = Math.max(0, ...q.opts.flatMap((t) => String(t).split(/\s+/)).map((w) => w.length));
  const short = many && q.opts.every((t) => String(t).length <= 28) && longestWord <= 10; // a longer word will not fit half a phone's width
  const snug = short && q.opts.some((t) => String(t).length > 14); // a few words each: smaller type in the columns
  const long = !many && q.opts.some((t) => String(t).length > 70);
  return h('div', { class: `opts${many ? ' many' : ''}${short ? ' short' : ''}${snug ? ' snug' : ''}${long ? ' long' : ''}`, style: short ? `--rows:${Math.ceil(q.opts.length / 2)}` : null }, rows);
}

function optionRow(q, i, { tag = 'div', cls = '', n = null, fill = null, onclick = null } = {}) {
  return h(
    tag,
    { class: `opt ${cls}`, type: tag === 'button' ? 'button' : null, onclick },
    fill !== null ? h('div', { class: 'opt-fill', style: `width:${fill}%` }) : null,
    h('span', { class: 'opt-letter', text: LETTERS[i] }),
    h('span', { class: 'opt-text', text: q.opts[i] }),
    n !== null ? h('span', { class: 'opt-n', text: String(n) }) : null,
  );
}

function screenQuestion() {
  const q = player.snap.q;
  const c = q.ends ? clock() : null;
  activeClock = c;
  const head = [worth(q), q.text ? h('div', { class: 'q', text: q.text }) : null, c?.el];
  if (q.type === 'num') {
    // Guess the number: a slider over the question's range, with a nudge either
    // side for the last step or two, and a button to lock it in. It starts in
    // the middle; nothing counts as a guess until it is moved or locked in.
    const start = player.guess() ?? cleanNumber((q.min + q.max) / 2, q);
    const big = h('b', { text: showNumber(start) });
    const slider = h('input', { class: 'num-slider', type: 'range', min: String(q.min), max: String(q.max), step: String(q.step), 'aria-label': 'Your guess' });
    slider.value = String(start);
    const say = (value) => {
      const n = cleanNumber(value, q);
      slider.value = String(n);
      big.textContent = showNumber(n);
      player.setGuess(n);
    };
    slider.addEventListener('input', () => say(+slider.value));
    const nudge = (by) => h('button', { class: 'num-nudge', type: 'button', text: by < 0 ? '−' : '+', 'aria-label': by < 0 ? 'A little less' : 'A little more', onclick: () => say(+slider.value + by * q.step) });
    const lock = h('button', { class: 'go stick', type: 'button', text: 'Lock in', onclick: () => { if (player.guess() === null) player.setGuess(+slider.value); player.lockIn(); } });
    return [...head, h('div', { class: 'num-read' }, big, q.unit ? h('span', { text: q.unit }) : null), h('div', { class: 'num-row' }, nudge(-1), slider, nudge(1)), h('div', { class: 'num-ends' }, h('span', { text: showNumber(q.min) }), h('span', { text: showNumber(q.max) })), lock];
  }
  if (q.multi || q.type === 'rank') {
    // Several answers are right: tap to tick, tap again to untick, then lock in.
    // Putting in order is the same, and each tap gives the next place: the first
    // tapped is 1st. Taking one out moves the rest up.
    // Ticks are shown in place, so a tap never redraws (and re-fades) the screen.
    const ordering = q.type === 'rank';
    const lock = h('button', { class: 'go stick', type: 'button', text: 'Lock in', onclick: () => player.lockIn() });
    const rows = q.opts.map((_, i) => optionRow(q, i, { tag: 'button', n: ordering ? '' : null, onclick: () => player.toggle(i) && show() }));
    const show = () => {
      const set = player.chosen();
      rows.forEach((row, i) => {
        const at = set.indexOf(i);
        row.classList.toggle('picked', at >= 0);
        row.setAttribute('aria-pressed', String(at >= 0));
        if (ordering) row.querySelector('.opt-n').textContent = at >= 0 ? ordinal(at + 1) : '';
      });
      lock.disabled = !set.length;
      if (ordering) lock.textContent = set.length && set.length < q.opts.length ? `Lock in ${set.length} of ${q.opts.length}` : 'Lock in';
    };
    show();
    const hint = ordering ? 'Tap them in order: 1st, 2nd, 3rd… Tap one again to take it out.' : 'Pick all that apply, then lock in.';
    return [...head, h('p', { class: 'hint', text: hint }), optsBox(q, rows), lock];
  }
  if (isChoice(q.type)) {
    // Tap to choose, tap another to change your mind, then lock in. Shown in
    // place, so a tap never redraws (and re-fades) the screen.
    const lock = h('button', { class: 'go stick', type: 'button', text: 'Lock in', onclick: () => player.lockIn() });
    const rows = q.opts.map((_, i) => optionRow(q, i, { tag: 'button', onclick: () => player.select(i) && show() }));
    const show = () => {
      const [mine] = player.chosen();
      rows.forEach((row, i) => {
        row.classList.toggle('picked', mine === i);
        row.setAttribute('aria-pressed', String(mine === i));
      });
      lock.disabled = mine === undefined;
    };
    show();
    return [...head, h('p', { class: 'hint', text: 'Tap your answer, then lock in. You can change it until you do.' }), optsBox(q, rows), lock];
  }
  if (q.type === 'open') {
    // An open answer: a sentence, which goes up on the big screen as a card.
    const left = h('span', { class: 'left' });
    const box = h('textarea', { id: 'word', rows: '3', autocapitalize: 'sentences', autocorrect: 'on', spellcheck: 'true', maxlength: String(LIMITS.open), placeholder: 'Your answer', enterkeyhint: 'send' });
    const count = () => (left.textContent = `${LIMITS.open - box.value.length} left`);
    box.addEventListener('input', count);
    // Enter sends, as it does in a chat; there is no need for a second line.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        player.answer(box.value);
      }
    });
    count();
    const form = h('form', { class: 'open', onsubmit: (e) => { e.preventDefault(); player.answer(box.value); } }, box, h('div', { class: 'open-foot' }, left, h('button', { class: 'go', type: 'submit', text: 'Send' })));
    queueMicrotask(() => box.focus());
    return [...head, h('p', { class: 'hint', text: 'It goes up on the screen. One answer each.' }), form];
  }
  // A word for the cloud, or a typed answer: the same box, longer for an answer.
  const typing = q.type === 'text';
  const input = h('input', { id: 'word', autocomplete: 'off', autocapitalize: typing ? 'sentences' : 'none', autocorrect: 'off', spellcheck: 'false', maxlength: String(typing ? LIMITS.typed : LIMITS.word), placeholder: typing ? 'Your answer' : 'One word', enterkeyhint: 'send' });
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        player.answer(input.value);
      },
    },
    input,
    h('button', { class: 'go', type: 'submit', text: typing ? 'Lock in' : 'Send' }),
  );
  queueMicrotask(() => input.focus());
  return [...head, typing ? h('p', { class: 'hint', text: 'Type it in. Spelling needn’t be perfect.' }) : null, form];
}

function screenLocked() {
  const q = player.snap.q;
  const mine = player.myPick();
  const c = q.ends && player.snap.ph === 'open' ? clock() : null;
  activeClock = c;
  if (mine === null) {
    return [h('h1', { class: 'plain', text: "Time's up" }), h('p', null, 'Too slow on that one. The answer is coming.')];
  }
  const sent = player.confirmed();
  return [
    h('h1', { class: 'plain', text: sent ? 'Answer in' : 'Sending' }),
    q.type === 'num' ? h('div', { class: 'num-read' }, h('b', { text: showNumber(mine) }), q.unit ? h('span', { text: q.unit }) : null) : q.type === 'rank' ? h('div', { class: `opts${mine.length > 6 ? ' many' : ''}` }, mine.map((i, p) => optionRow(q, i, { cls: 'mine', n: ordinal(p + 1) }))) : isChoice(q.type) ? h('div', { class: 'opts' }, [].concat(mine).map((i) => optionRow(q, i, { cls: 'mine' }))) : h('div', { class: 'q', text: `“${mine}”` }),
    c?.el,
    h('p', { class: sent ? '' : 'dots', text: sent ? (isScored(q.type) ? 'Locked. Wait for the reveal.' : 'Got it. Watch the screen.') : 'Getting it to the screen' }),
  ];
}

function screenResult() {
  const s = player.snap;
  const q = s.q;
  const mine = player.myPick();
  if (q.type === 'rank' && Array.isArray(s.rv?.rightOrder)) {
    // The right order, once the presenter has shown it, against this phone's:
    // an item placed exactly where the right order has it is green.
    const right = s.rv.rightOrder;
    const card = Array.isArray(mine) ? mine : [];
    const hits = orderHits(card, right);
    const won = s.rv.won?.[player.pid] || 0;
    const order = [...right, ...q.opts.map((_, i) => i).filter((i) => !right.includes(i))];
    const rows = order.map((i) => {
      const at = right.indexOf(i);
      const mineAt = card.indexOf(i);
      const theirs = at >= 0 ? ordinal(at + 1) : '–';
      return optionRow(q, i, { cls: at >= 0 && mineAt === at ? 'right' : '', n: `${theirs} · you ${mineAt >= 0 ? ordinal(mineAt + 1) : '–'}` });
    });
    const me = s.lb?.[player.pid];
    const said = !card.length ? 'You did not answer this one.' : hits ? `You put ${hits} of ${right.length} in the right place.` : 'None in the right place this time.';
    if (won) navigator.vibrate?.([40, 60, 40]);
    return [
      h('h1', { class: won ? 'good' : 'plain', text: q.right || 'The right order' }),
      h('p', { text: said }),
      won ? h('div', { class: 'worth', text: `+${won} ${pointsWord(won)}` }) : null,
      h('div', { class: `opts${q.opts.length > 6 ? ' many' : ''}` }, rows),
      me ? h('div', { class: 'stat' }, h('div', null, h('b', { text: ordinal(me[0]) }), h('span', { text: `of ${s.n}` })), h('div', null, h('b', { text: String(me[1]) }), h('span', { text: pointsWord(me[1]) }))) : null,
    ];
  }
  if (q.type === 'rank') {
    // The room's order: each item's place and total, the lowest total first.
    // The one this phone put first is outlined.
    const rv = s.rv || {};
    const places = rv.places || [];
    const totals = rv.totals || [];
    const order = q.opts.map((_, i) => i).sort((x, y) => (places[x] ?? 99) - (places[y] ?? 99) || x - y);
    const first = Array.isArray(mine) ? mine[0] : null;
    const rows = order.map((i) => optionRow(q, i, { cls: `${rv.cards && places[i] === 1 ? 'right' : ''} ${i === first ? 'mine' : ''}`, n: rv.cards ? `${ordinal(places[i])} · ${showTotal(totals[i])}` : '' }));
    const said = !rv.cards ? 'Nobody answered this one.' : first === null ? 'You did not answer this one.' : `You put ${q.opts[first] || LETTERS[first]} first. The room put them ${ordinal(places[first])}.`;
    return [h('h1', { class: 'plain', text: 'The room’s order' }), h('p', { text: said }), h('div', { class: `opts${q.opts.length > 6 ? ' many' : ''}` }, rows)];
  }
  if (q.type === 'num') {
    // Closest wins three, next two, next one; what I won says which I was.
    const rv = s.rv || {};
    const won = rv.won?.[player.pid] || 0;
    const place = won ? NEAREST.indexOf(won / (q.pts || 1)) : -1;
    const me = s.lb?.[player.pid];
    if (won) navigator.vibrate?.([40, 60, 40]);
    return [
      h('h1', { class: won ? 'good' : 'plain', text: mine === null ? 'No guess' : ['Closest', 'Second closest', 'Third closest'][place] || 'Not this time' }),
      won ? h('div', { class: 'worth', text: `+${won} ${pointsWord(won)}` }) : null,
      h('div', { class: 'stat' }, h('div', null, h('b', { text: showNumber(rv.answer) }), h('span', { text: q.unit ? `${q.unit}, the answer` : 'the answer' })), mine === null ? null : h('div', null, h('b', { text: showNumber(mine) }), h('span', { text: 'your guess' }))),
      me ? h('div', { class: 'stat' }, h('div', null, h('b', { text: ordinal(me[0]) }), h('span', { text: `of ${s.n}` })), h('div', null, h('b', { text: String(me[1]) }), h('span', { text: pointsWord(me[1]) }))) : null,
    ];
  }
  if (q.type === 'text') {
    // Right or not, the answer, and what this phone typed.
    const rv = s.rv || {};
    const won = rv.won?.[player.pid] || 0;
    const me = s.lb?.[player.pid];
    if (won) navigator.vibrate?.([40, 60, 40]);
    return [
      h('h1', { class: won ? 'good' : 'plain', text: won ? 'Correct' : mine === null ? 'No answer' : 'Not this time' }),
      won && q.pts > 1 ? h('div', { class: 'worth', text: `${worthLabel(q.pts)}: +${won}` }) : null,
      h('div', { class: 'stat typed' }, rv.answer ? h('div', null, h('b', { text: rv.answer }), h('span', { text: 'the answer' })) : null, mine === null ? null : h('div', null, h('b', { text: mine }), h('span', { text: 'you typed' }))),
      me ? h('div', { class: 'stat' }, h('div', null, h('b', { text: ordinal(me[0]) }), h('span', { text: `of ${s.n}` })), h('div', null, h('b', { text: String(me[1]) }), h('span', { text: pointsWord(me[1]) }))) : null,
    ];
  }
  if (q.type === 'open') {
    return [h('h1', { class: 'plain', text: 'Thanks' }), mine ? h('div', { class: 'q', text: `“${mine}”` }) : h('p', { text: 'Have a look at the screen.' })];
  }
  if (!isChoice(q.type)) {
    return [h('h1', { class: 'plain', text: 'Thanks' }), mine ? h('p', null, 'Your word is on the screen: ', h('b', { text: mine })) : h('p', { text: 'Have a look at the screen.' })];
  }
  const rv = s.rv || { counts: [], correct: null };
  const top = Math.max(1, ...rv.counts);
  const rows = q.opts.map((_, i) =>
    optionRow(q, i, {
      cls: `${[].concat(mine).includes(i) ? 'mine' : ''} ${[].concat(rv.correct).includes(i) ? 'right' : rv.correct !== null ? 'dim' : ''}`,
      n: rv.counts[i] || 0,
      fill: ((rv.counts[i] || 0) / top) * 100,
    }),
  );
  if (!isScored(q.type)) {
    return [h('h1', { class: 'plain', text: 'The room says' }), optsBox(q, rows)];
  }
  const right = mine !== null && sameChoice(mine, rv.correct);
  const me = s.lb?.[player.pid];
  if (right) navigator.vibrate?.([40, 60, 40]);
  return [
    h('h1', { class: right ? 'good' : 'plain', text: right ? 'Correct' : mine === null ? 'No answer' : 'Not this time' }),
    right && q.pts > 1 ? h('div', { class: 'worth', text: `${worthLabel(q.pts)}: +${q.pts}` }) : null,
    optsBox(q, rows),
    me ? h('div', { class: 'stat' }, h('div', null, h('b', { text: ordinal(me[0]) }), h('span', { text: `of ${s.n}` })), h('div', null, h('b', { text: String(me[1]) }), h('span', { text: pointsWord(me[1]) }))) : null,
  ];
}

function screenBoard() {
  const s = player.snap;
  // The final placings are uncovered on the big screen first, a place at a time.
  if (s.hold) return [h('h1', { class: 'plain', text: 'Drum roll' }), h('p', { class: 'dots', text: 'Eyes on the big screen' })];
  const me = s.lb?.[player.pid];
  const won = s.final && me?.[0] === 1;
  return [
    h('h1', { class: won ? 'good' : '', text: won ? 'You won' : me ? `You're ${ordinal(me[0])}` : 'Leaderboard' }),
    me ? h('p', null, h('b', { text: String(me[1]) }), ` ${pointsWord(me[1])}, out of ${s.n} playing`) : null,
    h('div', { class: 'podium' }, (s.top || []).map(([name, score], i) => h('div', null, h('span', { class: 'rank', text: String(i + 1) }), h('span', { class: 'who', text: name }), h('span', { text: String(score) })))),
  ];
}

// A phone that has never heard its room may have the wrong code: a letter
// misheard over a call, or mistyped. It can go back and enter it again.
function retype() {
  if (player.snap) return null;
  return h('button', {
    class: 'again',
    type: 'button',
    text: 'Wrong code? Enter it again',
    onclick: () => {
      query.delete('r');
      history.replaceState(null, '', `${location.pathname}${query.size ? `?${query}` : ''}`);
      player.leaveRoom();
    },
  });
}

function screenAway() {
  return [h('h1', { class: 'plain', text: 'Hang on' }), h('p', { class: 'dots', text: 'Waiting for the presenter' }), h('p', { text: 'Nothing to do. This page reconnects by itself.' }), retype()];
}

const SCREENS = {
  code: screenCode,
  name: screenName,
  connecting: () => [h('h1', { class: 'plain', text: 'Connecting' }), h('p', { class: 'dots', text: 'Finding the room' }), retype()],
  waiting: screenWaiting,
  ready: screenReady,
  question: screenQuestion,
  locked: screenLocked,
  result: screenResult,
  leaderboard: screenBoard,
  away: screenAway,
};

// ---- drawing ---------------------------------------------------------------

let drawn = '';

// A screen is redrawn only when something on it would read differently, so a
// heartbeat every two seconds never disturbs a half-typed word.
function signature(screen) {
  const s = player.snap;
  const q = s?.q;
  const parts = [screen, player.room, player.name];
  if (q && ['ready', 'question', 'locked', 'result'].includes(screen)) parts.push(q.id, q.at, q.text, q.pts, q.opts?.join('|'));
  if (screen === 'locked') parts.push(player.myPick(), player.confirmed(), s.ph);
  if (screen === 'result') parts.push(JSON.stringify(s.rv), JSON.stringify(s.lb?.[player.pid]));
  if (screen === 'leaderboard') parts.push(JSON.stringify(s.top), JSON.stringify(s.lb?.[player.pid]), s.final, s.n, s.hold);
  return parts.join('\u0001');
}

function draw() {
  applyTheme(player.snap?.th);
  const screen = player.screen();
  $room.textContent = player.room || '';
  $name.textContent = player.name || '';
  $link.dataset.link = screen === 'away' ? 'away' : player.snap ? 'live' : 'connecting';
  $link.hidden = screen === 'code';

  const sig = signature(screen);
  if (sig === drawn) {
    patchWaiting();
    return;
  }
  const before = drawn.split('\u0001')[0];
  drawn = sig;
  activeClock = null;
  $app.replaceChildren(...SCREENS[screen]().filter(Boolean));
  // A new screen starts at the top: a tall result scrolled down must not leave
  // the next question's wording and clock above the top of the screen.
  if (screen !== before) window.scrollTo(0, 0);
  patchWaiting();
  if (screen === 'question' && before !== 'question') navigator.vibrate?.(60);
}

function frame() {
  player.autoLock(); // something chosen, not locked in, and the clock all but out
  const c = activeClock;
  if (c) {
    const left = player.remaining();
    const total = player.snap?.q?.dur || 0;
    if (left !== null && total > 0) {
      c.fill.style.transform = `scaleX(${Math.min(1, left / total)})`;
      const text = String(Math.ceil(left / 1000));
      if (c.num.textContent !== text) c.num.textContent = text;
    }
  }
  requestAnimationFrame(frame);
}

// ---- staying alive ---------------------------------------------------------

// A phone that goes to sleep drops its connection, so ask it to stay awake
// for as long as the page is in front. Not every browser allows it.
let lock = null;

async function wakeLock() {
  try {
    if (!lock && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock?.request('screen');
      lock?.addEventListener('release', () => (lock = null));
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    wakeLock();
    player.wake();
    draw();
  }
});
window.addEventListener('online', () => player.wake());
window.addEventListener('pageshow', (e) => {
  if (e.persisted) player.wake();
});

// ---- start -----------------------------------------------------------------

player.onChange(draw);
// The room always comes from the link (the QR code carries it, and typing a
// code rewrites the address), never from memory: a bare visit weeks later must
// ask for a code, not wander into a room that has long since closed.
const fromLink = normaliseRoom(query.get('r'));
if (fromLink.length === 4) player.open(fromLink);
else player.room = '';
if (player.name && player.room) wakeLock();
draw();
requestAnimationFrame(frame);

window.tally = { player };
