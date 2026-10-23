// The slide-type icons, drawn in the K·A style (BRAND.md): ink outlines, Slide
// Amber for the one part that matters. Emoji were used before, and drew
// differently on every computer.

const INK = '#1a1a1a';
const AMBER = '#f9ab00';
const S = `fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;

const PATHS = {
  mc: `<circle cx="12" cy="12" r="9" fill="${AMBER}" stroke="${INK}" stroke-width="1.8"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.3" ${S}/><circle cx="12" cy="16.9" r="1.15" fill="${INK}"/>`,
  tf: `<rect x="2.5" y="5" width="9" height="14" rx="3" fill="${AMBER}" stroke="${INK}" stroke-width="1.8"/><path d="M4.9 12.1l1.7 1.8 2.9-3.6" ${S}/><rect x="12.5" y="5" width="9" height="14" rx="3" fill="#fff" stroke="${INK}" stroke-width="1.8"/><path d="M15.2 10.2l3.6 3.6M18.8 10.2l-3.6 3.6" ${S}/>`,
  text: `<rect x="2.5" y="6.5" width="19" height="11" rx="3" fill="#fff" stroke="${INK}" stroke-width="1.8"/><path d="M6 12h6.5" ${S}/><path d="M16 9.2v5.6" fill="none" stroke="${AMBER}" stroke-width="2.4" stroke-linecap="round"/>`,
  poll: `<path d="M3 20.5h18" ${S}/><rect x="4.5" y="11" width="4" height="9.5" rx="1" fill="#fff" stroke="${INK}" stroke-width="1.8"/><rect x="10" y="5" width="4" height="15.5" rx="1" fill="${AMBER}" stroke="${INK}" stroke-width="1.8"/><rect x="15.5" y="14" width="4" height="6.5" rx="1" fill="#fff" stroke="${INK}" stroke-width="1.8"/>`,
  cloud: `<path d="M7 18.5h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.2A4.6 4.6 0 0 0 7 18.5z" fill="${AMBER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 14.5h3M13.5 14.5h2" ${S}/>`,
  open: `<path d="M4.5 4.5h15a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H10l-4.2 3.3v-3.3H4.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" fill="${AMBER}" stroke="${INK}" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.5 9h11M6.5 12.5h7" ${S}/>`,
  num: `<rect x="2.5" y="5" width="19" height="14" rx="3" fill="#fff" stroke="${INK}" stroke-width="1.8"/><path d="M8 8.5l-1.2 7M11 8.5l-1.2 7M5.6 10.6h6.3M5.2 13.4h6.3" ${S}/><path d="M14.5 15.5l2.2-7h.1l2.2 7" fill="none" stroke="${AMBER}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.3 13h2.9" fill="none" stroke="${AMBER}" stroke-width="2" stroke-linecap="round"/>`,
  rank: `<rect x="3" y="3.5" width="18" height="5" rx="1.6" fill="${AMBER}" stroke="${INK}" stroke-width="1.8"/><rect x="3" y="9.5" width="14" height="5" rx="1.6" fill="#fff" stroke="${INK}" stroke-width="1.8"/><rect x="3" y="15.5" width="10" height="5" rx="1.6" fill="#fff" stroke="${INK}" stroke-width="1.8"/>`,
  join: `<rect x="6" y="2.5" width="12" height="19" rx="2.8" fill="#fff" stroke="${INK}" stroke-width="1.8"/><rect x="8.6" y="7" width="3" height="3" rx=".5" fill="${INK}"/><rect x="12.4" y="7" width="3" height="3" rx=".5" fill="${AMBER}" stroke="${INK}" stroke-width=".9"/><rect x="8.6" y="10.8" width="3" height="3" rx=".5" fill="${AMBER}" stroke="${INK}" stroke-width=".9"/><rect x="12.4" y="10.8" width="3" height="3" rx=".5" fill="${INK}"/><path d="M10.5 18.2h3" ${S}/>`,
  leaderboard: `<path d="M2.5 20.5h19" ${S}/><rect x="9" y="6" width="6" height="14.5" rx="1" fill="${AMBER}" stroke="${INK}" stroke-width="1.8"/><rect x="3.5" y="11" width="5.5" height="9.5" rx="1" fill="#fff" stroke="${INK}" stroke-width="1.8"/><rect x="15" y="13.5" width="5.5" height="7" rx="1" fill="#fff" stroke="${INK}" stroke-width="1.8"/><path d="M12 2.6l.8 1.5 1.6.2-1.2 1.1" fill="none" stroke="${INK}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`,
};

// An <svg> element for a slide type, or an empty span for an unknown one.
export function typeIcon(id, size = 22) {
  const el = document.createElement('span');
  el.className = 'ico';
  if (PATHS[id]) el.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[id]}</svg>`;
  return el;
}
