// The listing lifecycle: the statuses, who may move a listing between them, and
// what a poll still owes it. Pure, so the page loads the same module (/lib/lifecycle.js).

// Every listing a poll finds starts in Review ("new"). The user's swipe sends it to
// Watching ("shortlisted") or Not interested ("rejected"); the agent's chat moves
// it along PROGRESS; an enquiry ends in "closed" or "unavailable" (taken).
export const STATUSES = ["new", "shortlisted", "contacted", "replied", "viewing_scheduled", "viewed", "applied", "closed", "rejected", "unavailable"];
export const PROGRESS = STATUSES.slice(0, 7);
export const rank = (status) => PROGRESS.indexOf(status);

export const FOLLOWED = new Set(PROGRESS.slice(1));
export const BEFORE_CONTACT = new Set(PROGRESS.slice(0, 2));
export const CHAT_SET = new Set(["contacted", "replied"]);
export const ENDED = new Set(["closed", "unavailable"]);
export const INACTIVE = new Set([...ENDED, "rejected"]);
export const IN_TOUCH = new Set([...PROGRESS.slice(2), "closed"]);
export const IN_ENQUIRIES = new Set([...FOLLOWED, ...ENDED]);

// Why a listing is rejected. Only the user's own hide also hides the same flat
// from other agents; a poll's skip is about the kind of listing, a repeat follows
// the flat the user hid, and a merged copy lives on in the listing kept.
export const HIDDEN_BY = ["user", "skip", "repeat", "merge"];
export const hiddenByUser = (l) => l.status === "rejected" && l.hidden_by === "user";
export const actedOn = (l) => l.status !== "new" && !["skip", "merge"].includes(l.hidden_by);

// The chat moves a listing forward by itself, but never past "replied" and never
// out of a status the user or an outcome chose.
export function advanceStatus(current, signals) {
  const at = rank(current);
  if (at < 0 || at > rank("replied") || !signals) return current;
  if (signals.repliedAt && at < rank("replied")) return "replied";
  if (signals.contactedAt && at < rank("contacted")) return "contacted";
  return current;
}

// When the chat that moved a listing to contacted or replied is unlinked, it goes
// back to Watching.
export const unlinkedStatus = (current) => (CHAT_SET.has(current) ? "shortlisted" : current);

// Outcomes a reviewed chat can record, each with the statuses it applies to and
// the status it sets. Evidence rules live in Store.recordFollowup.
const OUTCOMES = {
  none: { from: STATUSES, to: (current) => current },
  unavailable: { from: ["new", ...FOLLOWED], to: "unavailable", clearsViewing: true },
  declined: { from: [...FOLLOWED], to: "closed", clearsViewing: true },
  ended: { from: [...FOLLOWED], to: "closed", clearsViewing: true },
  viewing_cancelled: { from: ["viewing_scheduled"], to: "replied", clearsViewing: true },
  viewing_scheduled: { from: [...FOLLOWED].filter((s) => rank(s) < rank("viewed")), to: "viewing_scheduled" },
  viewed: { from: ["viewing_scheduled"], to: "viewed" }
};
export const OUTCOMES_KINDS = Object.keys(OUTCOMES);

export function followupStatus(current, outcome) {
  const rule = OUTCOMES[outcome];
  if (!rule || !rule.from.includes(current)) throw new Error(`Cannot apply ${outcome} to a ${current} listing`);
  return typeof rule.to === "function" ? rule.to(current) : rule.to;
}

export const clearsViewing = (outcome, next) => !!OUTCOMES[outcome]?.clearsViewing || ENDED.has(next);
export const decisionFor = (outcome, next) =>
  clearsViewing(outcome, next) ? "not_viewing" : next === "viewing_scheduled" ? "viewing" : next === "viewed" ? "viewed" : "maybe";

// A poll's direct status edit is only "the listing page is gone". Chat outcomes go
// through recordFollowup with evidence; Review, Watching and Not interested are the user's.
export function pollMaySetStatus(current, next) {
  if (next === current) return true;
  return current !== "rejected" && next === "unavailable";
}

// Two records of one listing meet (a short link resolved to the page already tracked):
// the one further along wins, and an ending or the user's hide wins over progress.
export function foldStatus(kept, folded) {
  if (folded === "rejected") return "rejected";
  if (rank(kept) < 0) return kept;
  if (ENDED.has(folded) || rank(folded) > rank(kept)) return folded;
  return kept;
}

// What a poll still owes a listing: its page ("details"), then Google Maps ("maps").
// Only "ready" listings reach the Review deck.
export const stage = (l) => (!l.details_at ? "details" : !l.enriched_at ? "maps" : "ready");

// A listing no search page has shown for this long may be gone, so polls reopen it.
export const RECHECK_AFTER_MS = 3 * 86_400_000;

// Still to decide on and not seen lately. From "contacted" on, the agent's chat
// says whether it is still available.
export function needsRecheck(l, now = Date.now()) {
  if (!BEFORE_CONTACT.has(l.status) || l.merged_into || stage(l) !== "ready") return false;
  return now - Date.parse(l.seen_at ?? l.details_at) > RECHECK_AFTER_MS;
}

export const inPlay = (l) => !l.merged_into && !INACTIVE.has(l.status);
export const detailDue = (l, now = Date.now()) => inPlay(l) && (stage(l) === "details" || needsRecheck(l, now));
export const mapsDue = (l) => inPlay(l) && stage(l) === "maps" && l.lat != null && l.lng != null;
