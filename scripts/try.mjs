// Everything needed to try Pop Quiz for real before it has a site of its own:
// serves the phone page, and the installer, to phones and Macs on the same
// Wi-Fi, and says what to do. See TESTING.md.
//   npm run try
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const port = +process.env.PORT || 8790;
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
// Wi-Fi first (en0 on a Mac), then any other private address.
const nets = networkInterfaces();
const ips = Object.entries(nets)
  .sort(([a], [b]) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0))
  .flatMap(([, list]) => list || [])
  .filter((i) => i.family === 'IPv4' && !i.internal)
  .map((i) => i.address);
const join = ips.length ? `http://${ips[0]}:${port}/` : null;

await import('./serve.mjs');

const line = '─'.repeat(64);
const site = join ? join.replace(/\/$/, '') : '<this Mac’s Wi-Fi address>';
console.log(`
${line}
 Pop Quiz, ready to try
${line}

 1. Put it in Chrome, once.
    On THIS Mac: chrome://extensions, Developer mode on, Load unpacked:
      ${app}
    On ANOTHER Mac on this Wi-Fi: open ${site}/get/ there and follow
    it, or paste this into its Terminal:
      curl -fsSL ${site}/get/popquiz.sh | POPQUIZ_SITE=${site} sh
    Then Load unpacked the folder it names (~/PopQuiz/app).

 2. Open a Google Slides deck, click the Pop Quiz icon, then the gear.
    Under "Where phones join", set the Join address to:
      ${join || '(no Wi-Fi address found: is this Mac on Wi-Fi?)'}

 3. Phones must be on the same Wi-Fi as this Mac. Mobile data won't
    reach it. They scan the QR code on your Join screen as normal.

 Keep this running while you test. Ctrl+C stops it.
 The full checklist is in TESTING.md.
${line}
`);
