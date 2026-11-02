---
name: one-chat-many-homes
description: Handle a WhatsApp chat in which one property agent discusses more than one home. Use during follow-ups when an agent sends another listing link, offers another unit, or answers about several homes in one message.
---

# One chat, many homes

A chat can be linked to several listings. Each listing sees only its own part of
the chat: from the latest message that links to it until a link to another home.

1. **Read each home separately.** `GET /api/listings/:id/follow-up` returns only
   that home's part. Summarise it as its own enquiry; don't carry another home's
   viewing, price or refusal across.
2. **Another link in the chat** starts that home's part. If the home isn't
   tracked yet, it stays out until the user adds it (pasting the link in the app,
   or the agent importing that listing page).
3. **Another unit offered without a link** ("I also have Blk 240, want to see?")
   stays inside the current home's part. Mention it in the summary ("Agent also
   offered Blk 240") and in the poll report. Never change the current home's
   status because of it.
4. **One message about several homes** ("both are available Saturday 3pm"):
   save a summary for each home it clearly names. The server refuses a status
   change when the subject is ambiguous; save the summary without the status.
5. **Tracking an offered unit** is the user's call. When they want it: find the
   listing on the site, import it, then link the chat:
   `node src/cli.js api POST /api/chats/<jid>/link '{"listingId": <id>}'`. Later
   replies need a link to start that home's part; the user can ask the agent for
   it. You never message the agent.
6. **Same agent is not same flat.** Never merge two listings because one agent
   handles both.
