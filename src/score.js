// Missing data scores half, so an unchecked listing is neither rewarded nor buried.
import { shortPrice } from "./intro.js";
import { criteriaOf } from "./projects.js";

// Co-living operators (rooms or tiny studios with shared amenities and managed
// contracts). The UI can hide them; they are not rejected.
const COLIVING_RE = /co-?living|coliwoo|hmlet|assembly place/i;

export function isColiving(listing) {
  return COLIVING_RE.test([listing.title, listing.building, listing.property_type, ...(listing.facts ?? [])].filter(Boolean).join(" "));
}

export function lin(value, best, worst) {
  if (value == null || Number.isNaN(value)) return null;
  const t = (value - best) / (worst - best);
  return Math.min(1, Math.max(0, 1 - t));
}

export function stationAccess(listing, c = { maxMinutes: 15, maxWalkMeters: 1000, allowBus: true }) {
  const m = listing?.enrichment?.mrt?.[0];
  if (!m || m.walk_min == null) return null;
  const walkM = m.walk_m ?? m.walk_min * 80;
  if (m.walk_min <= c.maxMinutes && walkM < c.maxWalkMeters) {
    return { ok: true, mode: "walk", minutes: m.walk_min, meters: walkM, station: m.name };
  }
  // Google answers a transit query with a plain walk when walking is faster;
  // only a timed trip ("8:30 AM … bus 232") is a bus option.
  const bus = c.allowBus && m.transit_min != null && /\b(AM|PM)\b/.test(m.transit_summary ?? "") ? m.transit_min : null;
  if (bus != null && bus <= c.maxMinutes) return { ok: true, mode: "bus", minutes: bus, station: m.name };
  const minutes = bus != null ? Math.min(m.walk_min, bus) : m.walk_min;
  return { ok: false, mode: bus != null && bus < m.walk_min ? "bus" : "walk", minutes, meters: walkM, station: m.name, checkedBus: m.transit_min != null };
}

function text(listing) {
  return [listing.furnishing, listing.lease, listing.availability, ...(listing.facts ?? [])].filter(Boolean).join(" · ");
}

function furnishing(listing) {
  const t = text(listing);
  if (/unfurnished|no furniture/i.test(t)) return [0, "unfurnished", "None"];
  if (/partial/i.test(t)) return [0.6, "partially furnished", "Part"];
  if (/fully furnished|furnished/i.test(t)) return [1, "fully furnished", "Full"];
  return [null, "unknown", "?"];
}

function leaseYears(listing) {
  const t = text(listing);
  if (/flexible lease/i.test(t)) return "flexible";
  const m = t.match(/(\d+(?:\.\d+)?)\s+years?\s+lease/i) ?? t.match(/lease[^·]*?(\d+(?:\.\d+)?)\s+years?/i);
  return m ? Number(m[1]) : null;
}

const MONTHS = "janfebmaraprmayjunjulaugsepoctnovdec";
const monthIndex = (ym) => { const [y, m] = String(ym).split("-").map(Number); return y * 12 + (m - 1); };

// Wanted window [from, to] as "YYYY-MM"; a month early still counts.
function moveIn(listing, c) {
  const t = text(listing);
  if (!c.from) return [null, "no move-in window set", "?"];
  const from = monthIndex(c.from);
  const to = monthIndex(c.to ?? c.from);
  const date = t.match(/(?:available from|avail\.?)\s*(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s*['’`]?(\d{2,4})?/i);
  if (date) {
    const month = MONTHS.indexOf(date[2].toLowerCase()) / 3;
    const year = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : Math.floor(from / 12);
    const index = year * 12 + month;
    const label = `${date[1]} ${date[2]}`;
    if (index >= from - 1 && index <= to) return [1, `from ${label}`, label];
    return [index < from - 1 ? 0.4 : 0.5, `from ${label}`, label];
  }
  if (/ready to move|vacant|immediate/i.test(t)) return [0.4, "ready now (may want an earlier start)", "Now"];
  return [null, "unknown", "?"];
}

function price(listing, budget = {}) {
  const p = listing.price;
  const stretch = budget.stretchMax || budget.max || Infinity;
  if (!p) return [null, "no price", "?"];
  const comfortable = (budget.min ?? 0) + (budget.spread ?? 300);
  const short = shortPrice(p);
  if (p <= comfortable) return [1, `S$${p.toLocaleString("en-SG")}`, short];
  if (p <= stretch) return [1 - 0.8 * ((p - comfortable) / Math.max(1, stretch - comfortable)), `S$${p.toLocaleString("en-SG")}`, short];
  // Over the stretch budget the score falls to 0 within S$1,000 a month, or 5% of a purchase price.
  return [Math.max(0, 0.2 - (p - stretch) / (stretch >= 100000 ? stretch * 0.05 : 1000)), `S$${p.toLocaleString("en-SG")}, over stretch`, short];
}

function evaluate(c, listing, project) {
  const e = listing.enrichment ?? {};
  switch (c.type) {
    case "commute": {
      const min = e.commute?.[c.key]?.transit_min;
      return { fraction: lin(min, c.bestMinutes, c.worstMinutes), detail: min != null ? `${min} min transit` : "not checked", value: min != null ? `${min}m` : "?", ok: min != null && min <= c.maxMinutes, box: `${c.label} ≤${c.maxMinutes} min` };
    }
    case "nearby": {
      const places = e.facilities?.[c.key];
      const min = places?.[0]?.walk_min;
      // Checked and nothing found nearby is a real zero, not missing data.
      const fraction = places && !places.length ? 0 : lin(min, c.bestMinutes, c.worstMinutes);
      return { fraction, detail: places ? (places.length ? `${min} min walk` : "none found") : "not checked", value: min != null ? `${min}m` : places ? "–" : "?", ok: min != null && min <= c.maxMinutes, box: `${c.label} ≤${c.maxMinutes} min walk` };
    }
    case "station": {
      const a = stationAccess(listing, c);
      const fraction = a ? (a.ok ? lin(a.minutes, c.bestMinutes, c.maxMinutes + 0.01) || 0.05 : 0) : null;
      return { fraction, detail: a ? `${a.minutes} min ${a.mode === "bus" ? "by bus" : "walk"}${a.ok ? "" : " (over limit)"}` : "not checked", value: a ? `${a.minutes}m${a.mode === "bus" ? " bus" : ""}` : "?", ok: !!a?.ok, box: `${c.label} ≤${c.maxMinutes} min (walk <${c.maxWalkMeters / 1000} km${c.allowBus ? " or bus" : ""})` };
    }
    case "price": {
      const [fraction, detail, value] = price(listing, project.budget);
      const stretch = project.budget?.stretchMax || project.budget?.max;
      return { fraction, detail, value, ok: listing.price != null && listing.price <= stretch, box: `Within S$${Number(stretch).toLocaleString("en-SG")}` };
    }
    case "size": {
      const sqft = listing.sqft && listing.sqft < 5000 ? listing.sqft : null; // listing sites carry typos like 1,001,154 sqft
      return { fraction: lin(sqft, c.goodSqft, c.smallSqft), detail: sqft ? `${sqft} sqft` : "unknown", value: sqft ? `${sqft}` : "?", ok: sqft != null && sqft >= (c.minSqft ?? c.smallSqft), box: `At least ${c.minSqft ?? c.smallSqft} sqft` };
    }
    case "furnishing": {
      const [fraction, detail, value] = furnishing(listing);
      return { fraction, detail, value, ok: fraction !== 0, box: "Not unfurnished" };
    }
    case "move_in": {
      const [fraction, detail, value] = moveIn(listing, c);
      return { fraction, detail, value, ok: fraction === 1, box: `Move-in ${c.from ?? "?"}${c.to && c.to !== c.from ? ` to ${c.to}` : ""}` };
    }
    case "lease": {
      const years = leaseYears(listing);
      const fraction = years === "flexible" ? 1 : years == null ? null : years <= c.maxYears ? 1 : 0.3;
      return { fraction, detail: years === "flexible" ? "flexible" : years == null ? "unknown" : `${years} year${years === 1 ? "" : "s"}`, value: years === "flexible" ? "Flex" : years == null ? "?" : `${years}y`, ok: fraction !== 0.3, box: `Lease ≤${c.maxYears} years` };
    }
    default:
      return { fraction: null, detail: "unknown criterion", value: "?", ok: true, box: c.label };
  }
}

export function scoreListing(listing, project) {
  const criteria = criteriaOf(project);
  const bonus = { allBoxes: 10, proximity: 5, ...(project.bonus ?? {}) };
  const factorTotal = 100 - bonus.allBoxes - bonus.proximity;
  const weightSum = criteria.reduce((s, c) => s + c.weight, 0) || 1;
  const parts = [];
  const boxes = [];
  const chips = [];
  for (const c of criteria) {
    const r = evaluate(c, listing, project);
    const max = Math.round((c.weight / weightSum) * factorTotal * 10) / 10;
    parts.push({ key: c.key, label: c.label, icon: c.icon, max, points: Math.round((r.fraction ?? 0.5) * max * 10) / 10, detail: r.detail, missing: r.fraction == null });
    if (c.mustHave) boxes.push({ key: c.key, label: r.box, ok: r.ok });
    chips.push({ key: c.key, label: c.label, icon: c.icon, value: r.value, ok: c.mustHave ? r.ok : null, detail: r.detail, box: c.mustHave ? r.box : null });
  }
  const ticked = boxes.filter((b) => b.ok).length;
  const all = ticked === boxes.length;
  parts.push({
    key: "all_boxes", label: "Bonus: all boxes ticked", max: bonus.allBoxes, bonus: true, points: all ? bonus.allBoxes : 0,
    detail: all ? `${ticked}/${boxes.length}` : `${ticked}/${boxes.length}, missing: ${boxes.filter((b) => !b.ok).map((b) => b.label).join("; ")}`
  });
  const station = criteria.find((c) => c.type === "station");
  const trips = [
    ...(station ? [stationAccess(listing, station)?.minutes] : []),
    ...criteria.filter((c) => c.type === "nearby").map((c) => listing.enrichment?.facilities?.[c.key]?.[0]?.walk_min)
  ];
  const known = trips.length && trips.every((t) => t != null);
  const total = known ? trips.reduce((a, b) => a + b, 0) : null;
  const near = known ? lin(total, 5 * trips.length, 15 * trips.length) : 0;
  parts.push({ key: "proximity", label: "Bonus: everything close by", max: bonus.proximity, bonus: true, points: Math.round(near * bonus.proximity * 10) / 10, detail: known ? `${total} min for ${trips.length} everyday trips` : "not all checked" });
  return {
    total: Math.round(parts.reduce((sum, p) => sum + p.points, 0)),
    parts, boxes, boxesTicked: ticked, chips,
    station: station ? stationAccess(listing, station) : null
  };
}
