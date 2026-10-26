// Draws the extension's PNG icons from the mark's SVGs (BRAND.md): the shape
// itself on a transparent ground, the full drawing at every size: the same
// mark the browser tab shows from mark.svg (Jozef's call, 26 October).
//   CHROMIUM=... node scripts/icons.mjs
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const icons = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
// size -> which drawing, and how much clear space around it
const SIZES = { 16: ['mark', 0], 32: ['mark', 1], 48: ['mark', 2], 128: ['mark', 8] };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, [name, pad]] of Object.entries(SIZES)) {
  const svg = await readFile(path.join(icons, `${name}.svg`), 'utf8');
  const inner = size - pad * 2;
  await page.setContent(`<html><body style="margin:0;background:transparent"><div id="i" style="width:${size}px;height:${size}px;display:grid;place-items:center"><img style="width:${inner}px;height:${inner}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></div></body></html>`);
  await page.locator('#i').screenshot({ path: path.join(icons, `${size}.png`), omitBackground: true });
  console.log(`icons/${size}.png from ${name}.svg`);
}
await browser.close();
