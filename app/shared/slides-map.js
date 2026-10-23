// What Pop Quiz relies on in Google's Slides markup, as data.
//
// Google changes Slides without notice (it redrew the selection on 15 Oct
// 2026). Once Pop Quiz is in the Chrome Web Store, a fix to ext/host.js waits
// on store review, which can take days. Most breakages are a renamed class or
// id prefix, so those live here instead: the copy below ships in the
// extension, and background.js fetches a newer one from MAP_URL, checks it
// key by key and keeps it in storage. The store allows this because it is
// data, not code: every value is checked against a strict pattern and an
// unknown key is dropped.
//
// A bad published map must not break every user at once, so a value from it
// is used only if it passes its check, and selector lookups (`find`, below)
// fall back to the shipped value when the published one finds nothing.

export const MAP_SCHEMA = 1;

// Where the published map lives. Off until Pop Quiz has a site of its own:
// pointed at Tally's, a change made for Tally would reach Pop Quiz too.
export const MAP_URL = 'https://play.popquiz.fun/slides-map.json';

export const MAP_KEY = 'slidesMap';

export const SHIPPED = {
  // the editor
  workspace: 'workspace', //                 div#workspace, the canvas
  pages: 'pages', //                         div#pages inside it
  editor: 'editor-', //                      g#editor-<objectId>, one per shape
  filmstrip: 'filmstrip-slide-', //          g#filmstrip-slide-<n>-<slideId>
  bg: '-bg', //                              a slide's own background rectangle
  paragraph: '-paragraph-', //               g#editor-<id>-paragraph-<n>
  filmstripScroll: '.punch-filmstrip-scroll', // the box the filmstrip scrolls in
  selectionStroke: '#1a73e8', //             the colour of Google's selection outline
  slideHash: 'slide=id.', //                 #slide=id.<slideId> in the address
  // the slideshow
  presentFrame: 'iframe.punch-present-iframe',
  svg: '.punch-viewer-svgpage-svgcontainer svg',
  presentPath: '/present',
};

const ID_PART = /^[A-Za-z0-9_-]{1,40}$/;
const CHECKS = {
  workspace: ID_PART,
  pages: ID_PART,
  editor: ID_PART,
  filmstrip: ID_PART,
  bg: ID_PART,
  paragraph: ID_PART,
  filmstripScroll: 'selector',
  selectionStroke: /^#[0-9a-fA-F]{3,8}$/,
  slideHash: /^[A-Za-z0-9_=.-]{1,20}$/,
  presentFrame: 'selector',
  svg: 'selector',
  presentPath: /^\/[A-Za-z0-9_/-]{1,40}$/,
};

// A selector is limited to tags, classes, ids, attribute tests, spaces and
// child combinators, and must parse.
const SELECTOR = /^[A-Za-z0-9_\-.#\[\]="'^$*~|:>() ]{1,200}$/;
function isSelector(s) {
  if (!SELECTOR.test(s)) return false;
  if (typeof document === 'undefined') return true; // the worker has no DOM; the page checks again
  try { document.createDocumentFragment().querySelector(s); return true; } catch { return false; }
}

// The published map's keys that pass their checks, and nothing else.
export function cleanMap(raw) {
  if (!raw || typeof raw !== 'object' || raw.schema !== MAP_SCHEMA || typeof raw.map !== 'object' || !raw.map) return {};
  const out = {};
  for (const [k, check] of Object.entries(CHECKS)) {
    const v = raw.map[k];
    if (typeof v !== 'string') continue;
    if (check === 'selector' ? isSelector(v) : check.test(v)) out[k] = v;
  }
  return out;
}

// The map to use: shipped values, with the published ones laid over them.
export function mergeMap(published) {
  return { ...SHIPPED, ...cleanMap(published) };
}

// querySelector that falls back to the shipped selector when the published
// one finds nothing.
export function find(root, M, key, all = false) {
  const q = (s) => (all ? [...root.querySelectorAll(s)] : root.querySelector(s));
  const got = q(M[key]);
  if ((all ? got.length : got) || M[key] === SHIPPED[key]) return got;
  return q(SHIPPED[key]);
}

// A map value, for use inside a RegExp.
export const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
