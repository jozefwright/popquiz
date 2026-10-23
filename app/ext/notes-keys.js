// Tally's hotkeys in Presenter view.
//
// Presenter view opens a second window for the speaker notes, and that is
// where the keyboard usually is. It is an about:blank window that Slides
// writes into, so no content script can run there. This file runs in the
// page's own world on the deck tab, notices Slides opening that window, and
// listens for T and Shift+R in it. A key heard there is handed to host.js,
// which decides whether the slide on show is one of Tally's.
//
// It changes nothing about how the window opens: Slides gets back exactly the
// window it asked for.
(() => {
  if (window.__tallyNotesKeys) return;
  window.__tallyNotesKeys = true;
  const realOpen = window.open;

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const el = e.target;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return; // typing a question, not a hotkey
    const key = e.key === 't' || e.key === 'T' ? 'advance' : e.key === 'R' && e.shiftKey ? 'rerun' : null;
    if (key) window.postMessage({ t: 'popquiz:notes-key', key }, location.origin);
  }

  function watch(win) {
    const timer = setInterval(() => {
      try {
        if (win.closed) return clearInterval(timer);
        // Slides writes into the window after opening it, and each write
        // silently drops every listener while leaving the same document in
        // place. So there is nothing to notice: ask again on every tick.
        // Adding the same listener twice is a no-op.
        win.addEventListener('keydown', onKey, true);
      } catch {
        clearInterval(timer);
      }
    }, 400);
  }

  window.open = function (...args) {
    const win = realOpen.apply(this, args);
    try {
      if (win && typeof args[1] === 'string' && args[1].startsWith('punch_speaker_notes')) watch(win);
    } catch {}
    return win;
  };
})();
