// `ssw privacy`: what the WhatsApp filter let into the local database. Prints
// positions, link hosts and counts; never message text, names or numbers.
import { findPropertyLinks } from "./links.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const REASONS = {
  personal: "personal (more messages than allowed before the first link)",
  excluded: "excluded (a name in excludeNames)",
  manual: "Not an agent (your choice in Enquiries or a listing's chat)"
};

export function privacyReport(store, { maxMessagesBeforeLink = 10, excludeNames = [] } = {}) {
  const lines = [];
  const problems = [];
  const chats = store.listChats();
  const tracked = { isTracked: (key) => Boolean(store.findListingByKey(key)) };
  const total = chats.reduce((n, c) => n + c.message_count, 0);
  lines.push(`Rule: one-to-one chats whose first PropertyGuru or 99.co link (or tracked Carousell listing's link) is within the first ${maxMessagesBeforeLink} messages. Names in excludeNames: ${excludeNames.length}.`, "");

  lines.push(`Stored property chats: ${chats.length} (${plural(total, "message")})`);
  chats.forEach((chat, i) => {
    const messages = store.chatMessages(chat.jid);
    const at = messages.findIndex((m) => findPropertyLinks(m.text, tracked).length);
    const link = at < 0
      ? `no link stored (${chat.flag_reason?.startsWith("intro") ? "started by your intro" : "flagged earlier"})`
      : `first link at message ${at + 1} (${new URL(findPropertyLinks(messages[at].text, tracked)[0].url).hostname})`;
    const listings = chat.listing_ids.length ? `, listings ${chat.listing_ids.join(", ")}` : "";
    lines.push(`  ${i + 1}. ${chat.kind ?? "agent"} chat, ${plural(messages.length, "message")}, ${link}${listings}`);
    if (at > maxMessagesBeforeLink) problems.push(`chat ${i + 1} has ${at} messages before its first link`);
  });

  const census = store.chatCensus();
  lines.push("", `Ignored chats, nothing stored: ${census.ignored.reduce((n, r) => n + r.n, 0)}`);
  for (const { reason, n } of census.ignored) lines.push(`  ${REASONS[reason] ?? reason}: ${n}`);

  const dropped = Object.values(store.get("wa.dropped_counts", {}));
  const bucket = (lo, hi) => dropped.filter((n) => n >= lo && n <= hi).length;
  lines.push("", `Dropped chats, no listing link, only a message count kept: ${plural(dropped.length, "chat")}, ${plural(dropped.reduce((a, b) => a + b, 0), "message")}`);
  if (dropped.length) lines.push(`  1-10 messages: ${plural(bucket(1, 10), "chat")}; 11-100: ${plural(bucket(11, 100), "chat")}; over 100: ${plural(bucket(101, Infinity), "chat")}`);

  if (census.outside) problems.push(`${census.outside} messages stored for chats that are not property chats`);
  lines.push("", problems.length
    ? `Check failed:\n  ${problems.join("\n  ")}`
    : "Check passed: every stored chat is a property chat that starts at its listing link.");
  lines.push("No message text, names or phone numbers were printed.");
  return { ok: !problems.length, text: lines.join("\n") };
}
