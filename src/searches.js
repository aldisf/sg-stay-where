// filters: {
//   minPrice, maxPrice,          // S$/month
//   bedrooms: [0, 1, 2],         // 0 = studio
//   wholeUnit: true,             // false = rooms only, null/undefined = both
//   districts: ["D01", ...],     // Singapore postal districts; empty = anywhere
// }
// Results are always sorted newest first: the poll reads the first pages only.

export const DISTRICTS = {
  D01: "Raffles Place, Marina, Cecil", D02: "Tanjong Pagar, Chinatown", D03: "Tiong Bahru, Alexandra, Queenstown",
  D04: "HarbourFront, Telok Blangah, Sentosa", D05: "Buona Vista, West Coast, Clementi", D06: "City Hall, Clarke Quay",
  D07: "Bugis, Beach Road, Golden Mile", D08: "Little India, Farrer Park", D09: "Orchard, River Valley",
  D10: "Tanglin, Holland, Bukit Timah", D11: "Newton, Novena, Thomson", D12: "Balestier, Toa Payoh, Serangoon",
  D13: "Macpherson, Braddell", D14: "Geylang, Paya Lebar, Eunos", D15: "Katong, Marine Parade, Joo Chiat",
  D16: "Bedok, Upper East Coast", D17: "Changi, Loyang", D18: "Tampines, Pasir Ris", D19: "Serangoon Gardens, Hougang, Punggol",
  D20: "Bishan, Ang Mo Kio", D21: "Upper Bukit Timah, Clementi Park", D22: "Jurong, Boon Lay", D23: "Bukit Batok, Bukit Panjang, Choa Chu Kang",
  D24: "Lim Chu Kang, Tengah", D25: "Kranji, Woodlands", D26: "Upper Thomson, Mandai", D27: "Yishun, Sembawang", D28: "Seletar, Yio Chu Kang"
};

const SITE_NAMES = { propertyguru: "PropertyGuru", "99co": "99.co", carousell: "Carousell" };

// Postal sector (first two digits of a postal code) → district.
const SECTORS = {
  D01: [1, 2, 3, 4, 5, 6], D02: [7, 8], D03: [14, 15, 16], D04: [9, 10], D05: [11, 12, 13], D06: [17], D07: [18, 19],
  D08: [20, 21], D09: [22, 23], D10: [24, 25, 26, 27], D11: [28, 29, 30], D12: [31, 32, 33], D13: [34, 35, 36, 37],
  D14: [38, 39, 40, 41], D15: [42, 43, 44, 45], D16: [46, 47, 48], D17: [49, 50, 81], D18: [51, 52], D19: [53, 54, 55, 82],
  D20: [56, 57], D21: [58, 59], D22: [60, 61, 62, 63, 64], D23: [65, 66, 67, 68], D24: [69, 70, 71], D25: [72, 73],
  D26: [77, 78], D27: [75, 76], D28: [79, 80]
};
const SECTOR_TO_DISTRICT = Object.fromEntries(Object.entries(SECTORS).flatMap(([d, list]) => list.map((n) => [n, d])));

export function districtOfPostal(postal) {
  const m = String(postal ?? "").match(/\b(\d{2})\d{4}\b/);
  return m ? SECTOR_TO_DISTRICT[Number(m[1])] ?? null : null;
}

function checkFilters(f) {
  if (!f || typeof f !== "object") throw new Error("filters are required");
  const errors = [];
  if (!Number.isFinite(f.minPrice) || !Number.isFinite(f.maxPrice) || !(f.minPrice >= 0) || !(f.maxPrice > 0) || f.minPrice > f.maxPrice) errors.push("minPrice/maxPrice must be numbers with min ≤ max");
  if (!Array.isArray(f.bedrooms) || !Array.isArray(f.districts)) throw new Error("bedrooms and districts must be arrays");
  if (f.wholeUnit != null && typeof f.wholeUnit !== "boolean") errors.push("wholeUnit must be true, false or null");
  for (const b of f.bedrooms ?? []) if (!Number.isInteger(b) || b < 0 || b > 5) errors.push(`bedrooms ${b} must be 0 (studio) to 5`);
  for (const d of f.districts ?? []) if (!DISTRICTS[d]) errors.push(`district ${d} must be D01–D28`);
  if (errors.length) throw new Error(errors.join("; "));
}

function propertyguru(f) {
  const q = new URLSearchParams({ listingType: "rent", isCommercial: "false", minPrice: String(f.minPrice), maxPrice: String(f.maxPrice) });
  for (const b of f.bedrooms ?? []) q.append("bedrooms", String(b));
  if (f.wholeUnit === true) q.append("entireUnitOrRoom", "ent");
  if (f.wholeUnit === false) q.append("entireUnitOrRoom", "room");
  for (const d of f.districts ?? []) q.append("districtCode", d);
  q.append("sort", "date");
  q.append("order", "desc");
  return `https://www.propertyguru.com.sg/property-for-rent?${q}`;
}

// 99.co's own filters write the URL this way. It has no district filter (its
// location search knows MRT stations, streets and projects only), so it searches
// all of Singapore and n99Extract({ districts }) applies the districts from each
// card's postal code.
function n99(f) {
  const q = new URLSearchParams({
    main_category: "all", name: "Singapore", query_name: "Singapore", property_segments: "residential",
    price_range: `${f.minPrice},${f.maxPrice}`,
    rental_type: f.wholeUnit === true ? "unit" : f.wholeUnit === false ? "room" : "all"
  });
  if (f.bedrooms?.length) q.append("rooms", f.bedrooms.join(","));
  q.append("sort_field", "recency");
  q.append("sort_order", "desc");
  q.append("page_size", "36");
  return `https://www.99.co/singapore/rent?${q}`;
}

// Carousell's own filters write the URL this way. It has no whole-unit or
// district filter, so rooms are left to the skip rules and districts to each
// listing's postal code.
const CAROUSELL_BEDROOMS = ["BEDROOMS_0_BEDROOMS_STUDIO", "BEDROOMS_1_BEDROOM", "BEDROOMS_2_BEDROOMS", "BEDROOMS_3_BEDROOMS", "BEDROOMS_4_BEDROOMS", "BEDROOMS_5_BEDROOMS"];
function carousell(f) {
  const q = new URLSearchParams({ price_start: String(f.minPrice), price_end: String(f.maxPrice) });
  if (f.bedrooms?.length) q.append("property_bedrooms", f.bedrooms.map((b) => CAROUSELL_BEDROOMS[b]).join(","));
  q.append("sort_by", "3");
  return `https://www.carousell.sg/categories/property-102/rent-in-singapore-229/?${q}`;
}

const BUILDERS = { propertyguru, "99co": n99, carousell };

// A search URL made by hand on the site, sorted newest first: polls read only
// the first pages, so any other order would miss new listings.
export function newestFirst(url) {
  const u = new URL(url);
  const sort = /99\.co$/.test(u.hostname) ? { sort_field: "recency", sort_order: "desc" }
    : /carousell\.sg$/.test(u.hostname) ? { sort_by: "3" }
    : { sort: "date", order: "desc" };
  for (const [k, v] of Object.entries(sort)) u.searchParams.set(k, v);
  // A copied address bar can carry the page it was on; polls page by appending their own.
  for (const k of ["page", "page_num"]) u.searchParams.delete(k);
  return u.toString();
}

function describe(f) {
  const beds = (f.bedrooms ?? []).map((b) => (b === 0 ? "studio" : `${b}BR`)).join("/") || "any size";
  const unit = f.wholeUnit === true ? "whole unit" : f.wholeUnit === false ? "rooms" : "units and rooms";
  const k = (n) => `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k`;
  const where = f.districts?.length ? `${f.districts.length} districts` : "anywhere";
  return `${unit}, ${beds}, S$${k(f.minPrice)}–${k(f.maxPrice)}, ${where}`;
}

// How much one poll reads. The defaults keep it at browsing pace; the user can
// raise them up to max, and asks their agent for a one-off backfill beyond that.
// rpm: listing-site page loads per minute per site; 12 is about as fast as a person clicks through.
export const POLL_LIMITS = { pages: { default: 5, max: 5 }, listings: { default: 40, max: 150 }, rpm: { default: 10, max: 12 } };
export const validPages = (n) => Number.isInteger(n) && n >= 1 && n <= POLL_LIMITS.pages.max;

export function searchesFromTemplate(filters, { sites = ["propertyguru", "99co", "carousell"], template = "main", pages = POLL_LIMITS.pages.default } = {}) {
  checkFilters(filters);
  if (!Array.isArray(sites) || !sites.length || new Set(sites).size !== sites.length) throw new Error("choose at least one site, without duplicates");
  if (!validPages(pages)) throw new Error(`pages must be between 1 and ${POLL_LIMITS.pages.max}`);
  return sites.map((site) => {
    if (!BUILDERS[site]) throw new Error(`unknown site ${site}`);
    const search = { id: `${template}-${site}`, title: `${SITE_NAMES[site]} · ${describe(filters)}`, site, url: BUILDERS[site](filters), pages, active: true, template };
    // Districts are a post-filter; keep the same browsing budget on both sites.
    if (site === "99co" && filters.districts?.length) {
      Object.assign(search, { districts: filters.districts, why: "99.co has no district filter: it searches all of Singapore and keeps listings in your districts (from the postal code). Some matching homes may be beyond the pages checked." });
    }
    if (site === "carousell") {
      Object.assign(search, { why: "Carousell filters price and bedrooms only. Rooms are skipped by your skip rules; listings outside your districts are dropped once their page gives the postal code." });
      if (filters.districts?.length) search.districts = filters.districts;
    }
    return search;
  });
}

export function applyTemplate(project, name, { filters, sites = ["propertyguru", "99co", "carousell"], pages = POLL_LIMITS.pages.default }) {
  if (project.deal === "buy") throw new Error("The search template builds rental searches. For buying, set up each site's search in the browser and add it by link (skills/build-search).");
  const fresh = searchesFromTemplate(filters, { sites, template: name, pages });
  const old = project.searches ?? [];
  const before = new Map(old.filter(s => s.template === name).map(s => [s.id, s]));
  const sameUrl = new Map(old.filter(s => s.template !== name).map(s => [s.url, s]));
  return {
    ...project,
    templates: { ...project.templates, [name]: { filters, sites, pages } },
    searches: [
      ...old.filter(s => s.template !== name && !fresh.some(f => f.id === s.id || f.url === s.url)),
      ...fresh.map(s => ({ ...s, active: before.get(s.id)?.active ?? sameUrl.get(s.url)?.active ?? true }))
    ]
  };
}

export function filtersFromPropertyGuru(url) {
  const q = new URL(url).searchParams;
  const unit = q.get("entireUnitOrRoom");
  return {
    minPrice: Number(q.get("minPrice") ?? 0),
    maxPrice: Number(q.get("maxPrice") ?? 0),
    bedrooms: q.getAll("bedrooms").map(Number),
    wholeUnit: unit === "ent" ? true : unit === "room" ? false : null,
    districts: q.getAll("districtCode")
  };
}

export const SEARCH_URL_RE = /^https:\/\/(www\.)?(propertyguru\.com\.sg|99\.co|carousell\.sg)\//;
export const siteOf = (url) => (/99\.co\//.test(url) ? "99co" : /carousell\.sg\//.test(url) ? "carousell" : "propertyguru");

// For buying, or anything the template can't express.
export function applySearchLinks(project, name, { searches, pages = POLL_LIMITS.pages.default }) {
  if (!Array.isArray(searches) || !searches.length) throw new Error("Give at least one search link.");
  if (!validPages(pages)) throw new Error(`pages must be between 1 and ${POLL_LIMITS.pages.max}`);
  const others = (project.searches ?? []).filter((s) => s.template !== name);
  const switches = new Map((project.searches ?? []).filter((s) => s.template === name).map((s) => [s.id, s.active]));
  const ids = new Set(others.map((s) => s.id));
  const fresh = searches.map(({ url, title, districts, why }) => {
    if (!SEARCH_URL_RE.test(url ?? "")) throw new Error(`${url} isn't a PropertyGuru, 99.co or Carousell search address.`);
    for (const d of districts ?? []) if (!DISTRICTS[d]) throw new Error(`district ${d} must be D01–D28`);
    const site = siteOf(url);
    let id = `${name}-${site}`;
    for (let n = 2; ids.has(id); n++) id = `${name}-${site}-${n}`;
    ids.add(id);
    // districts: kept by the reader from each card's postal code, for sites
    // without a district filter (99.co); why: what the site can't filter.
    return { id, title: title || `${SITE_NAMES[site]} · ${project.deal === "buy" ? "for sale" : "search"}`, site, url: newestFirst(url), pages, active: switches.get(id) ?? true, template: name,
      ...(districts?.length ? { districts } : {}), ...(why ? { why } : {}) };
  });
  return { ...project, searches: [...others, ...fresh] };
}
