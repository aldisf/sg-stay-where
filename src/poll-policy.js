import { existsSync, readFileSync, writeFileSync } from "node:fs";

// A listing no search page has shown for this long may be gone, so polls reopen it.
export const RECHECK_AFTER_MS = 3 * 86_400_000;
const DONE = ["rejected", "closed", "unavailable"];

// Still to decide on and not seen lately. From "contacted" on, the agent's chat
// says whether it is still available.
export function needsRecheck(listing, now = Date.now()) {
  if (!["new", "shortlisted"].includes(listing.status) || listing.merged_into || !listing.details_at || !listing.enriched_at) return false;
  return now - Date.parse(listing.seen_at ?? listing.details_at) > RECHECK_AFTER_MS;
}

export const detailDue = (listing, now = Date.now()) =>
  !listing.merged_into && !DONE.includes(listing.status) && (!listing.details_at || needsRecheck(listing, now));

// Grants have jitter rather than allowing a burst at the minute boundary. The
// ledger survives server restarts and is shared by projects and poll workers.
export class PortalPacer {
  constructor(file, clock = Date.now, random = Math.random) { this.file = file; this.clock = clock; this.random = random; }

  permit(site, rpm) {
    const ledger = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    const now = this.clock();
    const previous = ledger[site];
    const interval = 60_000 / rpm;
    const wait_ms = previous == null ? 0 : Math.max(0, Math.ceil(Math.max(previous.ready_at, previous.at + interval) - now));
    if (wait_ms) return { allowed: false, wait_ms, rpm };
    ledger[site] = { at: now, ready_at: now + Math.ceil(interval * (1 + this.random() / 2)) };
    writeFileSync(this.file, JSON.stringify(ledger));
    return { allowed: true, wait_ms: 0, rpm };
  }
}
