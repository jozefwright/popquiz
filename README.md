# Pop Quiz for Google Slides

Live quizzes, polls and a leaderboard inside your own Google Slides deck. You make a slide a question, press Slideshow, and the room answers on their phones: no app, no sign-up, and the results land on your own slides, in your deck's own design.

**Website:** [popquiz.fun](https://popquiz.fun) · **Try it as a player:** [play.popquiz.fun/demo](https://play.popquiz.fun/demo/) · **Chrome Web Store:** coming soon

This is the whole of Pop Quiz: the Chrome extension, the phone page players join on, and the relay that carries a game between them. It's open so you can see exactly what it does with your slides and your players before you install it.

## What it does with your data

Short version: very little, and nothing is kept.

- **Where it runs.** The extension runs only on Google Slides pages (`docs.google.com/presentation/*`, see `app/manifest.json`). It reads the open deck's slide ids, shape positions and text, to place the quiz on your slide. It does not read other Docs, Sheets, Gmail or your browsing.
- **What it stores.** Your quiz is kept in Chrome on your own computer (`chrome.storage.local`), with a safety copy in your Downloads folder. No account, no server copy.
- **What travels.** During a game, the question, options, timer and results go from your browser through the relay to the players' phones; phones send back a nickname and their answers. The relay (`relay/`) passes messages on and stores nothing: one Cloudflare Durable Object per room, held in memory while the room is open.
- **No analytics, ads or tracking** in the extension or the phone page.

The privacy policy in plain English: [popquiz.fun/privacy](https://popquiz.fun/privacy/).

## How it's built

No framework and no build step: `app/` is both the unpacked Chrome extension and the phone page's website.

| Part | Where | What it is |
|---|---|---|
| Engine | `app/shared/engine.js` | The game: room, players, answers, clock, scores. Knows nothing about Slides or the network. |
| Phone logic | `app/shared/player.js` | What a phone does, with no screen attached. The tests drive this same class. |
| Stage | `app/stage/` | The big-screen drawing plus the engine, laid over the slideshow in an iframe. |
| Phone page | `app/index.html`, `app/phone.js` | What players see. Served at play.popquiz.fun. |
| Slides hook | `app/content.js`, `app/ext/host.js` | Finds the slideshow, mounts the stage, reports the current slide and shapes. |
| Side panel | `app/panel/` | Where a slide is made a quiz question. |
| Quiz format | `app/shared/quizformat.js` | Reads a pasted or loaded quiz: the open format at [popquiz.fun/quiz-format](https://popquiz.fun/quiz-format/). |
| Relay | `relay/` | A Cloudflare Worker and one Durable Object per room. See `relay/README.md`. |
| Demo | `app/demo/` | The self-running game behind play.popquiz.fun/demo. |
| Fallback player | `app/play/` | Plays a deck from a PDF with the same stage. Also the test bench. |

How Pop Quiz finds its way around the Slides page, and why it does it that way: `docs/SLIDES.md`.

## Run it

```bash
npm install
npm test                 # unit tests
npm run serve            # the phone page, the demo and the fallback player on http://localhost:8790
npm run relay            # the relay, locally, on http://127.0.0.1:8787 (no account needed)
```

To load the extension: open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, choose `app/`, then reload any open Google Slides tab and click the Pop Quiz icon.

To use your own relay and phone page, change `CF_RELAY_URL` and `DEFAULT_JOIN_BASE` in `app/shared/config.js`, and `ALLOWED_ORIGINS` and the route in `relay/wrangler.toml`.

The browser tests (`npm run test:extension`, `npm run test:player` and others) drive Playwright's Chrome for Testing; see the top of each file.

## The name and logo

The code is MIT-licensed: use it, change it, ship it. The **Pop Quiz** name and the starburst logo are not part of that licence. If you publish your own version, give it your own name and look, so nobody mistakes it for this one.

## Security

Found a way to read someone else's game, get past the relay's limits or misuse the extension? Please email **hello@popquiz.fun** rather than opening a public issue. See `SECURITY.md`.

## Who makes it

Pop Quiz is made by Jozef Wright, an independent developer in Auckland, New Zealand. It isn't affiliated with or endorsed by Google; Google Slides and Chrome are trademarks of Google LLC.
