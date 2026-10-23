// Where Tally keeps things: chrome.storage.local inside the extension,
// localStorage on a plain web page (the PDF fallback, the dev harness).
// Same keys, same JSON, so a deck exported from one opens in the other.

const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;

export const KEYS = {
  deck: (presentationId) => `tally.deck.${presentationId}`,
  session: (presentationId) => `tally.session.${presentationId}`,
  settings: 'tally.settings',
};

const chromeStore = {
  kind: 'chrome',
  async get(key) {
    const out = await chrome.storage.local.get(key);
    return out[key] ?? null;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
  watch(key, fn) {
    const listener = (changes, area) => {
      if (area === 'local' && key in changes) fn(changes[key].newValue ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
};

const sameTab = new Map();

const localStore = {
  kind: 'local',
  async get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('[tally] could not save', key, e);
    }
    for (const fn of sameTab.get(key) || []) fn(value);
  },
  async remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
    for (const fn of sameTab.get(key) || []) fn(null);
  },
  watch(key, fn) {
    if (!sameTab.has(key)) sameTab.set(key, new Set());
    sameTab.get(key).add(fn);
    const listener = (e) => {
      if (e.key !== key) return;
      try {
        fn(e.newValue ? JSON.parse(e.newValue) : null);
      } catch {
        fn(null);
      }
    };
    window.addEventListener('storage', listener);
    return () => {
      sameTab.get(key)?.delete(fn);
      window.removeEventListener('storage', listener);
    };
  },
};

export const store = hasChromeStorage ? chromeStore : localStore;

// The engine's view of the store: one session, loaded once, saved on every
// change. The save takes its own copy so later edits cannot leak into a write
// already on its way.
export function sessionStore(presentationId) {
  const key = KEYS.session(presentationId);
  return {
    load: () => store.get(key),
    save: (session) => store.set(key, JSON.parse(JSON.stringify(session))),
  };
}
