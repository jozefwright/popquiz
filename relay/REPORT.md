# Pop Quiz relay: report

21 October 2026. Branch `relay-cloudflare`. Built and tested on this Mac under `wrangler dev` only. Nothing is deployed, no account was made, and the app's default is unchanged (`RELAY_KIND = 'supabase'`).

## What was built

| Piece | Where | What it does |
|---|---|---|
| Worker | `relay/src/index.js` | Answers `/` (a health line), turns away anything but `/room/<ROOM>` WebSocket upgrades from an allowed Origin, and hands each room to its own Durable Object, named by the room code. |
| Durable Object `Room` | `relay/src/index.js` | Holds the room's sockets with the Hibernation API (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`, `webSocketError`). Forwards each message, untouched, to the others in the room. Stores nothing. |
| Rules | `relay/src/rules.js` | Room-code check, Origin check, per-socket token bucket, message check, who hears what. Plain JS, unit-tested in Node. |
| Config | `relay/wrangler.toml`, `relay/.dev.vars` | No `account_id`. `compatibility_date = "2026-10-15"`. SQLite-backed class (the only kind on the free plan). `ALLOWED_ORIGINS` and `ROUTE` as vars; `.dev.vars` opens Origins to `*` under `wrangler dev` only. |
| Client | `CloudflareTransport` in `app/shared/transport.js` | Same interface and statuses as `RelayTransport`: `open`, `send`, `onMessage`, `onStatus`, `reset`, `rejoin`, `close`, `trouble`; `'connecting'`, `'live'`, `'down'`. |
| Switch | `RELAY_KIND`, `CF_RELAY_URL` in `app/shared/config.js`; `makeTransport()` in `app/shared/relay.js` | Every connection is now made by `makeTransport()`: stage, phone page, pretend players, and the live tests (`sim-live`, `soak`, `join-room`, `relay-restart`, `ext-e2e`, via `test/helpers/relay.mjs`, which reads `POPQUIZ_RELAY` and `POPQUIZ_RELAY_URL`). `'cloudflare'` with an empty URL falls back to Supabase. |
| Tests | `test/relay.test.mjs` | 15 unit tests: the rules, and the client's reconnect, backoff, ping watchdog, full room and closing socket. `npm test`: 111 of 111 pass. |
| Run script | `npm run relay` | `wrangler dev` on `127.0.0.1:8787`. |

## How it maps to the Supabase behaviour

| Supabase broadcast | Cloudflare relay |
|---|---|
| Channel `tally-<room>` on a shared project | One Durable Object per room, `/room/<ROOM>`. No other game shares it, so no prefix is needed. |
| Broadcast to every subscriber | Each message to every other socket, optionally narrowed (below). |
| `self: true` for the presenter, so it hears itself and knows the link works | The relay never echoes. Liveness is a literal `ping` that Cloudflare answers `pong` itself, without waking the room and without charge. The presenter pings every 2 s and rebuilds after `TIMING.echoMs` (6.5 s) of silence, the same window as before. Phones ping every 10 s; they also have the presenter's heartbeat. |
| `ack: true` for the presenter's sends | Not needed: a send reaches the relay or the socket dies, and the ping watchdog catches the silent kind. |
| Supabase's client reconnects and rejoins by itself | `CloudflareTransport` reconnects by itself: 1, 2, 4, 8, then 15 s, each times 0.75 to 1.35, so a room does not come back in step. At least 10 s after "room full". A socket that has not opened in 10 s is abandoned and retried. |
| `rejoin()`: leave and rejoin on the same socket | A socket is a room, so `rejoin()` is `reset()`. Nothing calls `rejoin` today. |
| `live` once the channel is SUBSCRIBED | `live` once the socket is open: the room exists the moment the socket does. |
| Project-wide limits (100 messages a second on Supabase's free plan) | Per-room, per-socket limits of our own. |

Self-echo was relied on in one place only: the presenter's dead-link check in `RelayTransport`. Neither the engine nor the player depends on it.

**One deliberate change:** a phone's message goes to the presenter alone (`ROUTE = "presenter"`). Only the presenter listens to phones (`Engine.receive` reads hellos and answers; `Player` reads only snapshots), so every phone hearing every other phone's answers was pure waste. The spike measured that at about 200 deliveries a second for 25 phones; at 100 phones it is sixteen times that. Narrowed, traffic grows with the room rather than its square. `ROUTE = "all"` restores plain broadcast.

## Limits in the relay

| Limit | Value | Why |
|---|---|---|
| Phones per room | 150 (`LIMITS.players`) | Presenter sockets are counted apart (up to 4), so a full room cannot shut out its own presenter. The 151st phone is closed with `4003 room full`. |
| Quiet sockets when full | Closed after 25 s with no message and no ping (`4001`) | Phones that slept or left. A live phone pings every 10 s, so it is never taken. |
| Message size | 16 KB from a phone, 128 KB from the presenter | **A flat 16 KB would break the game.** The open-answer reveal carries every card: measured at 19 KB for 100 phones and 28 KB for 150 with 140-letter answers, and up to three times that in a script of three bytes a letter. A phone's largest message is under 1 KB. Over the cap: closed with `1009`. A unit test builds the biggest reveal and checks it fits. |
| Rate | Phone: 20 burst, 4 a second. Presenter: 60 burst, 15 a second | A phone repeats hellos and answers every 1.4 s, so it sends one or two a second at its busiest. The presenter's rate does not grow with the room (receipts are batched every 0.6 s). Over the rate a message is dropped (the protocol resends); 200 drops in a row closes with `1008`. |
| Room code | Four of `BCDFGHJKLMNPQRSTVWXZ`, either case | The alphabet `makeRoomCode` uses, now exported from `protocol.js`. Anything else is a 400 from the Worker, without touching a Durable Object. |
| Origin | `ALLOWED_ORIGINS`, exact or with `*` | A speed bump against other websites, not a lock: anything that is not a browser can send any Origin. No Origin at all is refused outside dev. |
| Counting | `count()` hook, a TODO | Games started and peak phones, written to Workers Analytics Engine once a `STATS` binding is added. Nothing stored by us, nothing that names a room or a person. Off. |

Anyone can still claim `?role=presenter` and send into a room whose code they know, exactly as anyone holding Supabase's publishable key can today. Closing that needs a secret per session: a protocol change, not a relay one.

## Test results

All against `wrangler dev` at `ws://127.0.0.1:8787`, Node 24, workerd 1.20261019, on this Mac. Loopback: no real network is in these numbers.

**`test/sim-live.mjs`** (join over 3 s, two 8-second questions, a leaderboard):

| Phones | Joined in | Question on every phone | Answer confirmed, median / worst (q1; q2) | Result on every phone | Answers lost |
|---|---|---|---|---|---|
| 25 | 3.1 s | 52 ms | 463 / 616 ms; 308 / 566 ms | 17 ms; 25 ms | 0 of 50 |
| 60 | 3.6 s | 51 ms | 359 / 659 ms; 307 / 619 ms | 19 ms; 35 ms | 0 of 120 |
| 100 | 3.6 s | 53 ms | 304 / 661 ms; 358 / 662 ms | 75 ms; 31 ms | 0 of 200 |
| 150 | 3.6 s | 50 ms | 352 / 659 ms; 355 / 656 ms | 80 ms; 75 ms | 0 of 300 |

"Question on every phone" sits at the test's 50 ms polling floor. Confirmation time is the engine's own 600 ms receipt batching, not the relay.

**`test/soak.mjs`** (14 questions on 8-second clocks: clouds, polls, true or false, leaderboards; three latecomers, three phones cut silently mid-talk, one page reload mid-question):

| Phones | Minutes | Answers counted | Lost | Every phone saw every question | Reveal on every phone | Relay trouble |
|---|---|---|---|---|---|---|
| 25 | 3.4 | 346 | 0 | 14 of 14 | 14 of 14 | none |
| 60 | 3.6 | 835 | 0 | 14 of 14 | 14 of 14 | none |
| 100 | 3.9 | 1,395 | 0 | 14 of 14 | 14 of 14 | none |

The three phones cut mid-talk came back after 5.7 to 6.7 s each time, by the phone's own recovery.

**`test/relay-restart.mjs`**, 25 phones:

| Mode | Supabase (spike, 6 Oct) | Cloudflare, local |
|---|---|---|
| `room`: presenter and every phone leave, all back two seconds later | Unreliable in four of five runs: phones deaf for about a minute, answers lost | Clean: no phone ever deaf, no reconnects, 0 of 75 answers lost |
| `blip`: every phone's connection cut at once | Clean, phones back after about 6 s | Clean: each phone reconnected once, after 5.5 to 5.9 s; 0 of 75 lost |

**Room full**, with raw sockets: the 151st phone gets `4003 room full`; a presenter still gets in; once phones have been silent for 25 s a newcomer gets in and the quietest phone stops receiving.

**An accidental extra:** the first 25-phone soak ran into a wrangler reload (an edit inside `relay/` restarts the local server, as a deploy restarts the real one). All 26 sockets dropped at once, 40 s in. Every one came back by itself and that run still passed, 0 of 343 answers lost.

### Found along the way

- A hibernating socket closed from the room's `fetch` (making space in a full room) sends its close frame, but under `wrangler dev` the connection never finishes closing, so the client gets no `close` event. The client now treats a closing socket as gone. Refusals use the standard `accept()`, which closes properly. Worth checking once on real Cloudflare.
- `test/relay-restart.mjs` counted joins by head count, which a resumed session inflates. It now checks that every phone is on the presenter's list, and its `blip` cut works on either relay.

## Costs and Cloudflare's limits

From Cloudflare's docs, read 21 October 2026:

- **Durable Objects, free plan** ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)): 100,000 requests and 13,000 GB-s of duration a day, reset at 00:00 UTC; past either, further operations fail. Only SQLite-backed objects ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- **Paid plan** (Workers Paid, US$5 a month minimum): 1 million requests a month included, then US$0.15 a million; 400,000 GB-s included, then US$12.50 a million GB-s.
- **WebSocket billing** ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)): opening a socket is one request. Incoming messages are billed at 20 to 1. Outgoing messages are free. Auto-response pings are free and add no duration. Duration is charged at 128 MB per object, and an object that is idle and able to hibernate is not charged. It becomes eligible after 10 s of inactivity ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- **Per object** ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [state API](https://developers.cloudflare.com/durable-objects/api/state/)): a soft limit of 1,000 requests a second; up to 32,768 hibernating sockets; received messages up to 32 MiB; 30 s of CPU per message.
- **Workers, free plan** ([limits](https://developers.cloudflare.com/workers/platform/limits/)): 100,000 requests a day, 10 ms CPU each. Only socket upgrades pass through the Worker.

**What one talk costs**, a rough estimate for 100 phones, 20 questions, 45 minutes:

- Requests: about 130 sockets opened (phones, presenter, reconnects) plus about 4,800 incoming messages (the presenter's snapshots and heartbeats about 1,500; answers and their repeats about 3,000; hellos about 300), billed as about 240. **About 370 requests a talk**, so the free plan's 100,000 a day is some 270 talks.
- Duration, worst case: the presenter's heartbeat every 2 s means the room never sits idle for 10 s during a talk, so assume it is billed throughout: 2,700 s × 0.125 GB = **about 340 GB-s a talk**. That makes duration the binding limit: about **38 talks a day on the free plan**, about **1,180 a month** inside the paid plan's allowance, and about US$0.004 a talk beyond that. Cloudflare's own worked example bills only the time spent handling messages, which would be far lower; not measured here.
- Between talks the relay costs nothing: no sockets, no objects running.

At 100 phones the busiest moment sends the presenter something like 100 to 150 messages a second, a tenth of one object's soft limit.

## What is left for Jozef

1. Decide whether to move. If yes: a Cloudflare account of his own, `npx wrangler login`, set `ALLOWED_ORIGINS`, `npx wrangler deploy`, ideally a custom domain. Steps in `relay/README.md`.
2. Then `RELAY_KIND = 'cloudflare'` and `CF_RELAY_URL` in `app/shared/config.js`, `npm run files`, `npm test`, and live runs (`sim-live`, `soak`, `meet-sim`) **against the deployed relay**, from Auckland, on 4G as well as Wi-Fi. Everything above is loopback; the real round trip to wherever Cloudflare places the room is not measured.
3. Confirm on real Cloudflare that a phone evicted from a full room hears its close.
4. Optional: turn on counting (an Analytics Engine binding named `STATS`).
5. Optional, later: a per-session secret, so only the real presenter can speak for a room.

Never deploy during a talk: a deploy drops every socket. They come back by themselves within seconds, as the accidental reload showed, but a question in flight would feel it.
