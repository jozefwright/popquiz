// Where Playwright's Chrome for Testing is on this Mac: the newest build in its
// cache, so a Playwright update doesn't break every browser test. CHROMIUM, if
// set, wins.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function findChrome() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(homedir(), 'Library/Caches/ms-playwright');
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +a.split('-')[1] - +b.split('-')[1]);
  if (!builds.length) throw new Error(`No Chrome for Testing in ${cache}. Set CHROMIUM to a Chrome binary.`);
  return path.join(cache, builds.at(-1), 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}
