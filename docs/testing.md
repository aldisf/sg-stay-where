# Browser testing

```sh
npm ci
npx playwright install chromium webkit
npm test
npm run test:e2e
npx playwright show-report
```

Playwright starts a fresh fictional demo database and server for each test,
including retries. Servers bind to loopback on ports 17432 onward (`SSW_E2E_PORT`
moves the base, so two checkouts can test at once). Temporary
data is removed after each test. The fixture never reads the user's `data/`
directory or connects WhatsApp. It fails if its port is occupied instead of
reusing another server.

The suite uses the real UI, API, SQLite and MapLibre renderer. It replaces
external tiles with a minimal map style and replaces fonts and embeds with
empty responses. No tests visit listing portals or send messages. Screenshots
and traces contain fictional demo data only.

## Coverage

- Review, Watch, hide and Undo, including persistence after reload.
- Review badge and header count equal the listings the deck deals under a filter.
- Search, filter reset, price ordering and matching map pins.
- Rejected listings stay out of Everything and the map.
- Detail and photo dialogs, keyboard focus, notes and browser Back/Forward.
- Closing a sheet while its request is pending.
- Failed startup and Retry.
- Failed decisions restore the card even if refreshing is also offline.
- Merge and Undo remain reachable inside the detail dialog.
- Saving search switches and switching between separate projects.
- Short, vertical, cancelled and completed card gestures.
- Watching rows: status pill and no action button; a short or slow half drag
  springs back with no PATCH; a full drag (touch, and mouse on desktop), a fast
  fling and a reduced-motion drag each send one PATCH to rejected with Undo.
- Real Chromium touch input: scrolling, swiping and unchanged browser history.
- Map and marker movement during page scrolling, navigation and dialog stacking.
- The Detailed map switch: liberty style requested, pins kept, choice remembered
  after reload, theme changes ignored while Detailed, back to Simple in dark.
- Narrow 360px layouts, dark theme and reduced motion across every tab.
- Marker reuse, inactive tabs remaining unrendered, static gzip and ETags.

Profiles are desktop Chromium, Android-sized Chromium and iPhone-sized WebKit.
Browser-specific cases are skipped on profiles where they do not apply.

## Real map check

```sh
SSW_LIVE_MAP=1 npm run test:e2e -- --project=iphone --grep captures --workers=1 --output=test-results-live
```

This allows OpenFreeMap requests while keeping all application data fictional.
Inspect the resulting viewport screenshot; successful HTTP requests alone do
not prove tiles rendered. A live WebKit screenshot was inspected on 2026-10-28.
On 2026-10-30 live WebKit (390x844) and Chromium (1440x900) screenshots of the
Detailed map over Tiong Bahru at zoom 17.5 showed building footprints and HDB
block numbers; `queryRenderedFeatures` on the `housenumber` layer returned them.
The e2e stub style has no OpenMapTiles source, so the suite cannot see them.

## Performance evidence

`test/e2e/assets.spec.js` alternates raw and gzip requests to the real server
five times. Each gzip body is decompressed and compared byte-for-byte with the
raw response. Each conditional request must return 304 with an empty body.
The report includes `transfer-bytes.json` with every run.

Measured on 2026-10-31 with MapLibre 6.16.0:

| Response body | Median bytes | Range over five runs |
| --- | ---: | ---: |
| Uncompressed map script | 1,108,049 | 1,108,049–1,108,049 |
| Gzip map script | 295,254 | 295,254–295,254 |
| Revalidated map script | 0 | 0–0 |

MapLibre 6 ships as an ES module with its worker in a separate file,
`/vendor/maplibre-gl-worker.mjs` (519,372 bytes, 147,628 gzipped by Node's
default level; not part of the five-run measurement). MapLibre 5.9.0 inlined the
worker in one 954,516-byte script (250,585 gzipped), so a cold load now transfers about
192 KB more gzipped and nothing on a revalidated one.

There were no response or content mismatches. This is a 73.4% reduction in the
map script's response body. Headers, TLS and external map tiles are excluded. It is
not a page-load timing result. Compression runs asynchronously once per file
revision; the cache retains at most 32 assets of up to 2 MB each. APIs and
private media retain `no-store`.

The browser regression test also checks that unchanged markers remain attached
after refresh and that unused views have no listing/search rows. This verifies
the removed rendering work without treating DOM counts as a latency benchmark.

## Remaining checks

On a physical iPhone, swipe from the middle and near either screen edge, scroll
vertically, pinch zoom, open and close a photo, then use browser Back. Safari's
system-edge history gesture is not reproduced by desktop WebKit. Horizontal
card touches are cancelled after direction detection; vertical scrolling and
pinch zoom remain native. No app code pushes a history entry for a decision.
Also swipe a Watching row left slowly past the trash zone and let go (it must
spring back), then all the way (it must leave with Undo); the 75% point, the
fling speed and the spring are tuned on desktop WebKit and Chromium only.

`npm audit` reported 0 vulnerabilities on 2026-10-31 after the upgrade to
MapLibre 6.16.0 and sharp 0.35.5. Photo fingerprints from sharp 0.35.5 matched
0.34.5 bit for bit on nine test images, so hashes stored before the upgrade
still compare.

Follow-up coverage also exercises evidence-bound refusals, manual restoration,
same-second and edited messages, cancelled viewings, merged-chat privacy cleanup,
property attribution, unread updates and revisioned search briefs. The browser
suite covers Enquiries (one row per home, one Latest block in the sheet even after
two readings, an outcome or later reply shown in that block, "New" cleared on open, the
collapsed Ended section, old Viewings/Chats/Updates addresses), copying the
intro without WhatsApp, Watch again, cancellation, brief-to-template application,
320px toast alignment, and vibration invocation only after a committed gesture.
Vibration spies verify the call; they do not establish physical-device support.
