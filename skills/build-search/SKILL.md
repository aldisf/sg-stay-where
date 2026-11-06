---
name: build-search
description: Build or repair a listing-site search for sg-stay-where in the user's own Chrome, by setting the site's own filters and saving the address bar. Use for every buying project, for rental filters the search template can't express (property type, MRT station, tenure), and when a saved search returns no cards or ignores a filter because a site changed its URLs.
---

# Build a search on the site

The tracker polls saved search URLs. Rather than guessing a site's URL
parameters, let the site write the URL: open its search page in the user's
Chrome, set the filters with its own controls, and save what the address bar
shows. This also works when a site renames its parameters.

**When to use it:**
- **Buying projects** (`"deal": "buy"`). The search template only builds rental
  searches, so every buying search is built this way.
- **Renting, when the template can't express a filter**: HDB only, one MRT
  station, a project, PropertyGuru's floor or furnishing filters.
- **Recovery.** A search returns `no listing cards found`, or its results ignore
  a filter, such as prices outside the range or the wrong property type.

## Rules

- Use the user's own Chrome, in one tab, at browsing pace. If a page needs a
  human (a CAPTCHA that doesn't clear by itself, or a login), stop and tell the
  user. Never work around it. Cloudflare's "Just a moment" page clears in
  5–10 s; wait, don't click.
- Never fetch listing sites from the server or a script.
- Never invent filters. Use what the interview recorded
  (docs/setup-interview.md); ask the user when something is missing.

## Steps

1. **Read the project**: `node src/cli.js api GET /api/state?project=<id>`. Note
   `project.deal`, the budget, home type, areas and districts, and any existing
   searches.
2. **Open the site's search page** for that deal (starting points are below).
3. **Set the filters with the site's controls**, not by editing the URL: price
   range, property type (HDB, condo or EC, landed), bedrooms, area, and tenure
   when the site has it. Filter panels change as you choose: on PropertyGuru,
   picking HDB adds a sub-type row (an HDB 4-room is the usual 3-bedroom flat),
   so look again after every click. Then read the address bar. The server sorts
   it newest first and drops any page number it carries, because polls read only
   the first pages and add their own.
4. **Check it with the site's reader** on page 1 (docs/polling.md step 1.2 shows
   how to load `pgExtract`, `n99Extract` or `cxExtract`). There must be cards
   (`r.listings.length > 0`), prices inside the range, and types that match. If
   not, adjust the filters and check again.
5. **Save it.**
   - **One search:** `node src/cli.js api POST /api/projects/<id>/searches '{"title":"PropertyGuru · 4-room HDB, east","url":"<address bar>","pages":5}'`
   - **A set that replaces earlier ones** (one per site, keeping each one's
     on/off switch): send them in a sourcing plan as `searches`
     (docs/sourcing.md):
     `[{ "url": "…", "title": "…", "districts": ["D16","D18"], "why": "99.co has no district filter" }]`.
     Give `districts` to a 99.co search so its reader keeps only cards in them,
     by postal code.
6. **Tell the user** what each search covers and what the site couldn't filter.
   They switch searches on and off in the Searches tab.

## Repairing a broken search

1. Open the saved URL and see what the site does with it: an error page, all of
   Singapore, a dropped filter.
2. Rebuild it with steps 3–4, then update it:
   `node src/cli.js api PATCH /api/projects/<id>/searches/<search id> '{"url":"<new address bar>"}'`.
3. A rental **template** search (its `template` is `main` and the project is
   renting) gets its URL from `src/searches.js`. Fix the builder there to match
   the URL the site produced, update `test/searches.test.js` with that URL, and
   re-apply the template. If you aren't sure, save the hand-built URL as its own
   search, switch the broken one off, and tell the user.
4. If the URL is right but the reader returns nothing, the page changed instead:
   follow `skills/repair-reader`.

Done this way on 31 Oct 2026 for a buying project (HDB 4-room, 3 bedrooms,
S$500–800k on PropertyGuru): the site wrote
`property-for-sale?listingType=sale&isCommercial=false&minPrice=500000&maxPrice=800000&propertyTypeGroup=H&propertyTypeCode=4A&…&bedrooms=3`;
page 1 read 25 HDB 3-bedroom cards at S$505k–780k, and a poll took one through
details and Google Maps into Review.

## Starting points (checked in Chrome, 31 Oct 2026)

| Site | Renting | Buying |
| --- | --- | --- |
| PropertyGuru | `https://www.propertyguru.com.sg/property-for-rent?listingType=rent&isCommercial=false&minPrice=…&maxPrice=…` | `https://www.propertyguru.com.sg/property-for-sale?listingType=sale&isCommercial=false&minPrice=…&maxPrice=…` |
| 99.co | `https://www.99.co/singapore/rent?main_category=all&property_segments=residential&price_range=MIN,MAX` | `https://www.99.co/singapore/sale?main_category=all&property_segments=residential&price_range=MIN,MAX` |
| Carousell | `https://www.carousell.sg/categories/property-102/rent-in-singapore-229/?price_start=…&price_end=…` | `https://www.carousell.sg/categories/property-102/property-for-sale-230/?price_start=…&price_end=…` |

These are only starting points. Add the rest of the filters with each site's own
controls. 99.co has no district filter, so use `districts`. Carousell filters
price and bedrooms only; the skip rules and postal codes do the rest once each
listing page is read.
