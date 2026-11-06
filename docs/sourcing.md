# From a conversation to a working search

Describe your home search to your coding agent, or use **Searches → Describe your
search**. The scheduled agent reads the brief on its next run, translates it into
structured filters, and applies those filters to PropertyGuru, 99.co and Carousell. There
is no separate model service in the web server: automatic interpretation requires
the existing poll runner to be installed and working. Pending and clarification
states are visible in Searches.

Sourcing has three layers:

| Requirement | Where it belongs |
| --- | --- |
| Monthly price, bedroom counts, whole unit/room, districts | Portal search template |
| Excluded agents, co-living, room/short-term adverts | Project filters and skip rules |
| Commutes, station access, nearby places, furnishing, move-in, lease | Project criteria, listing details and Google Maps checks |

A commute such as "under 40 minutes to HarbourFront" cannot be represented by a
portal price/location query alone. Keep it as a commute criterion; do not invent
a district boundary as an equivalent. Stable criterion keys preserve the meaning
of earlier checks. Changing a route, place or map requirement invalidates saved
map results and queues fresh checks. Changing weights or labels does not.

1. The compiler generates every portal URL from one filter object, so one
   interview gives searches on PropertyGuru, 99.co and Carousell.
2. 99.co has no district URL filter in this integration. Its extractor filters
   cards by postal district after reading them.
3. Carousell filters only price and bedrooms. Its cards carry no postal code, so
   districts and room-vs-whole-unit are applied when a listing's page is read,
   and those outside leave Review with an "Auto-skipped" note.
4. 99.co and Carousell can miss matching homes beyond the first two pages. The
   two-page budget is the same for every portal; there is no silent extra page.

Captchas or browser disconnection can delay sourcing.

## Agent contract

1. Read `/api/state?project=<id>` and the pending `project.searchBrief`, including
   its `revision` and the returned `projectVersion`. Use the existing project as
   context. A brief changes only the requirements it explicitly addresses.
2. Resolve names/addresses through the user's browser when needed. Put unsupported
   or missing facts into a clarification question. Do not invent household facts,
   edit the introduction, toggle unrelated searches, or create schedules.
3. Apply a complete plan in one request:

```json
{
  "revision": 3,
  "projectVersion": "<from state>",
  "filters": {
    "minPrice": 2500, "maxPrice": 3500,
    "bedrooms": [0, 1, 2], "wholeUnit": true, "districts": ["D03", "D05"]
  },
  "sites": ["propertyguru", "99co", "carousell"], "pages": 5,
  "explanation": "Whole studio to 2BR in D03/D05, up to S$3,500. The commute remains a scored requirement.",
  "project": {
    "budget": {"min": 2500, "max": 3300, "stretchMax": 3500, "spread": 300}
  }
}
```

Send to `PUT /api/projects/:id/search-plan`. The optional `project` fields are
`budget`, `home`, `criteria`, `filters`, and `skip`; supply complete objects/arrays
for fields you change, preserving unrelated values and criterion keys. Update
scoring budget too when the user changes their budget. Do not widen a constraint
silently. `explanation` must say what was applied and what remains a scoring check.

If a needed fact is missing, send `revision`, `projectVersion`, `explanation`, and
`question` instead. Existing searches stay intact. The user can revise the brief
and send it again. If the project or brief changed, the server returns 409;
re-read and reinterpret. Template edits from the UI invalidate pending plans.
Existing search on/off switches survive an applied plan.

For an interactive coding-agent conversation, save the user's request with
`PUT /api/projects/:id/search-brief {"text":"…"}`, then use the same plan
endpoint immediately. Do not make the user hand-write query URLs or JSON.

## Buying

The template builds rental searches only (`PUT …/templates/main` answers 400 for
a buying project). A buying project's searches are built on each site with
[skills/build-search](../skills/build-search/SKILL.md) and saved as links: one
at a time with `POST /api/projects/:id/searches`, or as a set in a sourcing plan
with `searches` instead of `filters`:

```json
{ "revision": 3, "projectVersion": "…", "explanation": "4-room HDB, east, up to S$800k",
  "searches": [
    { "url": "https://www.propertyguru.com.sg/property-for-sale?…", "title": "PropertyGuru · 4-room HDB, east" },
    { "url": "https://www.99.co/singapore/sale?…", "districts": ["D16", "D18"], "why": "99.co has no district filter" }
  ] }
```

Re-applying a plan replaces that set and keeps each search's on/off switch. The
readers handle rent and sale pages on all three sites (checked 31 Oct 2026).

## Searches the template can't express

The template covers price, bedrooms, whole unit or room, and districts. For
anything else the portal can filter (property type such as HDB only, one MRT
station, a specific project, PropertyGuru's floor or furnishing filters), build
the search on the site itself:

1. Open the portal in the user's Chrome and set the filters by hand, or ask the
   user to. Copy the address bar.
2. `POST /api/projects/:id/searches {"title": "PropertyGuru · HDB near Bishan", "url": "<copied>", "pages": 5}`.
   The server adds the newest-first sort (polls read the first pages only),
   accepts 1–5 pages and refuses non-portal URLs.
3. Run the extractor on that page once to confirm it returns cards
   (`r.listings.length > 0`).

The Searches tab shows these as ordinary cards the user can switch on and off.
Re-applying the template never touches them.

## Portal URL changes

[skills/build-search](../skills/build-search/SKILL.md) ("Repairing a broken
search") is the agent's step-by-step for this; [skills/repair-reader](../skills/repair-reader/SKILL.md)
covers pages whose data moved.

Signs: a template search returns `no listing cards found`, or results ignore a
filter (prices outside the range, other districts). The compiler is the single
place that writes portal URLs: `src/searches.js` (`propertyguru()`, `n99()`, `carousell()`).

1. Set the same filters by hand on the portal and compare its URL with the one
   the compiler wrote.
2. Change the builder, then update `test/searches.test.js` with the URL the site
   produced by hand, so the test pins real portal output.
3. Re-apply the template from Searches (on/off switches are kept).

Extractors break the same way when a page's embedded data moves:
`browser/propertyguru.js` reads `__NEXT_DATA__`, `browser/99co.js` reads JSON-LD,
card text and the agent block in the page's script data, `browser/carousell.js`
reads the listing page's JSON-LD and the agent's CEA block. Fix the extractor
against the live page in the user's browser; never fetch portal pages from the
server.
