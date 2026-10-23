# Pop Quiz relay

Pop Quiz's own realtime relay, to replace Supabase Realtime broadcast on someone else's project. A Cloudflare Worker in front of one Durable Object per room. It passes messages between the presenter and the phones and stores nothing: quiz state stays in the presenter's browser, as before.

Live at `relay.popquiz.fun` since 23 October 2026; the app uses it (`RELAY_KIND = 'cloudflare'` in `app/shared/config.js`).

## How it works

- `wss://<relay>/room/<ROOM>` for a phone, `?role=presenter` for the presenter's stage. One socket per room per device.
- Each room is a Durable Object named by its code, held with the WebSocket Hibernation API: a quiet room costs nothing while every socket stays open.
- A message is a JSON text `{"event": …, "payload": …}`, forwarded exactly as it came. A phone's message goes to the presenter only (nobody else listens to phones); the presenter's goes to every other socket. `ROUTE = "all"` in `wrangler.toml` turns that back into plain broadcast.
- A literal `ping` is answered `pong` by Cloudflare without waking the room. That is the presenter's liveness check now, in place of hearing its own broadcasts come back.
- Limits: 150 phones and 4 presenter sockets a room; 16 KB a message from a phone, 128 KB from the presenter (an open-answer reveal in a full room is about 28 KB); a token bucket per socket; room codes must be four of the app's consonants; `Origin` must be on `ALLOWED_ORIGINS`.

The rules live in `src/rules.js`, unit-tested by `test/relay.test.mjs`. The client is `CloudflareTransport` in `app/shared/transport.js`, made by `makeTransport()` in `app/shared/relay.js`.

## Run it locally

From the repo root (wrangler is a dev dependency, so `npm install` is all the setup):

```bash
npm run relay
```

That is `wrangler dev` on `http://127.0.0.1:8787`. It runs Cloudflare's own runtime on this Mac, needs no account and no login, and reads `.dev.vars`, which lets any origin connect. `curl http://127.0.0.1:8787/` answers `Pop Quiz relay`.

Then, in another terminal, point the live tests at it:

```bash
POPQUIZ_RELAY=cloudflare POPQUIZ_RELAY_URL=ws://127.0.0.1:8787 node test/sim-live.mjs 60
POPQUIZ_RELAY=cloudflare POPQUIZ_RELAY_URL=ws://127.0.0.1:8787 node test/soak.mjs 25 8
```

To try the real stage and phone page on the local relay, set in `app/shared/config.js`:

```js
export const RELAY_KIND = 'cloudflare';
export const CF_RELAY_URL = 'ws://127.0.0.1:8787';
```

and reload the extension. Phones on other devices need the Mac's Wi-Fi address instead of `127.0.0.1`, and `wrangler dev --ip 0.0.0.0`. Put it back before committing.

## Deploying it

`npx wrangler deploy`, from `relay/`, deploys to whichever Cloudflare account wrangler is logged in to (`wrangler.toml` names no account). It needs a zone on that account for the custom domain in `routes`; change or remove that line for your own. `ALLOWED_ORIGINS` lists the pages allowed to open a socket: the phone page's home, the site, local addresses for development and the extension.

Every deploy disconnects every open socket (Cloudflare restarts the objects), so never deploy during someone's game. Phones and presenter reconnect on their own within a few seconds.
