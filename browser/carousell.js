// Runs inside carousell.sg (Claude in Chrome, or the bookmarklet) and returns
// listings shaped like pgExtract's. Carousell has no district filter and search
// cards carry no postal code, so districts are applied once the listing page
// gives one. A listing page has JSON-LD, the
// breadcrumb (HDB / Condos & ECs / Room Rentals), the unit details and the
// agent's CEA block with their mobile number. It has no coordinates: the poll
// looks the postal code up on Google Maps.
function cxExtract(opts = {}) {
  const SECTORS = { D01: [1, 2, 3, 4, 5, 6], D02: [7, 8], D03: [14, 15, 16], D04: [9, 10], D05: [11, 12, 13], D06: [17], D07: [18, 19], D08: [20, 21], D09: [22, 23], D10: [24, 25, 26, 27], D11: [28, 29, 30], D12: [31, 32, 33], D13: [34, 35, 36, 37], D14: [38, 39, 40, 41], D15: [42, 43, 44, 45], D16: [46, 47, 48], D17: [49, 50, 81], D18: [51, 52], D19: [53, 54, 55, 82], D20: [56, 57], D21: [58, 59], D22: [60, 61, 62, 63, 64], D23: [65, 66, 67, 68], D24: [69, 70, 71], D25: [72, 73], D26: [77, 78], D27: [75, 76], D28: [79, 80] };
  const districtOf = (postal) => {
    const n = Number(String(postal ?? "").slice(0, 2));
    return Object.keys(SECTORS).find((d) => SECTORS[d].includes(n)) ?? null;
  };
  const num = (v) => (v == null || v === "" ? null : Number(String(v).replace(/[^\d.]/g, "")) || null);
  const idOf = (path) => path.replace(/\/+$/, "").match(/-(\d{6,})$/)?.[1] ?? null;
  const pathOf = (a) => new URL(a.getAttribute("href"), location.origin).pathname;

  if (/^\/p\//.test(location.pathname)) {
    const lds = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .filter(Boolean)
      .flatMap((x) => [].concat(x["@graph"] ?? x));
    const p = lds.find((x) => [].concat(x["@type"]).includes("Product"));
    const crumbs = lds.find((x) => x["@type"] === "BreadcrumbList")?.itemListElement?.map((e) => e.name) ?? [];
    if (!p) return { kind: "none", listings: [], error: "not a Carousell listing page" };
    const lines = document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
    // Unit details and the CEA block render as a label line, then its value.
    const after = (label) => { const i = lines.indexOf(label); return i >= 0 ? lines[i + 1] ?? null : null; };
    const postal = after("Postal Code")?.match(/\b\d{6}\b/)?.[0] ?? null;
    const beds = lines.find((l) => /\b\d+ Bedrooms?\b|\bStudio\b/i.test(l) && l.length < 60) ?? "";
    const path = location.pathname.replace(/\/+$/, "");
    const hdbType = after("Type");
    // HDB pages give the estate, not the street; their titles are usually the
    // block address ("3 Saint George's Road"), which flat matching relies on.
    const street = after("Street Name") ?? (/^(blk\s*)?\d+[a-z]?\s+\S/i.test(p.name ?? "") ? p.name : null);
    return {
      kind: "listing",
      listings: [{
        source: "carousell",
        source_id: idOf(path),
        url: `${location.origin}${path}/`,
        title: p.name ?? null,
        // Condos: Property Name and Street Name. HDB: Estate.
        building: after("Property Name") ?? after("Estate") ?? null,
        address: [street, after("Estate"), postal ? `Singapore ${postal}` : null].filter(Boolean).join(", ") || null,
        postal,
        district: districtOf(postal) ?? after("District")?.match(/^D\d{2}\b/)?.[0] ?? null,
        property_type: crumbs.at(-1) && !["Rentals", "For Sale"].includes(crumbs.at(-1)) ? crumbs.at(-1) : null,
        bedrooms: /studio/i.test(beds) ? 0 : num(beds.match(/(\d+) Bedrooms?/i)?.[1]) ?? (hdbType ? num(hdbType.match(/^(\d)/)?.[1]) - 1 || null : null),
        bathrooms: num(beds.match(/(\d+) Bathrooms?/i)?.[1]),
        sqft: num(lines.find((l) => /^[\d,]+\s*sqft$/i.test(l))),
        price: num(p.offers?.price),
        furnishing: after("Furnishing") ?? lines.find((l) => /^(fully|partially|partly|un)\s*-?furnished$/i.test(l)) ?? null,
        availability: lines.find((l) => /^available (from|immediately|now)/i.test(l) && l.length < 60) ?? null,
        facts: [hdbType && `Type ${hdbType}`, after("Lease") && `Lease ${after("Lease")}`, after("Level") && `Level ${after("Level")}`].filter(Boolean),
        source_mrts: after("MRT") ? [{ name: after("MRT"), walk: null }] : [],
        agent_name: after("Full Name"),
        agent_phone: after("Mobile Number")?.replace(/[^\d+]/g, "") || null,
        description: typeof p.description === "string" ? p.description.slice(0, 4000) : null,
        photos: [].concat(p.image ?? []).slice(0, 12).map((src) => ({ src, kind: "photo" })),
        details_at: new Date().toISOString()
      }]
    };
  }

  // A search results page: the card is the largest ancestor whose listing links
  // all point at the same listing.
  const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
  const seen = new Set();
  const listings = [];
  for (const a of anchors) {
    const path = pathOf(a).replace(/\/+$/, "");
    const id = idOf(path);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let card = a;
    while (card.parentElement && [...card.parentElement.querySelectorAll('a[href*="/p/"]')].every((x) => idOf(pathOf(x).replace(/\/+$/, "")) === id)) card = card.parentElement;
    const lines = card.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const price = lines.find((l) => /^S\$\s?[\d,]+(\/mo)?$/i.test(l));
    const priceAt = lines.indexOf(price);
    const photo = [...card.querySelectorAll("img")].map((i) => i.currentSrc || i.src).find((s) => /media\.karousell\.com\/media\/photos\/products\//.test(s));
    listings.push({
      source: "carousell",
      source_id: id,
      url: `${location.origin}${path}/`,
      title: priceAt > 0 ? lines[priceAt - 1] : null,
      price: num(price),
      sqft: num(lines.find((l) => /^[\d,]+\s*sqft$/i.test(l))),
      posted_at: lines.find((l) => /\bago$/i.test(l)) ?? null,
      photos: photo ? [{ src: photo, kind: "photo" }] : []
    });
  }
  return { kind: "search", listings, skipped: 0, districts: opts.districts ?? null, error: listings.length ? null : "no listing cards found on this Carousell page" };
}
