import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { FACES, DISPLAY_FONT } from '../app/shared/fonts.js';
import { DEFAULT_THEME, FONT_CHOICES, normaliseDeck } from '../app/shared/deck.js';

const vendor = new URL('../app/vendor/', import.meta.url);

test('every face ships, with its licence', () => {
  for (const f of FACES) assert.ok(existsSync(new URL(f.file, vendor)), `${f.file} is in vendor/`);
  assert.ok(existsSync(new URL('OFL-bricolage-grotesque.txt', vendor)));
  assert.ok(existsSync(new URL('OFL-figtree.txt', vendor)));
});

test('fonts.css declares the same faces as fonts.js', () => {
  const css = readFileSync(new URL('fonts.css', vendor), 'utf8');
  const faces = [...css.matchAll(/@font-face \{([^}]*)\}/g)].map(([, body]) => ({
    family: body.match(/font-family: '([^']+)'/)[1],
    file: body.match(/url\('([^']+)'\)/)[1],
    weight: body.match(/font-weight: ([^;]+);/)[1],
    range: body.match(/unicode-range: ([^;]+);/)[1],
  }));
  assert.deepEqual(faces, FACES);
});

test('the standard look uses the display face, and an old Mona Sans deck takes it too', () => {
  assert.equal(DEFAULT_THEME.font, DISPLAY_FONT);
  assert.ok(!FONT_CHOICES.includes('Mona Sans'));
  const deck = normaliseDeck({ presentationId: 'x', theme: { font: 'Mona Sans' } }, 'x');
  assert.equal(deck.theme.font, DISPLAY_FONT);
});
