---
name: repair-reader
description: Fix one of sg-stay-where's site readers (browser/propertyguru.js, browser/99co.js, browser/carousell.js) when a listing site changes its pages. Use when a reader returns kind "none", an error, zero cards on a page that shows listings, or listings missing price, postal code, photos or the agent's number.
---

# Repair a site reader

The readers are plain functions the agent runs inside the user's browser on a
listing site's page. They read the page's structured data and return
tracker-shaped listings. They break when a site moves that data. Fix them
against the live page; never fetch listing pages from the server.

| Reader | Search pages | Listing pages |
| --- | --- | --- |
| `pgExtract` (`browser/propertyguru.js`) | `__NEXT_DATA__` → `props.pageProps.pageData.data.listingsData[].listingData` | `__NEXT_DATA__` `listingData`, `detailsData.metatable`, `contactAgentData`, `listingLocationData` |
| `n99Extract` (`browser/99co.js`) | cards: links to `/singapore/(rent\|sale)/property/…`, card text, JSON-LD `ItemList` | JSON-LD `Product`, the facts line under the `h1`, the agent's `whatsapp_number` in script data |
| `cxExtract` (`browser/carousell.js`) | cards: links to `/p/<slug>-<id>/`, card text | JSON-LD `Product` and `BreadcrumbList`, label/value lines (Postal Code, Estate, Mobile Number) |

## Steps

1. **Rule out the page first.** In the user's Chrome, look at the page. If it
   shows a CAPTCHA, a login wall, an empty search or an error, the reader isn't
   the problem. Stop and tell the user, or fix the search instead
   (`skills/build-search`).
2. **Find what moved.** Run the reader and look at what it returns. Then inspect
   the live page with small JavaScript checks: does the data path still exist
   (`__NEXT_DATA__`, JSON-LD types, link patterns, label text)? Compare a field
   the reader gets wrong with where the page now shows it. Read only what you
   need; don't dump whole pages into the conversation.
3. **Make the smallest change** in that reader. Keep its output shape
   (`{ kind, listings: [...] }` and the field names). Prefer structured data
   (embedded JSON, JSON-LD) over screen text. Keep rent and sale pages both
   working: patterns like `/(rent|sale)/` and prices with or without `/mo`.
4. **Check the edited reader on the live site.** Load the edited source into the
   page the way docs/polling.md step 1.2 describes, then run it on one search
   page and one listing page. Confirm the counts, and that price, type, size,
   postal code and the agent's number come through.
5. **Run `npm test`**, commit on a branch with a message that says what the site
   changed and when you checked it, and tell the user. Don't run a full poll to
   test it; one search page and one listing page are enough.

Keep to the browsing rules while you do this: one tab, a few page loads, and stop
at any human check.
