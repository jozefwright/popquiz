// The shared copy of a deck's quiz: one small JSON file per deck, kept in a
// private Vercel Blob store and filed under the deck's Google Slides id, with
// its earlier versions in a second file beside it.
//
//   GET  /api/deck?id=<presentationId>            -> { rev, updatedAt, schema, deck }  or 404
//   GET  /api/deck?id=<presentationId>&history=1  -> { versions: [{ rev, updatedAt, slides, questions }] }
//   GET  /api/deck?id=<presentationId>&rev=<rev>  -> one earlier version, { rev, updatedAt, schema, deck }  or 404
//   PUT  /api/deck?id=<presentationId>            body { deck, client, baseRev?, force?, keep? }
//                                                 -> { rev, updatedAt }
//                                                 or 409 with the shared copy, if it moved on since baseRev
//                                                 or 426 if the copy of Tally saving is out of date
//
// There is no sign-in. The id is the key: it is long, unguessable, and known
// only to people who can open the deck. Anyone holding it can read and write
// that deck's quiz, which is the trade made for it to work on any device with
// no setup. Nothing but quiz settings is ever stored here.
//
// The rules for a save are in shared/shelf.js; this file only fetches and stores.

import { get, put } from '@vercel/blob';
import { DECK_ID, MAX_BYTES } from '../shared/sync.js';
import { save, shown, remember, listed, version } from '../shared/shelf.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  'cache-control': 'no-store',
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' } });
const pathFor = (id) => `decks/${id}.json`;
const historyFor = (id) => `decks/${id}.history.json`;

async function read(pathname) {
  // useCache: false, because a device must see another's save straight away.
  const found = await get(pathname, { access: 'private', useCache: false });
  if (!found || found.statusCode !== 200) return null;
  try {
    return JSON.parse(await new Response(found.stream).text());
  } catch {
    return null;
  }
}

const store = (pathname, value) => put(pathname, JSON.stringify(value), { access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });

function idFrom(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  return DECK_ID.test(id) ? id : null;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  const id = idFrom(request);
  if (!id) return json(400, { error: 'bad id' });
  const query = new URL(request.url).searchParams;
  if (query.get('history')) return json(200, { versions: listed(await read(historyFor(id))) });
  if (query.get('rev')) {
    const found = version(await read(historyFor(id)), query.get('rev'));
    return found ? json(200, shown(found)) : json(404, { error: 'no such version' });
  }
  const current = await read(pathFor(id));
  return current ? json(200, shown(current)) : json(404, { error: 'no shared copy yet' });
}

export async function PUT(request) {
  const id = idFrom(request);
  if (!id) return json(400, { error: 'bad id' });
  const raw = await request.text();
  if (raw.length > MAX_BYTES) return json(413, { error: 'too large' });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: 'not json' });
  }
  const result = save({ id, current: await read(pathFor(id)), body, now: Date.now() });
  if (result.next) {
    // The earlier version first: if this fails, nothing has been replaced yet.
    if (result.keep) await store(historyFor(id), remember(await read(historyFor(id)), result.keep));
    await store(pathFor(id), result.next);
  }
  return json(result.status, result.body);
}
