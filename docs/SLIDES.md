# How Pop Quiz finds its way around Google Slides

Run 6 October 2026, in a real 85-slide deck, Chrome 154.

**Answer: yes.** All three questions from the brief came back positive. One part is still to be seen with his own eyes: true full screen in his own Chrome.

## What was asked, and what was found

| Question | Result | How it was seen |
|---|---|---|
| Can the current slide be detected as slides advance? | Yes | A watcher on the slideshow logged the slide id changing on each of three advances. The address bar's `#slide=id.…` changes in step. |
| Can a box be drawn on top of the slide in the slideshow? | Yes | A test box appended inside Google's full-screen element showed over slide 4. Screenshot taken. |
| Can a placeholder shape's on-screen rectangle be read? | Yes, by the shape's id | Every shape on the slide is in the slideshow's markup under its own id, and its rectangle reads back as a fraction of the slide. |
| Can the shape be found by its alt text? | No | Alt text is not in the editor's or the slideshow's markup. The side panel picks the shape instead, and stores its id. |

## The markup Tally relies on

If Google changes any of this, `app/ext/host.js` is the only file that needs to follow.

**In the editor**

- `g#editor-<objectId>`: one group per shape on the open slide. Its bounding box is the shape's position.
- `g#editor-<slideId>-bg`: the slide's own background, which gives the slide's rectangle.
- `g#filmstrip-slide-<n>-<slideId>`: thumbnails, `n` from 0. The filmstrip only draws the thumbnails near the one in view (12 of 85 at a time), so it cannot be used to list a whole deck.
- Inside each (read off the real deck on 12 Oct 2026, opened view-only): `g#filmstrip-slide-<n>-<slideId>-bg` is the thumbnail's own rectangle, 16:9, and each shape is `g#filmstrip-slide-<n>-<objectId>`. The thumbnails sit in `svg.punch-filmstrip-thumbnails`, inside `div.punch-filmstrip-scroll`, which is positioned and is the box that scrolls. Tally draws its miniatures inside that box, so they scroll with the strip.
- `#slide=id.<slideId>` in the address follows the selected slide.

**In the slideshow**

- Pressing Slideshow adds `div.punch-full-screen-element` to the page, containing `iframe.punch-present-iframe`. The iframe is same-origin, so its document is readable. Both are removed when the slideshow ends.
- The slide is `.punch-viewer-svgpage-svgcontainer > svg`, with `viewBox="0 0 975360 548640"`. Its first group is `g#<slideId>`; each shape inside is `g#<objectId>`.
- `div.punch-viewer-svgpage-a11yelement` carries `aria-label="Slide 4 of 85: …"`.
- The page sets no `frame-src` or `connect-src` policy, so an iframe of the extension's own page may be placed over the slide, and that page may open a WebSocket.
- The page does enforce Trusted Types. `host.js` builds its elements with `createElement` and never assigns HTML.

## What changed in the design because of it

- **Placement is by shape id, picked in the side panel.** Not by alt text.
- **The stage is an iframe of the extension's own page**, laid over the slide inside the full-screen element. It is isolated from Google's styles and scripts, and it is the same page the PDF fallback uses.
- **The stage dies when the slideshow closes** (Google removes its parent). The engine therefore saves on every change and resumes on the next start. This is tested.
- **The placeholder shape is hidden during the show**, so the presenter can leave a visible, labelled rectangle in the editor.

## What the relay taught us

Measured 6 October 2026 with 25 simulated phones on real sockets (`test/soak.mjs`, `test/relay-restart.mjs`).

| Situation | Result |
|---|---|
| A room starting on a quiet relay | Clean every time, including a 13.5-minute run of 14 questions. |
| The presenter leaves and is back two seconds later, then the room joins | Clean. Stopping and restarting the slideshow is safe. |
| Every phone's connection cut in the same instant, presenter still connected | Clean. Each phone began reconnecting about six seconds later; all 25 answered the next question. |
| The presenter and every phone leave, and all return within two seconds | **Unreliable.** In four of five runs phones stayed connected but stopped hearing the presenter, repeatedly; with the uneven recovery it settled after about a minute, with a few answers lost meanwhile. In the fifth run nothing went wrong beyond one phone being slow to join. |

The failure needs two things together: the project's connections dropping to none, and a crowd arriving straight after. The likely cause is the relay tearing the project down when its last connection leaves, and the newcomers being caught in that. That is an inference from the timing; nothing in the relay's own messages says so.

Where it could happen for real: the venue's Wi-Fi dropping for a few seconds for the laptop and the phones together. And in testing: two full runs back to back, which is why the tests say to leave a few minutes between them.

Built in because of it:

- **Recovery is uneven on purpose.** A phone that stops hearing the presenter reconnects after a random moment, and stretches every later wait by a random amount, so a room does not come back in step. Before this, every phone reconnected at the same five-second mark, and the unstable state never settled. (A gentler first step, rejoining on the same socket, was tried and removed: it never cured anything in a test, and once cost a phone six seconds.)
- Traffic is kept lean: one snapshot per phase change, receipts for answers batched, a two-second heartbeat only when nothing else is being sent.
- The presenter listens for its own messages coming back, and rebuilds its link if they stop.
- Every answer is repeated until the presenter's snapshot lists it.
- `Shift` + `R` re-runs a question, which is the practical cure if a drop lands in the middle of one.

Measured again on 16 October 2026 with `test/meet-sim.mjs`: 25 browser phones on the real relay, with room, home Wi-Fi and 4G delays, through a ten-question talk, four times. Every answer arrived; questions reached 4G phones in 0.4 s (median) and room phones in 0.1 s. A question with 25 phones answering fans out to about 200 deliveries a second at its busiest (every phone hears every other phone's answer), against far fewer sends. Supabase's free plan allows 100 messages a second and its documentation does not say whether a broadcast counts once or once per listener; across the four runs nothing was disconnected or lost, so at this size it holds. An inbound channel that only the presenter hears would cut the fan-out to a twenty-fifth, if a bigger room ever needs it.

What is not solved: the minute of instability after a total drop. It is a property of this relay. A relay of our own would remove it; that is a larger change and was not made before the talk.

## Checked in the real deck with the extension loaded

6 October 2026, a personal Chrome profile, a real deck, a recorder running inside the page.

| Check | Result |
|---|---|
| The content script starts and reads the editor | Yes: slide 4, its number, and five shapes, with the same positions the slideshow reports. |
| The side panel works against the real editor | Yes: we made slide 4 a question from it, and the setting was stored against that slide. |
| True full screen | Yes: `document.fullscreenElement` is `div.punch-full-screen-element`, the element the stage is mounted in. |
| The stage stays mounted | Yes: mounted once, never removed, across 40 seconds, a reveal and two slide changes. |
| A question runs end to end | Yes: six simulated phones joined over the relay, answered, and were ranked. |
| The `T` hotkey | Yes: a `T` keydown in the slideshow's frame revealed the answer. |
| Tally follows the slideshow | Yes: advancing went to an ordinary slide (phones waiting); going back showed the result again. |
| Ending the show | Yes: leaving full screen ended the slideshow and the stage was removed. |
| Placement on a shape | Yes: with the module tied to a shape, the slideshow reported that shape at 27.4%, 52.3%, 20.5% by 36.5%, identical to the editor, and the shape was hidden. |

The key presses in this run were sent by script into the slideshow's frame, not typed on a keyboard.

Later the same day, in the real editor and seen in screenshots:

| Check | Result |
|---|---|
| The module drawn on the slide in the editor | Yes: on a blue rectangle on slide 4, to the pixel, with the rectangle's fill hidden beneath it. |
| Clicking the module selects the shape beneath | Yes: Slides drew its selection handles around it. |
| Dragging a hand-placed module | Yes: moved 100 by 50 pixels and the stored position changed by exactly that; Slides selected nothing. |
| Resizing it by its corner | Yes. |
| Knowing which shape is selected | Yes: clicking a text box on slide 9 was reported as that shape. |
| Jumping to a slide | Yes: setting `#slide=id.<slideId>` moves the editor to it. |
| A shape that arrives at the reveal | Yes: Sue's photo, as a stand-in, was hidden while the question was open and visible, with its entrance, the moment `T` revealed the answer. |

Two more facts about the editor's markup that these rely on:

- A selection is drawn as `path[stroke="#1a73e8"]` with no fill, in the `svg` that follows `div#pages` inside `div#workspace`. Its rectangle matches the selected shape's.
- Slide text is real `<text>` with its colour as `fill`, which is how the deck's orange (`#ff4f26`) was read.

## Presenter view, checked in the real deck

9 October 2026, the same profile and deck, the same in-page recorder.

| Check | Result |
|---|---|
| What Presenter view opens | A second window, `window.open('about:blank', 'punch_speaker_notes_…')`, which Slides then writes into. No content script can run in it. |
| Where the slideshow runs | In the deck's own tab, not full screen. The stage mounted there once and stayed for the whole run. |
| Arrows pressed in the notes window | They drive the show, and Tally follows each slide change. |
| `T` and `Shift` + `R` pressed in the notes window | Nothing, at first: the keys never reach the deck's tab. Fixed by `app/ext/notes-keys.js`, which runs in the page's own world, notices that window opening and listens in it. |
| The same keys with the fix | `T`: open to reveal. `Shift` + `R`: reveal to open. `T` again: open to reveal. Three presses, three heard, three acted on. |

One thing this cost an hour: writing into a window with `document.open()` drops every listener on it and leaves the same document object in place, so there is nothing to notice. A listener attached once, before Slides writes, hears nothing afterwards. The fix asks again every 400 ms; adding the same listener twice is a no-op. The automated test's mock now writes late, as Slides does, and fails against the attach-once version.

The key presses were again sent by script, and on this run the fix was pasted into the page rather than loaded by the extension, because this profile's copy had not been reloaded since the manifest changed. The manifest route is covered by the automated test.

## The fallback, run over the real deck's PDF

9 October 2026. `File, Download, PDF` gave 18.2 MB and 11 pages. `node test/play-real.mjs` over it, with that day's copy of the quiz:

| Check | Result |
|---|---|
| Loading | 0.1 s for the PDF. Pages draw in about 70 ms, the slowest in 0.4 s. |
| Every Tally slide | The right module over the right page: join on 2, questions on 4, 5, 7 and 8, the leaderboard on 6. |
| A question, end to end | Eight simulated phones answered and the reveal scored them. |
| A module tied to a shape | It sits exactly where the editor shows it. The shape itself is printed into the PDF, so the player paints it out in the colour around it. |

Two faults found and fixed on the way. A quiz loaded into the player (from a file or from the shared copy) was not played until the page was reloaded: the stage's address changed only after the `#`, which is not a load, so it carried on with the demo quiz. The test that should have caught it passed because the demo quiz also has a join slide on that page. Both are fixed.

The fallback matches a quiz slide to a PDF page by its number. Download the PDF after the last edit to the deck, not before.

## Slides redrew its selection (15 October 2026)

Slides now draws a selected shape with round corner handles, pills on the edges and, for a photo, a floating "Edit image" bar. Tally had found the selected shape by its blue outline (`path[stroke="#1a73e8"]` in the svg after `#pages`), and stopped finding it: the panel said "Nothing selected on the slide" with a photo plainly selected, which broke marking reveal photos, pinning votes to photos and tying a module to a shape.

The new markup could not be read from here. The deck is shared view-only, and a view-only editor selects nothing when clicked, so there is no selection to look at. So `host.js` no longer depends on it: it still reads the outline when it can, and otherwise works out the selected shape from where a press on the canvas lands (`pressedShape`). It watches and changes nothing. The topmost shape under the press is taken, a group as a whole, nothing on empty canvas; Escape and Shift or Cmd clear it.

## Updating a plugin that is not from the store (14 October 2026)

- Chrome updates by itself only what comes from the Web Store. Nothing outside Chrome can load, reload or remove an extension; a page cannot open `chrome://extensions`.
- An unpacked extension can restart itself with `chrome.runtime.reload()`, and Chrome then reads its files, manifest included, afresh from the folder. That is what **Reload Tally** rests on. The side panel is part of the extension, so it closes with it.
- Content scripts already in a tab are cut off by the restart, so Tally leaves itself a note before reloading and, on coming up, reloads the Slides tabs that are open.
- **Not seen end to end here.** An extension loaded with `--load-extension`, which is the only way a test browser can load one, does not come back from `chrome.runtime.reload()` (its pages then answer `ERR_BLOCKED_BY_CLIENT`). `test/update-e2e.mjs` therefore checks the press and the coming back separately. The first real press, in a Chrome, is the proof.
- The panel can read the manifest on disk with `fetch(chrome.runtime.getURL('manifest.json'))` and compare it with the one running (`chrome.runtime.getManifest()`). That is how it knows a newer copy has landed.

## Sharing the slideshow tab, with sound (17 October 2026)

Meet shares a tab on Chrome with `getDisplayMedia`, the tab audio riding along. `test/.out/meet-presenter.mjs` did the same thing to the real deck. A test Chrome with Tally opened the deck at `/present`, and a second page in it shared that tab (picked by title with `--auto-select-tab-capture-source-by-title`). The picture and sound went across a WebRTC link and were metered at the far end. 24 phones from `test/.out/meet-phones.mjs` played in the room over the live relay.

- Chrome offered the tab as two tracks, "Tab audio" and the picture. Tally's stage was in the picture as drawn.
- Slide 36 (Jay Cutler, YouTube) started on one arrow press. Over 8 seconds the far end got 191 frames and loud sound in 30 of 33 quarter-seconds, the same count as was sent. Peak level arrived at 0.196 against 0.209 sent. No packets lost, no frames dropped.
- The far end showed the join slide with "24 in" and the names, Q1 live ("16 of 24 answered"), and the reveal: C 18, D 3, E 1, 22 answered. That matches the phones' own record exactly. No phone errors. Over the 40 seconds of the question, 7,722 video packets arrived with none lost.
- In a signed-out browser, Slides puts "You don't have permission to play 5 media objects" over the slide, on top of Tally's stage, and the five Drive clips do not play. Present signed in to an account that can open them.

Not done: the same through Meet itself. A Meet call hosted by a personal Gmail account turns away a signed-out guest (sent to Meet's home page, no knock reaches the host). The tab the test seat was sharing sat outside Claude's tab group. That Mac grants no Accessibility or Screen Recording to the agent, so no keys and no screen capture. A the test harness seat in the call did receive that seat's live tab share, with Meet's three audio streams.

## Still to be seen

1. **The picture itself.** Everything above was read from the page, not looked at. The check tool cannot take a screenshot while another extension's frame is on the page. The same module was seen drawn correctly in the automated test against the mock, and a plain test box was seen over the real slideshow in the spike.
2. **A transparent placeholder.** A shape with no fill and no outline should still report its rectangle. Not yet tried on a real one.
3. **A real key in Presenter view.** The notes-window hotkeys have been driven by script only. Press `T` there by hand once.
4. **A phone in the hand.** On 10 October the phone page went through a whole round in Mobile Safari on the iOS Simulator (iPhone 17, iOS 26.5), against the live site and the live relay: the link from the join slide, a name, the waiting screen, a question answered with twelve seconds left, "Correct", and the leaderboard. `node test/host-room.mjs` hosted the room. Still untried: a physical phone, the camera reading the QR code, and mobile data.

## A note for whoever tests this next

Claude's browser extension cannot run script, press keys or take screenshots in a tab while Tally's stage is mounted: it refuses with "Cannot access a chrome-extension:// URL of different extension". Calls that do get through can return misleading answers. Record from inside the page (a timer writing to `localStorage`), then read the record after the slideshow ends.
