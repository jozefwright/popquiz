// The type that ships with Pop Quiz (BRAND.md): Bricolage Grotesque for
// display (questions, options, headings), Figtree for running text. Both are
// variable fonts under the SIL Open Font Licence, bundled in vendor/ with
// their licences so nothing loads from a CDN during a talk. Each comes in two
// parts: latin, and latin-ext, which carries the macrons in Māori names.
//
// vendor/fonts.css declares the same faces for pages that can use CSS. Keep
// the two in step (test/fonts.test.mjs checks).

export const DISPLAY_FONT = 'Bricolage Grotesque';
export const BODY_FONT = 'Figtree';

const LATIN = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT = 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF';

export const FACES = [
  { family: DISPLAY_FONT, file: 'bricolage-latin.woff2', weight: '200 800', range: LATIN },
  { family: DISPLAY_FONT, file: 'bricolage-latin-ext.woff2', weight: '200 800', range: LATIN_EXT },
  { family: BODY_FONT, file: 'figtree-latin.woff2', weight: '300 900', range: LATIN },
  { family: BODY_FONT, file: 'figtree-latin-ext.woff2', weight: '300 900', range: LATIN_EXT },
];

// Registers every face on a document, for text whose CSS cannot do it: a
// font declared inside a shadow root is ignored. `vendor` is the address
// vendor/ is served from, ending in a slash.
export function addFonts(doc, vendor) {
  const faces = FACES.map((f) => new FontFace(f.family, `url(${vendor}${f.file})`, { weight: f.weight, unicodeRange: f.range }));
  for (const face of faces) doc.fonts.add(face);
  return Promise.all(faces.map((face) => face.load()));
}
