import test from 'node:test';
import assert from 'node:assert/strict';
import { SHIPPED, MAP_SCHEMA, cleanMap, mergeMap, find, reEscape } from '../app/shared/slides-map.js';
import { readFileSync } from 'node:fs';

const published = (map, schema = MAP_SCHEMA) => ({ schema, map });

test('the published copy matches what ships', () => {
  const file = JSON.parse(readFileSync(new URL('../app/slides-map.json', import.meta.url)));
  assert.equal(file.schema, MAP_SCHEMA);
  assert.deepEqual(file.map, SHIPPED);
});

test('with nothing published, the shipped map is used', () => {
  assert.deepEqual(mergeMap(null), SHIPPED);
  assert.deepEqual(mergeMap({}), SHIPPED);
});

test('a published value that passes its check replaces the shipped one', () => {
  const M = mergeMap(published({ selectionStroke: '#0B57D0', filmstripScroll: '.punch-filmstrip-scroll-v2', editor: 'ed-' }));
  assert.equal(M.selectionStroke, '#0B57D0');
  assert.equal(M.filmstripScroll, '.punch-filmstrip-scroll-v2');
  assert.equal(M.editor, 'ed-');
  assert.equal(M.svg, SHIPPED.svg);
});

test('anything that fails its check is dropped, key by key', () => {
  const M = mergeMap(published({
    editor: 'editor-"]<script>', // not an id part
    svg: 'svg{}', // braces are not allowed in a selector
    selectionStroke: 'blue', // not a hex colour
    presentPath: 'present', // must start with a slash
    workspace: 42, // not a string
    evil: 'x', // not a key Pop Quiz knows
    pages: 'pages-v2', // fine
  }));
  assert.equal(M.editor, SHIPPED.editor);
  assert.equal(M.svg, SHIPPED.svg);
  assert.equal(M.selectionStroke, SHIPPED.selectionStroke);
  assert.equal(M.presentPath, SHIPPED.presentPath);
  assert.equal(M.workspace, SHIPPED.workspace);
  assert.equal(M.evil, undefined);
  assert.equal(M.pages, 'pages-v2');
});

test('a map for another schema is ignored whole', () => {
  assert.deepEqual(mergeMap(published({ pages: 'pages-v2' }, MAP_SCHEMA + 1)), SHIPPED);
});

test('find falls back to the shipped selector when the published one finds nothing', () => {
  const hits = { [SHIPPED.svg]: 'shipped', 'svg.new': 'new' };
  const root = { querySelector: (s) => hits[s] || null, querySelectorAll: (s) => (hits[s] ? [hits[s]] : []) };
  assert.equal(find(root, { ...SHIPPED, svg: 'svg.missing' }, 'svg'), 'shipped');
  assert.equal(find(root, { ...SHIPPED, svg: 'svg.new' }, 'svg'), 'new');
  assert.deepEqual(find(root, { ...SHIPPED, svg: 'svg.missing' }, 'svg', true), ['shipped']);
});

test('map values are escaped for use in a pattern', () => {
  assert.ok(new RegExp(`^${reEscape('filmstrip.slide-')}(\\d+)-`).test('filmstrip.slide-3-x'));
  assert.ok(!new RegExp(`^${reEscape('filmstrip.slide-')}(\\d+)-`).test('filmstripXslide-3-x'));
});
