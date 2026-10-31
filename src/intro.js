export const DEFAULT_TEMPLATE = [
  "Hi{agentFirstName}, I'm {name}. I'm interested in your listing on {site}: {listingTitle} ({listingPrice}/month)",
  "{url}",
  "",
  "Details:",
  "- {household}",
  "- {residency}",
  "- {lifestyle}",
  "- Move-in: {moveIn}",
  "- Lease: {lease}",
  "- Budget: {budgetRange}/month",
  "",
  "{closing}"
].join("\n");

// Buying: no monthly rent, and the agent wants to know how you'll pay and when.
export const DEFAULT_BUY_TEMPLATE = [
  "Hi{agentFirstName}, I'm {name}. I'm interested in your listing on {site}: {listingTitle} ({listingPrice})",
  "{url}",
  "",
  "Details:",
  "- {household}",
  "- {residency}",
  "- Financing: {financing}",
  "- Timeline: {moveIn}",
  "- Budget: {budgetRange}",
  "",
  "{closing}"
].join("\n");

export const defaultTemplate = (deal) => (deal === "buy" ? DEFAULT_BUY_TEMPLATE : DEFAULT_TEMPLATE);

const SITE_NAMES = { propertyguru: "PropertyGuru", "99co": "99.co", carousell: "Carousell" };

// For chips and map pins: "$2.8k" a month, "$758k" or "$1.25M" to buy.
export function shortPrice(amount, decimals = 1) {
  if (amount >= 1e6) return `$${+(amount / 1e6).toFixed(2)}M`;
  if (amount >= 1e5) return `$${Math.round(amount / 1000)}k`;
  return `$${(amount / 1000).toFixed(decimals)}k`;
}

export function formatSgd(amount) {
  return `S$${Math.round(amount).toLocaleString("en-SG")}`;
}

// The range to quote for a listing: listing price ± spread, never above the
// stretch ceiling. A listing over the ceiling gets [ceiling - spread, ceiling].
export function budgetRange(price, budget = {}) {
  const { min = 0, max = 0, stretchMax = max, spread = 300, roundTo = (price ?? max) >= 100000 ? 1000 : 50 } = budget;
  const round = (x) => Math.round(x / roundTo) * roundTo;
  if (!price) return { low: min, high: max, text: `${formatSgd(min)}–${Math.round(max).toLocaleString("en-SG")}` };
  const ceiling = stretchMax || max || price + spread;
  const high = round(Math.min(price + spread, ceiling));
  const low = Math.max(0, round(Math.min(price - spread, ceiling - spread)));
  return { low, high, text: `${formatSgd(low)}–${high.toLocaleString("en-SG")}`, overBudget: price > ceiling };
}

export function agentFirstName(name) {
  const first = String(name ?? "").replace(/\(.*?\)/g, " ").trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'-]*$/u.test(first) ? first : "";
}

export function listingTitle(listing) {
  const where = listing.building || listing.address || listing.title || "this unit";
  const beds = listing.bedrooms === 0 ? "studio" : listing.bedrooms ? `${listing.bedrooms}BR` : null;
  return [beds, where].filter(Boolean).join(" at ");
}

// Lines whose placeholders all resolve to empty are dropped, so an unset
// profile field removes its bullet instead of leaving "- ".
export function composeIntro(profile, listing, template = profile?.template || defaultTemplate(profile?.deal)) {
  const range = budgetRange(listing.price, profile.budget);
  const first = agentFirstName(listing.agent_name);
  const values = {
    agentFirstName: first ? ` ${first}` : "",
    name: profile.name ?? "",
    site: SITE_NAMES[listing.source] ?? "the listing site",
    listingTitle: listingTitle(listing),
    listingPrice: listing.price ? formatSgd(listing.price) : "price on request",
    url: listing.url ?? "",
    household: profile.household ?? "",
    residency: profile.residency ?? "",
    lifestyle: (profile.lifestyle ?? []).filter(Boolean).join(", "),
    moveIn: profile.moveIn ?? "",
    lease: profile.lease ?? "",
    financing: profile.financing ?? "",
    budgetRange: range.text,
    closing: profile.closing ?? ""
  };
  const lines = [];
  for (const line of template.split("\n")) {
    const keys = [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const filled = line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
    if (keys.length && keys.every((key) => key !== "agentFirstName" && !values[key])) continue;
    lines.push(filled);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
