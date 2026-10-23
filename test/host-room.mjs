// Hosts a room with the demo quiz, on the real page and over the real relay,
// so a real phone (or the iOS Simulator) can be tried against it without the
// deck. The presenter is the fallback player in a headless browser.
//
//   node test/host-room.mjs                                  the public site
//   TALLY_URL=http://localhost:8790 node test/host-room.mjs  a local server
//
// It puts the join slide up and prints the address to open on the phone. Once
// someone has joined it asks one question (again, if nobody answered in time),
// reveals it, shows the leaderboard and stops. Pictures of the big screen land
// in test/.out/host/.
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '.out', 'host');
await mkdir(out, { recursive: true });
const base = (process.env.TALLY_URL || 'https://play.popquiz.fun').replace(/\/$/, '');
const executablePath = findChrome();
const JOIN_PAGE = 2;
const QUESTION_PAGE = 7; // multiple choice, 20 seconds, A is right
const BOARD_PAGE = 10;

const started = Date.now();
const say = (line) => console.log(`${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${line}`);
const browser = await chromium.launch({ executablePath, headless: true });
let code = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => say(`page error: ${e}`));
  await page.goto(`${base}/play/`);
  await page.waitForFunction(() => !!document.getElementById('stage').contentWindow.tally?.engine?.s?.room, null, { timeout: 30000 });
  const engine = (fn) => page.evaluate(`(${fn})(document.getElementById('stage').contentWindow.tally.engine)`);
  const view = () => engine((e) => { const v = e.view(); return { phase: v.phase, link: v.link, names: v.names, answered: v.answered ?? null, counts: v.counts ?? null, correct: v.correct ?? null }; });
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await view();
      if (test(v)) return v;
      if (Date.now() > end) return null;
      await page.waitForTimeout(250);
    }
  };
  const goTo = async (n) => { await page.evaluate((to) => window.tallyPlayer.go(to), n); await page.waitForTimeout(700); };
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}.png`) });

  await goTo(JOIN_PAGE);
  const room = await engine((e) => e.s.room);
  const linked = await until((v) => v.link !== 'connecting', 15000);
  say(`room ${room} is up, relay ${(linked || (await view())).link}`);
  say(`JOIN  ${base}/?r=${room}`);

  const joined = await until((v) => v.names.length > 0, 8 * 60 * 1000);
  if (!joined) throw new Error('nobody joined in eight minutes');
  say(`joined: ${joined.names.join(', ')}`);
  await page.waitForTimeout(1500);
  await shot('1-join');
  await page.waitForTimeout(Number(process.env.HOLD_MS || 20000)); // time to look at the phone's waiting screen

  await goTo(QUESTION_PAGE);
  let answered = null;
  for (let attempt = 1; attempt <= 5 && !answered; attempt++) {
    const open = await until((v) => v.phase === 'open', 5000);
    say(open ? `question open (attempt ${attempt}), 20 seconds` : `question did not open: ${JSON.stringify(await view())}`);
    answered = await until((v) => v.answered > 0 || v.phase !== 'open', 30000);
    if (answered && answered.answered > 0) break;
    say('nobody answered in time; running it again');
    answered = null;
    await page.keyboard.press('R');
    await page.waitForTimeout(800);
  }
  if (!answered) throw new Error('no answer arrived in five runs of the question');
  say(`an answer arrived: ${JSON.stringify(answered.counts)}`);
  await page.waitForTimeout(1500);
  await shot('2-open');
  if ((await view()).phase === 'open') await page.keyboard.press('t');
  const reveal = await until((v) => v.phase === 'reveal', 8000);
  say(reveal ? `revealed: counts ${JSON.stringify(reveal.counts)}, right answer is option ${reveal.correct + 1}` : `did not reveal: ${JSON.stringify(await view())}`);
  await page.waitForTimeout(1500);
  await shot('3-reveal');
  await page.waitForTimeout(Number(process.env.HOLD_MS || 20000));

  await goTo(BOARD_PAGE);
  const board = await engine((e) => e.leaderboard().map((r) => `${r.rank}. ${r.name} ${r.score}`));
  say(`leaderboard: ${board.join(' | ')}`);
  await page.waitForTimeout(1500);
  await shot('4-leaderboard');
  await page.waitForTimeout(Number(process.env.HOLD_MS || 20000));
  say('done');
} catch (e) {
  say(`FAILED: ${e.message}`);
  code = 1;
}
await browser.close();
process.exit(code);
