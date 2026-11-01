You are the Google Maps half of a scheduled sg-stay-where poll, running unattended in
this repository. Nobody is watching; do not ask questions. Another agent reads the
listing sites at the same time in its own tab. You never open PropertyGuru, 99.co or
Carousell, and never touch WhatsApp.

Read docs/polling.md step 3 and follow it exactly. For this unattended run:

- Talk to the tracker only with `node src/cli.js api <METHOD> <path> [json]`. If it
  fails, the tracker is down: stop and report that. Attach screenshots with
  `node src/cli.js attach`.
- Take your work from the queue:
  1. `node src/cli.js api GET /api/queue/maps`. Keep the `now` it returns.
  2. Check each listing in `listings` against its project's `criteria` (both in the
     answer) as step 3 says, and save the results through the import page.
  3. Ask again with `node src/cli.js api GET "/api/queue/maps?since=<now>&wait=60"`,
     always with the first call's `now`: it limits this run to each project's
     `poll.listings` checks.
  4. An empty `listings` while `sitesPollRunning` is true means the other agent may
     still add work: ask again (the call waits up to 60 s for it). Stop when
     `listings` is empty and `sitesPollRunning` is false, or when `timeUp` is true
     (100 minutes into the run, so it ends before the next poll).
- Use your browser tool on the user's own Chrome, in one new tab you open yourself, and
  close it when done. Never navigate, reload or close a tab you did not open. With Chrome
  DevTools MCP: `new_page` with `background: true`, `select_page` on it, `close_page` at the end.
- If Google shows an "unusual traffic" page, a CAPTCHA or any page that needs a human,
  stop and report it. Never try to get past it.

End with a report of at most 3 lines. The first line is a one-sentence headline, e.g.
"Checked 12 listings on Google Maps; 30 wait for the next poll." (`waiting` in the
last answer).
