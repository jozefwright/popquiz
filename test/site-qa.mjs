// Checks every page of the built site, on a laptop and a phone: it loads, logs
// no errors, doesn't scroll sideways, has one h1, a title and description of
// the right length, valid structured data, images that load, internal links
// and #anchors that land, external links that answer; and every button and
// control on the page does what it says. Screenshots of each go to
// test/.out/site/.
//
//   npm run site:serve            (in another terminal: serves site/public on 8791)
//   node test/site-qa.mjs         add --external to check outside links too
import { chromium } from 'playwright-core';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '.out', 'site');
const BASE = process.env.SITE || 'http://localhost:8791';
const EXTERNAL = process.argv.includes('--external');
await mkdir(OUT, { recursive: true });

const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
const paths = [...sitemap.matchAll(/<loc>https:\/\/popquiz\.fun([^<]*)<\/loc>/g)].map((m) => m[1]);
paths.push('/this-page-does-not-exist/');

const problems = [];
const passes = [];
const flag = (page, what) => problems.push(`${page}: ${what}`);
const ok = (what) => passes.push(what);

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const VIEWS = {
  laptop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
};

const linkStatus = new Map();
async function status(url) {
  if (linkStatus.has(url)) return linkStatus.get(url);
  let s;
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) PopQuizLinkCheck' }, signal: AbortSignal.timeout(15000) });
    s = r.status;
  } catch (e) {
    s = `error ${e.name}`;
  }
  linkStatus.set(url, s);
  return s;
}

for (const [view, opts] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
  for (const p of paths) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/status of 404/.test(m.text()) && errors.push(m.text()));
    const res = await page.goto(BASE + p, { waitUntil: 'networkidle' });
    const want = p.includes('does-not-exist') ? 404 : 200;
    if (res.status() !== want) flag(`${p} (${view})`, `status ${res.status()}, expected ${want}`);
    await page.waitForTimeout(300);

    const facts = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      h1: document.querySelectorAll('h1').length,
      title: document.title,
      desc: document.querySelector('meta[name=description]')?.content || '',
      canonical: document.querySelector('link[rel=canonical]')?.href || '',
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => {
        try {
          JSON.parse(s.textContent);
          return true;
        } catch {
          return false;
        }
      }),
      badImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src),
      links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
      ids: [...document.querySelectorAll('[id]')].map((e) => e.id),
    }));
    if (errors.length) flag(`${p} (${view})`, `errors: ${errors.slice(0, 3).join(' | ')}`);
    if (facts.overflow > 1) flag(`${p} (${view})`, `scrolls sideways by ${facts.overflow}px`);
    if (facts.h1 !== 1) flag(`${p} (${view})`, `${facts.h1} h1 elements`);
    if (view === 'laptop' && want === 200) {
      if (facts.title.length > 65) flag(p, `title is ${facts.title.length} characters`);
      if (facts.desc.length < 120 || facts.desc.length > 160) flag(p, `description is ${facts.desc.length} characters`);
      if (!facts.canonical) flag(p, 'no canonical');
      if (!facts.ld.length) flag(p, 'no structured data');
      if (facts.ld.includes(false)) flag(p, 'structured data that does not parse');
    }
    if (facts.badImages.length) flag(`${p} (${view})`, `images that don't load: ${facts.badImages.join(', ')}`);

    // links: anchors on this page, internal pages and their anchors, outside sites
    if (view === 'laptop') {
      for (const href of new Set(facts.links)) {
        if (href.startsWith('#')) {
          if (href.length > 1 && !facts.ids.includes(decodeURIComponent(href.slice(1)))) flag(p, `link to ${href}, which isn't on the page`);
          continue;
        }
        if (/^(mailto|tel):/.test(href)) continue;
        const url = new URL(href, BASE + p);
        if (url.origin === BASE || url.hostname === 'popquiz.fun') {
          const local = new URL(url.pathname + url.search, BASE).href;
          const s = await status(local);
          if (s !== 200) flag(p, `internal link ${href} gives ${s}`);
          else if (url.hash) {
            const target = await (await fetch(local)).text();
            if (!target.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`)) flag(p, `link ${href}: no ${url.hash} on that page`);
          }
        } else if (EXTERNAL) {
          const s = await status(url.href);
          if (typeof s !== 'number' || s >= 400) flag(p, `outside link ${url.href} gives ${s}`);
        }
      }
    }

    // controls, by page
    try {
      if (p === '/') {
        if (view === 'laptop') {
          for (const kind of ['poll', 'cloud', 'open', 'quiz']) {
            await page.click(`.chips button[data-kind="${kind}"]`);
            if (!(await page.isVisible(`.view[data-view="${kind}"]`))) flag(p, `chip ${kind} doesn't show its slide`);
          }
          await page.click('.switch button[data-after="0"]');
          if (!(await page.isVisible('.view[data-view="before"]'))) flag(p, 'Before switch does nothing');
          await page.click('.switch button[data-after="1"]');
          ok('home: Before / With switch and all four chips');
          await page.click('.srcs summary');
          if (!(await page.isVisible('.srcs-grid'))) flag(p, 'Sources does not open');
          else ok('home: comparison Sources opens');
          if (await page.$('a.soon, button.soon')) flag(p, 'a coming-soon button is clickable');
        }
        const faq = page.locator('.faq details').nth(1);
        await faq.locator('summary').click();
        if (!(await faq.evaluate((d) => d.open))) flag(`${p} (${view})`, 'FAQ item does not open');
        else ok(`home (${view}): FAQ opens`);
        await page.click('a[href="#see-it-work"]');
        await page.waitForTimeout(400);
        const top = await page.$eval('#see-it-work', (e) => e.getBoundingClientRect().top);
        if (top < 0 || top > 200) flag(`${p} (${view})`, `"See it work" lands at ${Math.round(top)}px, not under the header`);
        else ok(`home (${view}): See it work jumps to its section`);
        if (view === 'phone') {
          await page.evaluate(() => scrollTo(0, 2500));
          await page.waitForTimeout(500);
          if (!(await page.$eval('.pinbar', (b) => b.classList.contains('up')))) flag(p, 'phone install bar does not appear after the hero');
          await page.click('.pinbar .x');
          await page.waitForTimeout(300);
          if (await page.$eval('.pinbar', (b) => b.classList.contains('up'))) flag(p, 'phone install bar does not close');
          else ok('home (phone): install bar appears and closes');
        }
      }
      if (p === '/christmas-quiz-for-work/') {
        const first = page.locator('.reveal').first();
        await first.locator('summary').click();
        if (!(await first.evaluate((d) => d.open))) flag(`${p} (${view})`, 'Show answer does not open');
        await page.click('[data-answers]');
        const open = await page.$$eval('.reveal', (ds) => ds.filter((d) => d.open).length);
        const all = await page.$$eval('.reveal', (ds) => ds.length);
        if (open !== all) flag(`${p} (${view})`, `Show all answers opened ${open} of ${all}`);
        else ok(`christmas (${view}): Show answer and Show all answers (${all})`);
      }
      if (p === '/this-page-does-not-exist/') {
        await page.click('.q404-opt >> nth=3');
        await page.waitForSelector('.q404.revealed', { timeout: 3000 });
        await page.click('[data-again]');
        await page.click('.q404-opt >> nth=0');
        await page.waitForSelector('.q404.revealed', { timeout: 3000 });
        ok(`404 (${view}): question, reveal and the bonus question`);
      }
      const tocLink = view === 'laptop' ? page.locator('.toc a[href^="#"]').nth(1) : null;
      if (tocLink && (await tocLink.count())) {
        const href = await tocLink.getAttribute('href');
        await tocLink.click();
        await page.waitForTimeout(500);
        const t = await page.$eval(`[id="${decodeURIComponent(href.slice(1))}"]`, (e) => e.getBoundingClientRect().top).catch(() => null);
        if (t === null || t < 0 || t > 260) flag(p, `contents link ${href} lands at ${t}`);
        else ok(`${p}: contents links land below the header`);
        await page.evaluate(() => scrollTo(0, 3000));
        await page.waitForTimeout(400);
        await page.click('.to-top');
        await page.waitForTimeout(600);
        if ((await page.evaluate(() => scrollY)) > 50) flag(p, 'back-to-top does not go back to the top');
      }
      if (view === 'phone' && (await page.$('.toc-mini'))) {
        await page.click('.toc-mini summary');
        await page.click('.toc-mini a >> nth=1');
        await page.waitForTimeout(500);
        if (await page.$eval('.toc-mini', (d) => d.open)) flag(p, 'phone contents menu stays open after a pick');
        else ok(`${p} (phone): contents menu jumps and closes`);
      }
      if (view === 'phone' && (await page.$('.subbar .back'))) ok(`${p} (phone): back button present`);
    } catch (e) {
      flag(`${p} (${view})`, `a control failed: ${e.message.split('\n')[0]}`);
    }

    await page.evaluate(() => scrollTo(0, 0));
    const name = (p.replace(/^\/|\/$/g, '') || 'home').replace(/\//g, '-');
    await page.screenshot({ path: path.join(OUT, `${name}-${view}.png`), fullPage: true });
    await page.close();
  }
  await ctx.close();
}
await browser.close();

console.log(`${paths.length} pages, laptop and phone. ${passes.length} control checks passed.`);
console.log(passes.map((p) => `  ok  ${p}`).join('\n'));
console.log(problems.length ? `\n${problems.length} problems:\n${problems.map((p) => `  !!  ${p}`).join('\n')}` : '\nNo problems found.');
process.exit(problems.length ? 1 : 0);
