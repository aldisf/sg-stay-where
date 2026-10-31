# Follow-ups and sourcing ownership

WhatsApp ingestion receives permitted property messages continuously. A scheduled
coding agent interprets them; the web server has no language-model runtime.
`Store.recordFollowup(id, input)` owns the whole decision: validate a current
snapshot, verify incoming evidence and its listing-link context, respect manual
choices, then atomically save summary, status and an update record.

```js
const { token, messages } = store.followup(id);
store.recordFollowup(id, {
  token, summary: { text: "Owner declined this enquiry." },
  outcome: "declined", evidence: { chat_jid, msg_id }
});
store.updates(projectId); // newest 100 interpreted changes and unreviewed replies
```

The token hashes status/version and the actual message content, so same-second
arrivals, edits, merges, splits and manual choices invalidate stale work. Manual
choices also fence existing message ingestion IDs. Restoring a home therefore
cannot be reversed by rereading its old refusal. Exact retries are idempotent.

`closed` means this enquiry ended. `unavailable` means the property is no longer
available. `rejected` remains the user's Not interested choice. Cancellation
clears the appointment and returns a scheduled viewing to `replied` (Watching).
Current structured state takes precedence over old viewing hints.

The chosen shape is a small ledger of interpreted changes plus derived incoming
replies. A purely derived feed was considered: it saves a table, but replacing a
summary loses the reason for an earlier closure. The ledger preserves that reason
without copying every raw message or introducing event sourcing. The app shows
only the newest reading per home (one Latest block in the detail sheet, "New"
on the Enquiries row); earlier readings stay in the ledger, off screen. The bounded
feed and opaque read keys came from the derived alternative. Independent review
favoured this shape and exposed merge/privacy and attribution cases now covered
by tests. The attempted cross-family design review timed out; no consensus across
model families is claimed.

Property-link segments scope both display and decision evidence. Ignoring,
unlinking or deleting a source message erases copied interpretations; merged
copies are included in cleanup. No chat text is executed, and no follow-up sends
a WhatsApp message. Ambiguous decisions remain summaries for human review.

Sourcing uses the existing template compiler. `requestSearchBrief` creates a
pending revision; `resolveSearchBrief` checks that revision and a whole-project
version before applying filters and explicit criteria changes together. A missing
fact produces a visible question, leaving current searches intact. Map-related
criterion changes invalidate old route results; labels and weights do not.

Tradeoffs: semantic follow-ups and brief interpretation wait for the scheduled
agent; conservative link attribution can require human clarification; the feed
shows only the latest 100 items. The Everything/status filters still expose
closed listings after privacy erasure removes their conversation history.
