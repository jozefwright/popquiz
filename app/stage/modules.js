// What Tally draws on the big screen.
//
// One function, mountModule(), turns a view from the engine into DOM inside
// whatever box it is given. The stage gives it the placeholder's rectangle; the
// side panel gives it a small preview frame. Everything is sized in container
// units, so the same module is right at any size.
//
// A module is rebuilt only when its structure changes (new slide, new phase).
// Counts, bars, names and the clock are patched in place so they can animate.

import qrcode from '../vendor/qrcode.js';
import { isScored, isChoice, worthLabel, showNumber, LETTERS, ordinal, showTotal, scores, tagRect, TAG_SHAPE, resultName, roomHeading, answerHeading, underName } from '../shared/protocol.js';
import { joinUrl, textOn, contrast, readableOn } from '../shared/deck.js';
import { BRAND } from '../shared/brand.js';


export function h(tag, attrs, ...kids) {
  const el = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'g' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') for (const [prop, val] of Object.entries(v)) (prop.startsWith('--') ? el.style.setProperty(prop, val) : (el.style[prop] = val));
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// `slideFill` is the slide's own background colour, where the host can see
// one. Words that sit straight on the slide (no ground behind the module) are
// made to read against it: the standard look's ink on a dark deck turns white.
export function applyTheme(el, theme, slideFill = null) {
  const s = el.style;
  const bare = theme.ground === 'transparent' && slideFill;
  s.setProperty('--t-font', `"${theme.font}", "Bricolage Grotesque", system-ui, sans-serif`);
  const text = bare && contrast(theme.text, slideFill) < 3 ? textOn(slideFill) : theme.text;
  s.setProperty('--t-text', text);
  // Words in the accent colour (headings, ranks, the top word) keep it only
  // where it reads against what is behind them: amber on a white slide does
  // not, from the back of a room, and turns to the text colour instead.
  const behind = theme.ground !== 'transparent' ? theme.ground : slideFill || theme.card;
  s.setProperty('--t-accent-text', readableOn(theme.accent, behind, text));
  s.setProperty('--t-accent', theme.accent);
  s.setProperty('--t-card', theme.card);
  s.setProperty('--t-card-text', theme.cardText);
  s.setProperty('--t-correct', theme.correct);
  s.setProperty('--t-ground', theme.ground);
  s.setProperty('--t-radius', String(theme.radius));
  s.setProperty('--t-weight', String(theme.weight));
  s.setProperty('--t-case', theme.uppercase ? 'uppercase' : 'none');
  s.setProperty('--t-on-accent', textOn(theme.accent));
  s.setProperty('--t-on-correct', textOn(theme.correct));
  const edged = !!theme.edge && theme.edge !== 'none';
  s.setProperty('--t-edge', edged ? theme.edge : 'transparent');
  el.toggleAttribute('data-grounded', theme.ground !== 'transparent');
  el.toggleAttribute('data-edged', edged);
}

// Type in a question is sized by the box's height, so a box made narrower
// keeps its type. This is what makes it smaller where it has to be. Run after
// every build and resize.
//
// A row of things that cannot wrap (the count, the points pill, the clock) is
// scaled down as one until it fits across. Then each piece of text is shrunk
// until it fits its box: no taller than the box, no wider, and no single word
// wider than its line. While it measures, words are not allowed to break, or
// one too long for its line would never be noticed. Text marked to be dropped
// is hidden if even that is not enough: the join line, which is a nicety.
export function fitText(root) {
  for (const row of root.querySelectorAll('[data-fit-row]')) {
    row.style.removeProperty('--fit');
    let k = 1;
    for (let i = 0; i < 12 && row.scrollWidth > row.clientWidth + 1; i++) {
      k *= 0.93;
      row.style.setProperty('--fit', k.toFixed(3));
    }
  }
  root.classList.add('tm-fitting');
  for (const el of root.querySelectorAll('[data-fit]')) {
    el.style.fontSize = '';
    el.style.visibility = '';
    const box = el.closest('[data-fit-box]') || el.parentElement;
    // A word can run past its own cell and still sit inside the row (over the
    // number beside it), so every part is asked, not only the whole.
    // Strictly: a word one pixel too wide for its line still breaks once measuring ends.
    const wide = (n) => n.scrollWidth > n.clientWidth;
    // The column it sits in is asked too: a word too long for a narrow column
    // runs on into the next one (an option's count) without the box noticing.
    // And the text itself is measured to the fraction of a pixel: widths in
    // whole pixels let a word a sliver too wide through, to break once measuring ends.
    const overhangs = (n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      const t = r.getBoundingClientRect();
      const c = n.getBoundingClientRect();
      return t.width > 0 && (t.right > c.right + 0.25 || t.left < c.left - 0.25);
    };
    const fits = () => el.offsetHeight <= box.clientHeight * 0.9 && el.offsetWidth <= box.clientWidth + 1 && !wide(el) && !overhangs(el) && !(el.parentElement !== box && wide(el.parentElement)) && ![...el.querySelectorAll('*')].some(wide);
    let size = parseFloat(getComputedStyle(el).fontSize);
    const floor = size * 0.4;
    for (let i = 0; i < 16 && size > floor; i++) {
      if (fits()) break;
      size *= 0.93;
      el.style.fontSize = `${size}px`;
    }
    if (el.dataset.fit === 'or-drop' && !fits()) el.style.visibility = 'hidden';
  }
  root.classList.remove('tm-fitting');
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const quiet = 2;
  return h('svg', { viewBox: `${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`, class: 'tm-qr-svg', 'shape-rendering': 'crispEdges' }, h('path', { d, fill: '#111' }));
}

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 100) : 0);

// ---- join ------------------------------------------------------------------

function buildJoin(view, ctx) {
  const url = joinUrl(ctx.joinBase, view.room);
  const shown = url ? url.replace(/^https?:\/\//, '').replace(/\?.*$/, '').replace(/\/$/, '') : '';
  const count = h('div', { class: 'tm-join-count' });
  const names = h('div', { class: 'tm-join-names' });
  const el = h(
    'div',
    { class: 'tm-in tm-join' },
    h('div', { class: 'tm-join-qr' }, url ? qrSvg(url) : h('div', { class: 'tm-join-noqr', text: `Set the join address in the ${BRAND} panel` })),
    h(
      'div',
      { class: 'tm-join-side' },
      h('div', { class: 'tm-kicker', text: view.cfg.headline || 'Join the quiz' }),
      h('div', { class: 'tm-join-how' }, shown ? h('span', { text: 'Scan, or go to ' }) : null, shown ? h('b', { text: shown }) : null),
      h('div', { class: 'tm-join-code' }, h('span', { class: 'tm-join-code-label', text: 'Code' }), h('span', { class: 'tm-join-code-value', text: view.room })),
      count,
      names,
    ),
  );
  let seen = new Set();
  return {
    el,
    update(v) {
      count.textContent = v.playerCount === 0 ? 'Waiting for the first phone' : `${v.playerCount} in`;
      const latest = v.names.slice(-14).reverse();
      const next = new Set(latest);
      names.replaceChildren(...latest.map((n) => h('span', { class: `tm-chip${seen.has(n) ? '' : ' tm-pop'}`, text: n })));
      seen = next;
    },
  };
}

// ---- question --------------------------------------------------------------

function timerRing() {
  const r = 44;
  const c = 2 * Math.PI * r;
  const arc = h('circle', { cx: 50, cy: 50, r, class: 'tm-ring-arc', 'stroke-dasharray': c, 'stroke-dashoffset': 0, transform: 'rotate(-90 50 50)' });
  const num = h('div', { class: 'tm-ring-num' });
  const el = h('div', { class: 'tm-ring' }, h('svg', { viewBox: '0 0 100 100' }, h('circle', { cx: 50, cy: 50, r, class: 'tm-ring-track' }), arc), num);
  return {
    el,
    set(leftMs, totalMs) {
      const secs = Math.ceil(leftMs / 1000);
      const text = String(Math.max(0, secs));
      if (num.textContent !== text) num.textContent = text;
      arc.setAttribute('stroke-dashoffset', String(c * (1 - (totalMs > 0 ? Math.min(1, Math.max(0, leftMs / totalMs)) : 0))));
      el.classList.toggle('tm-ring-hot', leftMs > 0 && leftMs <= 5000);
      el.classList.toggle('tm-ring-done', leftMs <= 0);
    },
  };
}

// The top row of a question: the question text if the module carries it,
// otherwise a quiet line telling latecomers how to join. A question worth
// more than one point says so here. A slide may switch off the join line, the
// count and the clock; with nothing left to show there is no row at all, and
// what is below has the whole box.
function header(view, ring, ctx) {
  const off = view.cfg.hide || {};
  const answered = h('div', { class: 'tm-answered' }); // kept even when unseen, so whoever writes the count need not ask
  let lead = null;
  if (view.cfg.showText && view.cfg.text) {
    lead = h('div', { class: 'tm-qtext', 'data-fit-box': true }, h('span', { 'data-fit': true, text: view.cfg.text }));
  } else if (ctx.joinHint && ctx.joinBase && !off.join) {
    const host = ctx.joinBase.replace(/^https?:\/\//, '').replace(/[?#].*$/, '').replace(/\/$/, '');
    lead = h('div', { class: 'tm-qtext tm-joinhint', 'data-fit-box': true }, h('span', { 'data-fit': 'or-drop' }, 'Join at ', h('b', { text: host }), ' · code ', h('b', { text: view.room })));
  }
  const worth = scores(view.cfg) && view.cfg.points > 1 ? h('div', { class: 'tm-worth', text: worthLabel(view.cfg.points) }) : null;
  // The room has to know it may pick more than one, or nobody will.
  const several = view.cfg.multi ? h('div', { class: 'tm-several', text: 'Pick all that apply' }) : view.cfg.type === 'rank' ? h('div', { class: 'tm-several', text: 'Put them in order' }) : null;
  const parts = [lead, several, worth, off.count ? null : answered, ring ? ring.el : null];
  if (!parts.some(Boolean)) return { el: null, answered };
  // The text or the join line fills the row and pushes the rest right; without either, an empty filler does.
  return { el: h('div', { class: 'tm-head', 'data-fit-row': true }, lead || h('div', { class: 'tm-qtext' }), ...parts.slice(1)), answered };
}

function answeredText(v) {
  if (v.phase === 'armed') return 'Get ready';
  if (v.playerCount === 0) return `${v.answered} answered`;
  return `${v.answered} of ${v.playerCount} answered`;
}

// Whether option i is a right answer in this view: one is, or several are.
const rightAt = (v, i) => (Array.isArray(v.correct) ? v.correct.includes(i) : v.correct === i);

function optionCard(i, label) {
  const fill = h('div', { class: 'tm-fill' });
  const num = h('div', { class: 'tm-opt-num' });
  const mark = h('div', { class: 'tm-opt-mark' });
  const el = h(
    'div',
    { class: 'tm-opt', 'data-fit-box': true },
    fill,
    h('div', { class: 'tm-opt-letter', text: LETTERS[i] }),
    h('div', { class: 'tm-opt-text' }, h('span', { 'data-fit': true, text: label })),
    num,
    mark,
  );
  return { el, fill, num, mark };
}

// An option whose votes are shown on the slide itself, over a photo or a
// shape: a column that rises from the bottom of it, with the letter and the count.
function optionPin(i) {
  const fill = h('div', { class: 'tm-pin-fill' });
  const num = h('span', { class: 'tm-pin-num' });
  const mark = h('span', { class: 'tm-pin-mark' });
  const el = h('div', { class: 'tm-pin' }, fill, h('div', { class: 'tm-pin-ring' }), h('div', { class: 'tm-pin-foot' }, h('span', { class: 'tm-pin-letter', text: LETTERS[i] }), num, mark));
  return { el, fill, num, mark };
}

// Each pin is placed as a share of the module's own box, from where the box
// and the pin's shape sit on the slide. The host says where they are now;
// failing that, where they were last seen.
function pinPlacer(pins, cfg, ctx) {
  return () => {
    if (!pins) return;
    const f = ctx.frame || cfg.place;
    pins.forEach((p, i) => {
      const r = p && (ctx.pins?.[i] || cfg.pins[i]);
      if (!r || !f?.w || !f?.h) return;
      Object.assign(p.el.style, { left: `${((r.x - f.x) / f.w) * 100}%`, top: `${((r.y - f.y) / f.h) * 100}%`, width: `${(r.w / f.w) * 100}%`, height: `${(r.h / f.h) * 100}%` });
    });
  };
}

// A put-in-order round's place, out on the slide: a label put by hand where its
// item is. Hidden while the room answers; at the reveal it says where the room
// placed it, and after T where the right order has it.
function optionTag(i) {
  const place = h('span', { class: 'tm-tag-place' });
  const mark = h('span', { class: 'tm-tag-mark' });
  const room = h('div', { class: 'tm-tag-room' });
  const card = h('div', { class: 'tm-tag-card' }, h('span', { class: 'tm-tag-letter', text: LETTERS[i] }), h('div', { class: 'tm-tag-line' }, place, mark), room);
  const el = h('div', { class: 'tm-tag' }, card);
  return { el, card, place, mark, room };
}

// Each label as a share of the module's own box: where it was dragged to on
// the slide, or one still on a shape where the host says that shape is now.
// The slide's settings are asked for each time: a label dragged in the editor
// moves without the module being built again.
function tagPlacer(tags, settings, ctx) {
  return () => {
    if (!tags) return;
    const cfg = settings();
    const f = ctx.frame || cfg.place;
    if (!f?.w || !f?.h) return;
    tags.forEach((t, i) => {
      const pin = cfg.pins?.[i];
      const r = (pin?.shapeId && pin.shapeId !== TAG_SHAPE && ctx.pins?.[i]) || tagRect(cfg, i);
      Object.assign(t.el.style, { left: `${((r.x - f.x) / f.w) * 100}%`, top: `${((r.y - f.y) / f.h) * 100}%`, width: `${(r.w / f.w) * 100}%`, height: `${(r.h / f.h) * 100}%` });
    });
  };
}

// Put in order. While it is open the items are cards, or wait as labels on the
// slide. At the reveal the cards become the room's order, first to last, each
// with its place and its total (the lowest total comes first), arriving from
// the bottom up so first place is named last. On the slide, each label shows
// its item's place, last place first and first place last. Where a right order
// is set, T then turns it into the right order, arriving the same way, with
// where the room put each item.
function buildRank(view, ctx) {
  const cfg = view.cfg;
  const ring = cfg.seconds > 0 && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const reveal = view.phase === 'reveal';
  const onSlide = cfg.display === 'pins';
  const inBox = onSlide
    ? []
    : cfg.options.map((label, i) => {
        const c = optionCard(i, label);
        c.place = h('div', { class: 'tm-rank-place' });
        c.el.insertBefore(c.place, c.el.children[1]);
        return { ...c, i };
      });
  const body = inBox.length ? h('div', { class: `tm-opts tm-opts-stack tm-n${inBox.length}` }, inBox.map((c) => c.el)) : null;
  const tags = onSlide ? cfg.options.map((_, i) => optionTag(i)) : null;
  const layer = tags ? h('div', { class: 'tm-pins tm-tags' }, tags.map((t) => t.el)) : null;
  let live = cfg;
  const placeTags = tagPlacer(tags, () => live, ctx);
  const el = h('div', { class: `tm-in tm-q tm-rankq tm-phase-${view.phase} tm-display-${onSlide ? 'pins' : 'bars'}${reveal ? ' tm-revealed' : ''}${body ? '' : ' tm-headonly'}` }, head.el, body, layer);
  let order = '';
  let landed = '';
  let pillSet = false;
  const pill = head.el?.querySelector('.tm-several');
  return {
    el,
    update(v) {
      live = v.cfg;
      const answered = v.playerCount && v.phase !== 'reveal' ? `${v.answered} of ${v.playerCount} answered` : `${v.answered} answered`;
      head.answered.textContent = v.phase === 'armed' ? 'Get ready' : answered;
      const room = v.verdict && v.verdict.cards > 0 ? v.verdict : null;
      // The right order, once T has shown it: its place for each item.
      const right = reveal && Array.isArray(v.verdict?.rightOrder) ? v.verdict.rightOrder : null;
      const verdict = room || (right ? { places: [], totals: [] } : null);
      el.classList.toggle('tm-answered', !!right);
      // What the slide calls the two results ("The office", "The experts").
      const roomName = resultName(live, 'room');
      if (pill) {
        const said = right ? answerHeading(live) : reveal && room ? roomHeading(live) : 'Put them in order';
        // A longer name after T would run out of the box: fit it again.
        if (pill.textContent !== said) {
          pill.textContent = said;
          if (pillSet && el.parentElement) fitText(el.parentElement);
        }
        pillSet = true;
      }
      const rightPlace = (i) => (right && right.includes(i) ? right.indexOf(i) + 1 : null);
      const placeOf = (i) => (right ? rightPlace(i) : room ? room.places[i] : null);
      if (body && reveal && verdict) {
        // First place first, and in from the bottom: first place lands last.
        const far = 999;
        const sorted = inBox.slice().sort((a, b) => (placeOf(a.i) ?? far) - (placeOf(b.i) ?? far) || (room ? room.places[a.i] - room.places[b.i] : 0) || a.i - b.i);
        const key = sorted.map((c) => c.i).join();
        if (key !== order) {
          order = key;
          body.replaceChildren(...sorted.map((c) => c.el));
          // About two seconds from last place to second, then a beat, then the winner.
          const step = Math.min(450, 2400 / Math.max(1, sorted.length - 1));
          sorted.forEach((c, k) => {
            c.el.classList.add('tm-rise');
            c.el.style.setProperty('--d', `${Math.round((sorted.length - 1 - k) * step + (k === 0 && sorted.length > 1 ? 500 : 0))}ms`);
          });
        }
      }
      for (const c of inBox) {
        const p = placeOf(c.i);
        // In the right order, where the room put each one sits under its right
        // place, not beside the name: in a narrow box the name needs the width.
        c.place.replaceChildren(p ? ordinal(p) : right ? '–' : '', right && room ? h('small', { text: `${underName(roomName)} ${ordinal(room.places[c.i])}` }) : '');
        c.num.textContent = room && !right ? showTotal(room.totals[c.i]) : '';
        c.el.classList.toggle('tm-shown', !!verdict);
        c.el.classList.toggle('tm-right', reveal && p === 1);
      }
      if (tags) {
        // In the editor every label shows, so it can be seen and dragged.
        const editing = !!ctx.editing;
        tags.forEach((t, i) => {
          const place = placeOf(i);
          t.place.textContent = place ? ordinal(place) : editing ? '–' : '';
          t.mark.textContent = reveal && place === 1 ? '★' : '';
          t.room.textContent = right && room ? `${underName(roomName)} ${ordinal(room.places[i])}` : '';
          t.el.classList.toggle('tm-shown', !!place || editing);
          t.el.classList.toggle('tm-right', reveal && place === 1);
        });
        // The room's order, then the right one: each lands last place first, about
        // two seconds to second place, a beat, then first place. Not in the editor.
        const key = reveal && verdict ? `${right ? 'right' : 'room'}:${tags.map((_, i) => placeOf(i)).join()}` : '';
        if (key && key !== landed && !editing) {
          landed = key;
          const worst = Math.max(1, ...tags.map((_, i) => placeOf(i) || 1));
          const step = Math.min(450, 2400 / Math.max(1, worst - 1));
          tags.forEach((t, i) => {
            const place = placeOf(i) || worst;
            t.card.classList.remove('tm-rise');
            void t.card.offsetWidth;
            t.card.style.setProperty('--d', `${Math.round((worst - place) * step + (place === 1 && worst > 1 ? 500 : 0))}ms`);
            t.card.classList.add('tm-rise');
          });
        }
        placeTags();
      }
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
    place: placeTags,
  };
}

function buildChoice(view, ctx) {
  const cfg = view.cfg;
  const timed = cfg.seconds > 0;
  const ring = timed && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const reveal = view.phase === 'reveal';
  const display = cfg.display;
  const scored = isScored(cfg.type);
  const live = cfg.live === 'tally' || cfg.type === 'poll'; // a poll is for watching; a quiz would give the game away

  let body;
  let cards = null;
  let pie = null;
  let rows = null;

  if (reveal && display === 'pie') {
    pie = buildPie(cfg);
    body = pie.el;
  } else if (reveal && display === 'table') {
    rows = cfg.options.map((label, i) => {
      const votes = h('td', { class: 'tm-td-n' });
      const share = h('td', { class: 'tm-td-n' });
      const tr = h('tr', null, h('td', { class: 'tm-td-l', text: LETTERS[i] }), h('td', { class: 'tm-td-t', text: label }), votes, share);
      return { tr, votes, share };
    });
    body = h(
      'div',
      { class: 'tm-table-wrap', 'data-fit-box': true },
      h('table', { class: 'tm-table', 'data-fit': true }, h('thead', null, h('tr', null, h('th'), h('th', { text: 'Answer' }), h('th', { text: 'Votes' }), h('th', { text: 'Share' }))), h('tbody', null, rows.map((r) => r.tr))),
    );
  } else {
    // Shown on the slide: an option with a place there is drawn there (below).
    // One with no place yet is an ordinary card in the box, so nothing goes missing.
    cards = cfg.options.map((label, i) => (display === 'pins' && cfg.pins?.[i] ? null : optionCard(i, label)));
    const layout = display === 'bars' || display === 'pins' ? 'stack' : 'grid';
    const inBox = cards.filter(Boolean);
    body = inBox.length ? h('div', { class: `tm-opts tm-opts-${layout} tm-n${inBox.length}` }, inBox.map((c) => c.el)) : null;
  }
  const pins = display === 'pins' && !pie && !rows ? cfg.options.map((_, i) => (cfg.pins?.[i] ? optionPin(i) : null)) : null;
  const layer = pins?.some(Boolean) ? h('div', { class: 'tm-pins' }, pins.filter(Boolean).map((p) => p.el)) : null;
  // Each pin is placed as a share of the module's own box, from where the box
  // and the pin's shape sit on the slide. The host says where they are now;
  // failing that, where they were last seen.
  const placePins = pinPlacer(pins, cfg, ctx);

  const el = h('div', { class: `tm-in tm-q tm-phase-${view.phase} tm-display-${display}${reveal ? ' tm-revealed' : ''}${scored ? ' tm-scored' : ''}${body ? '' : ' tm-headonly'}` }, head.el, body, layer);

  return {
    el,
    update(v) {
      head.answered.textContent = v.phase === 'reveal' ? `${v.answered} answered` : answeredText(v);
      const total = v.counts.reduce((a, b) => a + b, 0);
      const top = Math.max(1, ...v.counts);
      const showNumbers = v.phase === 'reveal' || (live && v.phase !== 'armed');
      if (pins) {
        pins.forEach((p, i) => {
          if (!p) return;
          const n = v.counts[i] || 0;
          const isRight = v.phase === 'reveal' && scored && rightAt(v, i);
          p.el.classList.toggle('tm-right', isRight);
          p.el.classList.toggle('tm-wrong', v.phase === 'reveal' && scored && !isRight);
          p.el.classList.toggle('tm-lead', v.phase === 'reveal' && !scored && n === top && n > 0);
          p.fill.style.height = `${showNumbers ? (n / top) * 100 : 0}%`;
          p.num.textContent = showNumbers ? String(n) : '';
          p.mark.textContent = isRight ? '✓' : '';
        });
        placePins();
      }
      if (cards) {
        cards.forEach((c, i) => {
          if (!c) return;
          const n = v.counts[i] || 0;
          const isRight = v.phase === 'reveal' && scored && rightAt(v, i);
          const isLead = v.phase === 'reveal' && !scored && n === top && n > 0;
          c.el.classList.toggle('tm-right', isRight);
          c.el.classList.toggle('tm-wrong', v.phase === 'reveal' && scored && !isRight);
          c.el.classList.toggle('tm-lead', isLead);
          c.el.classList.toggle('tm-shown', showNumbers);
          // In the bar layouts the fill is the bar. Elsewhere it stays empty.
          const bar = showNumbers && display !== 'numbers' ? (n / top) * 100 : 0;
          c.fill.style.width = `${bar}%`;
          c.num.textContent = showNumbers ? (display === 'numbers' ? String(n) : `${n}`) : '';
          c.mark.textContent = isRight ? '✓' : '';
        });
      }
      if (pie) pie.update(v, scored);
      if (rows) {
        rows.forEach((r, i) => {
          const n = v.counts[i] || 0;
          r.votes.textContent = String(n);
          r.share.textContent = `${pct(n, total)}%`;
          r.tr.classList.toggle('tm-right', scored && rightAt(v, i));
        });
      }
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
    place: placePins,
  };
}

// Each option's shade in the pie, as a share (0 to 1) of the way from the accent
// to the text colour. Up to six they run in order. Beyond that neighbouring
// shades would be too close to tell apart, so they are dealt out of order:
// each slice is a long way from the one beside it.
function shade(i, n) {
  if (n <= 1) return 0;
  if (n <= 6) return i / (n - 1);
  let step = Math.ceil(n * 0.4);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  while (gcd(step, n) !== 1) step++;
  return ((i * step) % n) / (n - 1);
}

function buildPie(cfg) {
  const svg = h('svg', { viewBox: '0 0 100 100', class: 'tm-pie-svg' });
  const many = cfg.options.length;
  const tint = (i) => ({ '--i': String(i), '--k': shade(i, many).toFixed(3) });
  const legend = cfg.options.map((label, i) => {
    const n = h('span', { class: 'tm-leg-n' });
    const row = h('div', { class: 'tm-leg' }, h('span', { class: 'tm-leg-dot', style: tint(i) }), h('span', { class: 'tm-leg-l', text: LETTERS[i] }), h('span', { class: 'tm-leg-t', text: label }), n);
    return { row, n };
  });
  const el = h('div', { class: 'tm-pie', 'data-fit-box': true }, h('div', { class: 'tm-pie-art' }, svg), h('div', { class: `tm-pie-legend${many > 6 ? ' tm-legend-2' : ''}`, 'data-fit': true }, legend.map((l) => l.row)));
  return {
    el,
    update(v, scored) {
      const total = v.counts.reduce((a, b) => a + b, 0);
      const slices = [];
      let at = 0;
      v.counts.forEach((n, i) => {
        if (!total || !n) return;
        const frac = n / total;
        const cls = `tm-slice${scored && rightAt(v, i) ? ' tm-right' : ''}`;
        if (frac >= 0.9999) {
          slices.push(h('circle', { cx: 50, cy: 50, r: 34, class: cls, style: tint(i) }));
        } else {
          const a0 = at * 2 * Math.PI - Math.PI / 2;
          const a1 = (at + frac) * 2 * Math.PI - Math.PI / 2;
          const p = (a, r) => `${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)}`;
          slices.push(h('path', { class: cls, style: tint(i), d: `M ${p(a0, 34)} A 34 34 0 ${frac > 0.5 ? 1 : 0} 1 ${p(a1, 34)}`, fill: 'none' }));
        }
        at += frac;
      });
      if (!slices.length) slices.push(h('circle', { cx: 50, cy: 50, r: 34, class: 'tm-slice tm-slice-empty' }));
      svg.replaceChildren(...slices);
      legend.forEach((l, i) => {
        const n = v.counts[i] || 0;
        l.n.textContent = `${n} · ${pct(n, total)}%`;
        l.row.classList.toggle('tm-right', scored && rightAt(v, i));
        l.row.classList.toggle('tm-wrong', scored && !rightAt(v, i));
      });
    },
  };
}

function buildCloud(view, ctx) {
  const cfg = view.cfg;
  const ring = cfg.seconds > 0 && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const cloud = h('div', { class: 'tm-cloud' });
  const el = h('div', { class: `tm-in tm-q tm-cloudq tm-phase-${view.phase}` }, head.el, cloud);
  const made = new Map();
  return {
    el,
    update(v) {
      head.answered.textContent = v.phase === 'armed' ? 'Get ready' : `${v.answered} ${v.answered === 1 ? 'word' : 'words'} in`;
      const words = v.words.slice(0, 40);
      const top = Math.max(1, ...words.map((w) => w.n));
      // Biggest in the middle, the rest falling away on both sides.
      const order = [];
      words.forEach((w, i) => (i % 2 ? order.push(w) : order.unshift(w)));
      const keep = new Set();
      order.forEach((w, i) => {
        const key = w.w.toLowerCase();
        keep.add(key);
        let node = made.get(key);
        if (!node) {
          node = h('span', { class: 'tm-word tm-pop', text: w.w });
          node.addEventListener('animationend', () => node.classList.remove('tm-pop'), { once: true });
          made.set(key, node);
          cloud.append(node);
        }
        const scale = 0.55 + 0.45 * Math.sqrt(w.n / top) + (w.n === top && top > 1 ? 0.35 : 0);
        node.style.setProperty('--s', scale.toFixed(3));
        node.classList.toggle('tm-word-top', w.n === top && top > 1);
        // Placed by CSS order, not by moving the node: moving it would restart
        // its entrance and leave a busy cloud permanently mid-fade.
        node.style.order = String(i);
      });
      for (const [key, node] of made) {
        if (!keep.has(key)) {
          node.remove();
          made.delete(key);
        }
      }
      fitCloud(cloud);
    },
    refit() {
      fitCloud(cloud);
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
  };
}

// Type the answer. While it is open the box says to type on the phones and
// counts who has; nothing typed shows, as a right answer on the screen would
// give it away. At the reveal the answer lands, with how many got it, and
// below it what the room typed, most typed first, the right ones marked.
function buildTyped(view, ctx) {
  const cfg = view.cfg;
  const ring = cfg.seconds > 0 && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const reveal = view.phase === 'reveal';
  const answer = h('span', { 'data-fit': true });
  const got = h('div', { class: 'tm-typed-got' });
  const list = h('div', { class: 'tm-opts tm-opts-stack' });
  const body = reveal
    ? h('div', { class: 'tm-typed' }, h('div', { class: 'tm-typed-top', 'data-fit-box': true }, h('div', { class: 'tm-typed-answer' }, answer), got), list)
    : h('div', { class: 'tm-typed' }, h('div', { class: 'tm-typed-wait', 'data-fit-box': true }, h('span', { 'data-fit': true, text: 'Type your answer on your phone' })));
  const el = h('div', { class: `tm-in tm-q tm-typedq tm-phase-${view.phase}${reveal ? ' tm-revealed' : ''}` }, head.el, body);
  let shown = null;
  return {
    el,
    update(v) {
      head.answered.textContent = v.phase === 'reveal' ? `${v.answered} answered` : answeredText(v);
      if (!reveal) return;
      answer.textContent = v.correct || 'No answer set';
      got.textContent = `${v.gotIt || 0} of ${v.answered} got it`;
      const rows = (v.typed || []).slice(0, 5);
      const sig = rows.map((r) => `${r.w}:${r.n}:${r.ok}`).join('|');
      if (sig === shown) return;
      const again = shown !== null;
      shown = sig;
      const most = Math.max(1, ...rows.map((r) => r.n));
      list.className = `tm-opts tm-opts-stack tm-n${Math.max(1, rows.length)}`;
      list.replaceChildren(
        ...rows.map((r) => {
          const fill = h('div', { class: 'tm-fill', style: { width: `${(r.n / most) * 100}%` } });
          return h('div', { class: `tm-opt tm-shown ${r.ok ? 'tm-right' : 'tm-wrong'}`, 'data-fit-box': true }, fill, h('div', { class: 'tm-opt-text' }, h('span', { 'data-fit': true, text: r.w })), h('div', { class: 'tm-opt-num', text: String(r.n) }), h('div', { class: 'tm-opt-mark', text: r.ok ? '✓' : '' }));
        }),
      );
      // Late answers within the grace period change the list: fit it again.
      if (again && el.parentElement) fitText(el.parentElement);
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
  };
}

// An open answer. While it is open the box says to answer on the phones and
// counts who has; nothing shows, so the presenter sees each answer no sooner
// than the room (unless the slide is set to show them as they come). At the
// reveal they land as a wall of cards, in the order they came. Where the host
// allows it (the stage), clicking a card takes it off the screen.
const WALL_MAX = 24;
function buildOpen(view, ctx) {
  const cfg = view.cfg;
  const ring = cfg.seconds > 0 && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const showing = view.phase === 'reveal' || cfg.live === 'tally';
  const wall = h('div', { class: 'tm-wall' });
  const more = h('div', { class: 'tm-wall-more' });
  const body = showing
    ? h('div', { class: 'tm-open' }, wall, more)
    : h('div', { class: 'tm-open' }, h('div', { class: 'tm-typed-wait', 'data-fit-box': true }, h('span', { 'data-fit': true, text: 'Answer on your phone' })));
  const el = h('div', { class: `tm-in tm-q tm-openq tm-phase-${view.phase}${ctx.onHide ? ' tm-hideable' : ''}` }, head.el, body);
  const made = new Map();
  let shown = '';
  return {
    el,
    update(v) {
      head.answered.textContent = answeredText(v);
      if (!showing) return;
      const cards = (v.cards || []).slice(0, WALL_MAX);
      const sig = cards.map((c) => `${c.pid}:${c.w}:${c.by || ''}`).join('|');
      if (sig === shown) return;
      shown = sig;
      const extra = (v.cards || []).length - cards.length;
      more.textContent = extra > 0 ? `+${extra} more` : '';
      // As many columns as reads well: one for a couple, up to four for a crowd.
      const n = cards.length;
      const cols = n <= 2 ? 1 : n <= 6 ? 2 : n <= 12 ? 3 : 4;
      wall.style.setProperty('--cols', String(cols));
      wall.style.setProperty('--rows', String(Math.max(1, Math.ceil(n / cols))));
      const keep = new Set();
      for (const c of cards) {
        keep.add(c.pid);
        let node = made.get(c.pid);
        if (!node) {
          node = h('div', { class: 'tm-card tm-pop', 'data-fit-box': true, 'data-pid': c.pid }, h('span', { 'data-fit': true, text: c.w }), c.by ? h('small', { text: c.by }) : null);
          node.addEventListener('animationend', () => node.classList.remove('tm-pop'), { once: true });
          if (ctx.onHide) {
            node.title = 'Click to take this off the screen';
            node.addEventListener('click', () => ctx.onHide(c.pid));
          }
          made.set(c.pid, node);
          wall.append(node);
        }
      }
      for (const [pid, node] of made) {
        if (!keep.has(pid)) {
          node.remove();
          made.delete(pid);
        }
      }
      if (el.parentElement) fitText(el.parentElement);
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
  };
}

// Finds the largest type size at which every word still sits inside the box,
// so three words fill the space and thirty still fit. Measured with the size
// transition switched off, then applied with it on so the change animates.
function fitCloud(cloud) {
  const words = [...cloud.children];
  if (!words.length) return;
  const before = cloud.style.getPropertyValue('--k') || '1';
  cloud.classList.add('tm-measuring');
  const fits = () => {
    const box = cloud.getBoundingClientRect();
    for (const w of words) {
      const r = w.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) return false;
    }
    return true;
  };
  let lo = 0.3;
  let hi = 3;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    cloud.style.setProperty('--k', mid.toFixed(3));
    if (fits()) lo = mid;
    else hi = mid;
  }
  cloud.style.setProperty('--k', before);
  cloud.classList.remove('tm-measuring');
  void cloud.offsetWidth;
  cloud.style.setProperty('--k', (lo * 0.92).toFixed(3));
}

// ---- guess the number ------------------------------------------------------

// A number line from the least a phone can say to the most. Each guess is a
// dot on it, stacked where guesses crowd. At the reveal the answer drops in as
// a marker, the dots that won light up, and the winners are named below.
const COLUMNS = 41; // how finely guesses are gathered into stacks

function buildNumber(view, ctx) {
  const cfg = view.cfg;
  const ring = cfg.seconds > 0 && !cfg.hide?.clock ? timerRing() : null;
  const head = header(view, ring, ctx);
  const span = cfg.max - cfg.min || 1;
  const at = (n) => Math.min(1, Math.max(0, (n - cfg.min) / span));
  const dots = h('div', { class: 'tm-num-dots' });
  const label = h('div', { class: 'tm-num-mark-label' });
  const mark = h('div', { class: 'tm-num-mark' }, label, h('div', { class: 'tm-num-mark-line' }));
  const axis = h(
    'div',
    { class: 'tm-num-axis' },
    [0, 0.25, 0.5, 0.75, 1].map((f) => h('div', { class: 'tm-num-tick', style: { left: `${f * 100}%` }, text: showNumber(cfg.min + Math.round((f * span) / cfg.step) * cfg.step) })),
  );
  const winners = h('div', { class: 'tm-num-winners' });
  const el = h('div', { class: `tm-in tm-q tm-numq tm-phase-${view.phase}${view.phase === 'reveal' ? ' tm-revealed' : ''}` }, head.el, h('div', { class: 'tm-num-plot' }, dots, mark, axis), winners);
  let signature = '';
  return {
    el,
    update(v) {
      const reveal = v.phase === 'reveal';
      head.answered.textContent = v.phase === 'armed' ? 'Get ready' : reveal ? `${v.answered} ${v.answered === 1 ? 'guess' : 'guesses'}` : v.playerCount ? `${v.answered} of ${v.playerCount} have guessed` : `${v.answered} guessed`;
      const guesses = v.guesses || [];
      const sig = `${reveal}|${v.answer}|${guesses.map((g) => `${g.n}:${g.points || 0}`).join(',')}|${(v.closest || []).map((w) => w.name).join(',')}`;
      if (sig === signature) return;
      signature = sig;
      // Gather into columns, the winners at the foot of each stack where they are seen first.
      const stacks = new Map();
      for (const g of [...guesses].sort((a, b) => (b.points || 0) - (a.points || 0))) {
        const col = Math.round(at(g.n) * (COLUMNS - 1));
        const stack = stacks.get(col) || [];
        stack.push(g);
        stacks.set(col, stack);
      }
      const tallest = Math.max(1, ...[...stacks.values()].map((st) => st.length));
      dots.style.setProperty('--rows', String(Math.max(6, tallest)));
      dots.replaceChildren(
        ...[...stacks].flatMap(([col, stack]) =>
          stack.map((g, row) => h('div', { class: `tm-num-dot${g.points ? ` tm-won-${g.points > 0 ? Math.min(3, Math.max(1, Math.round(g.points / (cfg.points || 1)))) : 0}` : ''}`, style: { left: `${(col / (COLUMNS - 1)) * 100}%`, '--row': String(row) } })),
        ),
      );
      if (reveal && typeof v.answer === 'number') {
        const x = at(v.answer);
        mark.style.left = `${x * 100}%`;
        label.textContent = showNumber(v.answer, cfg.unit);
        label.style.transform = `translateX(${-x * 100}%)`; // never off either end of the line
      }
      const named = (v.closest || []).slice(0, 4);
      const more = (v.closest || []).length - named.length;
      winners.replaceChildren(
        ...[
        ...named.map((w, i) => h('div', { class: 'tm-num-winner tm-rise', style: { '--d': `${500 + i * 140}ms` } }, h('b', { text: `+${w.points}` }), h('span', { class: 'tm-num-who', text: w.name }), h('span', { class: 'tm-num-said', text: showNumber(w.n, cfg.unit) }))),
        more > 0 ? h('div', { class: 'tm-num-winner tm-num-more tm-rise', style: { '--d': '1100ms' }, text: `and ${more} more` }) : null,
        reveal && !(v.closest || []).length ? h('div', { class: 'tm-num-winner tm-num-more', text: 'Nobody guessed' }) : null,
        ].filter(Boolean),
      );
    },
    tick(now, v) {
      if (!ring) return;
      const total = cfg.seconds * 1000;
      if (v.phase === 'armed') ring.set(total, total);
      else if (v.phase === 'reveal' || v.phase === 'locking') ring.set(0, total);
      else ring.set(Math.max(0, (v.endsAt || 0) - now), total);
    },
  };
}

// ---- leaderboard -----------------------------------------------------------

const placeWord = (n) => ['1st', '2nd', '3rd'][n - 1] || `${n}th`;

function buildBoard(view) {
  return view.cfg.final ? buildPodium(view) : buildStandings(view);
}

// The standings. If a leaderboard has been up before in this session, the rows
// start where they stood then, the scores count up to what they are now, and
// the rows slide to their new places. The first one of a session, and one
// where nothing has changed, simply rises in.
function buildStandings(view) {
  const cfg = view.cfg;
  const list = h('div', { class: 'tm-board-list' });
  const foot = h('div', { class: 'tm-board-foot' });
  const el = h('div', { class: 'tm-in tm-board' }, h('div', { class: 'tm-kicker', text: cfg.title || 'Leaderboard' }), list, foot);
  let signature = '';
  let timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  return {
    el,
    update(v) {
      const rows = (v.board || []).slice(0, cfg.top);
      // A board of the put-in-order rounds alone, before any has been played and scored.
      const unplayed = !!cfg.only && v.played === 0;
      const sig = `${unplayed}|${rows.map((r) => `${r.pid}:${r.score}`).join('|')}`;
      if (sig === signature) return;
      signature = sig;
      timers.forEach(clearTimeout);
      timers = [];
      list.style.setProperty('--rows', String(Math.max(3, rows.length)));
      if (!rows.length || unplayed) {
        list.replaceChildren(h('div', { class: 'tm-board-empty', text: !rows.length ? 'Nobody has joined yet' : 'No put-in-order round scored yet' }));
        foot.textContent = '';
        return;
      }
      const was = (r) => v.before?.[r.pid] || null; // [rank, score] last time
      const moved = !!v.before && rows.some((r) => !was(r) || was(r)[0] !== r.rank || was(r)[1] !== r.score);
      // Where each of these rows stood last time, among themselves. Someone new goes below.
      const then = moved ? [...rows].sort((a, b) => (was(a)?.[0] ?? 1e6 + a.rank) - (was(b)?.[0] ?? 1e6 + b.rank)) : rows;
      const parts = rows.map((r, i) => {
        const gain = r.score - (was(r)?.[1] ?? 0);
        const up = was(r) ? was(r)[0] - r.rank : 0;
        const rank = h('span', { class: 'tm-row-rank', text: String(moved ? was(r)?.[0] ?? '' : r.rank) });
        const score = h('span', { class: 'tm-row-score', text: String(moved ? was(r)?.[1] ?? 0 : r.score) });
        const gained = moved && gain > 0 ? h('span', { class: 'tm-row-gain', text: `+${gain}` }) : null;
        const shift = moved && up !== 0 ? h('span', { class: `tm-row-move ${up > 0 ? 'tm-up' : 'tm-down'}`, text: `${up > 0 ? '▲' : '▼'}${Math.abs(up)}` }) : null;
        const row = h(
          'div',
          { class: `tm-row ${moved ? 'tm-row-held' : `tm-rise${i === 0 ? ' tm-row-first' : ''}`}`, style: { '--d': `${i * 90}ms`, '--from': String(then.indexOf(r) - i) } },
          rank,
          h('span', { class: 'tm-row-name', text: r.name }),
          shift,
          gained,
          score,
        );
        return { r, row, rank, score, gained, shift, start: was(r)?.[1] ?? 0 };
      });
      list.replaceChildren(...parts.map((p) => p.row));

      const climber = moved ? [...(v.board || [])].map((r) => ({ r, up: was(r) ? was(r)[0] - r.rank : 0 })).sort((a, b) => b.up - a.up)[0] : null;
      const notes = [];
      if (climber && climber.up > 0) notes.push(h('span', null, 'Biggest climber ', h('b', { text: climber.r.name }), ` ▲${climber.up}`));
      if (v.fastest) notes.push(h('span', null, 'Fastest finger ', h('b', { text: v.fastest.name }), ` ${(v.fastest.ms / 1000).toFixed(1)}s`));
      if (v.playerCount > rows.length) notes.push(h('span', { text: `Top ${rows.length} of ${v.playerCount}` }));
      foot.replaceChildren(...notes);
      foot.classList.toggle('tm-foot-wait', moved);
      if (!moved) return;

      // 1. the scores count up, and what each gained shows
      later(700, () => {
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / 800);
          for (const p of parts) p.score.textContent = String(Math.round(p.start + (p.r.score - p.start) * k));
          if (k < 1) timers.push(setTimeout(step, 40));
        };
        step();
        for (const p of parts) p.gained?.classList.add('tm-on');
      });
      // 2. the rows slide to where they stand now
      later(1900, () => {
        parts.forEach((p, i) => {
          p.row.classList.remove('tm-row-held');
          p.row.classList.add('tm-row-settle');
          p.row.classList.toggle('tm-row-first', i === 0);
          p.rank.textContent = String(p.r.rank);
          p.score.textContent = String(p.r.score);
          p.shift?.classList.add('tm-on');
        });
      });
      // 3. and the footnotes arrive
      later(2800, () => foot.classList.remove('tm-foot-wait'));
    },
  };
}

// The final leaderboard: a podium, covered at first. Each press of T uncovers
// a place, third first. Everyone below the podium is listed from the start.
function buildPodium(view) {
  const cfg = view.cfg;
  // In the order they stand: second, first, third.
  const places = [2, 1, 3].map((place) => {
    const name = h('span', { 'data-fit': true });
    const score = h('div', { class: 'tm-pod-score' });
    const tag = place === 1 ? h('div', { class: 'tm-pod-tag', text: 'Winner' }) : null;
    const block = h('div', { class: `tm-pod tm-pod-${place}` }, h('div', { class: 'tm-pod-who' }, tag, h('div', { class: 'tm-pod-name', 'data-fit-box': true }, name), score), h('div', { class: 'tm-pod-step', text: placeWord(place) }));
    return { place, block, name, score };
  });
  const rest = h('div', { class: 'tm-pod-rest' });
  const podium = h('div', { class: 'tm-podium' }, places.map((p) => p.block));
  const el = h('div', { class: 'tm-in tm-board tm-board-final' }, h('div', { class: 'tm-kicker', text: cfg.title || 'Leaderboard' }), podium, rest);
  let signature = '';
  return {
    el,
    update(v) {
      const board = v.board || [];
      const size = v.podium?.size ?? Math.min(3, board.length);
      const shown = v.podium?.shown ?? size;
      const sig = `${shown}/${size}|${board.slice(0, Math.max(3, cfg.top)).map((r) => `${r.pid}:${r.score}`).join('|')}`;
      if (sig === signature) return;
      signature = sig;
      for (const p of places) {
        const r = board[p.place - 1];
        // With three places, one press shows third, two show second, three show first.
        const open = !!r && p.place > size - shown;
        p.block.classList.toggle('tm-pod-none', p.place > Math.max(size, 1));
        p.block.classList.toggle('tm-pod-open', open);
        p.name.textContent = open ? r.name : '';
        p.score.textContent = open ? String(r.score) : '';
      }
      el.classList.toggle('tm-podium-done', size > 0 && shown >= size);
      rest.replaceChildren(...board.slice(3, cfg.top).map((r) => h('div', { class: 'tm-pod-also' }, h('span', { class: 'tm-row-rank', text: String(r.rank) }), h('span', { class: 'tm-row-name', text: r.name }), h('span', { class: 'tm-row-score', text: String(r.score) }))));
      if (!board.length) rest.replaceChildren(h('div', { class: 'tm-board-empty', text: 'Nobody has joined yet' }));
      fitText(el);
    },
  };
}

// ---- mounting --------------------------------------------------------------

function structure(view, ctx) {
  if (!view.cfg) return 'none';
  const c = view.cfg;
  const parts = [view.slideId, view.kind, JSON.stringify(view.theme), ctx.joinBase];
  if (view.kind === 'join') parts.push(view.room, c.headline);
  if (view.kind === 'leaderboard') parts.push(c.title, c.top, c.final);
  if (view.kind === 'question') {
    // Voting and the buzzer share a build so the clock runs on undisturbed.
    const stage = view.phase === 'reveal' ? 'reveal' : view.phase === 'armed' ? 'armed' : 'live';
    parts.push(stage, c.type, c.display, c.text, c.showText, c.seconds, c.live, c.points, c.multi, c.min, c.max, c.step, c.answer, c.unit, Object.keys(c.hide || {}).join(), (c.pins || []).map((p) => p?.shapeId || '').join(), c.options.join('\u0001'), (c.accepts || []).join('\u0001'), c.byline, view.room, !!ctx.joinHint);
  }
  return parts.join('\u0002');
}

// Returns a handle: update(view) on every engine change, tick(now) on every
// frame, refit() when the box changes size.
export function mountModule(root, ctx = {}) {
  root.classList.add('tm');
  let sig = null;
  let mod = null;
  let last = null;
  return {
    update(view) {
      last = view;
      const next = structure(view, ctx);
      if (next !== sig) {
        sig = next;
        mod = null;
        root.replaceChildren();
        root.classList.toggle('tm-empty', !view.cfg);
        if (view.cfg) {
          applyTheme(root, view.theme, ctx.slideFill);
          if (view.kind === 'join') mod = buildJoin(view, ctx);
          else if (view.kind === 'leaderboard') mod = buildBoard(view);
          else if (view.kind === 'question') mod = isChoice(view.cfg.type) ? buildChoice(view, ctx) : view.cfg.type === 'rank' ? buildRank(view, ctx) : view.cfg.type === 'num' ? buildNumber(view, ctx) : view.cfg.type === 'text' ? buildTyped(view, ctx) : view.cfg.type === 'open' ? buildOpen(view, ctx) : buildCloud(view, ctx);
          if (mod) {
            root.append(mod.el);
            mod.update(view);
            mod.tick?.(ctx.now ? ctx.now() : Date.now(), view);
            fitText(root);
          }
        }
        return;
      }
      if (view.cfg) applyTheme(root, view.theme, ctx.slideFill);
      if (mod) {
        mod.el.className = mod.el.className.replace(/tm-phase-\w+/, `tm-phase-${view.phase}`);
        mod.update(view);
      }
    },
    tick(now) {
      if (mod?.tick && last) mod.tick(now, last);
    },
    refit() {
      if (!mod) return;
      fitText(root);
      mod.refit?.();
    },
    // Where the module's box sits on the slide, and where each pinned option's
    // shape does, as shares of the slide. Cheap enough to call every frame.
    place(frame, pins) {
      ctx.frame = frame;
      ctx.pins = pins;
      mod?.place?.();
    },
    setContext(patch) {
      Object.assign(ctx, patch);
      if (last) this.update(last);
    },
  };
}
