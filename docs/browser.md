# Why it needs browser automation

The listing sites and Google Maps only work properly in a real browser on your
own connection, so sg-stay-where uses your Chrome instead of scraping from a server.

## Listing sites block servers

PropertyGuru, 99.co and Carousell sit behind bot protection (Cloudflare). A request from a
script or a headless browser gets `403` or a challenge page; the same page opens
normally in your everyday Chrome. So the tracker never fetches listings itself.
Instead:

1. Your agent opens a search or listing page **in your Chrome** with a browser
   tool (Claude in Chrome, or Codex's Chrome extension).
2. A small extractor (`browser/propertyguru.js`, `browser/99co.js`,
   `browser/carousell.js`) reads the data already on the page (PropertyGuru's
   embedded page data, 99.co's and Carousell's structured data) with photos, facts and the agent's number.
   If 99.co ever stops sending the number to signed-out visitors, the extractor
   returns `agent_phone: null`: sign in to 99.co in the same Chrome and re-run it
   on that listing page.
3. The result is handed to the tracker through `http://127.0.0.1:7431/import#…`
   (the data rides in the URL fragment, which never leaves your machine).

The same extractor works as a **bookmarklet** (Project tab) when you're browsing
by hand: on a listing, click it and the listing is imported with the agent's
number.

This keeps the load identical to you browsing: a few result pages per
search per poll, every 2 hours at most, one tab on the listing sites, no parallel crawling, no
proxies, no captcha solving. At a CAPTCHA or "are you human" page the poll skips
the search and never works around it.
It is still automated access to someone else's website; their terms apply (see
the README's "Risks and responsible use").

## Google Maps in the browser

Straight-line distance says little about Singapore commutes. A flat 2 km from
the office can be 12 minutes by MRT or 40 with two transfers. In your browser,
Google Maps gives:

- **Transit time at a fixed departure** (the next weekday at 08:30 by default, per
  commute criterion), not "leave now" at midnight.
- **Walking time to the nearest station**, and whether a bus beats the walk.
- **The nearest gym/hawker centre/laundromat** for each "nearby" criterion, with a
  routed walking time.

No API key or billing account is needed; it's the same Maps you use. (Google's
Distance Matrix API would do this server-side, but it needs a paid key.) Keep it
to the handful of lookups per listing the playbook describes; Google's terms
forbid bulk extraction.

## Which tools work

| Tool | Status |
| --- | --- |
| **Claude Code + Claude in Chrome** (`claude --chrome`) | Tested end to end; the default for `npm run poll`. |
| **Codex + the Codex Chrome extension** | `npm run poll` runs it with `SSW_AGENT=codex`. Setup: [polling.md](polling.md#give-the-agent-your-own-chrome). |
| Headless browsers, cloud browsers, server-side fetch, scraping APIs | Blocked by the sites, or another IP; not supported. |

You can also skip automation entirely and use the bookmarklet while browsing,
with the agent doing the Google Maps checks on request.
