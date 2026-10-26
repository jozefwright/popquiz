// Tally inside Google Slides.
//
// Loaded by content.js on every docs.google.com/presentation page. It does
// three things and no more:
//
//   1. In the editor, it tells the side panel which slide is selected and
//      where that slide's shapes sit, and it draws a preview of the module on
//      the slide itself, following its placeholder as that is moved. The same
//      preview is drawn small on the slide's thumbnail in the filmstrip.
//   2. When a slideshow starts, it lays the stage (an iframe of this
//      extension's own page) over the slide, inside the element Google puts
//      full screen, and keeps it told which slide is showing.
//   3. It passes Tally's hotkeys to the stage.
//
// It reads Google's page and never changes it, with one exception: the
// placeholder shape a module sits on is hidden during the slideshow.
//
// What it relies on in Google's markup, found in the spike on 6 Oct 2026
// (see docs/SLIDES.md). If Slides changes these, this file is where to look.
//   editor   div#workspace > div#pages       the canvas; a sibling svg after
//                                            #pages carries the selection handles
//            g#editor-<objectId>             one per shape on the open slide
//            g#editor-<slideId>-bg           the slide's own background
//            g#filmstrip-slide-<n>-<slideId> thumbnails, n from 0; only those near
//                                            the one in view exist at any moment
//            g#filmstrip-slide-<n>-<slideId>-bg   that thumbnail's own rectangle
//            g#filmstrip-slide-<n>-<objectId>     each shape, inside the thumbnail
//            div.punch-filmstrip-scroll      the box the filmstrip scrolls in
//            #slide=id.<slideId>             in the address, follows the selection
//            (Google's selection outline is read when it can be. Since Slides
//            redrew its selection on 15 Oct 2026, Tally also works out the
//            selected shape from where a press lands: see pressedShape.)
// The names are kept as data in shared/slides-map.js, so a fix can be
// published without a new extension; this map is what they mean.
//   show     div.punch-full-screen-element > iframe.punch-present-iframe
//            .punch-viewer-svgpage-svgcontainer svg > g#<slideId>   the slide
//            g#<objectId>                    each shape, inside that

import { store, KEYS } from '../shared/store.js';
import { normaliseDeck } from '../shared/deck.js';
import { DEFAULT_JOIN_BASE } from '../shared/config.js';
import { mountModule } from '../stage/modules.js';
import { mockView } from '../stage/mock.js';
import { tagRect, TAG_SHAPE, LETTERS } from '../shared/protocol.js';
import { BRAND } from '../shared/brand.js';
import { MAP_KEY, mergeMap, find, reEscape } from '../shared/slides-map.js';
import { addFonts } from '../shared/fonts.js';

// Google's markup, as shared/slides-map.js names it: the shipped copy until
// start() reads the one background.js keeps.
let M = mergeMap(null);
let SKIP = skipPattern();
function useMap(published) {
  M = mergeMap(published);
  SKIP = skipPattern();
}
// A shape's id that is really its slide's background or one of its paragraphs.
function skipPattern() {
  return new RegExp(`${reEscape(M.bg)}$|${reEscape(M.paragraph)}\\d+$`);
}
const ED = () => `g[id^="${M.editor}"]`;
const edEl = (id) => document.getElementById(M.editor + id);
const edId = (g) => g.id.slice(M.editor.length);
const thumbOf = (slideId) => document.querySelector(`g[id^="${M.filmstrip}"][id$="-${CSS.escape(slideId)}"]`);
const thumbN = (thumb) => thumb && thumb.id.match(new RegExp(`^${reEscape(M.filmstrip)}(\\d+)-`));
const VERSION = chrome.runtime.getManifest().version;

let presentationId = null;
let deck = null;
let stage = null; // the iframe, while a slideshow is running
let stageReady = false;
let stageState = null;
let viewer = null; // { doc, frame } of the running slideshow
let lastSent = '';
let keyTargets = new WeakSet();
let watcher = null;
const diag = { ticks: 0, mounts: 0, unmounts: 0, lastError: null, lastUnmountWhy: null };
let preview = null; // { el, module, box } drawn on the slide in the editor
let thumbs = null; // { el, root, items } the same, small, on the filmstrip's thumbnails
let previewSent = '';
let ui = { previewPhase: 'voting' };
let saveTimer = 0;
const EXT_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

const fromAddress = () => (location.href.match(new RegExp(`[#?&]${reEscape(M.slideHash)}([\\w.-]+)`)) || [])[1] || null;

// The colour a slide's background is filled with, when it is a plain colour,
// so the module can make its words read against it. Null for a picture or
// anything else that is not a plain fill.
function fillOf(bg) {
  if (!bg || bg.querySelector('image')) return null;
  const el = bg.hasAttribute('fill') ? bg : bg.querySelector('[fill]:not([fill="none"])');
  const f = (el?.getAttribute('fill') || '').trim();
  return /^#([0-9a-f]{3}){1,2}$/i.test(f) ? f : null;
}

function rect(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function fraction(inner, outer) {
  if (!outer.w || !outer.h) return null;
  return { x: (inner.x - outer.x) / outer.w, y: (inner.y - outer.y) / outer.h, w: inner.w / outer.w, h: inner.h / outer.h };
}

// ---- the editor: what the side panel needs to know --------------------------

function editorInfo() {
  const slideId = fromAddress();
  const info = { presentationId, version: VERSION, title: document.title.replace(/ - Google Slides$/, ''), slideId, index: null, shapes: [], selected: null, presenting: !!stage, stage: stageState };
  if (!slideId) return info;
  const thumb = thumbOf(slideId);
  const n = thumbN(thumb);
  if (n) info.index = +n[1] + 1;
  const page = edEl(slideId);
  if (!page) return info;
  const bg = edEl(slideId + M.bg);
  const slide = rect(bg || page);
  info.fill = fillOf(bg);
  for (const g of page.querySelectorAll(ED())) {
    const id = edId(g);
    if (id === slideId || SKIP.test(id)) continue;
    const f = fraction(rect(g), slide);
    if (!f || f.w < 0.02 || f.h < 0.02) continue;
    // The words in it, a paragraph at a time, so a question can start from the
    // slide's own title and a lineup's names. Only shapes directly on the page.
    const text = g.parentElement?.closest(ED()) === page ? shapeText(g) : [];
    info.shapes.push({ id, ...f, ...(text.length ? { text } : {}) });
  }
  const selected = selectedShape(slideId) || pressedShape(slideId);
  if (selected && info.shapes.some((sh) => sh.id === selected)) info.selected = selected;
  return info;
}

// A shape's text, one string per paragraph. Slides draws each word (and each
// change of style inside a word) as its own <text>, with no spaces between, so
// the spaces are put back from where the pieces sit: a gap, or a new line.
function shapeText(g) {
  const paras = [...g.querySelectorAll(`g[id*="${M.paragraph}"]`)];
  const out = [];
  for (const block of paras.length ? paras : [g]) {
    let line = '';
    let last = null;
    for (const t of block.querySelectorAll('text')) {
      const s = t.textContent;
      if (!s) continue;
      const r = t.getBoundingClientRect();
      if (last) {
        const sameLine = Math.abs(r.top - last.top) < last.height * 0.5;
        if (!sameLine || r.left - last.right > last.height * 0.08) line += ' ';
      }
      line += s;
      last = r;
    }
    line = line.replace(/\s+/g, ' ').trim();
    if (line) out.push(line.slice(0, 300));
  }
  return out.slice(0, 12);
}

// The shape the user has selected on the canvas, if it is exactly one.
// Slides draws a selection as a blue outline in the svg that follows #pages;
// the shape whose rectangle matches that outline is the selected one.
function selectedShape(slideId) {
  const workspace = document.getElementById(M.workspace);
  const page = edEl(slideId);
  const layer = workspace && [...workspace.children].find((c) => c.tagName.toLowerCase() === 'svg');
  if (!layer || !page) return null;
  const outlines = [...layer.querySelectorAll(`path[stroke="${M.selectionStroke}" i]`)].filter((el) => {
    const fill = el.getAttribute('fill');
    if (fill && fill !== 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 16 && r.height > 16;
  });
  if (outlines.length !== 1) return null;
  const o = rect(outlines[0]);
  let best = null;
  for (const g of page.querySelectorAll(ED())) {
    const id = edId(g);
    if (id === slideId || SKIP.test(id)) continue;
    const r = rect(g);
    const off = Math.abs(r.x - o.x) + Math.abs(r.y - o.y) + Math.abs(r.w - o.w) + Math.abs(r.h - o.h);
    if (off < 8 && (!best || off < best.off)) best = { id, off };
  }
  return best ? best.id : null;
}

// The shape last pressed on, worked out from where the press landed.
//
// Google draws its selection its own way, and changes it: on 15 Oct 2026 Slides
// gave selections round handles and pills on the edges, and selectedShape above
// stopped recognising them, so the panel said nothing was selected. This does
// not depend on how a selection looks. It only watches presses on the canvas,
// and it stops and changes nothing: Slides selects the shape as usual.
//
// It follows Slides' own rules as far as they matter here. The press picks the
// topmost shape under it, a group as a whole (as Slides' first click does), and
// nothing on empty canvas. A press just outside the selected shape is on its
// handles and keeps it. Shift or Cmd adds to Slides' selection, which is then
// more than one, and Escape clears it.

let pressed = null; // { slideId, id }

const IGNORE = 'button, [role="button"], [role="toolbar"], [role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], input, textarea';

function topShapeAt(slideId, x, y) {
  const page = edEl(slideId);
  if (!page) return null;
  let hit = null;
  for (const g of page.querySelectorAll(ED())) {
    const id = edId(g);
    if (id === slideId || SKIP.test(id)) continue;
    if (g.parentElement?.closest(ED()) !== page) continue; // inside a group: the group is what is picked
    const r = rect(g);
    if (r.w < 2 || r.h < 2) continue;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) hit = id; // later shapes are drawn over earlier ones
  }
  return hit;
}

function notePress(e) {
  if (e.button !== 0 && e.button !== 2) return;
  const slideId = fromAddress();
  const workspace = document.getElementById(M.workspace);
  if (!slideId || !workspace) return;
  const path = e.composedPath();
  if (preview && path.includes(preview.el)) return; // Tally's own handles
  if (path.some((n) => n instanceof Element && (n.matches(IGNORE) || n.matches(M.filmstripScroll)))) return; // Google's menus and floating tools
  const w = rect(workspace);
  const x = e.clientX;
  const y = e.clientY;
  if (x < w.x || x > w.x + w.w || y < w.y || y > w.y + w.h) return; // not on the canvas
  if (e.shiftKey || e.metaKey || e.ctrlKey) {
    pressed = null;
    return;
  }
  const held = pressed?.slideId === slideId && edEl(pressed.id);
  if (held) {
    const r = rect(held);
    const within = (pad) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
    if (!within(0) && within(14)) return;
  }
  const id = topShapeAt(slideId, x, y);
  pressed = id ? { slideId, id } : null;
}

window.addEventListener('pointerdown', notePress, true);
window.addEventListener('keydown', (e) => e.key === 'Escape' && (pressed = null), true);

function pressedShape(slideId) {
  return pressed?.slideId === slideId && edEl(pressed.id) ? pressed.id : null;
}

// ---- the editor: the module drawn on the slide ------------------------------

// Where the module belongs on the slide that is open in the editor, or null
// if that slide is not a Tally slide (or the editor is not showing one).
function editorTarget() {
  const slideId = fromAddress();
  const cfg = slideId && deck.slides[slideId];
  if (!cfg) return null;
  const workspace = document.getElementById(M.workspace);
  const pages = document.getElementById(M.pages);
  const page = edEl(slideId);
  if (!workspace || !pages || !page) return null;
  const bg = edEl(slideId + M.bg);
  const slide = rect(bg || page);
  if (slide.w < 40 || slide.h < 20) return null;
  const g = cfg.place.shapeId ? edEl(cfg.place.shapeId) : null;
  const shape = g && page.contains(g) ? rect(g) : null;
  const box = shape || { x: slide.x + cfg.place.x * slide.w, y: slide.y + cfg.place.y * slide.h, w: cfg.place.w * slide.w, h: cfg.place.h * slide.h };
  return { slideId, cfg, workspace, pages, slide, box, shape, fill: fillOf(bg) };
}

// Where each pinned option's shape sits on the open slide right now, as a
// share of the slide; where it was last seen if it cannot be found.
function editorPins(t) {
  return (t.cfg.pins || []).map((pin) => {
    if (!pin) return null;
    const g = edEl(pin.shapeId);
    return (g && fraction(rect(g), t.slide)) || pin;
  });
}

function removePreview() {
  preview?.observer.disconnect();
  preview?.el.remove();
  preview = null;
  previewSent = '';
  hideInEditor(null);
}

// Dresses the open slide in the editor the way the show will dress it.
//   - While its module is drawn over it, the placeholder's own fill is hidden,
//     so the slide looks as the room will see it. The shape is still there to
//     click, drag and resize.
//   - Shapes that arrive or leave at the reveal are ghosted when they would be
//     absent, following the panel's Voting / Result switch, and tagged.
// The rules exist only while a preview does, so nothing can be left faded.
function hideInEditor(t) {
  const sel = (shapeId) => `#${CSS.escape(M.editor + shapeId)}`;
  const rules = [];
  const marks = [];
  if (t) {
    if (t.shape) rules.push(`${sel(t.cfg.place.shapeId)}{opacity:0!important}`);
    const r = t.cfg.kind === 'question' ? t.cfg.reveal : null;
    const result = ui.previewPhase === 'reveal';
    for (const [list, kind] of [[r?.show || [], 'show'], [r?.hide || [], 'hide']]) {
      for (const shapeId of list) {
        const g = edEl(shapeId);
        if (!g) continue;
        const absent = kind === 'show' ? !result : result;
        if (absent) rules.push(`${sel(shapeId)}{opacity:.25!important}`);
        marks.push({ kind, box: rect(g) });
      }
    }
  }
  drawMarks(t, marks);
  const css = rules.join('');
  let style = document.getElementById('popquiz-editor-hide');
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = 'popquiz-editor-hide';
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

const PREVIEW_CSS = `
  :host { all: initial; position: absolute; display: block; pointer-events: none; user-select: none; }
  #module { position: absolute; inset: 0; }
  #frame { position: absolute; inset: 0; border: 1.5px dashed #f9ab00; border-radius: 2px; box-shadow: 0 0 0 1px rgba(26, 26, 26, 0.25); }
  /* The tag hangs just below the module, so it never covers an option. */
  #tag { position: absolute; left: -1px; top: 100%; padding: 2px 6px; font: 700 10px/1.3 'Figtree', system-ui, sans-serif; white-space: nowrap;
         letter-spacing: 0.04em; text-transform: uppercase; color: #1a1a1a; background: #f9ab00; border-radius: 0 0 3px 3px; }
  /* A module that is not on a shape is moved and sized here, by hand. */
  #drag, #corner { display: none; position: absolute; pointer-events: auto; touch-action: none; }
  :host([data-free]) #drag, :host([data-free]) #corner { display: block; }
  #drag { inset: 0; cursor: move; }
  :host([data-free]) #frame { border-style: solid; }
  :host([data-free]:hover) #frame, :host([data-dragging]) #frame { border-color: #f9ab00; box-shadow: 0 0 0 1px #f9ab00, 0 0 0 2px rgba(26, 26, 26, 0.4); }
  #corner { right: -7px; bottom: -7px; width: 14px; height: 14px; box-sizing: border-box; background: #fff;
            border: 2px solid #1a1a1a; border-radius: 50%; cursor: nwse-resize; }
  /* A put-in-order round's place labels, each dragged to its item on the slide. */
  #tags { position: absolute; inset: 0; pointer-events: none; }
  .tag { position: absolute; box-sizing: border-box; pointer-events: auto; touch-action: none; cursor: move;
         border: 1.5px dashed #f9ab00; border-radius: 6px; box-shadow: 0 0 0 1px rgba(26, 26, 26, 0.25); }
  .tag:hover, .tag.dragging { border-style: solid; box-shadow: 0 0 0 1px #f9ab00, 0 0 0 2px rgba(26, 26, 26, 0.4); }
  .tag .name { position: absolute; left: -1.5px; bottom: 100%; padding: 2px 6px; font: 700 10px/1.3 'Figtree', system-ui, sans-serif;
               white-space: nowrap; letter-spacing: 0.04em; text-transform: uppercase; color: #1a1a1a; background: #f9ab00;
               border-radius: 3px 3px 0 0; pointer-events: none; }
  .tag .size { position: absolute; right: -7px; bottom: -7px; width: 14px; height: 14px; box-sizing: border-box; background: #fff;
               border: 2px solid #1a1a1a; border-radius: 50%; cursor: nwse-resize; }
`;

const tagged = (cfg) => cfg?.kind === 'question' && cfg.type === 'rank' && cfg.display === 'pins';

// One handle per item on a put-in-order round shown on the slide, over its
// label, named, so each can be dragged to its item.
function placeTagGrips(t) {
  const box = preview.tags;
  const n = tagged(t.cfg) ? t.cfg.options.length : 0;
  while (box.childElementCount > n) box.lastElementChild.remove();
  while (box.childElementCount < n) box.append(tagGrip(box.childElementCount));
  [...box.children].forEach((g, i) => {
    const r = tagRect(t.cfg, i);
    const s = g.style;
    s.left = `${(t.slide.x + r.x * t.slide.w - t.box.x).toFixed(1)}px`;
    s.top = `${(t.slide.y + r.y * t.slide.h - t.box.y).toFixed(1)}px`;
    s.width = `${(r.w * t.slide.w).toFixed(1)}px`;
    s.height = `${(r.h * t.slide.h).toFixed(1)}px`;
    const name = `${LETTERS[i]} · ${String(t.cfg.options[i] ?? '').trim() || 'no name yet'}`;
    if (g.firstChild.textContent !== name) g.firstChild.textContent = name;
  });
}

function tagGrip(i) {
  const g = document.createElement('div');
  g.className = 'tag';
  g.title = 'Drag to this item on the slide';
  const name = document.createElement('span');
  name.className = 'name';
  const size = document.createElement('div');
  size.className = 'size';
  size.title = 'Drag to resize';
  g.append(name, size);
  g.addEventListener('pointerdown', (e) => beginTagDrag(e, i, e.target === size ? 'size' : 'move'));
  shieldFromSlides(g);
  return g;
}

// Dragging a label, or its corner. Saved as a pin on TAG_SHAPE, as a share of
// the slide, so it holds at any zoom and in the slideshow.
function beginTagDrag(e, i, mode) {
  if (e.button !== 0) return;
  const t = editorTarget();
  if (!t || !preview || !tagged(t.cfg)) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget;
  const from = { x: e.clientX, y: e.clientY, r: tagRect(t.cfg, i) };
  grip.classList.add('dragging');
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {}
  const move = (ev) => {
    const now = editorTarget();
    if (!now || !tagged(now.cfg) || i >= now.cfg.options.length) return;
    const dx = (ev.clientX - from.x) / now.slide.w;
    const dy = (ev.clientY - from.y) / now.slide.h;
    const r = { ...from.r };
    if (mode === 'move') {
      r.x = clamp(from.r.x + dx, 0, 1 - r.w);
      r.y = clamp(from.r.y + dy, 0, 1 - r.h);
    } else {
      r.w = clamp(from.r.w + dx, 0.04, 1 - r.x);
      r.h = clamp(from.r.h + dy, 0.04, 1 - r.y);
    }
    const pins = now.cfg.options.map((_, k) => now.cfg.pins?.[k] || null);
    pins[i] = { shapeId: TAG_SHAPE, x: r.x, y: r.y, w: r.w, h: r.h };
    now.cfg.pins = pins;
    placePreview(now);
  };
  const end = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    grip.classList.remove('dragging');
    clearTimeout(saveTimer);
    store.set(KEYS.deck(presentationId), deck);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Dragging the module (or its corner) in the editor. Positions are fractions
// of the slide, so they hold at any zoom and in the slideshow.
function beginDrag(e, mode) {
  if (e.button !== 0) return;
  const t = editorTarget();
  if (!t || t.shape || !preview) return;
  e.preventDefault();
  e.stopPropagation();
  const grip = e.currentTarget;
  const from = { x: e.clientX, y: e.clientY, place: { ...t.cfg.place } };
  preview.el.toggleAttribute('data-dragging', true);
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {}
  const move = (ev) => {
    const now = editorTarget();
    if (!now || now.shape) return;
    const p = now.cfg.place;
    const dx = (ev.clientX - from.x) / now.slide.w;
    const dy = (ev.clientY - from.y) / now.slide.h;
    if (mode === 'move') {
      p.x = clamp(from.place.x + dx, 0, 1 - p.w);
      p.y = clamp(from.place.y + dy, 0, 1 - p.h);
    } else {
      p.w = clamp(from.place.w + dx, 0.12, 1 - p.x);
      p.h = clamp(from.place.h + dy, 0.12, 1 - p.y);
    }
    placePreview(now);
  };
  const end = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    preview?.el.toggleAttribute('data-dragging', false);
    clearTimeout(saveTimer);
    store.set(KEYS.deck(presentationId), deck);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// A press on Tally's own handles must not also reach Slides, which would
// start a selection box on the canvas underneath. The handles swallow their
// own mouse events on the way back up; nothing is intercepted on the way down,
// or the handles themselves would never hear the press.
function shieldFromSlides(el) {
  for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
    el.addEventListener(type, (e) => {
      e.stopPropagation();
      if (type !== 'click') e.preventDefault();
    });
  }
}

let fontLoaded = false;

// A font declared inside a shadow root is ignored, so Pop Quiz's type is
// registered on the document, once, by whichever preview is drawn first.
function ensureFont() {
  if (fontLoaded) return;
  fontLoaded = true;
  try {
    addFonts(document, chrome.runtime.getURL('vendor/')).then(() => {
      preview?.module.refit();
      for (const item of thumbs?.items.values() || []) item.module.refit();
    }, () => {});
  } catch {}
}

// The module is drawn straight into the page, inside a shadow root so that
// Google's styles and Tally's cannot touch each other. (In the slideshow it is
// an iframe instead, because there it also runs the engine.)
function buildPreview(t) {
  ensureFont();
  const el = document.createElement('div');
  el.id = 'popquiz-preview';
  el.setAttribute('aria-hidden', 'true');
  const root = el.attachShadow({ mode: 'open' });
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = chrome.runtime.getURL('stage/modules.css');
  const own = document.createElement('style');
  own.textContent = PREVIEW_CSS;
  const box = document.createElement('div');
  box.id = 'module';
  const frame = document.createElement('div');
  frame.id = 'frame';
  const tag = document.createElement('div');
  tag.id = 'tag';
  tag.textContent = `${BRAND} preview`;
  const drag = document.createElement('div');
  drag.id = 'drag';
  drag.title = 'Drag to move';
  drag.addEventListener('pointerdown', (e) => beginDrag(e, 'move'));
  const corner = document.createElement('div');
  corner.id = 'corner';
  corner.title = 'Drag to resize';
  corner.addEventListener('pointerdown', (e) => beginDrag(e, 'size'));
  shieldFromSlides(drag);
  shieldFromSlides(corner);
  const tags = document.createElement('div');
  tags.id = 'tags';
  root.append(css, own, box, frame, tag, drag, corner, tags);
  // Straight after the pages and before the selection handles, so the handles
  // still draw on top and every click reaches the shape beneath.
  t.workspace.insertBefore(el, t.pages.nextSibling);
  const module = mountModule(box, { joinBase: '', editing: true });
  let refit = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(refit);
    refit = setTimeout(() => module.refit(), 40);
  });
  observer.observe(el);
  css.addEventListener('load', () => module.refit());
  preview = { el, module, observer, tags };
  requestAnimationFrame(follow);
}

// Runs every animation frame while a preview is up, so the module tracks its
// placeholder as it is dragged. It only ever sets four style properties.
function placePreview(t) {
  const origin = rect(t.workspace);
  const s = preview.el.style;
  s.left = `${(t.box.x - origin.x).toFixed(1)}px`;
  s.top = `${(t.box.y - origin.y).toFixed(1)}px`;
  s.width = `${Math.max(8, t.box.w).toFixed(1)}px`;
  s.height = `${Math.max(8, t.box.h).toFixed(1)}px`;
  // Options shown out on the slide follow their own shapes, wherever the box is.
  if (t.cfg.pins || tagged(t.cfg)) preview.module.place(fraction(t.box, t.slide), editorPins(t));
  placeTagGrips(t);
}

function drawEditorPreview() {
  const t = stage || findViewer() ? null : editorTarget();
  if (!t) {
    if (preview) removePreview();
    return;
  }
  if (preview && (!preview.el.isConnected || preview.el.parentElement !== t.workspace)) removePreview();
  if (!preview) buildPreview(t);
  placePreview(t);
  preview.el.toggleAttribute('data-free', !t.shape);
  hideInEditor(t);
  const packed = JSON.stringify([t.slideId, t.cfg, deck.theme, deck.joinBase, deck.showJoin, ui.previewPhase, t.fill]);
  if (packed !== previewSent) {
    previewSent = packed;
    const now = Date.now();
    preview.module.setContext({ joinBase: DEFAULT_JOIN_BASE || deck.joinBase, joinHint: deck.showJoin, slideFill: t.fill, now: () => now });
    preview.module.update(mockView(deck, t.cfg, { phase: ui.previewPhase, slideId: t.slideId, now }));
    preview.module.tick(now);
    preview.module.refit();
  }
  remember(t);
}

function follow() {
  if (!preview) return;
  const t = stage ? null : editorTarget();
  if (t && preview.el.isConnected) placePreview(t);
  requestAnimationFrame(follow);
}

// Small labels on the shapes that change at the reveal, so it is plain in the
// editor which ones they are.
let marksEl = null;

function drawMarks(t, marks) {
  if (!t || !marks.length) {
    marksEl?.remove();
    marksEl = null;
    return;
  }
  if (!marksEl || !marksEl.isConnected || marksEl.parentElement !== t.workspace) {
    marksEl?.remove();
    marksEl = document.createElement('div');
    marksEl.id = 'popquiz-marks';
    marksEl.setAttribute('aria-hidden', 'true');
    marksEl.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;';
    t.workspace.insertBefore(marksEl, t.pages.nextSibling);
  }
  const origin = rect(t.workspace);
  const packed = JSON.stringify(marks.map((m) => [m.kind, Math.round(m.box.x - origin.x), Math.round(m.box.y - origin.y), Math.round(m.box.w)]));
  if (marksEl.dataset.packed === packed) return;
  marksEl.dataset.packed = packed;
  marksEl.replaceChildren(
    ...marks.map((m) => {
      const tag = document.createElement('div');
      // Kept to the shape's own width, so two shapes side by side never have
      // their labels run into each other.
      const wide = m.box.w >= 140;
      tag.textContent = m.kind === 'show' ? (wide ? 'Arrives at the reveal' : 'Arrives') : wide ? 'Leaves at the reveal' : 'Leaves';
      tag.title = m.kind === 'show' ? 'Arrives at the reveal' : 'Leaves at the reveal';
      tag.style.cssText = `all:initial;position:absolute;box-sizing:border-box;left:${(m.box.x - origin.x).toFixed(1)}px;top:${(m.box.y - origin.y).toFixed(1)}px;max-width:${Math.max(40, m.box.w).toFixed(0)}px;overflow:hidden;text-overflow:ellipsis;padding:2px 6px;font:700 10px/1.3 'Figtree',system-ui,sans-serif;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;color:#fff;background:${m.kind === 'show' ? 'rgba(20,145,90,.94)' : 'rgba(90,90,98,.94)'};border-radius:0 0 3px 0;pointer-events:none;`;
      return tag;
    }),
  );
}

// The slideshow reads the placeholder live, but the PDF fallback cannot see
// shapes at all. So the position and slide number last seen in the editor are
// kept with the slide's settings.
function remember(t) {
  const cfg = t.cfg;
  let dirty = false;
  if (t.shape) {
    const f = fraction(t.shape, t.slide);
    for (const k of ['x', 'y', 'w', 'h']) {
      if (f && Math.abs(cfg.place[k] - f[k]) > 0.002) {
        cfg.place[k] = Math.min(1, Math.max(0, f[k]));
        dirty = true;
      }
    }
  }
  // The same for each shape an option is pinned to.
  (cfg.pins || []).forEach((pin, i) => {
    const now = pin && editorPins(t)[i];
    if (!now || now === pin) return;
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Math.abs(pin[k] - now[k]) > 0.002) {
        pin[k] = Math.min(1, Math.max(0, now[k]));
        dirty = true;
      }
    }
  });
  const thumb = thumbOf(t.slideId);
  const n = thumbN(thumb);
  if (n && cfg.index !== +n[1] + 1) {
    cfg.index = +n[1] + 1;
    dirty = true;
  }
  if (!dirty) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set(KEYS.deck(presentationId), deck), 500);
}

// ---- the editor: the module drawn on the filmstrip's thumbnails -------------

const THUMBS_CSS = `
  :host { all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; user-select: none; }
  .thumb { position: absolute; }
`;

// The box the filmstrip scrolls in: by its name, or failing that the nearest
// thing around the thumbnails that scrolls.
function stripOf(bg) {
  const named = bg.closest(M.filmstripScroll);
  if (named) return named;
  for (let el = bg.ownerSVGElement?.parentElement; el && el !== document.body; el = el.parentElement) {
    if (el instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}

function removeThumbs() {
  thumbs?.el.remove();
  thumbs = null;
  document.getElementById('popquiz-thumbs-hide')?.remove();
}

// Every Tally slide whose thumbnail is in the filmstrip gets its module drawn
// on the thumbnail too, so the strip shows each slide as the room will see it.
//
// Slides builds only the thumbnails near the one in view, and the strip
// scrolls. So the miniatures are put inside the strip's own scrolling box,
// where they scroll with it and are clipped by it, and each is placed by where
// its thumbnail's background sits. Nothing here can be clicked: every press
// still reaches the thumbnail beneath.
// The slide numbers Tally has on record, kept true. A number is noted when a
// slide is made a Tally slide, and goes stale as slides are added or moved;
// the PDF fallback puts each question on the page with its number. Every
// thumbnail the filmstrip draws says where its slide is now, so scrolling the
// filmstrip from top to bottom brings every number up to date. Read from the
// stored deck and written straight back, so an edit in the panel is not lost.
let renumbering = false;
function noteNumbers(seen) {
  const moved = [...seen].filter(([, v]) => v.cfg.index !== v.n + 1);
  if (!moved.length || renumbering) return;
  renumbering = true;
  store
    .get(KEYS.deck(presentationId))
    .then((raw) => {
      if (!raw) return;
      const fresh = normaliseDeck(raw, presentationId);
      let changed = false;
      for (const [id, v] of moved) {
        if (fresh.slides[id] && fresh.slides[id].index !== v.n + 1) {
          fresh.slides[id].index = v.n + 1;
          changed = true;
        }
      }
      if (changed) return store.set(KEYS.deck(presentationId), fresh);
    })
    .catch(() => {})
    .finally(() => (renumbering = false));
}

function drawThumbs() {
  const seen = new Map(); // slideId -> { n, cfg, bg }
  for (const bg of document.querySelectorAll(`g[id^="${M.filmstrip}"][id$="${M.bg}"]`)) {
    const m = bg.id.match(new RegExp(`^${reEscape(M.filmstrip)}(\\d+)-(.+)${reEscape(M.bg)}$`));
    const cfg = m && deck.slides[m[2]];
    if (cfg) seen.set(m[2], { n: +m[1], cfg, bg });
  }
  noteNumbers(seen);
  const scroller = seen.size ? stripOf(seen.values().next().value.bg) : null;
  if (!scroller) {
    if (thumbs) removeThumbs();
    return;
  }
  if (thumbs && (!thumbs.el.isConnected || thumbs.el.parentElement !== scroller)) removeThumbs();
  if (!thumbs) {
    ensureFont();
    const el = document.createElement('div');
    el.id = 'popquiz-thumbs';
    el.setAttribute('aria-hidden', 'true');
    const root = el.attachShadow({ mode: 'open' });
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('stage/modules.css');
    css.addEventListener('load', () => { for (const item of thumbs?.items.values() || []) item.module.refit(); });
    const own = document.createElement('style');
    own.textContent = THUMBS_CSS;
    root.append(css, own);
    scroller.append(el);
    thumbs = { el, root, items: new Map() };
  }

  for (const [slideId, item] of thumbs.items) {
    if (seen.has(slideId)) continue;
    item.el.remove();
    thumbs.items.delete(slideId);
  }

  const origin = rect(thumbs.el); // moves with the strip as it scrolls, so these are places in the strip
  const hide = [];
  let dirty = false;
  for (const [slideId, { n, cfg, bg }] of seen) {
    const slide = rect(bg);
    if (slide.w < 8 || slide.h < 5) continue;
    const g = cfg.place.shapeId ? document.getElementById(`${M.filmstrip}${n}-${cfg.place.shapeId}`) : null;
    const box = g ? rect(g) : { x: slide.x + cfg.place.x * slide.w, y: slide.y + cfg.place.y * slide.h, w: cfg.place.w * slide.w, h: cfg.place.h * slide.h };
    // As in the editor: the placeholder's own fill would show through the module.
    if (g) hide.push(`#${CSS.escape(g.id)}{opacity:0!important}`);

    let item = thumbs.items.get(slideId);
    if (!item) {
      const el = document.createElement('div');
      el.className = 'thumb';
      const inner = document.createElement('div');
      inner.style.cssText = 'position:absolute;inset:0';
      el.append(inner);
      thumbs.root.append(el);
      item = { el, module: mountModule(inner, { joinBase: '' }), packed: '', size: '' };
      thumbs.items.set(slideId, item);
    }
    const s = item.el.style;
    s.left = `${(box.x - origin.x).toFixed(1)}px`;
    s.top = `${(box.y - origin.y).toFixed(1)}px`;
    s.width = `${Math.max(4, box.w).toFixed(1)}px`;
    s.height = `${Math.max(4, box.h).toFixed(1)}px`;

    const packed = JSON.stringify([cfg, deck.theme, deck.joinBase, deck.showJoin, ui.previewPhase, fillOf(bg)]);
    const size = `${box.w.toFixed(0)}x${box.h.toFixed(0)}`;
    if (packed !== item.packed) {
      item.packed = packed;
      item.size = size;
      const now = Date.now();
      item.module.setContext({ joinBase: DEFAULT_JOIN_BASE || deck.joinBase, joinHint: deck.showJoin, slideFill: fillOf(bg), now: () => now });
      item.module.update(mockView(deck, cfg, { phase: ui.previewPhase, slideId, now }));
      item.module.tick(now);
      item.module.refit();
    } else if (size !== item.size) {
      item.size = size;
      item.module.refit();
    }
    // Options shown out on the slide sit over the same shapes on the thumbnail.
    if (cfg.pins) {
      item.module.place(
        fraction(box, slide),
        cfg.pins.map((pin) => {
          const shape = pin && document.getElementById(`${M.filmstrip}${n}-${pin.shapeId}`);
          return pin && ((shape && fraction(rect(shape), slide)) || pin);
        }),
      );
    }

    // The slide's number, as remember() keeps it for the open slide: the PDF
    // fallback finds a question's page by it, and it goes stale when slides
    // are added or moved above.
    if (cfg.index !== n + 1) {
      cfg.index = n + 1;
      dirty = true;
    }
  }

  const css = hide.join('');
  let style = document.getElementById('popquiz-thumbs-hide');
  if (!css) style?.remove();
  else {
    if (!style) {
      style = document.createElement('style');
      style.id = 'popquiz-thumbs-hide';
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }
  if (dirty) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(KEYS.deck(presentationId), deck), 500);
  }
}

// ---- the slideshow ----------------------------------------------------------

function findViewer() {
  const frame = find(document, M, 'presentFrame');
  if (frame) {
    let doc = null;
    try {
      doc = frame.contentDocument;
    } catch {}
    return (doc && find(doc, M, 'svg')) ? { doc, frame, mount: frame.parentElement } : null;
  }
  // The standalone /present page: the viewer is the page itself.
  if (new RegExp(`${reEscape(M.presentPath)}\\b`).test(location.pathname) && find(document, M, 'svg')) return { doc: document, frame: null, mount: document.body };
  return null;
}

// Whatever Google has put full screen must contain the stage, or it will not
// be seen. If the stage is outside it, it is moved in (which reloads it; the
// engine resumes from its saved session).
function mountPoint(v) {
  const fs = document.fullscreenElement;
  if (fs && fs !== v.mount && !v.mount.contains(fs) && fs.contains(v.mount)) return v.mount;
  if (fs && !fs.contains(v.mount)) return fs;
  return v.mount;
}

function mountStage(v) {
  const el = document.createElement('iframe');
  el.id = 'popquiz-stage';
  el.title = 'Pop Quiz';
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  el.src = `${chrome.runtime.getURL('stage/index.html')}#pid=${encodeURIComponent(presentationId)}`;
  el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;border:0;margin:0;padding:0;z-index:2147483646;pointer-events:none;background:transparent;color-scheme:normal;';
  mountPoint(v).appendChild(el);
  diag.mounts++;
  stage = el;
  stageReady = false;
  stageState = null;
  cards = [];
  lastSent = '';
}

function unmountStage(why = '') {
  diag.unmounts++;
  diag.lastUnmountWhy = why;
  stage?.remove();
  stage = null;
  stageReady = false;
  stageState = null;
  cards = [];
  viewer = null;
  lastSent = '';
}

function readSlide(v) {
  const svgs = find(v.doc, M, 'svg', true);
  if (!svgs.length) return null;
  const wanted = fromAddress();
  let page = wanted ? v.doc.getElementById(wanted) : null;
  if (!page || !page.ownerSVGElement) page = svgs[svgs.length - 1].querySelector('g[id]');
  if (!page) return null;
  const svg = page.ownerSVGElement;
  const offset = v.frame ? rect(v.frame) : { x: 0, y: 0 };
  const origin = rect(stage);
  const s = rect(svg);
  const slide = { x: s.x + offset.x - origin.x, y: s.y + offset.y - origin.y, w: s.w, h: s.h };
  const shapes = {};
  // The placeholder a module sits on, and the shapes its options are pinned to.
  for (const cfg of Object.values(deck.slides)) {
    for (const id of [cfg.place?.shapeId, ...(cfg.pins || []).map((p) => p?.shapeId)]) {
      if (!id || shapes[id]) continue;
      // Looked up inside this slide's own drawing: Slides may keep a neighbouring
      // slide in the page too, and layout shapes share ids across slides.
      const g = svg.querySelector(`#${CSS.escape(id)}`);
      if (!g) continue;
      const f = fraction(rect(g), s);
      if (f && f.w > 0.02 && f.h > 0.02) shapes[id] = f;
    }
  }
  return { slideId: page.id, slide, shapes, fill: fillOf(v.doc.getElementById(page.id + M.bg)) };
}

// Dresses the slideshow's own shapes for Tally, with one stylesheet covering
// the whole deck so a rule is already in force when its slide first appears.
//   - A placeholder is a guide for the editor; in the show the module takes
//     its place, so the shape itself is hidden.
//   - A shape marked "show at the reveal" stays hidden until its question is
//     revealed, then pops in. Until the stage says otherwise it is hidden:
//     better a photo arriving late than an answer given away early.
//   - A shape marked "hide at the reveal" leaves at the same moment.
function dressSlides(v) {
  const id = (shapeId) => `#${CSS.escape(shapeId)}`;
  const revealed = stageState?.phase === 'reveal' ? stageState.slideId : null;
  const rules = [];
  for (const [slideId, cfg] of Object.entries(deck.slides)) {
    if (cfg.place?.shapeId) rules.push(`${id(cfg.place.shapeId)}{visibility:hidden!important}`);
    if (cfg.kind !== 'question' || !cfg.reveal) continue;
    const now = revealed === slideId;
    for (const shapeId of cfg.reveal.show) {
      rules.push(now ? `${id(shapeId)}{transform-box:fill-box;transform-origin:center;animation:popquiz-arrive .5s cubic-bezier(.2,1.3,.4,1) both}` : `${id(shapeId)}{visibility:hidden!important}`);
    }
    if (now) for (const shapeId of cfg.reveal.hide) rules.push(`${id(shapeId)}{visibility:hidden!important}`);
  }
  const css = rules.length ? `@keyframes popquiz-arrive{from{opacity:0;transform:scale(.88)}}${rules.join('')}` : '';
  let style = v.doc.getElementById('popquiz-hide');
  if (!style) {
    style = v.doc.createElement('style');
    style.id = 'popquiz-hide';
    (v.doc.head || v.doc.documentElement).appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

function toStage(msg) {
  if (stage?.contentWindow && stageReady) stage.contentWindow.postMessage(msg, EXT_ORIGIN);
}

// Tally's keys do something on a question, and on the final leaderboard,
// where T uncovers the podium. Anywhere else they are left to Slides.
const takesKeys = (cfg) => cfg?.kind === 'question' || (cfg?.kind === 'leaderboard' && cfg.final);

function onKey(e) {
  if (!stage || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const cfg = deck.slides[stageState?.slideId];
  if (!takesKeys(cfg)) return;
  let key = null;
  if (e.key === 't' || e.key === 'T') key = 'advance';
  else if (e.key === 'R' && e.shiftKey) key = 'rerun';
  if (!key) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  toStage({ t: 'tally:key', key });
}

// An open answer's cards on the big screen, as the stage last reported them,
// in its own pixels. A click that lands on one takes it off the screen, and
// Slides never sees that click (it would move to the next slide).
let cards = [];
const cardWindows = new WeakSet();

function cardAt(e) {
  if (!stage || !cards.length) return null;
  const off = viewer?.frame && e.view !== window ? rect(viewer.frame) : { x: 0, y: 0 };
  const s = rect(stage);
  const x = e.clientX + off.x - s.x;
  const y = e.clientY + off.y - s.y;
  return cards.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) || null;
}

function onCardPointer(e) {
  if (e.button !== 0) return;
  const card = cardAt(e);
  if (!card) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.type === 'click') toStage({ t: 'tally:hide', pid: card.pid });
}

function listenForCardClicks(win) {
  if (!win || cardWindows.has(win)) return;
  cardWindows.add(win);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) win.addEventListener(type, onCardPointer, true);
}

function listenForKeys(win) {
  if (!win || keyTargets.has(win)) return;
  keyTargets.add(win);
  win.addEventListener('keydown', onKey, true);
}

// Runs a few times a second. Cheap, and immune to whatever order Google's
// page builds and tears down the slideshow in.
function tick() {
  diag.ticks++;
  const v = findViewer();
  if (!v) {
    if (stage) unmountStage('no slideshow');
    drawEditorPreview();
    drawThumbs();
    return;
  }
  if (preview) removePreview();
  if (thumbs) removeThumbs();
  if (stage && !stage.isConnected) unmountStage('removed from the page');
  else if (stage && stage.parentElement !== mountPoint(v)) unmountStage('wrong parent');
  if (!stage) mountStage(v);
  viewer = v;
  listenForKeys(v.doc.defaultView);
  listenForKeys(window);
  listenForCardClicks(v.doc.defaultView);
  listenForCardClicks(window);
  dressSlides(v);
  if (!stageReady) return;
  const now = readSlide(v);
  if (!now) return;
  const packed = JSON.stringify(now);
  if (packed === lastSent) return;
  lastSent = packed;
  toStage({ t: 'tally:slide', ...now });
}

// ---- wiring -----------------------------------------------------------------

function onWindowMessage(e) {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (stage && e.source === stage.contentWindow) {
    if (m.t === 'tally:ready') {
      stageReady = true;
      lastSent = '';
      tick();
    } else if (m.t === 'tally:cards') {
      cards = Array.isArray(m.cards) ? m.cards : [];
    } else if (m.t === 'tally:state') {
      stageState = m;
      if (viewer) dressSlides(viewer); // the reveal must not wait for the next tick
      chrome.runtime.sendMessage({ t: 'tally:stage', presentationId, state: m }).catch(() => {});
    }
    return;
  }
  // A hotkey pressed in Presenter view's notes window (see notes-keys.js).
  // Held to the same rule as one pressed in the slideshow: only where Tally's keys do something.
  if (e.source === window && m.t === 'popquiz:notes-key') {
    const cfg = deck.slides[stageState?.slideId];
    if (stage && takesKeys(cfg) && (m.key === 'advance' || m.key === 'rerun')) toStage({ t: 'tally:key', key: m.key });
    return;
  }
  // Development hooks, reachable from the page's own console:
  //   postMessage({ t: 'popquiz:dev', do: 'status' })  -> replies with tally:dev-status
  //   postMessage({ t: 'popquiz:dev', do: 'reload' })  -> reloads the extension
  if (e.source === window && m.t === 'popquiz:dev') {
    if (m.do === 'reload') chrome.runtime.sendMessage({ t: 'tally:reload-extension' }).catch(() => {});
    else if (m.do === 'status') window.postMessage({ t: 'popquiz:dev-status', version: VERSION, presentationId, presenting: !!stage, stageReady, stage: stageState, lastSent: lastSent ? JSON.parse(lastSent) : null, editor: editorInfo(), tallySlides: Object.keys(deck.slides).length, slides: deck.slides, joinBase: deck.joinBase, preview: preview ? { rect: rect(preview.el), parent: preview.el.parentElement?.id || null, options: preview.el.shadowRoot.querySelectorAll('.tm-opt').length } : null, thumbs: thumbs ? [...thumbs.items].map(([slideId, item]) => ({ slideId, rect: rect(item.el) })) : [], diag: { ...diag, connected: stage?.isConnected ?? null, parent: stage?.parentElement ? `${stage.parentElement.tagName}.${stage.parentElement.className}` : null, sameDocument: stage ? stage.ownerDocument === document : null } }, location.origin);
    else if (m.do === 'key') toStage({ t: 'tally:key', key: m.key });
    else if (m.do === 'put-slide' && m.slideId && m.cfg) {
      // Lets a test set up a Tally slide without going through the side panel.
      deck.slides[m.slideId] = m.cfg;
      deck = normaliseDeck(deck, presentationId);
      store.set(KEYS.deck(presentationId), deck);
    } else if (m.do === 'remove-slide' && m.slideId) {
      delete deck.slides[m.slideId];
      store.set(KEYS.deck(presentationId), deck);
    }
  }
}

export async function start() {
  const m = location.pathname.match(/\/presentation\/d\/([^/]+)/);
  if (!m || m[1] === 'e') return; // not a deck we can key anything to
  presentationId = m[1];
  useMap(await store.get(MAP_KEY));
  deck = normaliseDeck(await store.get(KEYS.deck(presentationId)), presentationId);
  store.watch(KEYS.deck(presentationId), (raw) => {
    deck = normaliseDeck(raw, presentationId);
    lastSent = '';
    previewSent = '';
  });
  ui = { ...ui, ...((await store.get('tally.ui')) || {}) };
  store.watch('tally.ui', (raw) => {
    ui = { previewPhase: 'voting', ...(raw || {}) };
    previewSent = '';
  });

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.t === 'tally:editor?') reply(editorInfo());
    else if (msg?.t === 'tally:goto' && typeof msg.slideId === 'string') {
      location.hash = `${M.slideHash}${msg.slideId}`;
      reply({ ok: true });
    } else if (msg?.t === 'tally:key') {
      toStage({ t: 'tally:key', key: msg.key });
      reply({ ok: !!stage });
    }
    return false;
  });

  window.addEventListener('message', onWindowMessage);
  window.addEventListener('resize', () => {
    lastSent = '';
  });
  document.addEventListener('fullscreenchange', () => {
    lastSent = '';
    tick();
  });
  // Look at the shared copy now, when the tab or the window comes back to the
  // front, and every five minutes while it is in view, so a change made on
  // another device turns up here. Never more than once in two minutes: every
  // look is counted against the store's monthly allowance (see background.js).
  // Leaving the tab sends whatever has not been sent yet, and costs nothing if
  // there is nothing to send.
  let looked = 0;
  const pull = (now) => {
    if (!now && Date.now() - looked < 120000) return;
    looked = Date.now();
    chrome.runtime.sendMessage({ t: 'tally:sync', presentationId }).catch(() => {});
  };
  const send = () => chrome.runtime.sendMessage({ t: 'tally:sync', presentationId, ifDirty: true }).catch(() => {});
  pull(true);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? pull() : send()));
  window.addEventListener('focus', () => pull());
  window.addEventListener('pagehide', send);
  setInterval(() => document.visibilityState === 'visible' && !stage && pull(), 300000);

  watcher = setInterval(() => {
    try {
      tick();
    } catch (e) {
      diag.lastError = String(e?.stack || e).slice(0, 300);
    }
  }, 250);
  document.documentElement.dataset.tally = VERSION;
  console.info(`[tally] ${VERSION} ready on this deck`);
}
