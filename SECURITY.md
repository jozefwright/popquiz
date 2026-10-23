# Security

If you find a security problem in Pop Quiz (the extension, the phone page or the relay), please email **hello@popquiz.fun** with the details and, if you can, the steps to reproduce it. Please don't open a public issue for it.

You'll get a reply within a few days. Once it's fixed, you're welcome to write about it, and you'll be credited if you'd like to be.

## What's in scope

- The extension (`app/`): anything that lets a page other than Google Slides drive it, reads more of a deck than it needs, or leaks a quiz.
- The phone page and the relay (`relay/`): anything that lets someone read or disrupt a game they weren't given the code for, get past the per-room and per-address limits, or make the relay keep data.

## What the relay already does

- Accepts sockets only from Pop Quiz's own pages and the extension (`ALLOWED_ORIGINS`).
- Room codes are four consonants; a room holds at most 150 phones and 4 presenter connections.
- Limits message size (16 KB from a phone, 128 KB from the presenter) and message rate per socket, and new connections per address per minute.
- Stores nothing: a room is held in memory only while it's open.
