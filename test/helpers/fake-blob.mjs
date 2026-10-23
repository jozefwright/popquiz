// A stand-in for @vercel/blob, held in memory, with the two calls api/deck.js
// makes. It also counts them the way the real store does: a get is a look
// (a "simple operation"), a put is a save (an "advanced operation").
export const files = new Map();
export const ops = { looks: 0, saves: 0 };

export async function get(pathname) {
  ops.looks += 1;
  if (!files.has(pathname)) return null;
  return { statusCode: 200, stream: new Response(files.get(pathname)).body };
}

export async function put(pathname, body, options = {}) {
  if (files.has(pathname) && !options.allowOverwrite) throw new Error('this blob already exists');
  ops.saves += 1;
  files.set(pathname, String(body));
  return { pathname };
}
