// Tally's service worker. Four small jobs:
//   1. make the toolbar button open the side panel;
//   2. keep a safety copy of every deck's quiz as a file on disk;
//   3. keep each deck's quiz in step with its shared copy, so it is there on
//      every device that opens the deck;
//   4. reload the extension when the panel's Reload Tally button asks, once a
//      newer copy of it is on this laptop, and bring the open decks back after;
//   5. keep the published map of Google's Slides markup (shared/slides-map.js).

import { BRAND } from './shared/brand.js';
import { DEFAULT_SYNC_BASE } from './shared/config.js';
import { normaliseDeck } from './shared/deck.js';
import { decide, fingerprint, DECK_ID, SCHEMA } from './shared/sync.js';
import { MAP_URL, MAP_KEY, cleanMap } from './shared/slides-map.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- safety copies ---------------------------------------------------------
//
// A deck's questions live in this extension's storage, which Chrome deletes if
// the extension is ever removed. So about a minute after the last change to a
// deck, the whole of its quiz is written to Downloads/Pop Quiz/<deck>.popquiz.json,
// replacing the previous copy. The side panel's Import reads that file back.

const DECK = 'tally.deck.';
const BACKUP = 'tally.backup.';

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(DECK) || !change.newValue) continue;
    const id = key.slice(DECK.length);
    chrome.alarms.create(`backup:${id}`, { delayInMinutes: 1 });
    localChanged(id, change.newValue);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('backup:')) backup(alarm.name.slice('backup:'.length)).catch((e) => console.warn('[tally] safety copy failed', e));
  else if (alarm.name.startsWith('sync:')) sync(alarm.name.slice('sync:'.length));
  else if (alarm.name === MAP_ALARM) fetchMap();
});

async function backup(presentationId) {
  const key = DECK + presentationId;
  const deck = (await chrome.storage.local.get(key))[key];
  if (!deck?.slides || !Object.keys(deck.slides).length) return null;
  const slug = (deck.title || 'deck').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deck';
  const file = `${BRAND}/${slug}-${presentationId.slice(0, 6)}.popquiz.json`;
  const body = JSON.stringify({ ...deck, savedAt: new Date().toISOString(), savedBy: `${BRAND} ${chrome.runtime.getManifest().version}` }, null, 2);
  const bytes = new TextEncoder().encode(body);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  await chrome.downloads.download({ url: `data:application/json;base64,${btoa(binary)}`, filename: file, conflictAction: 'overwrite', saveAs: false });
  const record = { at: Date.now(), file };
  await chrome.storage.local.set({ [BACKUP + presentationId]: record });
  return record;
}

// ---- sharing between devices ------------------------------------------------
//
// The working copy in this profile is always the one in use; nothing waits on
// the network. Opening a deck pulls its shared copy, and a change is pushed
// within a minute of being made, or at once when the deck's tab is left.
// shared/sync.js decides which way to go.
//
// Why not at once: the shared copies live in a store that counts every save and
// every look against a monthly allowance (on the free plan 2,000 saves and
// 10,000 looks, for every deck and every person together), and locks for up to
// 30 days when one is spent. So changes go up in batches. The first unsent
// change starts the wait and later ones ride along with it.

const SYNC = 'tally.sync.';
const KEPT = 'tally.kept.';
const KEEP = 'tally.keep.';
const PUSH_AFTER = 60000;
const pushTimers = new Map();
const queues = new Map();

const read = async (key) => (await chrome.storage.local.get(key))[key] ?? null;
const write = (key, value) => chrome.storage.local.set({ [key]: value });

async function syncBase() {
  const settings = (await read('tally.settings')) || {};
  return typeof settings.syncBase === 'string' ? settings.syncBase : DEFAULT_SYNC_BASE;
}

// `pushAfter` in the settings overrides the wait. The tests set it, to be quick.
async function pushAfter() {
  const ms = ((await read('tally.settings')) || {}).pushAfter;
  return Number.isFinite(ms) && ms >= 0 ? ms : PUSH_AFTER;
}

// A change in this profile: note when it happened, and send it up shortly.
async function localChanged(id, deck) {
  if (!DECK_ID.test(id)) return;
  const state = (await read(SYNC + id)) || {};
  if (fingerprint(normaliseDeck(deck, id)) === state.mark) return; // this is the copy we just pulled or pushed
  if (!state.dirtyAt) await write(SYNC + id, { ...state, dirtyAt: Date.now() });
  if (pushTimers.has(id)) return; // a send is already waiting; this change goes with it
  pushTimers.set(id, null);
  const wait = await pushAfter();
  pushTimers.set(id, setTimeout(() => sync(id), wait));
  // An alarm too, in case the worker is put to sleep before the timer fires.
  // Not if one is already set: making it again would start its wait afresh.
  const alarm = `sync:${id}`;
  if (!(await chrome.alarms.get(alarm))) chrome.alarms.create(alarm, { delayInMinutes: Math.max(0.5, wait / 60000 + 0.25) });
}

// One sync at a time per deck.
function sync(id) {
  // The alarm is cleared only once a look has gone through: if this one fails,
  // it is still there to try once more.
  const next = (queues.get(id) || Promise.resolve()).then(() => syncOnce(id)).then(() => chrome.alarms.clear(`sync:${id}`)).catch(async (e) => {
    const state = (await read(SYNC + id)) || {};
    await write(SYNC + id, { ...state, status: 'unreachable', error: String(e?.message || e).slice(0, 120), triedAt: Date.now() });
  });
  queues.set(id, next);
  return next.then(() => read(SYNC + id));
}

async function syncOnce(id, again = true) {
  if (!DECK_ID.test(id)) return;
  const base = await syncBase();
  if (!base) return;
  // Whatever was waiting to be sent goes with this look.
  clearTimeout(pushTimers.get(id));
  pushTimers.delete(id);
  const url = `${base}?id=${encodeURIComponent(id)}`;
  const local = normaliseDeck(await read(DECK + id), id);
  const state = (await read(SYNC + id)) || {};
  const res = await fetch(url, { cache: 'no-store' });
  let remote = null;
  if (res.status === 200) remote = await res.json();
  else if (res.status !== 404) throw new Error(`the shared copy answered ${res.status}`);
  const d = decide({ local, state, remote });
  // A newer Tally has saved this quiz. This copy would drop what it does not
  // know, so it takes nothing and sends nothing until it is updated.
  const outdated = () => write(SYNC + id, { ...state, at: Date.now(), status: 'outdated' });
  if (d.do === 'outdated') return outdated();
  const done = (extra) => write(SYNC + id, { rev: remote?.rev ?? null, mark: fingerprint(local), dirtyAt: 0, at: Date.now(), status: 'in step', ...extra });

  if (d.do === 'adopt') {
    const deck = normaliseDeck(remote.deck, id);
    if (d.keep) await write(KEPT + id, { at: Date.now(), deck: d.keep });
    // The state goes first, so the change this causes is seen as already in step.
    await write(SYNC + id, { rev: remote.rev, mark: fingerprint(deck), dirtyAt: 0, at: Date.now(), status: 'in step', pulledAt: Date.now() });
    await write(DECK + id, deck);
  } else if (d.do === 'push') {
    // `client` is this copy's format number: the service refuses a save from a
    // copy older than the last that saved this quiz. `keep` asks it to set the
    // version being replaced aside whatever the hour (the panel sets it before
    // bringing an earlier version back, so that can itself be undone).
    const keep = !!(await read(KEEP + id));
    const put = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deck: local, client: SCHEMA, baseRev: remote?.rev ?? null, force: !!d.overwrote, keep }) });
    if (put.status === 409 && again) return syncOnce(id, false); // someone else saved in between: look again, once
    if (put.status === 426) return outdated();
    if (put.status === 503) throw new Error('the sharing service is being updated');
    if (!put.ok) throw new Error(`the shared copy would not save (${put.status})`);
    if (keep) await chrome.storage.local.remove(KEEP + id);
    const saved = await put.json();
    if (d.overwrote) await write(KEPT + id, { at: Date.now(), deck: d.overwrote });
    await write(SYNC + id, { rev: saved.rev, mark: fingerprint(local), dirtyAt: 0, at: Date.now(), status: 'in step', pushedAt: Date.now() });
  } else if (remote && d.settle) {
    await done();
  } else if (remote) {
    await write(SYNC + id, { ...state, at: Date.now(), status: 'in step' });
  } else {
    await write(SYNC + id, { ...state, at: Date.now(), status: 'nothing to share yet' });
  }
}

// ---- coming back after a reload ----------------------------------------------
//
// The panel's Reload Tally button (shown when a newer copy is on this laptop)
// restarts the extension. Decks that were open are reloaded, so they get the
// new page script and nobody has to think about it.

const REVIVE = 'tally.revive';

async function revive() {
  const asked = await read(REVIVE);
  if (!asked) return;
  await chrome.storage.local.remove(REVIVE);
  if (Date.now() - asked > 60000) return; // a stale note from some other day
  const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/presentation/*' }).catch(() => []);
  for (const tab of tabs) chrome.tabs.reload(tab.id).catch(() => {});
}

// A service worker sleeps until something wakes it, and after a reload nothing
// would: the decks would sit there dead until the toolbar button was pressed.
// Listening for the reload itself is what brings the worker up to do this.
chrome.runtime.onInstalled.addListener(() => revive());
revive();

// ---- the Slides map ---------------------------------------------------------
//
// Fetched when the worker starts and every six hours. Only the keys that pass
// their checks are kept, and the page reads it as it loads, so a fix reaches a
// deck the next time it is opened. A map that cannot be fetched or read
// leaves the last good one in place.

const MAP_ALARM = 'slides-map';

async function fetchMap() {
  if (!MAP_URL) return;
  try {
    const res = await fetch(MAP_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const raw = await res.json();
    if (!Object.keys(cleanMap(raw)).length) return;
    await chrome.storage.local.set({ [MAP_KEY]: { schema: raw.schema, map: cleanMap(raw), fetchedAt: Date.now() } });
  } catch (e) {
    console.warn('[tally] slides map not fetched', e);
  }
}

if (MAP_URL) {
  chrome.alarms.get(MAP_ALARM).then((a) => a || chrome.alarms.create(MAP_ALARM, { periodInMinutes: 360 }));
  fetchMap();
}

// ---- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.t === 'tally:reload-extension') {
    reply({ ok: true });
    // Reloading leaves every open deck with a dead copy of the page script, so
    // note that they are to be reloaded, and do it on the way back up (below).
    chrome.storage.local.set({ [REVIVE]: Date.now() }).then(() => setTimeout(() => chrome.runtime.reload(), 50));
    return false;
  }
  if (msg?.t === 'tally:revive') {
    // The come-back step, on request. The tests ask, because a test browser
    // cannot be followed through an extension's own reload.
    revive().then(() => reply({ ok: true }));
    return true;
  }
  if (msg?.t === 'tally:version') {
    reply({ version: chrome.runtime.getManifest().version, id: chrome.runtime.id });
    return false;
  }
  if (msg?.t === 'tally:sync' && msg.presentationId) {
    // `ifDirty` is the deck's tab being left: send what is waiting, and if
    // nothing is, do not spend a look on it.
    const go = msg.ifDirty ? read(SYNC + msg.presentationId).then((state) => (state?.dirtyAt ? sync(msg.presentationId) : state)) : sync(msg.presentationId);
    go.then(
      (state) => reply({ ok: true, state }),
      () => reply({ ok: false }),
    );
    return true;
  }
  if (msg?.t === 'tally:backup-now' && msg.presentationId) {
    backup(msg.presentationId).then(
      (record) => reply({ ok: !!record, record }),
      (e) => reply({ ok: false, error: String(e) }),
    );
    return true; // the reply comes later
  }
  return false;
});
