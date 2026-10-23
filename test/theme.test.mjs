import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme } from '../app/stage/modules.js';
import { DEFAULT_THEME, contrast } from '../app/shared/deck.js';

const el = () => {
  const props = {};
  return { props, style: { setProperty: (k, v) => (props[k] = v) }, toggleAttribute: () => {} };
};

test('contrast is the WCAG ratio', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff')), 21);
  assert.equal(contrast('#777777', '#777777'), 1);
});

test('the standard look turns its words white on a dark slide, and leaves a light one alone', () => {
  const dark = el();
  applyTheme(dark, DEFAULT_THEME, '#1f1f1f');
  assert.equal(dark.props['--t-text'], '#ffffff');
  const light = el();
  applyTheme(light, DEFAULT_THEME, '#ffffff');
  assert.equal(light.props['--t-text'], DEFAULT_THEME.text);
  const unknown = el();
  applyTheme(unknown, DEFAULT_THEME, null);
  assert.equal(unknown.props['--t-text'], DEFAULT_THEME.text);
});

test('a look with its own ground keeps its words, whatever the slide', () => {
  const grounded = el();
  applyTheme(grounded, { ...DEFAULT_THEME, ground: '#ffffff' }, '#1f1f1f');
  assert.equal(grounded.props['--t-text'], DEFAULT_THEME.text);
});

test('colours are read whole: six digits are not taken for three', async () => {
  const { textOn } = await import('../app/shared/deck.js');
  assert.equal(textOn('#1f1f1f'), '#ffffff', 'near-black takes white');
  assert.equal(textOn('#f9ab00'), '#1a1a1a', 'Slide Amber takes ink');
  assert.equal(textOn('#fff'), '#1a1a1a');
  assert.equal(textOn('#1a1a1acc'), '#ffffff', 'transparency is ignored');
  assert.equal(textOn('not a colour'), '#ffffff');
});
