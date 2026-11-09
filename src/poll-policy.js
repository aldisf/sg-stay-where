import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
