// Listing links from PropertyGuru, 99.co and Carousell. A WhatsApp chat counts
// as a property chat only when one of its messages carries such a link.
// Carousell sells everything, so a Carousell link counts only for a listing
// the tracker already holds (isTracked); a friend's sofa link never does.

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\b(?:www\.)?(?:propertyguru\.com\.sg|99\.co|carousell\.sg)\/[^\s<>"')\]]+/gi;

const PROPERTY_HOST_RE = /(^|\.)(propertyguru\.com\.sg|99\.co)$/i;
const CAROUSELL_HOST_RE = /(^|\.)carousell\.sg$/i;

function toUrl(raw) {
  const cleaned = raw.replace(/[.,;:!?]+$/, "");
  try {
    return new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
  } catch {
    return null;
  }
}

export function isPropertyHost(host) {
  return PROPERTY_HOST_RE.test(host ?? "");
}

export function findPropertyLinks(text, { isTracked = () => false } = {}) {
  if (!text) return [];
  const found = new Map();
  for (const match of text.matchAll(URL_RE)) {
    const url = toUrl(match[0]);
    if (!url) continue;
    const carousell = CAROUSELL_HOST_RE.test(url.hostname);
    if (!carousell && !isPropertyHost(url.hostname)) continue;
    const parsed = parseListingUrl(url.href);
    if (carousell && !(parsed.listingKey && isTracked(parsed.listingKey))) continue;
    const key = parsed.listingKey ?? parsed.url;
    if (!found.has(key)) found.set(key, parsed);
  }
  return [...found.values()];
}

export function hasPropertyLink(text, options) {
  return findPropertyLinks(text, options).length > 0;
}

// listingKey is null for a property-site link that is not a listing
// (a search page, an agent profile, a short link we cannot resolve).
export function parseListingUrl(href) {
  const url = toUrl(href);
  if (!url) return { source: null, sourceId: null, listingKey: null, url: href };
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  if (host.endsWith("propertyguru.com.sg")) {
    // /listing/hdb-for-rent-145-jalan-bukit-merah-500297009, /listing/500297009,
    // /listing/500297009/for-rent-..., short share links /l/500297009
    const m = path.match(/^\/listing\/(?:(\d{6,})(?:\/.*)?|.*?-(\d{6,}))$/i) ?? path.match(/^\/l\/(\d{6,})$/i);
    const id = m ? m[1] ?? m[2] : null;
    return {
      source: "propertyguru",
      sourceId: id,
      listingKey: id ? `propertyguru:${id}` : null,
      url: id ? `https://www.propertyguru.com.sg${path}` : `https://www.propertyguru.com.sg${path}${url.search}`
    };
  }

  if (host.endsWith("99.co")) {
    // /singapore/rent/property/<slug>-<id>  (id is the last dash-separated token)
    // /e/<code> enquiry share links redirect to a listing; the code stands in
    // for the id until the page is opened in the browser.
    const m = path.match(/^\/singapore\/(?:rent|sale)\/property\/(.+)$/i);
    const short = path.match(/^\/e\/([A-Za-z0-9]+)$/);
    const id = m ? m[1].split("-").pop() : short ? `e-${short[1]}` : null;
    return {
      source: "99co",
      sourceId: id,
      listingKey: id ? `99co:${id}` : null,
      url: id ? `https://www.99.co${path}` : `https://www.99.co${path}${url.search}`
    };
  }

  if (host.endsWith("carousell.sg")) {
    // /p/<slug>-<id>/ (id is the last dash-separated token)
    const m = path.match(/^\/p\/(?:.*-)?(\d{6,})$/i);
    const id = m ? m[1] : null;
    return {
      source: "carousell",
      sourceId: id,
      listingKey: id ? `carousell:${id}` : null,
      url: id ? `https://www.carousell.sg${path}/` : `https://www.carousell.sg${path}${url.search}`
    };
  }

  return { source: null, sourceId: null, listingKey: null, url: url.href };
}
