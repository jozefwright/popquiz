// Writes app/files.txt: every file a laptop needs to run the plugin, with its
// SHA-1, one per line ("<sha1>  <path>", as shasum prints). The fetch script
// (app/get/popquiz.sh) reads it from the public site, downloads only what has
// changed, and checks each file against its line before putting it in place.
//
//   npm run files          rewrite it (do this before every push)
//   npm run files -- check say whether it is current, and exit 1 if not (the tests do)
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
// The plugin is everything in app/ that git tracks, less what only the website
// uses (the function, its package file, the site's own settings and pages) and
// less any dotfile: the site does not serve those, and Chrome needs none.
const SITE_ONLY = /^(api\/|get\/|package\.json$|vercel\.json$|_headers$|files\.txt$)|(^|\/)\./;

export async function list() {
  const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '.'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const lines = [];
  for (const file of tracked.filter((f) => !SITE_ONLY.test(f)).sort()) lines.push(`${createHash('sha1').update(await readFile(path.join(root, file))).digest('hex')}  ${file}`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const want = await list();
  const target = path.join(root, 'files.txt');
  if (process.argv[2] === 'check') {
    const have = await readFile(target, 'utf8').catch(() => '');
    if (have !== want) {
      console.error('app/files.txt is out of date. Run: npm run files');
      process.exit(1);
    }
    console.log(`app/files.txt is current (${want.trim().split('\n').length} files)`);
  } else {
    await writeFile(target, want);
    console.log(`app/files.txt written: ${want.trim().split('\n').length} files`);
  }
}
