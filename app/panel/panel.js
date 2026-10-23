// The side panel: where a slide becomes a quiz slide.
//
// One screen, no tabs. It follows whichever slide is selected in the editor:
// a slide with nothing on it offers what it could be, as tiles; a slide with
// something shows only what that needs (the question, the answers, the timer)
// with the rest folded under More options. Below: whether the quiz is ready to
// present, and the game itself. Everything else lives behind the gear.
//
// It edits that slide's entry in the deck config and saves as you type. The
// preview at the top is the real module, drawn by the same code the big screen
// uses, fed with made-up votes.
//
// Opened as a plain web page (no extension APIs) it runs against a stand-in
// editor, which is how it is developed and tested: /panel/panel.html?pid=demo

import { typeIcon } from './icons.js';
import { BRAND, SITE } from '../shared/brand.js';
import { readQuiz, describeQuiz } from '../shared/quizformat.js';
import { store, KEYS } from '../shared/store.js';
import { DEFAULT_JOIN_BASE, DEFAULT_SYNC_BASE } from '../shared/config.js';
import { newSession } from '../shared/engine.js';
import { isChoice, isScored, ownsOptions, scores, ordinal, LIMITS, LETTERS, tagRect, RESULT_NAMES, resultName, roomHeading, answerHeading, underName } from '../shared/protocol.js';
import { mockView } from '../stage/mock.js';
import { normaliseDeck, normaliseSlide, newSlide, joinUrl, themeFor, DEFAULT_THEME, DEFAULT_PLACE, FULL_PLACE, FONT_CHOICES, HIDEABLE, NAME_LIMIT } from '../shared/deck.js';
import { mountModule } from '../stage/modules.js';

const inExtension = typeof chrome !== 'undefined' && !!chrome.tabs;
const query = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---- tiny DOM helper --------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const group = (title, ...kids) => h('div', { class: 'group' }, title ? h('h3', { text: title }) : null, ...kids);
// Puts what is given into a pane, skipping the gaps (null, false) that a list
// of optional parts leaves; replaceChildren would print them.
const fill = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter((p) => p !== null && p !== undefined && p !== false));
const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { text: label }), control, hint ? h('small', { text: hint }) : null);

function seg(options, value, onpick) {
  return h(
    'div',
    { class: 'seg', role: 'group' },
    options.map(([val, label]) => h('button', { type: 'button', 'aria-pressed': String(val === value), text: label, onclick: () => onpick(val) })),
  );
}

let toastTimer = 0;
function toast(text) {
  let el = document.querySelector('.toast');
  if (!el) document.body.append((el = h('div', { class: 'toast' })));
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

// ---- state ------------------------------------------------------------------

let editor = null; // what the content script says about the open deck
let pid = null;
let deck = null;
let session = null;
let backup = null; // { at, file } of the last safety copy written to disk
let shared = null; // how this deck stands against its shared copy
let kept = null; // a copy set aside when a newer one replaced it
let practice = null; // { bots } while a practice game with pretend players is on
let copyOf = null; // { key, title, count } when this empty deck looks like a copy of one with a quiz
let copyCheckedFor = ''; // the deck and slide it was last looked for
let bank = [];
let view = 'slide'; // the open tab: 'slide', 'quiz' or 'present'
let moreOpen = false; // whether More options is unfolded, kept across redraws
let changing = false; // the tiles are up to change what an existing slide is
let previewPhase = 'voting';
let picking = false;
let unwatch = [];
let drawnFor = ''; // which slide + shape of form is on screen
let saveTimer = 0;

const slideId = () => editor?.slideId || null;
const current = () => (deck && slideId() ? deck.slides[slideId()] || null : null);

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(KEYS.deck(pid), deck), 150);
}

function flush() {
  if (!deck || !pid) return;
  clearTimeout(saveTimer);
  store.set(KEYS.deck(pid), deck);
}

// Change the current slide's config. `redraw` rebuilds the form, for changes
// that alter which controls exist; otherwise only the preview is refreshed so
// the field being typed in keeps its focus.
function patch(fn, redraw = false) {
  const cfg = current();
  if (!cfg) return;
  fn(cfg);
  deck.slides[slideId()] = normaliseSlide(cfg);
  save();
  if (redraw) drawSlide(true);
  drawQuiz();
  drawBadge();
  drawPreview();
}

function patchTheme(fn) {
  fn(deck.theme);
  deck = normaliseDeck(deck, pid);
  save();
  drawPreview();
}

// ---- talking to the deck's tab ----------------------------------------------

async function askEditor() {
  if (!inExtension) {
    // Stand-in editor for development.
    const id = query.get('slide') || 'demo-q1';
    return {
      presentationId: query.get('pid') || 'demo',
      title: 'Demo deck',
      slideId: id,
      index: 5,
      presenting: false,
      shapes: [
        { id: 'g_title', x: 0.06, y: 0.08, w: 0.6, h: 0.2, text: ['Which planet is the biggest?', 'Put them in order, biggest first.'] },
        { id: 'g_box', x: 0.06, y: 0.36, w: 0.88, h: 0.56 },
        { id: 'g_photo', x: 0.7, y: 0.06, w: 0.24, h: 0.26 },
        { id: 'g_n1', x: 0.3, y: 0.94, w: 0.12, h: 0.04, text: ['Jupiter'] },
        { id: 'g_n2', x: 0.5, y: 0.94, w: 0.12, h: 0.04, text: ['Saturn'] },
        { id: 'g_n3', x: 0.69, y: 0.94, w: 0.12, h: 0.04, text: ['Neptune'] },
        { id: 'g_n4', x: 0.85, y: 0.94, w: 0.12, h: 0.04, text: ['Earth'] },
        { id: 'g_a', x: 0.32, y: 0.83, w: 0.04, h: 0.08, text: ['A'] },
        { id: 'g_page', x: 0.95, y: 0.95, w: 0.03, h: 0.03, text: ['66'] },
      ],
    };
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active?.id) return null;
    return await chrome.tabs.sendMessage(active.id, { t: 'tally:editor?' });
  } catch {
    return null;
  }
}

async function adopt(nextPid) {
  flush();
  for (const off of unwatch) off();
  unwatch = [];
  pid = nextPid;
  deck = normaliseDeck(await store.get(KEYS.deck(pid)), pid);
  session = await store.get(KEYS.session(pid));
  backup = await store.get(`tally.backup.${pid}`);
  shared = await store.get(`tally.sync.${pid}`);
  kept = await store.get(`tally.kept.${pid}`);
  practice = await store.get(`tally.practice.${pid}`);
  bank = (await store.get(`tally.bank.${pid}`)) || [];
  const settings = (await store.get(KEYS.settings)) || {};
  if (!deck.joinBase && settings.joinBase) deck.joinBase = settings.joinBase;
  unwatch.push(
    store.watch(KEYS.session(pid), (s) => {
      session = s;
      if (view === 'present') drawPresent();
    }),
  );
  unwatch.push(
    store.watch(`tally.backup.${pid}`, (b) => {
      backup = b;
      if (view === 'quiz') drawDeck();
    }),
  );
  unwatch.push(
    store.watch(`tally.sync.${pid}`, (s) => {
      shared = s;
      if (view === 'quiz') drawDeck();
    }),
  );
  unwatch.push(
    store.watch(`tally.practice.${pid}`, (p) => {
      practice = p;
      if (view === 'present') drawPresent();
    }),
  );
  unwatch.push(
    store.watch(`tally.kept.${pid}`, (k) => {
      kept = k;
      if (view === 'quiz') drawDeck();
    }),
  );
  // If the deck config changes underneath this panel (an import, or a second
  // window on the same deck), take the newer copy rather than saving over it.
  unwatch.push(
    store.watch(KEYS.deck(pid), (raw) => {
      const incoming = normaliseDeck(raw, pid);
      if (JSON.stringify(incoming) === JSON.stringify(normaliseDeck(deck, pid))) return;
      clearTimeout(saveTimer);
      deck = incoming;
      drawnFor = '';
      drawAll();
    }),
  );
  drawnFor = '';
}

async function poll() {
  const asked = await askEditor();
  // In Presenter view the window last focused is the notes window, which has no
  // Tally in it. While a slideshow is running, carry on as if it still is,
  // rather than tell the presenter to reload a page mid-talk.
  const info = asked?.presentationId ? asked : editor?.presenting ? editor : null;
  const ok = !!info?.presentationId;
  // While it runs, the panel shows nothing of the quiz: in Presenter view this
  // window can be on the projector, or shared to a call.
  const showing = ok && !!info.presenting;
  $('notice').hidden = ok;
  $('presenting').hidden = !showing;
  $('tabs').hidden = !ok || showing;
  document.querySelector('main').hidden = !ok || showing;
  if (!ok) {
    editor = null;
    return;
  }
  if (info !== asked) return;
  const slideChanged = info.slideId !== editor?.slideId;
  const shapesChanged = JSON.stringify(info.shapes) !== JSON.stringify(editor?.shapes) || info.fill !== editor?.fill;
  const selectionChanged = info.selected !== editor?.selected;
  editor = info;
  if (info.presentationId !== pid) await adopt(info.presentationId);
  $('deck-title').textContent = info.title || '';
  if (deck.title !== info.title && info.title) {
    deck.title = info.title;
    save();
  }
  if (slideChanged) {
    picking = false;
    changing = false;
    drawAll();
    checkCopy();
  } else if (shapesChanged) {
    drawPreview();
  }
  // Selecting a shape on the slide changes which placement buttons are offered.
  // That happens with the mouse on the canvas, never while typing in here.
  if (!slideChanged && selectionChanged && view === 'slide' && current()) drawSlide(true);
}

// ---- the preview ------------------------------------------------------------

const previewModule = mountModule($('preview-module'), { joinBase: DEFAULT_JOIN_BASE, joinHint: true });

function drawPreview() {
  // In settings the preview shows a sample question, so the look can be seen.
  // On a slide with nothing on it the tiles take its place.
  // The Quiz tab shows a sample question where the slide has none, so the look
  // can be seen; Present shows none: the slide itself is what matters there.
  const cfg = view === 'present' ? null : view === 'quiz' ? current() || sampleSlide() : changing ? null : current();
  $('preview-wrap').hidden = !cfg;
  const $shapes = $('preview-shapes');
  const $mod = $('preview-module');
  $('preview').classList.toggle('picking', picking);
  $shapes.replaceChildren(
    ...(editor?.shapes || []).map((s) =>
      h('button', {
        type: 'button',
        class: `shape${current()?.place.shapeId === s.id ? ' chosen' : ''}${current()?.reveal?.show.includes(s.id) ? ' arrives' : ''}${current()?.reveal?.hide.includes(s.id) ? ' leaves' : ''}`,
        title: 'Put the quiz box here',
        style: `left:${s.x * 100}%;top:${s.y * 100}%;width:${s.w * 100}%;height:${s.h * 100}%`,
        onclick: () => chooseShape(s),
      }),
    ),
  );
  // The preview is the open slide's own colour where the editor can see it,
  // white otherwise, and the module reads against it as it will on the slide.
  const slideFill = editor?.fill || '#ffffff';
  $('preview').style.background = slideFill;
  if (!cfg) {
    previewModule.update({ cfg: null });
    $('preview-bar').replaceChildren();
    return;
  }
  const p = cfg.place;
  Object.assign($mod.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` });
  previewModule.setContext({ joinBase: deck.joinBase || DEFAULT_JOIN_BASE, joinHint: deck.showJoin, slideFill });
  previewModule.update(mockView(deck, cfg, { phase: previewPhase, room: session?.room || 'KXTR', slideId: slideId() }));
  previewModule.refit();
  fill(
    $('preview-bar'),
    h('span', { text: picking ? 'Click a shape to put the quiz box on it' : view === 'quiz' && !current() ? 'A sample question, in this look' : cfg.kind === 'question' ? 'Preview, with made-up votes' : 'Preview, with made-up players' }),
    cfg.kind === 'question' && !picking
      ? seg([['voting', 'Voting'], ['reveal', 'Result']], previewPhase, (v) => {
          setPreviewPhase(v);
          drawPreview();
        })
      : null,
  );
}

// The module drawn on the slide in the editor shows the same phase as this
// preview, so the choice is shared through the store.
function setPreviewPhase(v) {
  previewPhase = v;
  store.set('tally.ui', { previewPhase: v });
}

function sampleSlide() {
  return newSlide('question', { text: 'Which planet has the most moons?', options: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'], correct: 1 });
}

function chooseShape(shape) {
  picking = false;
  patch((cfg) => {
    cfg.place = { shapeId: shape.id, x: shape.x, y: shape.y, w: shape.w, h: shape.h };
  }, true);
  toast('Placed on that shape. Move or resize the shape and the quiz box follows.');
}

// ---- this slide ---------------------------------------------------------------

// What a slide can be, as the tiles show it. Plain names: nobody should need to
// know what a module, a placeholder or a pin is.
const TILES = [
  { id: 'mc', name: 'Quiz question', blurb: 'Pick the right answer' },
  { id: 'tf', name: 'True or false', blurb: 'Two buttons, one right' },
  { id: 'text', name: 'Type the answer', blurb: 'Phones type it; close spellings count' },
  { id: 'poll', name: 'Poll', blurb: 'No right answer, just votes' },
  { id: 'cloud', name: 'Word cloud', blurb: 'Everyone sends a word' },
  { id: 'open', name: 'Open answer', blurb: 'Everyone writes a line; they show as cards' },
  { id: 'num', name: 'Guess the number', blurb: 'Closest guess wins' },
  { id: 'rank', name: 'Put in order', blurb: 'Everyone ranks them, then the right order' },
  { id: 'join', name: 'Join screen', blurb: 'The code and a QR code, so phones get in' },
  { id: 'leaderboard', name: 'Leaderboard', blurb: 'The scores so far, or the winner' },
];
const tileOf = (cfg) => TILES.find((t) => t.id === (cfg.kind === 'question' ? cfg.type : cfg.kind));

// The slide's own title, from the words on it: the top-most text in the top
// half of the slide, a paragraph or two of it. A new question starts from it.
function slideTitle() {
  const shapes = (editor?.shapes || []).filter((s) => s.text?.length && s.y < 0.5 && s.text.join(' ').length >= 4).sort((a, b) => a.y - b.y || a.x - b.x);
  let out = '';
  for (const p of shapes[0]?.text || []) {
    out = out ? `${out} ${p}` : p;
    if (out.length >= 12) break;
  }
  // A title and an instruction often share a box ("Which is biggest? Put them in
  // order."): the question is its first sentence, if that is more than a "Q1.".
  const first = out.match(/^(.{12,}?[?!.]+)(?=\s|$)/);
  return (first ? first[1] : out).slice(0, LIMITS.questionText);
}

// A row of short labels side by side on the slide (a lineup's names, a row of
// options): the most of them at one height, left to right. Single letters and
// bare numbers (A, B, C; a slide number) are not answers.
function slideRow() {
  const items = (editor?.shapes || [])
    .filter((s) => s.text?.length && s.text.length <= 2)
    .map((s) => ({ s, t: s.text.join(' ') }))
    .filter(({ t }) => t.length >= 2 && t.length <= 40 && !/^\d+$/.test(t));
  let best = [];
  for (const a of items) {
    const row = items.filter((b) => Math.abs(b.s.y - a.s.y) < 0.03);
    if (row.length > best.length) best = row;
  }
  return best.length >= 2 && best.length <= LIMITS.options ? best.sort((a, b) => a.s.x - b.s.x).map((r) => r.t) : null;
}

// A question made another type, keeping what still fits.
function switchType(c, type) {
  const from = c.type;
  c.type = type;
  if (ownsOptions(type) && (c.options.length < 2 || c.options.join() === 'True,False')) c.options = slideRow() || ['', '', '', ''];
  const open = (t) => t === 'cloud' || t === 'open';
  if (open(type) && (c.seconds === 15 || c.seconds === 20)) c.seconds = 0; // a word cloud or open answer stays open while answers come in
  if (open(from) && !open(type) && c.seconds === 0) c.seconds = 20;
  if (type === 'rank' && c.seconds > 0 && c.seconds < 30) c.seconds = 30; // putting a list in order takes longer than one tap
  if (type === 'text') {
    // A quiz question made a typed one: its right answer is the first that counts.
    const right = from === 'mc' ? String(c.options?.[c.correct] ?? '').trim() : '';
    if (!c.accepts?.length) c.accepts = right ? [right] : [''];
    if (c.seconds > 0 && c.seconds < 30) c.seconds = 30; // typing takes longer than a tap
  }
}

function newQuestion(type) {
  const c = newSlide('question', { index: editor.index || 0, text: slideTitle() });
  const row = ownsOptions(type) ? slideRow() : null;
  if (row) c.options = row.slice(0, LIMITS.options);
  switchType(c, type);
  return normaliseSlide(c);
}

function chooseTile(t) {
  const id = slideId();
  if (!id) return;
  const cfg = current();
  changing = false;
  if (t === 'join' || t === 'leaderboard') {
    if (cfg?.kind !== t) deck.slides[id] = normaliseSlide(newSlide(t, { index: editor.index || 0 }));
  } else if (cfg?.kind === 'question') {
    switchType(cfg, t);
    deck.slides[id] = normaliseSlide(cfg);
  } else {
    deck.slides[id] = newQuestion(t);
    const made = deck.slides[id];
    const fromSlide = ownsOptions(t) && made.options.some((o) => o.trim());
    if (made.text || fromSlide) toast(fromSlide ? 'The question and answers came from the slide. Check them.' : 'The question came from the slide’s title. Check it.');
  }
  save();
  drawAll();
}

function removeFromSlide() {
  const id = slideId();
  if (!id || !confirm(`Take ${BRAND} off this slide? What is set up on it goes too.`)) return;
  delete deck.slides[id];
  changing = false;
  save();
  drawAll();
}

// ---- a copied deck ----------------------------------------------------------------
//
// "Make a copy" of last month's deck keeps every slide's id, but the quiz is
// filed under the deck, so the copy arrives with none. If this deck has no quiz
// and another one in this Chrome has the slide that is open, offer it.

async function allQuizzes() {
  const found = [];
  if (inExtension) {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) if (k.startsWith('tally.deck.')) found.push([k, v]);
  } else {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('tally.deck.')) continue;
      try {
        found.push([k, JSON.parse(localStorage.getItem(k))]);
      } catch {}
    }
  }
  return found.filter(([k, v]) => k !== KEYS.deck(pid) && v?.slides && Object.keys(v.slides).length);
}

async function checkCopy() {
  const id = slideId();
  const key = `${pid}|${id}`;
  if (!deck || !id || Object.keys(deck.slides).length || key === copyCheckedFor) return;
  copyCheckedFor = key;
  if (await store.get(`tally.nocopy.${pid}`)) return;
  const hit = (await allQuizzes()).find(([, v]) => v.slides[id]);
  const next = hit ? { key: hit[0], title: hit[1].title || 'another deck', count: Object.values(hit[1].slides).filter((s) => s.kind === 'question').length } : null;
  if (JSON.stringify(next) === JSON.stringify(copyOf)) return;
  copyOf = next;
  drawSlide(true);
}

async function bringCopyAcross() {
  const raw = await store.get(copyOf.key);
  if (!raw) return;
  deck = normaliseDeck({ ...raw, presentationId: pid, title: deck.title }, pid);
  flush();
  toast(`Brought across ${copyOf.count} ${copyOf.count === 1 ? 'question' : 'questions'} from ${copyOf.title}.`);
  copyOf = null;
  drawAll();
}

function copyCard() {
  if (!copyOf || Object.keys(deck.slides).length) return null;
  return h(
    'div',
    { class: 'card copy-card' },
    h('b', { text: `This looks like a copy of “${copyOf.title}”.` }),
    h('div', { text: `That deck has a quiz (${copyOf.count} ${copyOf.count === 1 ? 'question' : 'questions'}). Bring it across to this one?` }),
    h(
      'div',
      { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', text: 'Bring the quiz across', onclick: bringCopyAcross }),
      h('button', { type: 'button', class: 'btn', text: 'No thanks', onclick: async () => { await store.set(`tally.nocopy.${pid}`, true); copyOf = null; drawSlide(true); } }),
    ),
  );
}

// The first time Pop Quiz opens anywhere. The Chrome Web Store requires the
// product itself (not only a privacy policy) to say what data leaves the
// computer, and to ask for a clear yes before it does. Quiz slides can't be
// made until then. A look and the join address ride along, with defaults.
let welcomed = true;
store.get('tally.welcomed').then((v) => {
  welcomed = !!v;
  if (!welcomed && deck) drawSlide(true);
});

function firstRun() {
  const done = async () => {
    welcomed = true;
    await store.set('tally.welcomed', Date.now());
    drawSlide(true);
  };
  const same = (p) => Object.entries(p.theme).every(([k, v]) => String(deck.theme[k]).toLowerCase() === v);
  return h(
    'div',
    { class: 'first-run' },
    h('h3', { text: `Welcome to ${BRAND}` }),
    h(
      'p',
      { class: 'consent' },
      'To run a game, Pop Quiz sends your questions, and the nicknames players type, through its relay to the players’ phones. The relay passes them on and keeps nothing. Your quiz itself stays in Chrome on this computer. ',
      h('a', { href: new URL('privacy/', SITE).href, target: '_blank', rel: 'noopener', text: 'Privacy policy' }),
    ),
    h('p', { class: 'hint', text: 'Pick a look and where phones join now, or later in the Quiz tab.' }),
    h(
      'div',
      { class: 'presets mini' },
      PRESETS.slice(0, 4).map((p) =>
        h('button', { type: 'button', class: 'preset', 'aria-pressed': String(same(p)), onclick: () => { patchTheme((t) => Object.assign(t, p.theme)); drawSlide(true); } }, h('span', { class: 'chips' }, h('i', { style: `background:${p.theme.accent}` }), h('i', { style: `background:${p.theme.card}` }), h('i', { style: `background:${p.theme.correct}` })), h('span', { text: p.name })),
      ),
    ),
    field(
      'Phones join at',
      h('input', {
        type: 'url',
        value: deck.joinBase,
        placeholder: DEFAULT_JOIN_BASE || 'https://…',
        oninput: (e) => {
          deck.joinBase = e.target.value.trim();
          save();
          store.set(KEYS.settings, { joinBase: deck.joinBase });
        },
      }),
    ),
    h('button', { type: 'button', class: 'btn primary', text: 'Agree and start', onclick: done }),
  );
}

function welcome() {
  return h(
    'div',
    { class: 'welcome' },
    h('h3', { text: 'Make this deck a live quiz' }),
    h('div', { class: 'hint', text: 'Everyone plays on their phone. No app, no sign-up.' }),
    h(
      'ol',
      null,
      h('li', { text: 'Pick a slide, then choose below what it does.' }),
      h('li', { text: 'Add a Join screen near the start, so people can get in.' }),
      h('li', { text: 'Present as normal. The questions run themselves.' }),
    ),
  );
}

function tiles(cfg) {
  const now = cfg ? tileOf(cfg)?.id : null;
  return h(
    'div',
    { class: 'tiles' },
    TILES.map((t) => h('button', { type: 'button', class: 'tile', 'aria-pressed': String(t.id === now), onclick: () => chooseTile(t.id) }, typeIcon(t.id), h('b', { text: t.name }), h('small', { text: t.blurb }))),
  );
}

function kindHead(cfg) {
  const t = tileOf(cfg);
  return h(
    'div',
    { class: 'kind-head' },
    typeIcon(t?.id, 26),
    h('div', { class: 'name' }, h('b', { text: t?.name || '' }), h('small', { text: t?.blurb || '' })),
    h('button', { type: 'button', class: 'btn small', text: 'Change', onclick: () => { changing = true; drawSlide(true); drawPreview(); } }),
    h('button', { type: 'button', class: 'btn small danger', text: 'Remove', onclick: removeFromSlide }),
  );
}

function bankPicker() {
  return field(
    'From your question list',
    h(
      'select',
      {
        onchange: (e) => {
          const q = bank[+e.target.value];
          if (!q) return;
          patch((c) => Object.assign(c, { type: q.type, text: q.text, options: q.options || c.options, correct: q.correct ?? 0, multi: q.multi, corrects: q.corrects, answer: q.answer, accepts: q.accepts, min: q.min, max: q.max, step: q.step, unit: q.unit, seconds: q.seconds ?? c.seconds, points: q.points ?? c.points, display: q.display || c.display }), true);
          toast(`Loaded question ${q.n}`);
        },
      },
      h('option', { value: '', text: 'Choose a question…' }),
      bank.map((q, i) => h('option', { value: String(i), text: `${q.n}. ${q.text}`.slice(0, 80) })),
    ),
  );
}

function questionField(cfg) {
  const title = slideTitle();
  return group(
    null,
    field(cfg.type === 'cloud' ? 'The question (phones send back a word)' : cfg.type === 'open' ? 'The question (phones write a line back)' : cfg.type === 'text' ? 'The question (phones type the answer)' : 'The question', h('textarea', { placeholder: 'What the phones show', maxlength: String(LIMITS.questionText), oninput: (e) => patch((c) => (c.text = e.target.value)) }, cfg.text)),
    title && title !== cfg.text.trim() ? h('button', { type: 'button', class: 'link suggest', title: title, text: `Use the slide’s title: ${title}`, onclick: () => patch((c) => (c.text = title), true) }) : null,
  );
}

function optionsGroup(cfg) {
  const scored = isScored(cfg.type);
  const ordering = cfg.type === 'rank';
  const row = slideRow();
  const rows = cfg.options.map((text, i) =>
    h(
      'div',
      { class: `opt-row${scored && (cfg.multi ? cfg.corrects.includes(i) : cfg.correct === i) ? ' correct' : ''}` },
      !scored
        ? null
        : cfg.multi
          ? h('input', { type: 'checkbox', title: 'A right answer', checked: cfg.corrects.includes(i), onchange: () => patch((c) => { const set = new Set(c.corrects); if (!set.delete(i)) set.add(i); if (!set.size) set.add(i); c.corrects = [...set]; }, true) })
          : h('input', { type: 'radio', name: 'correct', title: 'The right answer', checked: cfg.correct === i, onchange: () => patch((c) => (c.correct = i), true) }),
      h('span', { class: 'letter', text: LETTERS[i] }),
      h('input', { type: 'text', class: 'grow', value: text, placeholder: `${ordering ? 'Item' : 'Answer'} ${LETTERS[i]}`, maxlength: String(LIMITS.optionText), oninput: (e) => patch((c) => (c.options[i] = e.target.value)) }),
      cfg.options.length > 2 ? h('button', { type: 'button', class: 'x', title: 'Remove', text: '×', onclick: () => patch((c) => { c.options.splice(i, 1); c.pins?.splice(i, 1); if (c.correct >= c.options.length) c.correct = 0; else if (c.correct > i) c.correct--; if (c.corrects) c.corrects = c.corrects.filter((n) => n !== i).map((n) => (n > i ? n - 1 : n)); }, true) }) : null,
    ),
  );
  return group(
    ordering ? 'Items to put in order' : scored ? (cfg.multi ? 'Answers: tick every right one' : 'Answers: tick the right one') : 'Answers',
    rows,
    cfg.options.length < LIMITS.options ? h('button', { type: 'button', class: 'link', text: ordering ? '+ Add an item' : '+ Add an answer', onclick: () => patch((c) => c.options.push(''), true) }) : null,
    row && row.join('\u0001') !== cfg.options.join('\u0001') ? h('button', { type: 'button', class: 'link suggest', title: row.join(', '), text: `Use the labels on the slide: ${row.join(', ')}`, onclick: () => patch((c) => (c.options = row.slice()), true) }) : null,
    ordering ? h('p', { class: 'hint', text: 'Phones put them in order. The room’s order comes from everyone’s places added up: the lowest total comes first.' }) : null,
  );
}

// Type the answer: the answers that count. The first is the one shown at the
// reveal; the rest are other ways of saying it (NZ for New Zealand). Close
// spellings of any of them count without being listed.
function acceptsControls(cfg) {
  // Drawn from `list`, but every change works on the slide as it is now: typing
  // does not redraw, so `list` goes stale the moment a row is typed in.
  const list = cfg.accepts?.length ? cfg.accepts : [''];
  const rows = list.map((text, i) =>
    h(
      'div',
      { class: 'opt-row' },
      h('input', { type: 'text', class: 'grow', value: text, placeholder: i === 0 ? 'The answer' : 'Also accept', maxlength: String(LIMITS.typed), oninput: (e) => patch((c) => { const now = c.accepts?.length ? [...c.accepts] : ['']; now[i] = e.target.value; c.accepts = now; }) }),
      list.length > 1 ? h('button', { type: 'button', class: 'x', title: 'Remove', text: '×', onclick: () => patch((c) => { c.accepts = (c.accepts || []).filter((_, k) => k !== i); }, true) }) : null,
    ),
  );
  return group(
    'Answers that count',
    rows,
    list.length < LIMITS.accepts ? h('button', { type: 'button', class: 'link', text: '+ Add another way to say it', onclick: () => patch((c) => { c.accepts = [...(c.accepts?.length ? c.accepts : ['']), '']; }, true) }) : null,
    h('p', { class: 'hint', text: 'Close spellings count without being listed: a letter off, or two on long answers. Numbers and short words must be exact. Add short forms people might type, like NZ. The first one is shown at the reveal.' }),
  );
}

function rankResult(cfg) {
  return group(
    'Show the result',
    seg([['bars', 'In the box'], ['pins', 'On the slide']], cfg.display === 'pins' ? 'pins' : 'bars', (v) => {
      setPreviewPhase('reveal');
      patch((c) => (c.display = v), true);
    }),
    h('p', { class: 'hint', text: cfg.display === 'pins' ? 'Each item gets a label with its place. Drag the labels on the slide to where each one is.' : 'The order in the box, with first place named last.' }),
    cfg.display === 'pins' ? tagControls(cfg) : null,
  );
}

const TIMERS = [[10, '10s'], [15, '15s'], [20, '20s'], [30, '30s'], [60, '60s'], [0, 'None']];

function timerGroup(cfg) {
  const list = TIMERS.some(([s]) => s === cfg.seconds) ? TIMERS : [[cfg.seconds, `${cfg.seconds}s`], ...TIMERS];
  return group(
    'Timer',
    seg(list, cfg.seconds, (v) => patch((c) => (c.seconds = v), true)),
    cfg.seconds === 0 ? h('p', { class: 'hint', text: 'No timer: it stays open until you move on, or press T to show the result.' }) : null,
  );
}

// What a slide needs to work, and nothing else.
function essentials(cfg) {
  if (cfg.kind === 'join') {
    return [
      field('Headline', h('input', { type: 'text', value: cfg.headline, maxlength: '80', oninput: (e) => patch((c) => (c.headline = e.target.value)) })),
      h('p', { class: 'hint', text: 'Shows the game code and a QR code. People scan it, or type the address and the code.' }),
      deck.joinBase || DEFAULT_JOIN_BASE ? null : h('div', { class: 'card' }, h('b', { text: 'No join address yet.' }), ' Set it in the Quiz tab, under Joining, or the QR code cannot be drawn.'),
    ];
  }
  if (cfg.kind === 'leaderboard') {
    return [
      field('Title', h('input', { type: 'text', value: cfg.title, maxlength: '60', oninput: (e) => patch((c) => (c.title = e.target.value)) })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cfg.final, onchange: (e) => patch((c) => (c.final = e.target.checked), true) }), 'The final one: uncover the winner'),
      h('p', { class: 'hint', text: cfg.final ? 'In the show, press T to uncover third, then second, then first.' : 'Shows the scores so far, with who moved up.' }),
    ];
  }
  return [
    selectionCard(cfg),
    bank.length ? bankPicker() : null,
    questionField(cfg),
    ownsOptions(cfg.type) ? optionsGroup(cfg) : null,
    cfg.type === 'mc'
      ? group(
          null,
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!cfg.multi, onchange: (e) => patch((c) => { c.multi = e.target.checked; c.corrects = c.multi ? [c.correct] : undefined; }, true) }), 'More than one right answer'),
          cfg.multi ? h('p', { class: 'hint', text: 'Tick every right answer. Phones can pick several, then lock in. It scores only when exactly the right ones are picked.' }) : null,
        )
      : null,
    cfg.type === 'tf' ? group('The right answer', seg([[0, 'True'], [1, 'False']], cfg.correct, (v) => patch((c) => (c.correct = v), true))) : null,
    cfg.type === 'num' ? numberControls(cfg) : null,
    cfg.type === 'text' ? acceptsControls(cfg) : null,
    cfg.type === 'rank' ? rightOrderControls(cfg) : null,
    cfg.type === 'rank' ? rankResult(cfg) : null,
    timerGroup(cfg),
    scores(cfg) ? group('Points', seg([[1, 'Normal'], [2, 'Double'], [3, 'Triple'], [5, '×5']], cfg.points || 1, (v) => patch((c) => (c.points = v), true))) : null,
    isChoice(cfg.type)
      ? group(
          'Results as',
          seg([['bars', 'Bars'], ['pie', 'Pie'], ['table', 'Table'], ['numbers', 'Numbers'], ['pins', 'On slide']], cfg.display, (v) => {
            setPreviewPhase('reveal');
            patch((c) => (c.display = v), true);
          }),
        )
      : null,
  ];
}

// Everything else, folded away.
function moreBody(cfg) {
  const look = h('details', null, h('summary', { text: 'Different colours for this slide only' }), styleControls(cfg.style, (fn) => patch((c) => fn(c.style)), true));
  if (cfg.kind === 'join') return [placementControls(cfg), look];
  if (cfg.kind === 'leaderboard') {
    const orderRounds = Object.values(deck.slides).some((s) => s.kind === 'question' && s.type === 'rank');
    return [
      group('How many rows', h('div', { class: 'row' }, h('span', { text: 'Show the top' }), h('input', { type: 'number', min: '1', max: '25', value: String(cfg.top), oninput: (e) => patch((c) => (c.top = +e.target.value || 5)) }))),
      orderRounds || cfg.only
        ? group(
            'What it counts',
            seg([['all', 'Every question'], ['rank', 'Only Put in order rounds']], cfg.only === 'rank' ? 'rank' : 'all', (v) => patch((c) => (c.only = v === 'rank' ? 'rank' : undefined), true)),
            cfg.only === 'rank' ? h('p', { class: 'hint', text: 'Counts only the points won on Put in order rounds: who got the order most right. Put it after the last of them.' }) : null,
          )
        : null,
      placementControls(cfg),
      look,
    ];
  }
  const choice = isChoice(cfg.type);
  // Four plain headings, in the order a slide happens: when it starts, what
  // shows while people answer, what happens at the reveal, and where it sits.
  const part = (title) => h('h4', { class: 'more-head', text: title });
  return [
    part('Timing'),
    group(
      'Starts',
      seg([['auto', 'When the slide appears'], ['key', 'When I press T']], cfg.start, (v) => patch((c) => (c.start = v), true)),
      cfg.start === 'key' ? h('p', { class: 'hint', text: 'The slide says “Get ready” until you press T, so you can talk first.' }) : null,
    ),
    group(
      'Exact timer',
      h('div', { class: 'row' }, h('input', { type: 'number', min: '0', max: '600', value: String(cfg.seconds), onchange: (e) => patch((c) => (c.seconds = Math.max(0, Math.min(600, Math.round(+e.target.value) || 0))), true) }), h('span', { text: 'seconds; 0 for no timer' })),
    ),
    part('While it runs'),
    choice && cfg.type !== 'poll' ? group('While they vote', seg([['count', 'How many have answered'], ['tally', 'Live split']], cfg.live, (v) => patch((c) => (c.live = v), true))) : null,
    cfg.type === 'num' ? group('While they guess', seg([['count', 'How many have guessed'], ['tally', 'The guesses, as they come']], cfg.live, (v) => patch((c) => (c.live = v), true)), h('p', { class: 'hint', text: 'Showing the guesses as they come lets the room follow the crowd. Keeping them back makes it a real guess.' })) : null,
    cfg.type === 'rank' ? group('While they answer', seg([['count', 'How many have answered'], ['tally', 'The running totals']], cfg.live, (v) => patch((c) => (c.live = v), true))) : null,
    cfg.type === 'open'
      ? group(
          'The answers',
          seg([['count', 'Kept back until T'], ['tally', 'Shown as they come']], cfg.live, (v) => patch((c) => (c.live = v), true)),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!cfg.byline, onchange: (e) => patch((c) => (c.byline = e.target.checked || undefined), true) }), 'Show who wrote each one'),
          h('p', { class: 'hint', text: 'Common swear words are masked. Click any card on the big screen to take it off.' }),
        )
      : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: cfg.showText, onchange: (e) => patch((c) => (c.showText = e.target.checked)) }), 'Also show the question inside the quiz box'),
    topRowControls(cfg),
    part('At the reveal'),
    revealControls(cfg),
    cfg.type === 'rank' && scores(cfg) ? namesControls(cfg) : null,
    cfg.display === 'pins' && choice ? pinControls(cfg) : null,
    part('Where it sits'),
    placementControls(cfg, false),
    look,
  ];
}

// Everything else for this slide, folded into one row that says how it is set,
// so nothing needs opening just to check it.
function moreStatus(cfg) {
  const parts = [];
  if (cfg.kind === 'question') {
    parts.push(cfg.start === 'key' ? 'starts on T' : 'starts on arrival');
    if (cfg.type !== 'poll' && cfg.type !== 'cloud' && cfg.type !== 'text') parts.push(cfg.live === 'tally' ? 'shown live' : 'kept back until the reveal');
    const extras = (cfg.reveal?.show.length || 0) + (cfg.reveal?.hide.length || 0);
    if (extras) parts.push(`${extras} ${extras === 1 ? 'shape changes' : 'shapes change'} at the reveal`);
  }
  if (cfg.kind === 'leaderboard') parts.push(`top ${cfg.top}`);
  parts.push(cfg.place.shapeId ? 'on your shape' : 'placed by hand');
  if (cfg.style && Object.keys(cfg.style).length) parts.push('its own colours');
  const text = parts.join(' · ');
  return text[0].toUpperCase() + text.slice(1);
}

function more(cfg) {
  const d = h(
    'details',
    { class: 'step more-slide', open: moreOpen },
    h('summary', null, h('span', { class: 'what' }, h('b', { text: 'More for this slide' }), h('small', { text: moreStatus(cfg) }))),
    h('div', { class: 'body' }, moreBody(cfg).flat(Infinity).filter(Boolean)),
  );
  d.addEventListener('toggle', () => (moreOpen = d.open));
  return d;
}

function placementControls(cfg, titled = true) {
  const onShape = !!cfg.place.shapeId;
  const found = onShape && editor.shapes.some((s) => s.id === cfg.place.shapeId);
  const selected = editor.selected && editor.selected !== cfg.place.shapeId ? editor.shapes.find((s) => s.id === editor.selected) : null;
  const slider = (key, label) =>
    h('div', { class: 'row' }, h('span', { style: 'flex:0 0 46px', text: label }), h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(cfg.place[key] * 100)), oninput: (e) => patch((c) => (c.place[key] = +e.target.value / 100)) }));
  return group(
    titled ? 'Where the quiz box sits' : null,
    onShape
      ? h('div', { class: 'card' }, h('b', { text: found ? 'On a shape you drew.' : 'Its shape is no longer on this slide.' }), found ? ' Move or resize that shape in Slides and the quiz box follows. The shape itself is hidden in the slideshow.' : ' Pick another, or place it by hand.')
      : h('p', { class: 'hint', text: 'Drag the quiz box on the slide to move it, and its corner to resize it. Or tie it to a shape: select a rectangle on the slide and it can be placed on that.' }),
    selected ? h('button', { type: 'button', class: 'btn primary', text: 'Put it on the selected shape', onclick: () => chooseShape(selected) }) : null,
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn',
        text: picking ? 'Cancel' : onShape ? 'Pick a different shape' : 'Pick a shape here',
        onclick: () => {
          picking = !picking;
          drawSlide(true);
          drawPreview();
        },
      }),
      onShape ? h('button', { type: 'button', class: 'btn', text: 'Free it from the shape', onclick: () => patch((c) => delete c.place.shapeId, true) }) : null,
    ),
    onShape ? null : h('div', { class: 'group' }, slider('x', 'Left'), slider('y', 'Top'), slider('w', 'Width'), slider('h', 'Height')),
  );
}

function drawSlide(force = false) {
  const $pane = $('slide-pane');
  const cfg = current();
  const empty = !Object.keys(deck.slides).length;
  const key = `${pid}|${slideId()}|${cfg?.kind}|${cfg?.type}|${cfg?.display}|${picking}|${changing}|${editor?.selected}|${empty}`;
  if (!force && key === drawnFor) return;
  drawnFor = key;
  if (!slideId()) {
    fill($pane, h('p', { class: 'hint', text: 'Select a slide in the filmstrip on the left.' }));
    return;
  }
  const n = editor.index ? `Slide ${editor.index}` : 'This slide';
  // Nothing is built until the first-run disclosure has been agreed to.
  if (!welcomed) {
    fill($pane, firstRun());
    return;
  }
  if (!cfg || changing) {
    fill(
      $pane,
      !cfg && empty ? copyCard() || welcome() : null,
      h('h2', { text: cfg ? `${n}: change it to` : n }),
      cfg ? null : h('p', { class: 'hint', text: 'What should this slide do? Pick one. You can change it later.' }),
      tiles(cfg),
      cfg ? h('button', { type: 'button', class: 'link', text: 'Keep it as it is', onclick: () => { changing = false; drawSlide(true); drawPreview(); } }) : null,
    );
    return;
  }
  fill($pane, h('h2', { text: n }), kindHead(cfg), essentials(cfg), more(cfg));
}

// A put-in-order round's right order, tapped in here, first place first. With
// it, phones win a point for each item placed where the right order has it, and
// T after the room's order shows the right one. Without it, the round is just
// the room's opinion and scores nobody.
function rightOrderControls(cfg) {
  const order = cfg.rightOrder || [];
  const tap = (i) =>
    patch((c) => {
      const list = [...(c.rightOrder || [])];
      const at = list.indexOf(i);
      if (at >= 0) list.splice(at, 1);
      else list.push(i);
      c.rightOrder = list.length ? list : undefined;
    }, true);
  return group(
    'The right order',
    h('p', { class: 'hint', text: order.length ? `${order.length} of ${cfg.options.length} placed. Tap one again to take it out.` : 'Tap the items in the right order, first place first. Leave it empty for a matter of opinion: the room’s order, no points.' }),
    h('div', { class: 'list' }, cfg.options.map((name, i) => h('button', { type: 'button', title: order.includes(i) ? 'Take it out' : 'Place it next', onclick: () => tap(i) }, h('span', { class: 'n', text: order.includes(i) ? ordinal(order.indexOf(i) + 1) : '' }), h('span', { class: 'what', text: `${LETTERS[i]}  ${String(name).trim() || '(no name yet)'}` })))),
    order.length ? h('p', { class: 'hint', text: 'Phones win a point for each item in exactly the right place, times Points. In the show: the room’s order first, then T for the right one. What the two results are called is under More for this slide.' }) : null,
  );
}

// What the slide calls the two results: the room's ("The office") and the right
// order ("The experts"). Left empty, "The room" and "The right order".
function namesControls(cfg) {
  const name = (who, label) =>
    field(label, h('input', { type: 'text', value: cfg.names?.[who] || '', placeholder: RESULT_NAMES[who], maxlength: String(NAME_LIMIT), onchange: (e) => patch((c) => { c.names = { ...c.names, [who]: e.target.value }; }, true) }));
  const room = resultName(cfg, 'room');
  return h(
    'div',
    null,
    h('div', { class: 'row' }, name('room', 'The room is called'), name('answer', 'The right order is called')),
    h('p', { class: 'hint', text: `On the slide: “${roomHeading(cfg)}” at the reveal, then “${answerHeading(cfg)}” after T, with “${underName(room)} 2nd” under each place.` }),
  );
}

// The module's top row, a part at a time: the join line, the count, the clock.
// Each can be switched off for this slide. With all three off (and no question
// text or points pill to show) the row goes, and what is below has the whole box.
function topRowControls(cfg) {
  const names = { join: 'The join line', count: cfg.type === 'num' ? 'How many have guessed' : cfg.type === 'cloud' ? 'How many words are in' : 'How many have answered', clock: 'The clock' };
  return group(
    'At the top of the quiz box',
    HIDEABLE.map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !cfg.hide?.[k], onchange: (e) => patch((c) => { c.hide = { ...c.hide, [k]: !e.target.checked }; }, true) }), names[k])),
    h('p', { class: 'hint', text: cfg.hide?.clock && cfg.seconds > 0 ? 'The clock still runs, and phones still show it.' : deck.showJoin ? 'Untick a part to leave it off this slide.' : 'The join line is switched off for every slide, in Settings.' }),
  );
}

// Guess the number: the answer, the range of the phone's slider, and the unit.
// These are set when a box is left, not on every keystroke, or a range half
// typed would be taken at its word.
function numberControls(cfg) {
  const num = (key, title) => h('input', { type: 'number', step: 'any', class: 'grow', value: String(cfg[key]), title, onchange: (e) => e.target.value.trim() !== '' && patch((c) => (c[key] = +e.target.value), true) });
  return group(
    'The number',
    h('div', { class: 'row' }, field('The right answer', num('answer', 'The number they are trying to guess')), field('Unit', h('input', { type: 'text', value: cfg.unit, maxlength: String(LIMITS.unit), placeholder: 'kg', onchange: (e) => patch((c) => (c.unit = e.target.value), true) }))),
    h('div', { class: 'row' }, field('Slider from', num('min', 'The least a phone can guess')), field('to', num('max', 'The most a phone can guess')), field('in steps of', num('step', 'How fine the slider is'))),
    h('p', { class: 'hint', text: 'The closest guess wins 3 points, the next closest 2 and the next 1. Guesses the same distance out share a place. The slider stretches to take in the answer, and starts in the middle on every phone: choose a range whose middle is not the answer.' }),
  );
}

// Where on the slide a shape sits, in words, so a list of marked shapes can be
// told apart without names (Slides does not expose them).
function whereabouts(shape) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const v = cy < 0.38 ? 'Top' : cy > 0.62 ? 'Bottom' : 'Middle';
  const hz = cx < 0.38 ? 'left' : cx > 0.62 ? 'right' : 'centre';
  return `${v} ${hz}, ${Math.round(shape.w * 100)}% wide`;
}

// Votes shown on the slide itself: each option is put on a photo or a shape,
// and its votes rise over that. Chosen the way a reveal shape is: select it on
// the slide, then say which option it is.
function pinControls(cfg) {
  const pins = cfg.pins || [];
  const taken = new Set(pins.filter(Boolean).map((p) => p.shapeId));
  const sel = editor.selected && editor.selected !== cfg.place.shapeId && !taken.has(editor.selected) ? editor.shapes.find((s) => s.id === editor.selected) : null;
  const set = (i, pin) => patch((c) => { c.pins = c.options.map((_, k) => (k === i ? pin : c.pins?.[k] || null)); }, true);
  return group(
    cfg.type === 'rank' ? 'Where each item is on the slide' : 'Where each option shows its votes',
    h('p', { class: 'hint', text: sel ? (cfg.type === 'rank' ? 'Which item is the photo you clicked?' : 'Which option is the shape you have selected?') : cfg.type === 'rank' ? 'Click an item on the slide, then pick its letter here. At the reveal, its place shows over it.' : 'Select a photo or a shape on the slide, then pick its option here. In the show, that option\u2019s votes rise over it.' }),
    cfg.options.map((text, i) =>
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'letter', text: LETTERS[i] }),
        h('span', { class: 'grow', text: pins[i] ? whereabouts(pins[i]) : 'In the box, as a bar' }),
        sel ? h('button', { type: 'button', class: 'btn', text: pins[i] ? 'Move it here' : 'Put it here', onclick: () => set(i, { shapeId: sel.id, x: sel.x, y: sel.y, w: sel.w, h: sel.h }) }) : null,
        pins[i] && !sel ? h('button', { type: 'button', class: 'link', text: 'Take it off', onclick: () => set(i, null) }) : null,
      ),
    ),
  );
}

// A put-in-order round shown on the slide: each item's label is dragged on the
// slide in the editor. Here: where each one is, and a way to put one back.
function tagControls(cfg) {
  const back = (i) =>
    patch((c) => {
      const pins = c.options.map((_, k) => (k === i ? null : c.pins?.[k] || null));
      c.pins = pins.some(Boolean) ? pins : undefined;
    }, true);
  return group(
    'Where each item is on the slide',
    h('p', { class: 'hint', text: 'Drag each label on the slide to its item; drag its corner dot to size it. In the show the labels stay hidden while the room answers, then give each item’s place: the room’s first, the right order after T.' }),
    cfg.options.map((name, i) =>
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'letter', text: LETTERS[i] }),
        h('span', { class: 'grow', text: cfg.pins?.[i] ? `${String(name).trim() || '(no name yet)'}: ${whereabouts(tagRect(cfg, i)).toLowerCase()}` : `${String(name).trim() || '(no name yet)'}: not moved yet` }),
        cfg.pins?.[i] ? h('button', { type: 'button', class: 'link', text: 'Put back', title: 'Back to the row along the bottom', onclick: () => back(i) }) : null,
      ),
    ),
  );
}

// A photo or text box on the slide that changes with the answer: shown only
// at the reveal, or hidden at it. Choosing one is done from the card that comes
// up when something on the slide is clicked (selectionCard); here, the list.
function markReveal(id, kind) {
  patch((c) => {
    c.reveal.show = c.reveal.show.filter((x) => x !== id);
    c.reveal.hide = c.reveal.hide.filter((x) => x !== id);
    if (kind) c.reveal[kind].push(id);
  }, true);
}

// Click something on the slide and this card offers what can be done with it,
// at the top, where it will be seen.
function selectionCard(cfg) {
  if (cfg.kind !== 'question') return null;
  const sel = editor.selected && editor.selected !== cfg.place.shapeId ? editor.shapes.find((s) => s.id === editor.selected) : null;
  if (!sel) return null;
  const now = cfg.reveal.show.includes(sel.id) ? 'show' : cfg.reveal.hide.includes(sel.id) ? 'hide' : null;
  return h(
    'div',
    { class: 'card sel-card' },
    h('b', { text: now === 'show' ? 'This appears with the answer.' : now === 'hide' ? 'This leaves when the answer shows.' : 'You clicked something on the slide.' }),
    now ? null : h('div', { class: 'hint', text: 'It can stay hidden until the answer shows, or leave when it does.' }),
    h(
      'div',
      { class: 'row' },
      now
        ? h('button', { type: 'button', class: 'btn', text: 'Leave it as it is in the show', onclick: () => markReveal(sel.id, null) })
        : [h('button', { type: 'button', class: 'btn primary', text: 'Show it only at the reveal', onclick: () => markReveal(sel.id, 'show') }), h('button', { type: 'button', class: 'btn', text: 'Hide it at the reveal', onclick: () => markReveal(sel.id, 'hide') })],
    ),
  );
}

function revealControls(cfg) {
  const r = cfg.reveal;
  const marked = new Set([...r.show, ...r.hide]);
  const row = (id, kind) => {
    const shape = editor.shapes.find((s) => s.id === id);
    return h(
      'div',
      null,
      h('span', { class: `tag ${kind}`, text: kind === 'show' ? 'Appears' : 'Leaves' }),
      h('span', { class: 'what', text: shape ? whereabouts(shape) : 'No longer on this slide' }),
      h('button', { type: 'button', class: 'x', title: 'Stop changing this shape at the reveal', text: '×', onclick: () => markReveal(id, null) }),
    );
  };
  return group(
    null,
    h('p', { class: 'hint', text: 'A photo or text box on the slide can arrive with the answer, or leave at it. Put it on the slide in Slides where you want it, then click it: a card at the top of this panel offers both.' }),
    marked.size ? h('div', { class: 'list' }, r.show.map((id) => row(id, 'show')), r.hide.map((id) => row(id, 'hide'))) : null,
    marked.size ? h('p', { class: 'hint', text: 'Switch the preview between Voting and Result to see it on the slide. The backup player cannot do this: there, these shapes show throughout.' }) : null,
  );
}

// ---- the look -----------------------------------------------------------------

function styleControls(style, change, overrides = false) {
  const value = (k) => style[k] ?? (overrides ? deck.theme[k] : DEFAULT_THEME[k]);
  const colour = (key, label) => {
    const text = h('input', { type: 'text', class: 'grow', value: value(key), maxlength: '9', oninput: (e) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(e.target.value) && (change((s) => (s[key] = e.target.value)), (swatch.value = e.target.value)) });
    const swatch = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value(key)) ? value(key) : '#000000', oninput: (e) => { change((s) => (s[key] = e.target.value)); text.value = e.target.value; } });
    return h('label', { class: 'field' }, h('span', { text: label }), h('div', { class: 'row' }, swatch, text));
  };
  const font = value('font');
  const listed = FONT_CHOICES.includes(font);
  const custom = h('input', { type: 'text', value: listed ? '' : font, placeholder: 'Any font installed on this laptop', oninput: (e) => e.target.value.trim() && change((s) => (s.font = e.target.value)) });
  const ground = value('ground');
  return h(
    'div',
    { class: 'group' },
    field(
      'Font',
      h('select', { onchange: (e) => { if (e.target.value) change((s) => (s.font = e.target.value)); custom.hidden = !!e.target.value; } }, FONT_CHOICES.map((f) => h('option', { value: f, text: f, selected: f === font })), h('option', { value: '', text: 'Another font…', selected: !listed })),
    ),
    Object.assign(custom, { hidden: listed }),
    h('div', { class: 'swatches' }, colour('accent', 'Accent'), colour('text', 'Text'), colour('card', 'Option fill'), colour('cardText', 'Option text'), colour('correct', 'Right answer')),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: ground === 'transparent', onchange: (e) => { change((s) => (s.ground = e.target.checked ? 'transparent' : '#1f1f1f')); drawnFor = ''; view === 'quiz' ? drawDeck() : drawSlide(true); } }),
      'No backing: the slide shows through',
    ),
    ground === 'transparent' ? null : colour('ground', 'Backing colour'),
    field('Corners', h('input', { type: 'range', min: '0', max: '40', value: String(value('radius')), oninput: (e) => change((s) => (s.radius = +e.target.value)) })),
    field('Weight', h('input', { type: 'range', min: '400', max: '900', step: '100', value: String(value('weight')), oninput: (e) => change((s) => (s.weight = +e.target.value)) })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value('uppercase'), onchange: (e) => change((s) => (s.uppercase = e.target.checked)) }), 'Capitals'),
    overrides && Object.keys(style).length ? h('button', { type: 'button', class: 'link', text: 'Back to the deck design', onclick: () => { change((s) => { for (const k of Object.keys(s)) delete s[k]; }); drawSlide(true); } }) : null,
  );
}

// Ready-made looks: a click each. Colours only; the font, corners and weight
// stay as they are, and can be fine-tuned below them.
// The looks on offer (BRAND.md): Pop Quiz's own first, then the directions that
// were not chosen as the brand, kept as themes. Colours only: the font is a
// separate choice. `edge` is the ink outline and hard shadow, Pop Quiz's own;
// `paper` is what the phones sit on.
const PRESETS = [
  { name: 'Pop Quiz', theme: { text: '#1a1a1a', accent: '#f9ab00', card: '#ffffff', cardText: '#1a1a1a', correct: '#f9ab00', edge: '#1a1a1a', paper: '#fff6dc' } },
  { name: 'Slide Native', theme: { text: '#1f1f1f', accent: '#f5a800', card: '#f1f3f4', cardText: '#1f1f1f', correct: '#f5a800', edge: 'none', paper: '#f8f9fa' } },
  { name: 'Pop Art', theme: { text: '#111111', accent: '#1d4ed8', card: '#fff8e1', cardText: '#111111', correct: '#ffd60a', edge: '#111111', paper: '#ffd60a' } },
  { name: 'Bubblegum', theme: { text: '#2b1638', accent: '#ff5fa2', card: '#fff1f7', cardText: '#2b1638', correct: '#7ce0c3', edge: 'none', paper: '#fff1f7' } },
  { name: 'Game Night', theme: { text: '#ffffff', accent: '#ff3fd8', card: '#1b2250', cardText: '#ffffff', correct: '#3ef2ff', edge: 'none', paper: '#0b0f2a' } },
  { name: 'Clean Signal', theme: { text: '#0e0e10', accent: '#2f5bff', card: '#eef0f5', cardText: '#0e0e10', correct: '#12a150', edge: 'none', paper: '#ffffff' } },
  { name: 'Confetti', theme: { text: '#1f1a2e', accent: '#ff6b57', card: '#fffbf3', cardText: '#1f1a2e', correct: '#2ec4b6', edge: 'none', paper: '#fffbf3' } },
  { name: 'Citrus', theme: { text: '#ffffff', accent: '#ff8a65', card: '#1c2b20', cardText: '#ffffff', correct: '#c6f432', edge: 'none', paper: '#0f1a12' } },
];

function presetsRow() {
  const same = (p) => Object.entries(p.theme).every(([k, v]) => String(deck.theme[k]).toLowerCase() === v);
  return h(
    'div',
    { class: 'presets' },
    PRESETS.map((p) =>
      h(
        'button',
        {
          type: 'button',
          class: 'preset',
          'aria-pressed': String(same(p)),
          onclick: () => {
            patchTheme((t) => Object.assign(t, p.theme));
            drawDeck();
          },
        },
        h('span', { class: 'chips' }, h('i', { style: `background:${p.theme.accent}` }), h('i', { style: `background:${p.theme.card}` }), h('i', { style: `background:${p.theme.correct}` })),
        h('span', { text: p.name }),
      ),
    ),
  );
}

// ---- sharing, versions, backups ----------------------------------------------

const when = (t) => `${new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;

// One plain sentence on where this deck stands against its shared copy.
function sharedLine() {
  const s = shared;
  if (!s) return [h('b', { text: 'Not shared yet.' }), ' It will be, once this deck has a quiz slide.'];
  if (s.status === 'outdated') return [h('b', { text: `${BRAND} on this laptop is out of date.` }), ` A newer ${BRAND} has saved this quiz, and this one would lose what it does not know. Nothing here is sent or picked up until ${BRAND} is updated on this laptop.`];
  if (s.status === 'unreachable') return [h('b', { text: 'Could not reach the shared copy.' }), ` Your work is safe here and will be sent when it can be. (${s.error || 'no connection'})`];
  if (s.status === 'nothing to share yet') return [h('b', { text: 'Nothing to share yet.' }), ' This deck has no quiz slides.'];
  if (s.dirtyAt) return [h('b', { text: 'Saved on this laptop.' }), ' Your latest change goes to the shared copy within a minute, or at once when you leave the deck’s tab.'];
  const last = s.pulledAt && (!s.pushedAt || s.pulledAt > s.pushedAt) ? `Picked up a change from another device on ${when(s.pulledAt)}.` : s.pushedAt ? `Last sent on ${when(s.pushedAt)}.` : `Checked on ${when(s.at)}.`;
  return [h('b', { text: 'In step.' }), ` ${last}`];
}

// ---- earlier versions ---------------------------------------------------------
//
// The sharing service sets aside the quiz as it was, every few minutes of work.
// They are fetched only when asked for, and bringing one back is an ordinary
// change: it is sent like any other, and the version it replaces is kept too.

let syncOn = !!DEFAULT_SYNC_BASE;
store.get(KEYS.settings).then((st) => {
  const on = !!(st?.syncBase ?? DEFAULT_SYNC_BASE);
  if (on !== syncOn) {
    syncOn = on;
    if (view === 'quiz') drawDeck();
  }
});

let earlier = null; // { list } once asked for, or { error }

async function syncUrl(extra = '') {
  const base = ((await store.get(KEYS.settings)) || {}).syncBase ?? DEFAULT_SYNC_BASE;
  return base ? `${base}?id=${encodeURIComponent(pid)}${extra}` : null;
}

async function showEarlier() {
  try {
    const url = await syncUrl('&history=1');
    const res = url && (await fetch(url, { cache: 'no-store' }));
    if (!res?.ok) throw new Error(res ? `the shared copy answered ${res.status}` : 'sharing is switched off');
    earlier = { list: (await res.json()).versions || [] };
  } catch (e) {
    earlier = { error: String(e?.message || e) };
  }
  drawDeck();
}

async function bringBack(v) {
  if (!confirm(`Replace the quiz on this deck with the one from ${when(v.updatedAt)}? What is here now is kept as an earlier version.`)) return;
  try {
    const res = await fetch(await syncUrl(`&rev=${encodeURIComponent(v.rev)}`), { cache: 'no-store' });
    if (!res.ok) throw new Error(`the shared copy answered ${res.status}`);
    const found = await res.json();
    await store.set(`tally.keep.${pid}`, true); // so the version this replaces is set aside whatever the hour
    deck = normaliseDeck({ ...found.deck, presentationId: pid }, pid);
    flush();
    earlier = null;
    drawAll();
    toast(`Brought back the quiz from ${when(v.updatedAt)}`);
  } catch (e) {
    toast(`Could not bring it back: ${e?.message || e}`);
  }
}

function earlierControls() {
  return group(
    'Earlier versions',
    h('p', { class: 'hint', text: 'The shared copy keeps the quiz as it was, every few minutes of work. If something goes missing, bring an earlier one back.' }),
    !earlier
      ? h('button', { type: 'button', class: 'btn', text: 'Show earlier versions', onclick: showEarlier })
      : earlier.error
        ? h('p', { class: 'hint', text: `Could not fetch them: ${earlier.error}` })
        : earlier.list.length
          ? h('div', { class: 'list' }, earlier.list.map((v) => h('button', { type: 'button', title: 'Bring this one back', onclick: () => bringBack(v) }, h('span', { class: 'what', text: when(v.updatedAt) }), h('span', { class: 'tag', text: `${v.questions} ${v.questions === 1 ? 'question' : 'questions'}` }))))
          : h('p', { class: 'hint', text: 'None yet. The first is kept a few minutes into your next change.' }),
  );
}

// ---- a newer Tally --------------------------------------------------------------
//
// Chrome updates by itself only what comes from its store. So the panel looks:
// is the copy of Tally on this laptop's disk newer than the one running (then a
// press of Reload Tally is all it takes), and is there a newer one out than is
// on this laptop at all?

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v || '').split('.').map((n) => +n || 0));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkForNewer() {
  const bar = $('update');
  if (!inExtension || !bar) return;
  // A copy from the Chrome Web Store carries an update_url, and Chrome keeps
  // it current by itself: nothing to look for, and no reason to ask the site.
  if (chrome.runtime.getManifest().update_url) return;
  const running = chrome.runtime.getManifest().version;
  const read = (url) => fetch(url, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => j?.version || null, () => null);
  // The newest published copy is asked of the site phones join at, which is
  // where the plugin is fetched from too.
  let site = null;
  try {
    site = new URL('version.json', deck?.joinBase || DEFAULT_JOIN_BASE).href;
  } catch {}
  const [onDisk, out] = await Promise.all([read(chrome.runtime.getURL('manifest.json')), site ? read(site) : null]);
  const key = `${running}|${onDisk}|${out}|${!!editor?.presenting}`;
  if (bar.dataset.key === key) return;
  bar.dataset.key = key;
  if (onDisk && onDisk !== running) {
    bar.hidden = false;
    // No button during a slideshow: reloading would take the quiz off the screen.
    const parts = [
      h('span', null, h('b', { text: `${BRAND} ${onDisk} is ready on this laptop.` }), editor?.presenting ? ' Reload it after the slideshow.' : ' Your quiz is kept.'),
      editor?.presenting ? null : h('button', { type: 'button', class: 'btn primary', text: `Reload ${BRAND}`, onclick: () => { flush(); chrome.runtime.sendMessage({ t: 'tally:reload-extension' }).catch(() => {}); } }),
    ];
    bar.replaceChildren(...parts.filter(Boolean));
  } else if (out && newer(out, running)) {
    bar.hidden = false;
    bar.replaceChildren(h('span', null, h('b', { text: `${BRAND} ${out} is out.` }), ` This laptop has ${running}. `, h('a', { href: new URL('get/', site).href, target: '_blank', rel: 'noopener', text: 'How to get it' })));
  } else {
    bar.hidden = true;
    bar.replaceChildren();
  }
}

// Says what actually happened. An older copy of Tally still loaded in Chrome
// has no safety copies at all, and must not be reported as having saved one.
async function saveCopyNow() {
  flush();
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ t: 'tally:backup-now', presentationId: pid });
  } catch {}
  if (reply?.ok) toast('Safety copy saved to your Downloads folder');
  else if (reply && !reply.ok && !reply.error) toast('Nothing to save yet: this deck has no quiz slides');
  else toast(`Not saved. Reload ${BRAND} in chrome://extensions to turn safety copies on`);
}

async function goto(id) {
  if (!inExtension) return;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.sendMessage(active.id, { t: 'tally:goto', slideId: id });
  } catch {}
}

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A question list goes in for this deck, and the panel says what came in.
async function useBank(questions, skipped = []) {
  bank = questions;
  await store.set(`tally.bank.${pid}`, bank);
  drawnFor = '';
  drawDeck();
  toast(`${describeQuiz(bank)} loaded${skipped.length ? `, ${skipped.length} skipped` : ''}`);
}

// Paste a quiz: whatever someone or an AI assistant wrote, in the Pop Quiz
// format (popquiz.fun/quiz-format/) or as a plain numbered list. It's read as
// it's typed, so the count shows before anything is kept.
function pasteBox() {
  const box = $('paste-quiz');
  if (!box) return;
  if (box.firstChild) return box.replaceChildren();
  const area = h('textarea', { rows: '8', placeholder: '1. Which planet has the most moons?\nA) Jupiter\nB) Saturn *\nC) Uranus\n\nOr paste the Pop Quiz JSON an AI assistant wrote for you.', 'aria-label': 'Paste a quiz' });
  const said = h('p', { class: 'hint', 'aria-live': 'polite' });
  const use = h('button', { type: 'button', class: 'btn primary', text: 'Use these questions', disabled: true });
  let read = { questions: [], skipped: [] };
  const check = () => {
    read = area.value.trim() ? readQuiz(area.value) : { questions: [], skipped: [] };
    use.disabled = !read.questions.length;
    said.textContent = area.value.trim()
      ? read.questions.length
        ? `${describeQuiz(read.questions)}.${read.skipped.length ? ` Skipped ${read.skipped.length}: ${read.skipped.slice(0, 2).join('; ')}${read.skipped.length > 2 ? '…' : ''}` : ''}`
        : read.skipped[0] || 'No questions found yet.'
      : '';
  };
  area.addEventListener('input', check);
  use.addEventListener('click', async () => {
    await useBank(read.questions, read.skipped);
    box.replaceChildren();
  });
  box.replaceChildren(
    area,
    said,
    h('div', { class: 'row' }, use, h('button', { type: 'button', class: 'link', text: 'Cancel', onclick: () => box.replaceChildren() })),
    h('p', { class: 'hint' }, 'Ask any AI assistant to write the quiz “in Pop Quiz format”. ', h('a', { href: new URL('quiz-format/', SITE).href, target: '_blank', rel: 'noopener', text: 'How the format works' })),
  );
  area.focus();
}

function pickFile(onJson) {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      onJson(JSON.parse(await file.text()));
    } catch (e) {
      toast(`That file would not open: ${e.message}`);
    }
  });
  input.click();
}

// ---- your quiz: is it ready to present? -----------------------------------------

const KIND_NAME = { mc: 'Quiz question', tf: 'True or false', poll: 'Poll', cloud: 'Word cloud', num: 'Guess the number', rank: 'Put in order', text: 'Type the answer', open: 'Open answer' };

// What stands between this deck and a good game, in plain words. Each item
// with a slide takes you to it.
function readiness() {
  const all = Object.entries(deck.slides).sort((a, b) => (a[1].index || 999) - (b[1].index || 999));
  const questions = all.filter(([, s]) => s.kind === 'question');
  const joins = all.filter(([, s]) => s.kind === 'join');
  const boards = all.filter(([, s]) => s.kind === 'leaderboard');
  const at = (s) => (s.index ? `Slide ${s.index}` : 'A slide');
  const items = [];
  if (joins.length) items.push({ level: 'ok', text: joins.length === 1 ? 'Join screen' : `${joins.length} join screens`, slide: joins[0][0] });
  else items.push({ level: 'warn', text: 'No join screen yet. Add a slide near the start and pick Join screen, so people can get in.' });
  if (questions.length) items.push({ level: 'ok', text: `${questions.length} ${questions.length === 1 ? 'question' : 'questions'}` });
  for (const [id, s] of questions) {
    if (!s.text.trim()) items.push({ level: 'warn', text: `${at(s)}: no question wording yet. Phones show it.`, slide: id });
    if (ownsOptions(s.type)) {
      const blank = s.options.findIndex((o) => !o.trim());
      if (blank >= 0) items.push({ level: 'warn', text: `${at(s)}: ${s.type === 'rank' ? 'item' : 'answer'} ${LETTERS[blank]} is empty.`, slide: id });
    }
    if (s.type === 'text' && !s.accepts?.some((t) => t.trim())) items.push({ level: 'warn', text: `${at(s)}: no answer set, so nobody can get it right.`, slide: id });
    if (s.type === 'rank' && !scores(s)) items.push({ level: 'tip', text: `${at(s)}: no right order, so it scores nobody. That is fine for a matter of opinion.`, slide: id });
  }
  if (boards.some(([, s]) => s.final)) items.push({ level: 'ok', text: 'A final leaderboard to uncover the winner', slide: boards.find(([, s]) => s.final)[0] });
  else if (boards.length) items.push({ level: 'tip', text: 'Tick “The final one” on your last leaderboard to uncover the winner.', slide: boards.at(-1)[0] });
  else if (questions.length) items.push({ level: 'tip', text: 'Add a Leaderboard at the end to crown a winner.' });
  return items;
}

// Problems by slide, from readiness(): the first thing wrong on each.
function problemsBySlide() {
  const out = {};
  for (const it of Object.keys(deck?.slides || {}).length ? readiness() : []) if (it.level === 'warn' && it.slide && !out[it.slide]) out[it.slide] = it.text.replace(/^(Slide \d+|A slide): /, '');
  return out;
}

// The whole quiz: what is wrong first, then every quiz slide in order, each
// with its type and whether it is ready. A row takes you to its slide.
function drawQuiz() {
  const $pane = $('quiz-pane');
  if (view !== 'quiz' || !deck) return;
  const all = Object.entries(deck.slides).sort((a, b) => (a[1].index || 999) - (b[1].index || 999));
  if (!all.length) {
    fill($pane, h('h2', { text: 'Your quiz' }), h('p', { class: 'hint', text: 'No quiz slides yet. Pick a slide in Slides, then choose what it does in the Slide tab.' }));
    return;
  }
  const items = readiness();
  const bySlide = problemsBySlide();
  const loose = items.filter((i) => !i.slide && i.level !== 'ok'); // deck-wide: no join screen, no leaderboard
  const problems = items.filter((i) => i.level === 'warn').length;
  const label = (s) => (s.kind === 'question' ? s.text || 'No question wording yet' : s.kind === 'join' ? s.headline || 'Join screen' : `${s.title || 'Leaderboard'}${s.final ? ' · final' : ''}`);
  const typeOf = (s) => (s.kind === 'question' ? s.type : s.kind);
  fill(
    $pane,
    h('h2', { text: `${all.length} quiz ${all.length === 1 ? 'slide' : 'slides'} · ${problems ? `${problems} to fix` : 'ready to present'}` }),
    loose.length ? h('div', { class: 'checks' }, loose.map((it) => h('div', { class: `check-item ${it.level}` }, h('span', { class: 'mark', text: it.level === 'warn' ? '!' : '•' }), h('span', { text: it.text })))) : null,
    h(
      'div',
      { class: 'outline' },
      all.map(([id, s]) =>
        h(
          'button',
          { type: 'button', class: `line${bySlide[id] ? ' warn' : ''}${id === slideId() ? ' cur' : ''}`, title: 'Go to this slide', onclick: () => { goto(id); showView('slide'); } },
          h('span', { class: 'n', text: s.index || '–' }),
          typeIcon(typeOf(s), 18),
          h('span', { class: 'what' }, h('b', { text: label(s) }), bySlide[id] ? h('small', { text: bySlide[id] }) : null),
          bySlide[id] ? h('span', { class: 'flag', text: '!' }) : id === slideId() ? h('span', { class: 'here', text: 'Selected' }) : h('span', { class: 'ok', text: '✓' }),
        ),
      ),
    ),
  );
}

// ---- present -------------------------------------------------------------------

function drawPresent() {
  const $pane = $('present-pane');
  if (view !== 'present' || !deck) return;
  if (!Object.keys(deck.slides).length) {
    fill($pane, h('h2', { text: 'Present' }), h('p', { class: 'hint', text: 'Nothing to present yet. Make a slide a quiz slide in the Slide tab first.' }));
    return;
  }
  const players = session ? Object.keys(session.players || {}).length : 0;
  const played = session ? Object.values(session.q || {}).filter((q) => q.status === 'closed').length : 0;
  const site = siteOf(deck.joinBase || DEFAULT_JOIN_BASE);
  fill(
    $pane,
    h('h2', { text: 'Present' }),
    h(
      'div',
      { class: 'card present-card' },
      session
        ? [h('div', { class: 'hint', text: 'Game code' }), h('div', { class: 'present-code', text: session.room }), site ? h('div', { class: 'present-at', text: `at ${site}` }) : null, h('div', { class: 'hint', text: `${players} ${players === 1 ? 'player' : 'players'} in · ${played} ${played === 1 ? 'question' : 'questions'} played` })]
        : h('div', { text: 'Your game code appears here once you start the slideshow.' }),
    ),
    // People joining over a video call cannot scan a code on the screen they
    // are watching it on. A link in the call's chat takes them straight in.
    session
      ? h('button', {
          type: 'button',
          class: 'btn primary',
          text: 'Copy the join link, for a video call',
          onclick: async () => {
            const link = joinUrl(deck.joinBase || DEFAULT_JOIN_BASE, session.room);
            try {
              await navigator.clipboard.writeText(link);
              toast(`Copied: ${link}`);
            } catch {
              toast(link);
            }
          },
        })
      : null,
    practiceCard(players),
    h('p', { class: 'hint', text: 'Start the slideshow in Google Slides as usual. Pop Quiz runs the quiz slides by itself.' }),
    h('h3', { class: 'keys-head', text: 'Keys during the slideshow' }),
    h(
      'div',
      { class: 'keys' },
      h('span', null, h('kbd', { text: '→' })),
      h('span', { text: 'Next slide, as usual.' }),
      h('span', null, h('kbd', { text: 'T' })),
      h('span', { text: 'Starts a question set to wait, ends the timer early, or uncovers the next result.' }),
      h('span', null, h('kbd', { text: 'Shift' }), ' ', h('kbd', { text: 'R' })),
      h('span', { text: 'Runs a question again.' }),
    ),
    h('button', {
      type: 'button',
      class: 'btn danger',
      text: 'Start a new game',
      onclick: async () => {
        if (session && players > 0 && !confirm(`This clears ${players} ${players === 1 ? 'player' : 'players'} and every score, and gives the game a new code. Carry on?`)) return;
        await store.set(KEYS.session(pid), newSession(Date.now(), Math.random));
        toast('New game. New code.');
      },
    }),
    h('p', { class: 'hint', text: 'After a rehearsal, start a new game so the real one starts empty, with a new code.' }),
  );
}

// Rehearsing alone: a practice game, on a code of its own, that pretend players
// join and play when the slideshow starts. Ending it starts a clean real game.
const PRETEND = 12;

function practiceCard(players) {
  if (practice?.bots) {
    return h(
      'div',
      { class: 'card practice-on' },
      h('b', { text: 'Practice game on.' }),
      h('div', { text: `Start the slideshow and ${practice.bots} pretend players join and answer, so you can see every question, result and the podium. The screen says Practice while it is on.` }),
      h('button', {
        type: 'button',
        class: 'btn primary',
        text: 'End practice',
        onclick: async () => {
          await store.remove(`tally.practice.${pid}`);
          await store.set(KEYS.session(pid), newSession(Date.now(), Math.random));
          toast('Practice over. The real game starts empty, with a new code.');
        },
      }),
    );
  }
  return h(
    'div',
    { class: 'group' },
    h('button', {
      type: 'button',
      class: 'btn',
      text: 'Rehearse with pretend players',
      onclick: async () => {
        if (session && players > 0 && !confirm(`A practice game gets its own code, so the ${players} ${players === 1 ? 'player' : 'players'} in this game and their scores are cleared. Carry on?`)) return;
        await store.set(KEYS.session(pid), newSession(Date.now(), Math.random));
        await store.set(`tally.practice.${pid}`, { bots: PRETEND, at: Date.now() });
        toast(`Practice game ready. Start the slideshow and ${PRETEND} pretend players join.`);
      },
    }),
    h('p', { class: 'hint', text: 'Pretend players answer every question, so you see each result before the real thing.' }),
  );
}

// ---- the deck ------------------------------------------------------------------

// Settings for the whole deck, under the quiz: the look as swatches to tap,
// then joining and backups, each folded with a line saying how it stands.
const openParts = new Set();

function lookName() {
  const same = (p) => Object.entries(p.theme).every(([k, v]) => String(deck.theme[k]).toLowerCase() === v);
  return PRESETS.find(same)?.name || 'Your own colours';
}

const siteOf = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

function part(id, title, status, warn, ...body) {
  const el = h(
    'details',
    { class: `step${warn ? ' warn' : ''}`, open: openParts.has(id) || null },
    h('summary', null, h('span', { class: 'what' }, h('b', { text: title }), h('small', { text: status })), h('span', { class: 'flag', text: warn ? '!' : '' })),
    h('div', { class: 'body' }, ...body),
  );
  el.addEventListener('toggle', () => (el.open ? openParts.add(id) : openParts.delete(id)));
  return el;
}

function drawDeck() {
  const $pane = $('deck-pane');
  if (view !== 'quiz' || !deck) return;
  const joins = Object.values(deck.slides).filter((s) => s.kind === 'join');
  const site = siteOf(deck.joinBase || DEFAULT_JOIN_BASE);
  fill(
    $pane,
    h('h2', { text: 'For the whole deck' }),
    h('div', { class: 'look-head' }, h('b', { text: 'Look' }), h('small', { text: `${lookName()} · every quiz slide, and the phones` })),
    presetsRow(),
    h('div', { class: 'preview-slot' }),
    h('details', { class: 'more' }, h('summary', { text: 'Fine-tune the colours and font' }), h('div', { class: 'body' }, styleControls(deck.theme, patchTheme), h('button', { type: 'button', class: 'btn', text: 'Back to the standard look', onclick: () => { deck.theme = { ...DEFAULT_THEME }; save(); drawDeck(); drawPreview(); } }))),
    part(
      'join',
      'Joining',
      `${site ? `Phones go to ${site}` : 'No join address'} · ${deck.showJoin ? 'code on every question' : 'code on the join screen only'}`,
      !site,
      h('p', { class: 'hint', text: joins.length ? 'People scan the QR code on your join screen, or type the address and code shown there.' : 'Add a Join screen near the start of the deck too: it shows the QR code and the code.' }),
    field(
      'Join address',
      h('input', {
        type: 'url',
        value: deck.joinBase,
        placeholder: DEFAULT_JOIN_BASE || 'https://…',
        oninput: (e) => {
          deck.joinBase = e.target.value.trim();
          save();
          store.set(KEYS.settings, { joinBase: deck.joinBase });
        },
      }),
      DEFAULT_JOIN_BASE ? `The page the QR code opens. Leave it empty to use ${DEFAULT_JOIN_BASE.replace(/^https?:\/\//, '').replace(/\/$/, '')}.` : 'The page the QR code opens. Set once; every deck remembers it.',
    ),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: deck.showJoin, onchange: (e) => { deck.showJoin = e.target.checked; save(); drawPreview(); } }), 'Show the join address and code on every question, for latecomers'),
    ),
    part(
      'backups',
      syncOn ? 'Backups, sharing and question list' : 'Backups and question list',
      backup?.at ? `Safety copy saved ${new Date(backup.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${bank.length ? ` · ${bank.length} questions loaded` : ''}` : 'Safety copy not saved yet',
      false,
    h(
      'div',
      { class: 'card' },
      backup?.at
        ? [h('b', { text: 'Saved to your Mac.' }), ` Downloads/${backup.file}, at ${new Date(backup.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} on ${new Date(backup.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}.`]
        : [h('b', { text: 'Not saved yet.' }), ' A copy is written to your Downloads folder about a minute after each change.'],
    ),
    h('p', { class: 'hint', text: `Every question in this deck, as one file outside Chrome. If ${BRAND} is ever removed, Import brings it all back.` }),
    h('div', { class: 'row' }, inExtension ? h('button', { type: 'button', class: 'btn', text: 'Save a copy now', onclick: saveCopyNow }) : null, h('button', { type: 'button', class: 'btn', text: 'Import', onclick: () => pickFile((json) => { deck = normaliseDeck({ ...json, presentationId: pid }, pid); flush(); drawAll(); toast('Imported'); }) })),
    h('h3', { text: 'Backup player' }),
    h('p', { class: 'hint', text: 'Runs this quiz over a PDF of the deck, with no Google page involved, in case the slideshow ever lets you down. Export after any change.' }),
    h('button', { type: 'button', class: 'btn', text: 'Export for the backup player', onclick: () => download(`popquiz-${(deck.title || 'deck').replace(/[^\w]+/g, '-').toLowerCase()}.json`, deck) }),
    // Only while a sharing service is set: until Pop Quiz has one of its own,
    // each deck's quiz lives on this laptop and in its safety copy.
    ...(syncOn
      ? [
          h('h3', { text: 'On your other devices' }),
          h('div', { class: 'card' }, sharedLine()),
          h('p', { class: 'hint', text: `Open this deck in any Chrome with ${BRAND} and the quiz is there. Changes are sent within a minute, or at once when you leave the deck’s tab.` }),
          inExtension ? h('button', { type: 'button', class: 'btn', text: 'Check now', onclick: async () => { flush(); await chrome.runtime.sendMessage({ t: 'tally:sync', presentationId: pid }).catch(() => {}); toast('Checked'); } }) : null,
          kept?.deck
            ? h(
                'div',
                { class: 'card' },
                h('b', { text: 'A copy was set aside.' }),
                ` On ${when(kept.at)} a newer version from another device replaced what was here. The replaced one is kept. `,
                h('button', { type: 'button', class: 'link', text: 'Bring it back', onclick: async () => { if (!confirm('Replace the quiz on this deck with the copy that was set aside?')) return; deck = normaliseDeck({ ...kept.deck, presentationId: pid }, pid); flush(); await store.remove(`tally.kept.${pid}`); drawAll(); toast('Brought back'); } }),
                ' · ',
                h('button', { type: 'button', class: 'link', text: 'Discard it', onclick: () => store.remove(`tally.kept.${pid}`) }),
              )
            : null,
          earlierControls(),
        ]
      : []),
      h('h3', { text: 'Question list' }),
    h('p', { class: 'hint', text: bank.length ? `${bank.length} questions loaded. Pick one at the top of any question.` : 'Load a list of questions, or paste one written by you or an AI assistant, and each slide can be filled from it in one click.' }),
    h(
      'div',
      { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn',
        text: bank.length ? 'Load a different list' : 'Load a question list',
        onclick: () =>
          pickFile(async (json) => {
            const { questions, skipped } = readQuiz(json);
            if (!questions.length) throw new Error(skipped[0] || 'no questions in it');
            await useBank(questions, skipped);
          }),
      }),
      h('button', { type: 'button', class: 'btn', text: 'Paste a quiz', onclick: () => pasteBox() }),
    ),
    h('div', { id: 'paste-quiz' }),
    ),
    h('p', { class: 'hint version', text: `${BRAND} ${editor?.version || ''}${editor?.presenting ? ' · slideshow running' : ''}` }),
  );
  placePreview();
}


// ---- drawing ----------------------------------------------------------------

const TABS = ['slide', 'quiz', 'present'];

function drawAll() {
  if (!deck) return;
  for (const t of TABS) {
    $(`view-${t}`).hidden = view !== t;
    $(`tab-${t}`).setAttribute('aria-selected', String(view === t));
  }
  drawBadge();
  if (view === 'slide') drawSlide(true);
  if (view === 'quiz') {
    drawQuiz();
    drawDeck();
  }
  if (view === 'present') drawPresent();
  placePreview();
  drawPreview();
}

// The preview sits on top of the Slide tab, and beside the looks on the Quiz
// tab, where it shows a look as it is picked.
function placePreview() {
  const wrap = $('preview-wrap');
  const slot = view === 'quiz' ? $('deck-pane').querySelector('.preview-slot') : null;
  if (slot) slot.append(wrap);
  else if (wrap.parentElement !== $('view-slide')) $('view-slide').insertBefore(wrap, $('slide-pane'));
}

// How many things need fixing: a count on the Quiz tab, seen from every tab,
// and a line on top of the Slide tab, where the work is done.
function drawBadge() {
  const n = deck && Object.keys(deck.slides).length ? readiness().filter((i) => i.level === 'warn').length : 0;
  const badge = $('tab-quiz').querySelector('.badge');
  badge.hidden = !n;
  badge.textContent = String(n);
  $('tab-quiz').setAttribute('aria-label', n ? `Quiz, ${n} to fix` : 'Quiz');
  const chip = $('fix-chip');
  chip.hidden = !n || view !== 'slide';
  const here = n ? problemsBySlide()[slideId()] : null;
  // One problem is named outright, by its first sentence; several are counted.
  const only = n === 1 ? readiness().find((i) => i.level === 'warn').text.replace(/^(Slide \d+|A slide): /, '').split('. ')[0].replace(/\.$/, '') : null;
  if (n) fill(chip, h('span', { class: 'flag', text: '!' }), h('span', { class: 'what', text: here ? `This slide: ${here}` : only || `${n} things need fixing` }), here ? null : h('button', { type: 'button', class: 'link', text: 'Show', onclick: () => showView('quiz') }));
}

function showView(next) {
  view = next;
  picking = false;
  changing = false;
  document.querySelector('main').scrollTop = 0;
  drawAll();
}

for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => showView(t));

window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
new ResizeObserver(() => previewModule.refit()).observe($('preview'));

await poll();
checkForNewer();
setInterval(checkForNewer, 60000);
drawAll();
setInterval(poll, 700);
