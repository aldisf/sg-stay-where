import { $, ago, DECISION_LABEL, esc, icon, INACTIVE, SITE, state, STATUS_LABEL, when } from "./core.js";

export const nameOf = (l) => l.building || l.title || l.url.replace(/^https?:\/\/(www\.)?/, "");
export const bedsOf = (l) => (l.bedrooms === 0 ? "Studio" : l.bedrooms ? `${l.bedrooms} bed` : null);
export const subOf = (l) => [l.property_type, bedsOf(l), l.sqft && l.sqft < 5000 ? `${l.sqft} sqft` : null].filter(Boolean).join(" · ") || (l.needsDetails ? "Details pending" : "");
export const foundAgo = (l) => ago(Date.parse(l.created_at) / 1000);
const FOUND_BY = { poll: "found {ago} by a poll", manual: "added {ago}", bookmarklet: "added {ago} with the bookmarklet", import: "added {ago} with the bookmarklet", whatsapp: "found {ago} in a WhatsApp chat" };
export const foundLine = (l) => (FOUND_BY[l.found_by] ?? "found {ago}").replace("{ago}", foundAgo(l));
// "PropertyGuru + 99.co" when the same flat is advertised on both (merged into one card).
export const sitesOf = (l) => ((l.sites ?? []).length > 1 ? l.sites.map((s) => SITE[s] ?? s).join(" + ") : null);
export const thumbOf = (l) => l.photos?.[0]?.src ?? (l.media?.listing ? `/media/${l.id}/${l.media.listing}` : null);

export function slidesOf(l) {
  let photoNo = 0;
  return [
    ...(l.photos ?? []).map((p) => ({ src: p.src, caption: p.kind === "floor plan" ? "Floor plan" : `Photo ${++photoNo}`, remote: true })),
    ...(l.media?.listing ? [{ src: `/media/${l.id}/${l.media.listing}`, caption: "Listing page", remote: false }] : [])
  ];
}

export const criteria = () => state.criteria;
export const criterionOfType = (type) => criteria().find((c) => c.type === type);
export const commutes = () => criteria().filter((c) => c.type === "commute");
export const nearbys = () => criteria().filter((c) => c.type === "nearby");

export function commuteLine(l, c) {
  const trip = l.enrichment?.commute?.[c.key];
  if (trip?.transit_min != null) return `<strong>${esc(trip.transit_min)} min</strong> by transit${trip.km != null ? ` · ${esc(trip.km)} km` : ""}`;
  const s = l.straight?.places?.[c.key];
  return s ? `<span class="muted">${s.km} km away, not checked yet</span>` : `<span class="muted">not checked yet</span>`;
}

export function stationLine(l) {
  const a = l.station;
  if (!a) return `<span class="muted">not checked yet</span>`;
  const how = a.mode === "bus" ? `<strong>${esc(a.minutes)} min</strong> by bus` : `<strong>${esc(a.minutes)} min</strong> walk${a.meters ? ` · ${(a.meters / 1000).toFixed(1)} km` : ""}`;
  return `${esc(a.station)} · ${how}${a.ok ? "" : ` <span class="flag">over limit</span>`}`;
}

// Routed walks come from Google Maps directions; the rest are straight-line estimates.
export function walkText(p, long = false) {
  if (p.walk_min == null) return `${esc(p.meters)} m`;
  return p.routed ? `${esc(p.walk_min)} min${long ? " walk" : ""}` : `~${esc(p.walk_min)} min${long ? " (est.)" : ""}`;
}

export function nearbyLine(l) {
  const f = l.enrichment?.facilities;
  if (!f) return "";
  return nearbys().map((c) => (f[c.key] ? `${esc(c.label)} ${f[c.key][0] ? walkText(f[c.key][0]) : "none close"}` : null)).filter(Boolean).join(" · ");
}

// One chip per criterion: met (ink), missed must-have (amber, dashed),
// not checked yet (faint), or scored but not a must-have (plain).
export function chips(l, { labels = false, mustOnly = false } = {}) {
  return `<div class="crits${labels ? " labelled" : ""}">${l.score.chips.filter((c) => !mustOnly || c.box).map((c) => {
    const unknown = c.value === "?";
    const cls = unknown ? "unknown" : c.ok === true ? "ok" : c.ok === false ? "miss" : "plain";
    const tip = `${c.label}: ${c.detail}${c.box ? ` — must-have: ${c.box} (${unknown ? "not checked" : c.ok ? "met" : "not met"})` : ""}`;
    return `<span class="crit ${cls}" title="${esc(tip)}" aria-label="${esc(tip)}">${icon(c.icon)}${labels ? `<span class="crit-label">${esc(c.label)}</span>` : ""}<span class="crit-val">${esc(c.value)}</span></span>`;
  }).join("")}</div>`;
}

export const allBoxes = (l) => l.score.boxes.length > 0 && l.score.boxesTicked === l.score.boxes.length;
export const statusPill = (l) => `<span class="pill s-${esc(l.status)}">${esc(l.status === "unavailable" && l.gone_at ? "Removed from site" : STATUS_LABEL[l.status] ?? l.status)}</span>`;
// Nothing is known yet about a pasted link: half credit everywhere would read as a real score.
export const unscored = (l) => l.needsDetails && l.needsMaps;
export const scoreTag = (l, cls = "") => unscored(l)
  ? `<span class="score-tag ${cls}" title="Not scored yet: open the listing page with the bookmarklet">–</span>`
  : `<span class="score-tag${allBoxes(l) ? " all" : ""} ${cls}" title="Score out of 100${allBoxes(l) ? " · every must-have met" : ""}">${esc(l.score.total)}</span>`;

export function leadLine(l) {
  const out = [];
  const s = l.summary;
  if (s?.viewing?.at) out.push(`<span class="mark">Viewing ${esc(when(s.viewing.at))}${s.viewing.confirmed === false ? " (tentative)" : ""}</span>`);
  else if (s?.decision) out.push(`<strong>${esc(DECISION_LABEL[s.decision] ?? s.decision)}</strong>`);
  if (l.lead.unavailable) out.push("may be taken");
  if (l.lead.followUp) out.push(`<strong>follow up</strong> (no reply ${ago(l.lead.lastAt).replace(" ago", "")})`);
  else if (l.lead.awaitingReply) out.push("waiting for reply");
  else if (l.lead.repliedAt) out.push(`agent replied ${ago(l.lead.repliedAt)}`);
  else if (l.lead.contactedAt) out.push(`messaged ${ago(l.lead.contactedAt)}`);
  if (l.summaryStale) out.push(`<span class="muted">new messages</span>`);
  return out.join(" · ") || `<span class="muted">${l.chats.length ? "Chat linked" : "Not contacted"}</span>`;
}

export function statusSelect(l) {
  return `<select class="status" data-id="${l.id}" aria-label="Status">${state.statuses.map((s) => `<option value="${s}"${s === l.status ? " selected" : ""}>${esc(STATUS_LABEL[s] ?? s)}</option>`).join("")}</select>`;
}

// New listings ("To review") live only in the review deck until swiped.
export function filtered({ review = false } = {}) {
  const status = review ? "new" : $("#filter-status").value;
  const sort = $("#sort").value;
  const withinBudget = $("#filter-budget").checked;
  const stationOnly = $("#filter-station").checked && criterionOfType("station");
  const hideColiving = $("#filter-coliving").checked;
  const query = $("#listing-query").value.trim().toLocaleLowerCase();
  const ceiling = state.project.budget?.stretchMax || state.project.budget?.max || Infinity;
  const key = (l) => {
    if (sort === "score") return -l.score.total;
    if (sort === "price") return l.price ?? Infinity;
    if (sort === "activity") return -(l.lead.lastAt ?? 0);
    return -Date.parse(l.created_at);
  };
  // Not interested shows only when asked for by name, never under Everything.
  const byStatus = state.listings.filter((l) => !l.merged_into && (status === "*" ? l.status !== "rejected" : status ? l.status === status : !INACTIVE.has(l.status) && l.status !== "new"));
  const rows = byStatus
    .filter((l) => !query || [nameOf(l), l.address, l.district, l.agent_name].some((v) => v?.toLocaleLowerCase().includes(query)))
    .filter((l) => !withinBudget || l.price == null || l.price <= ceiling)
    // Unknown station access stays visible until it has been checked.
    .filter((l) => !stationOnly || !l.station || l.station.ok)
    .filter((l) => !hideColiving || !l.coliving)
    .sort((a, b) => key(a) - key(b));
  // The deck only deals listings the poll has finished (page details and Google
  // Maps); the rest stay out of sight until then.
  const shown = review ? rows.filter((l) => !l.needsDetails && !l.needsMaps) : rows;
  shown.filteredOut = byStatus.length - rows.length;
  shown.pending = rows.length - shown.length;
  shown.pendingMaps = review ? rows.filter((l) => !l.needsDetails && l.needsMaps).length : 0;
  return shown;
}

// Every finished listing waiting in Review, before the search box and filters.
export const readyToReview = () => state.listings.filter((l) => l.status === "new" && !l.merged_into && !l.needsDetails && !l.needsMaps);
