// Packs the extension for the Chrome Web Store: dist/popquiz-<version>.zip.
//
//   npm run pack            refuses while the app still points at the stopgaps
//   npm run pack -- --force packs anyway (for a look, never for upload)
//
// The zip holds what the extension uses: every file in app/files.txt except
// the website's own pages (the phone page, the demo and the install page),
// which the extension never loads.

import { readFile, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app');
const force = process.argv.includes('--force');

const SITE_ONLY = [/^demo\//, /^get\//, /^_headers$/,/^index\.html$/, /^phone\.(js|css)$/, /^slides-map\.json$/, /^version\.json$/, /^files\.txt$/];

const manifest = JSON.parse(await readFile(path.join(APP, 'manifest.json'), 'utf8'));
const config = await readFile(path.join(APP, 'shared', 'config.js'), 'utf8');

const problems = [];
if (/RELAY_KIND\s*=\s*'supabase'/.test(config)) problems.push("RELAY_KIND is still 'supabase': the store listing's privacy answers describe the Cloudflare relay.");
if (/CF_RELAY_URL\s*=\s*''/.test(config)) problems.push('CF_RELAY_URL is empty.');
if (/tally-quiz\.vercel\.app/.test(config)) problems.push('DEFAULT_JOIN_BASE still points at Tally’s old site.');
if (problems.length && !force) {
  console.error('Not packing:\n' + problems.map((p) => `  - ${p}`).join('\n') + '\n\nDeploy the relay and the phone page first (launch/MORNING.md), or pass --force for a look.');
  process.exit(1);
}

const files = (await readFile(path.join(APP, 'files.txt'), 'utf8'))
  .split('\n')
  .map((l) => l.trim().split(/\s+/)[1])
  .filter(Boolean)
  .filter((f) => !SITE_ONLY.some((re) => re.test(f)));
for (const need of ['manifest.json', 'background.js', 'content.js', 'panel/panel.html', 'stage/index.html'])
  if (!files.includes(need)) throw new Error(`${need} is missing from app/files.txt: run npm run files`);

const out = path.join(ROOT, 'dist', `popquiz-${manifest.version}${problems.length ? '-NOT-FOR-UPLOAD' : ''}.zip`);
await mkdir(path.dirname(out), { recursive: true });
await rm(out, { force: true });
execFileSync('zip', ['-X', '-q', out, ...files], { cwd: APP });
console.log(`${path.relative(ROOT, out)}: ${files.length} files, version ${manifest.version}`);
if (problems.length) console.log('Packed with --force. Not for upload:\n' + problems.map((p) => `  - ${p}`).join('\n'));
