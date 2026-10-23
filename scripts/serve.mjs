// Static server for app/. Nothing is cached, so an edit shows on the next
// reload, and it listens on the whole network so phones on the same Wi-Fi can
// reach the laptop during a rehearsal.
//   npm run serve            http://localhost:8790
//   PORT=9000 npm run serve
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const port = +process.env.PORT || 8790;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

// A stand-in for api/deck.js, so sharing between devices can be built and
// tested with no cloud: the same calls, the same answers (both run the rules in
// shared/shelf.js), with each deck's shared copy and its earlier versions kept
// as files under test/.out/sync/.
const { DECK_ID, MAX_BYTES } = await import('../app/shared/sync.js');
const { save, shown, remember, listed, version } = await import('../app/shared/shelf.js');
const shelf = path.resolve(root, '..', 'test', '.out', 'sync');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };
// How many looks and saves each deck has had since this server started. The
// real store counts both against a monthly allowance; `?counts=1` (here only)
// lets a test see what a piece of work cost.
const counts = new Map();

async function deckApi(req, res, url) {
  const send = (status, body) => {
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
    res.end(body === null ? '' : JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return send(204, null);
  const id = url.searchParams.get('id') || '';
  if (!DECK_ID.test(id)) return send(400, { error: 'bad id' });
  const file = path.join(shelf, `${id}.json`);
  const historyFile = path.join(shelf, `${id}.history.json`);
  const read = (f) => readFile(f, 'utf8').then(JSON.parse, () => null);
  const cost = counts.get(id) || { looks: 0, saves: 0 };
  counts.set(id, cost);
  if (req.method === 'GET' && url.searchParams.get('counts')) return send(200, cost);
  if (req.method === 'GET') {
    if (url.searchParams.get('history')) return send(200, { versions: listed(await read(historyFile)) });
    if (url.searchParams.get('rev')) {
      const found = version(await read(historyFile), url.searchParams.get('rev'));
      return found ? send(200, shown(found)) : send(404, { error: 'no such version' });
    }
    cost.looks += 1;
    const current = await read(file);
    return current ? send(200, shown(current)) : send(404, { error: 'no shared copy yet' });
  }
  if (req.method !== 'PUT') return send(405, { error: 'method' });
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.length > MAX_BYTES) return send(413, { error: 'too large' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(400, { error: 'not json' });
  }
  const result = save({ id, current: await read(file), body, now: Date.now() });
  if (result.next) {
    cost.saves += 1;
    await mkdir(shelf, { recursive: true });
    if (result.keep) await writeFile(historyFile, JSON.stringify(remember(await read(historyFile), result.keep)));
    await writeFile(file, JSON.stringify(result.next));
  }
  return send(result.status, result.body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/deck') return await deckApi(req, res, url);
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root)) throw Object.assign(new Error('outside root'), { code: 403 });
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 403 ? 403 : 404, { 'content-type': 'text/plain' });
    res.end(e.code === 403 ? 'forbidden' : 'not found');
  }
}).listen(port, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`pop quiz: http://localhost:${port}`);
  for (const ip of lan) console.log(`pop quiz: http://${ip}:${port}  (phones on this Wi-Fi)`);
});
