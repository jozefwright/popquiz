// Walks one phone through a whole question against the local player and saves
// a contact sheet of every screen it shows. Needs `npm run serve` running.
//   node test/phone-shots.mjs
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out');
await mkdir(out, { recursive: true });
const base = process.env.TALLY_URL || 'http://localhost:8790';
const executablePath = findChrome();

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const stage = await context.newPage();
await stage.setViewportSize({ width: 1280, height: 720 });
await stage.goto(`${base}/play/?relay=local&bots=17`);
const engine = (fn, arg) => stage.evaluate(([f, a]) => new Function('e', 'a', `return (${f})(e, a)`)(document.getElementById('stage').contentWindow.tally.engine, a), [fn.toString(), arg]);
await stage.waitForFunction(() => document.getElementById('stage').contentWindow.tally?.engine?.s?.room);
await engine((e) => e.newSession());
await stage.evaluate(() => window.tallyPlayer.go(2));
await stage.waitForFunction(() => document.getElementById('stage').contentWindow.tally.engine.view().playerCount >= 17, null, { timeout: 15000 });
const room = await engine((e) => e.s.room);

const phone = await context.newPage();
await phone.setViewportSize({ width: 390, height: 780 });
await phone.goto(`${base}/?r=${room}&relay=local&as=shots-${Date.now()}`);
const shots = [];
const shot = async (name, caption) => {
  await phone.waitForTimeout(450);
  const file = path.join(out, `phone-${name}.png`);
  await phone.screenshot({ path: file });
  shots.push({ file, caption });
};
const screen = (want) => phone.waitForFunction((w) => window.tally.player.screen() === w, want, { timeout: 15000 });

await phone.waitForSelector('#name');
await phone.fill('#name', 'Alex');
await shot('1-name', '1. Scan the QR, type a name');
await phone.keyboard.press('Enter');
await screen('waiting');
await shot('2-waiting', '2. In. Waits by itself');
await stage.evaluate(() => window.tallyPlayer.go(5));
await screen('question');
await shot('3-question', '3. Jumps to the question');
await phone.click('button.opt >> nth=0');
await phone.click('button.go'); // choose, then lock in
await screen('locked');
await phone.waitForFunction(() => window.tally.player.confirmed());
await shot('4-locked', '4. Tap once. Locked in');
await stage.waitForTimeout(5000);
await engine((e) => e.advance());
await screen('result');
await shot('5-result', '5. The reveal, with your rank');
await stage.evaluate(() => window.tallyPlayer.go(10));
await screen('leaderboard');
await shot('6-board', '6. Leaderboard slide');

const sheet = await context.newPage();
await sheet.setViewportSize({ width: 1500, height: 620 });
const cells = [];
for (const s of shots) cells.push(`<figure><img src="data:image/png;base64,${(await readFile(s.file)).toString('base64')}"><figcaption>${s.caption}</figcaption></figure>`);
await sheet.setContent(`<style>body{margin:0;padding:28px;background:#0c0c0c;font:600 15px system-ui;color:#cfcfcf;display:flex;gap:18px;justify-content:center}
figure{margin:0;width:226px}img{width:226px;border-radius:22px;border:3px solid #333;display:block}figcaption{margin-top:12px;text-align:center}</style>${cells.join('')}`);
await sheet.screenshot({ path: path.join(out, 'phone-screens.png') });
console.log('saved test/.out/phone-screens.png');
await browser.close();
