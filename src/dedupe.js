// When the user marks a listing "Not interested", its repeats (the same flat,
// usually from another agent) are hidden with it, now and when a poll imports them.

import { photoMatches } from "./photohash.js";

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function samePlace(a, b) {
  const na = norm(a.building);
  const nb = norm(b.building);
  if (na && nb && (na === nb || (Math.min(na.length, nb.length) >= 8 && (na.includes(nb) || nb.includes(na))))) return true;
  // ~70 m: the same block or condo, whatever each agent called it.
  return a.lat != null && b.lat != null && Math.abs(a.lat - b.lat) < 0.00065 && Math.abs(a.lng - b.lng) < 0.00065;
}

const plausible = (sqft) => sqft && sqft > 100 && sqft < 5000;

// Every block in Singapore has its own postal code, and an address line starts
// with the block or house number ("45 Normanton Park", "Blk 123 Bishan St 12").
// In a big condo, two blocks share a name, a size and a price; these tell them apart.
const postalOf = (l) => String(l.postal ?? "").match(/^\d{6}$/)?.[0] ?? String(l.address ?? "").match(/\b(\d{6})\b/)?.[1] ?? null;
function blockOf(l) {
  for (const segment of [l.address, l.street, l.building].flatMap((s) => String(s ?? "").split(/[,|]/))) {
    const m = segment.trim().match(/^(?:blk|block)?\s*(\d{1,4}[a-z]?)\s+(?=[a-z])/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}
const differ = (x, y) => x != null && y != null && x !== y;
const otherBlock = (a, b) => differ(postalOf(a), postalOf(b)) || differ(blockOf(a), blockOf(b));

// Price gaps are rent-sized in S$; a purchase price (S$100k and up) gets the
// same idea as a share of the price.
function near(a, b, rent, share) {
  const top = Math.max(a, b);
  return Math.abs(a - b) <= (top >= 100000 ? top * share : rent);
}

export function sameUnit(a, b) {
  if (!a || !b || a.id === b.id || !samePlace(a, b) || otherBlock(a, b)) return false;
  if (a.price && b.price && !near(a.price, b.price, 300, 0.005)) return false;
  if (plausible(a.sqft) && plausible(b.sqft)) return Math.abs(a.sqft - b.sqft) / Math.max(a.sqft, b.sqft) <= 0.08;
  return a.bedrooms != null && a.bedrooms === b.bedrooms;
}

// Agents upload the same photo set to every site, but one pool or facade shot is
// common to many units of a condo, so 2 shared photos also need the same place
// and a similar size. Stricter than sameUnit, because the copy is merged away
// even when nobody hid the original.
export function sameListing(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.bedrooms != null && b.bedrooms != null && a.bedrooms !== b.bedrooms) return false;
  const place = samePlace(a, b);
  const shared = photoMatches(a.photo_hashes, b.photo_hashes);
  const closePrice = a.price == null || b.price == null || near(a.price, b.price, 500, 0.01);
  const closeSize = !plausible(a.sqft) || !plausible(b.sqft) || Math.abs(a.sqft - b.sqft) / Math.max(a.sqft, b.sqft) <= 0.1;
  if (closePrice && (shared >= 3 || (shared >= 2 && place && closeSize))) return true;
  if (!place || otherBlock(a, b) || a.price == null || b.price == null) return false;
  if (plausible(a.sqft) && plausible(b.sqft)) return near(a.price, b.price, 100, 0.002) && Math.abs(a.sqft - b.sqft) / Math.max(a.sqft, b.sqft) <= 0.03;
  return near(a.price, b.price, 50, 0.001);
}

// A ranking for the "Same flat as…" picker, not a decision (sameListing is).
export function likeness(a, b) {
  const reasons = [];
  let score = 0;
  const shared = photoMatches(a.photo_hashes, b.photo_hashes);
  if (shared) { score += Math.min(60, shared * 25); reasons.push(`${shared} shared photo${shared === 1 ? "" : "s"}`); }
  if (samePlace(a, b)) { score += 30; reasons.push("same building"); }
  if (a.bedrooms != null && a.bedrooms === b.bedrooms) { score += 5; reasons.push(a.bedrooms === 0 ? "both studios" : `both ${a.bedrooms} bed`); }
  if (a.bedrooms != null && b.bedrooms != null && a.bedrooms !== b.bedrooms) score -= 40;
  if (a.price != null && b.price != null) {
    const gap = Math.abs(a.price - b.price);
    if (gap <= 50) { score += 10; reasons.push(gap ? `price within S$${gap}` : "same price"); } else if (gap <= 300) score += 4;
  }
  if (plausible(a.sqft) && plausible(b.sqft)) {
    const diff = Math.abs(a.sqft - b.sqft) / Math.max(a.sqft, b.sqft);
    if (diff <= 0.03) { score += 10; reasons.push(diff ? "same size (±3%)" : "same size"); } else if (diff <= 0.1) score += 4;
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export function pickPrimary(a, b) {
  // A listing the poll skipped by itself ("Auto-skipped…") wasn't acted on by the user.
  const acted = (l) => l.status !== "new" && !/^Auto-skipped/.test(l.notes ?? "");
  const rank = (l) => (acted(l) ? 4 : 0) + (l.details_at ? 1 : 0) + (l.enriched_at ? 1 : 0);
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? [a, b] : [b, a];
  return Date.parse(a.created_at ?? 0) <= Date.parse(b.created_at ?? 0) ? [a, b] : [b, a];
}

// The poll's auto-skips are about the kind of listing, not this flat.
export function hiddenByUser(listing) {
  return listing.status === "rejected" && !/^Auto-skipped/.test(listing.notes ?? "");
}
