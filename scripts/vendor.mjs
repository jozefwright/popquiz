// Builds the third-party code Tally ships into app/vendor/.
// Run once after `npm install`, and again only when a dependency is bumped.
// Everything is vendored: nothing loads from a CDN on the day of a talk,
// and Manifest V3 forbids remote code in the extension anyway.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'app', 'vendor');
await mkdir(out, { recursive: true });

await build({
  stdin: {
    contents: `export { RealtimeClient } from '@supabase/realtime-js';`,
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outfile: path.join(out, 'realtime.js'),
});

await build({
  stdin: {
    contents: `import qrcode from 'qrcode-generator'; export default qrcode;`,
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outfile: path.join(out, 'qrcode.js'),
});

const pdf = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
await copyFile(path.join(pdf, 'pdf.min.mjs'), path.join(out, 'pdf.min.mjs'));
await copyFile(path.join(pdf, 'pdf.worker.min.mjs'), path.join(out, 'pdf.worker.min.mjs'));

console.log('vendored: realtime.js, qrcode.js, pdf.min.mjs, pdf.worker.min.mjs');
