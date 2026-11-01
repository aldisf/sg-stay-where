# Setup interview

The agent runs this with the user before writing `data/projects/<id>.json`. Ask a
few questions at a time, offer choices (use a multiple-choice tool when you have
one), repeat back what you heard, and only then write the file. Skip what the
user already told you. Never invent answers; leave a field out instead.

## 1. The project

- **What should we call this search?** e.g. "2026 Rent", "Parents' HDB". One
  project per search effort; the user can add more later from the app's header.
- **Renting or buying?** Sets the project's `deal` (`"rent"` or `"buy"`). Buying
  projects show whole prices, use a buyer's intro (section 7) and build their
  searches on the sites (section 5). Leave out the furnishing and rental-lease
  criteria for buying; a new buying project starts without them.

## 2. The home

- **Budget**: the comfortable range (`budget.min`–`budget.max`) and the most
  they'd stretch to (`budget.stretchMax`). Listings above the stretch are flagged.
- **Quote range** in the intro message: listing price ± how much (`budget.spread`,
  default 300 for renting, 20,000 for buying). Example: S$2,800 listed →
  "S$2,500–3,100", never above the stretch.
- **Buying**: property type (HDB resale, condo, EC, landed), tenure
  (freehold or leasehold, and the least lease left they'd accept), and whether
  the purchase depends on selling their current home. Record the answers in
  `home`; tenure goes into the searches where a site can filter it and into the
  user's checks on each listing. Never advise on loans, grants or eligibility.
- **Unit**: whole unit or room; studio / 1 / 2 / 3 bedrooms; property types (HDB,
  condo, apartment, landed). Used to build the searches; `home` records it.
- **Furnishing**: does unfurnished rule a place out? (furnishing criterion,
  must-have "not unfurnished" by default).
- **Move-in window** (`move_in.from`/`to`, "YYYY-MM") and **lease length**
  (`lease.maxYears`).
- **Size**: a size that feels right (`size.goodSqft`) and too small (`smallSqft`).
- **Co-living**: hide co-living operators? (`filters.hideColiving`).

## 3. Places

Each becomes a criterion and an icon on every card.

**Regular trips** (type `commute`) — work, school, a partner's office, parents:

- Label ("Office", "Partner's office", "School"), the address, and when they leave
  (`departAt`, e.g. "08:30"; Google Maps transit uses the next weekday at that time).
- The longest acceptable door-to-door time (`maxMinutes`, must-have) and how
  much it matters (weight).
- Look the address up on Google Maps in the browser and store `query` (the full
  address you searched) plus `lat`/`lng` from the place URL (`!3d<lat>!4d<lng>`).
  A road, estate or building name often opens a list of results (`/maps/search/…`)
  whose URL has no `!3d…!4d…`: open the matching result, or go to
  `/maps/place/<full address>` directly, and read the coordinates from that URL.

**The train** (type `station`): ask all three — the nearest MRT/LRT within how
many minutes (`maxMinutes`, default 15), the longest walk to it in metres
(`maxWalkMeters`, default 1000), and does a short bus ride count instead
(`allowBus`, default yes)?

**Everyday places nearby** (type `nearby`) — walking time to the nearest one:

| Common choice | `search` (Google Maps) | `match` (name filter) | icon |
| --- | --- | --- | --- |
| Hawker centre | `hawker centre` | `hawker\|food cent\|market\|food village\|food court` | `soup` |
| A gym chain | `Fitness First` / `Anytime Fitness` / `ActiveSG gym` | the chain's name | `dumbbell` |
| Laundromat | `laundromat` | — | `washing-machine` |
| Supermarket | `supermarket` | `fairprice\|cold storage\|sheng siong\|giant` | `shopping-cart` |
| Park | `park` | — | `trees` |
| Polyclinic / GP | `polyclinic` or `clinic` | — | `stethoscope` |
| Primary school | the school's name, as `commute` instead | — | `school` |
| Place of worship | its name | — | `church` / `landmark` |
| Dog run | `dog run` | — | `dog` |

Ask for the longest acceptable walk (`maxMinutes`), whether it's a must-have
(`mustHave`, default yes) and how much it matters. Use the `match` filter when
the search returns noise (a "hawker centre" search also returns single stalls).

Icons: any name in `public/icons/` (see AGENTS.md to add more from Lucide). Pick
one the user would recognise at 16 px.

## 4. Priorities

Ask the user to sort the criteria into **must-have** and **nice to have**, and to
rate importance: high / medium / low. Suggested weights: high 15, medium 6,
low 2.5; price usually high (15–17); station high (13). Weights are relative and
scaled automatically. Bonuses: +10 when every must-have is met, +5 when the
everyday trips (station + nearby places) are all short.

Read the result back as a short table (criterion, rule, must-have, weight) and
adjust until the user agrees.

## 5. Searches

Use the **search template**: one set of filters that becomes the same search on
PropertyGuru, 99.co and Carousell (`src/searches.js`); one interview gives all three. Ask for the price range, bedrooms,
whole unit or room, and the districts (offer the ones on direct MRT lines to the
places they commute to; `DISTRICTS` has the names). Save it from the Searches tab
("Search template" → Apply), or, with the server running and the project file
written:

```sh
node src/cli.js api PUT /api/projects/<id>/templates/main \
  '{"filters":{"minPrice":2500,"maxPrice":3600,"bedrooms":[0,1,2],"wholeUnit":true,"districts":["D01","D02","D09"]},"sites":["propertyguru","99co"],"pages":2}'
```

The user can also give a plain-language brief; use the revisioned plan API in
[docs/sourcing.md](sourcing.md) to apply it with the scoring criteria.

99.co has no district filter, so its search covers all of Singapore and the
extractor keeps only the template's districts (by postal code), within the same
two-page limit. The same flat found on both sites is kept once.

**Buying**: the template only builds rental searches. Build one search per site
with [skills/build-search](../skills/build-search/SKILL.md): set the site's own
for-sale filters in the user's Chrome (price, property type, bedrooms, area,
tenure), check page 1 with the site's reader, and save the address bar. Give a
99.co search the districts to keep, because the site can't filter them.

For anything the template can't express (an MRT line, a property type, a
keyword), build the search **on the site, in the browser**, and add the address
bar as a search. The server sorts it newest first and caps it at two pages:

```sh
node src/cli.js api POST /api/projects/<id>/searches \
  '{"title":"PropertyGuru · HDB near Bishan","url":"https://www.propertyguru.com.sg/property-for-rent?…","pages":2}'
```

More on custom searches and what to do when a portal changes its URLs:
[docs/sourcing.md](sourcing.md#searches-the-template-cant-express).

- Prefer one or two tight searches over many loose ones; each page is a real
  page load in the user's browser.
- Districts tip: pick the districts between the commute places and their
  neighbours; ask whether HDB is fine.
- Skip rules (`skip.titlePatterns`): short-term, room rental, "master room only",
  common room, unless the user wants rooms. `skip.agents` for serviced-apartment
  operators they don't want.

## 6. WhatsApp (optional, recommended)

Always offer it and recommend it, then let the user decide. Say:

1. **What it adds.** Every enquiry tracks itself: who you messaged, who replied,
   viewing times and places, units that are taken. Each home gets one short
   summary of where things stand and what's next, and Enquiries shows who is
   waiting on you. A right swipe can send your intro in one click (you see it
   first).
2. **What to know first.** It links as a WhatsApp "linked device" through
   Baileys, an unofficial client; WhatsApp's terms don't allow unofficial
   clients, and accounts that message in bulk get restricted. This tool sends
   only what the user clicks, never the same message twice to one agent, and
   never replies on its own.
- Privacy: only chats that start with a PropertyGuru/99.co link (or a Carousell
  link to a listing already tracked) are stored.
- **Who will you share listing links with?** (partner, family, friends) → their
  WhatsApp names go in `excludeNames`, so their chats are never read.

Then ask: "Link WhatsApp now?" Only on a yes: they run `npm run whatsapp` in
their own terminal and scan, then `npm start`. On a no, Copy message and Open in
WhatsApp still work, and they can link it later.

## 7. The intro message

Required during setup: swiping right opens the intro for that listing, and
Review shows what's missing until it's complete. Check `GET /api/state`:
`profileMissing` must be empty.
Interview them for: first name, household, residency/pass, lifestyle, move-in,
lease, closing line. Buying: first name, household, residency (citizen, PR or
foreigner, in their words), financing (for example "HDB loan, HFE letter ready"
or "bank loan, in-principle approval"), timeline and a closing line; the intro
then quotes the whole price, not a monthly rent. Never invent these. Show the composed message for a sample
listing (the Project tab previews one, so no real listing is needed yet) and get
a yes before saving it with
`PATCH /api/projects/<id>` `{ "message": {...} }`.

No site needs the user to be signed in: the extractors read the agent's number
from the listing page (99.co masks it on screen but not in its page data, even
for signed-out visitors). If a 99.co listing ever comes back without a number,
ask the user to sign in to 99.co in their Chrome and re-run the extractor.

## 8. Running it

- **Scheduled polls** (optional): every 2 hours with the agent they use
  (`SSW_AGENT=claude|codex`, default `claude`), with skills/schedule-polls. Ask first; it uses their browser while it runs.
- **Phone access** (optional): Tailscale, docs/remote-access.md.

## Summary

Validate (`npm run project -- check <id>`), open the app (the server has been
running since setup step 3), and walk the user through Review (swipe right to see and send the intro to the agent,
or just watch; left if not interested),
Searches (switch on/off) and the Project tab.
