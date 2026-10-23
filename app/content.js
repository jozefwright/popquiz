// Content script for docs.google.com/presentation. Deliberately tiny: Chrome
// only re-reads this file when the extension is reloaded, so the real work
// lives in ext/host.js, which is fetched fresh on every page load.
(async () => {
  if (window.__tallyLoaded) return;
  window.__tallyLoaded = true;
  try {
    const host = await import(chrome.runtime.getURL('ext/host.js'));
    host.start();
  } catch (e) {
    console.error('[tally] could not start', e);
  }
})();
