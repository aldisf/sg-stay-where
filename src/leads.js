// Message text is untrusted agent input; it is matched, never executed.
// What the text says about a lead; what that does to the status is src/lifecycle.js.

const VIEWING_RE = /\b(view(ing)?s?|visit|see the (unit|place|house|flat|apartment)|come (down|by|over)|show you)\b/i;
const WHEN_RE = /\b(\d{1,2}(:\d{2})?\s?(am|pm)|\d{1,2}[:.]\d{2}|tmr|tomorrow|today|tonight|this (morning|afternoon|evening|weekend)|(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?|\d{1,2}\/\d{1,2}|\d{1,2}(st|nd|rd|th)?\s(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i;
const UNAVAILABLE_RE = /^\s*(sorry[,.]?\s*)?(it['’]?s\s+|unit\s+)?taken\b|\b(is|been|already|got)\s+taken\b|\btaken already\b|\b(rented out|no longer available|not available anymore|has been let|got a tenant|found a tenant|under offer|off the market)\b|\b(rec['’]?d|received|collected|taken)\s+(a\s+|the\s+)?deposit\b|\b(it['’]?s|is|has been|been|already|got)\s+sold\b|\bsold already\b|\b(granted|exercised|issued)\b.{0,30}\boption\b|\b(option|otp)\b.{0,30}\b(granted|exercised|issued|signed)\b/i;

const DAY = 24 * 60 * 60;

// Listing sites' WhatsApp enquiry bots (PropertyGuru: replies with the
// agent's contact link; 99.co: "the agent will be in touch"). Not agents.
const PORTAL_BOT_RE = /This is PropertyGuru\b|Thank you for your enquiry\.?\*?\s*WhatsApp the agent directly|propertyguru\.com\.sg\/contact-agent\/|The agent will be in touch with you very soon/i;

export function isPortalBotMessage(message) {
  return !message.from_me && !message.fromMe && PORTAL_BOT_RE.test(message.text ?? "");
}

function excerpt(text, max = 160) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// messages: [{ from_me, ts (unix seconds), text }]
export function leadSignals(messages, now = Date.now() / 1000) {
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  const firstOut = sorted.find((m) => m.from_me);
  const contactedAt = firstOut?.ts ?? null;
  const reply = sorted.find((m) => !m.from_me && contactedAt != null && m.ts >= contactedAt);
  const last = sorted.at(-1) ?? null;

  // Our own intro asks for a viewing, so only talk after the agent replied counts.
  const afterReply = reply ? sorted.filter((m) => m.ts >= reply.ts) : [];
  const viewingMsg = [...afterReply].reverse().find((m) => VIEWING_RE.test(m.text ?? ""));
  const latestIncoming = sorted.findLast(m => !m.from_me && !m.via_portal);
  const unavailableMsg = latestIncoming && !/[?]|\b(not|never|isn't|isnt|hasn't|hasnt)\b/i.test(latestIncoming.text ?? "") && UNAVAILABLE_RE.test(latestIncoming.text ?? "") ? latestIncoming : null;

  const awaitingReply = !!last?.from_me && (!reply || last.ts > reply.ts);
  return {
    messageCount: sorted.length,
    contactedAt,
    repliedAt: reply?.ts ?? null,
    lastAt: last?.ts ?? null,
    lastFromMe: last ? !!last.from_me : null,
    lastText: last ? excerpt(last.text) : null,
    awaitingReply,
    followUp: awaitingReply && now - last.ts > 2 * DAY,
    viewing: viewingMsg ? {
      ts: viewingMsg.ts,
      seq: viewingMsg.received_seq ?? null,
      fromMe: !!viewingMsg.from_me,
      withTime: WHEN_RE.test(viewingMsg.text ?? ""),
      text: excerpt(viewingMsg.text)
    } : null,
    unavailable: unavailableMsg ? { ts: unavailableMsg.ts, seq: unavailableMsg.received_seq ?? null, text: excerpt(unavailableMsg.text) } : null
  };
}
