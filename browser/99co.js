// Runs inside 99.co (Claude in Chrome, or the bookmarklet) and returns listings
// shaped like pgExtract's. A listing page is read from its JSON-LD
// (Product/Apartment) and visible facts.
// opts.districts (["D01", ...]) keeps only search cards whose postal code falls
// in those districts: 99.co's own search can't filter by district.
// The page masks the agent's number, but its embedded data (Next.js flight
// chunks) carries the lister's whatsapp_number, signed in or not.
function n99Extract(opts = {}) {
  // Postal sector (first two digits) → district, as in src/searches.js.
  const SECTORS = { D01: [1, 2, 3, 4, 5, 6], D02: [7, 8], D03: [14, 15, 16], D04: [9, 10], D05: [11, 12, 13], D06: [17], D07: [18, 19], D08: [20, 21], D09: [22, 23], D10: [24, 25, 26, 27], D11: [28, 29, 30], D12: [31, 32, 33], D13: [34, 35, 36, 37], D14: [38, 39, 40, 41], D15: [42, 43, 44, 45], D16: [46, 47, 48], D17: [49, 50, 81], D18: [51, 52], D19: [53, 54, 55, 82], D20: [56, 57], D21: [58, 59], D22: [60, 61, 62, 63, 64], D23: [65, 66, 67, 68], D24: [69, 70, 71], D25: [72, 73], D26: [77, 78], D27: [75, 76], D28: [79, 80] };
  const districtOf = (postal) => {
    const n = Number(String(postal ?? "").slice(0, 2));
    return Object.keys(SECTORS).find((d) => SECTORS[d].includes(n)) ?? null;
  };
  function n99Search(opts, districtOf) {
    const num = (v) => (v == null || v === "" ? null : Number(String(v).replace(/[^\d.]/g, "")) || null);
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    // Names and types from the page's JSON-LD ItemList, keyed by URL.
    const meta = new Map();
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      let j; try { j = JSON.parse(s.textContent); } catch { continue; }
      for (const node of [].concat(j["@graph"] ?? j)) {
        for (const el of node?.["@type"] === "ItemList" ? node.itemListElement ?? [] : []) {
          meta.set(el.url, { name: el.item?.name ?? null, type: [].concat(el.item?.additionalProperty ?? []).find((a) => /type/i.test(a.name))?.value ?? null });
        }
      }
    }
    const hrefOf = (a) => new URL(a.getAttribute("href"), location.origin).pathname;
    const isListing = (a) => /^\/singapore\/(rent|sale)\/property\//.test(hrefOf(a));
    const anchors = [...document.querySelectorAll('a[href*="/property/"]')].filter(isListing);
    const seen = new Set();
    const listings = [];
    let skipped = 0;
    for (const a of anchors) {
      const path = hrefOf(a);
      if (seen.has(path)) continue;
      seen.add(path);
      // The card: the largest ancestor whose listing links all point here.
      let card = a;
      while (card.parentElement && [...card.parentElement.querySelectorAll('a[href*="/property/"]')].filter(isListing).every((x) => hrefOf(x) === path)) card = card.parentElement;
      const lines = card.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
      const url = location.origin + path;
      const m = meta.get(url) ?? {};
      const addressLine = lines.find((l) => /,\s*\d{6}$/.test(l)) ?? null;
      const postal = addressLine?.match(/(\d{6})$/)?.[1] ?? null;
      const district = districtOf(postal);
      if (opts.districts?.length && (!district || !opts.districts.includes(district))) { skipped += 1; continue; }
      const beds = lines.find((l) => /^\d+ Beds?$/i.test(l));
      const avail = lines.find((l) => /^AVAIL \d{1,2}\/\d{1,2}\/\d{2}$/i.test(l));
      const [, d, mo, y] = avail?.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/) ?? [];
      const mrt = lines.find((l) => /(MRT|LRT)\s*·/.test(l));
      // Card photos load lazily; the address is there before the pixels are.
      const photo = [...card.querySelectorAll("img")].find((i) => /pic2\.99\.co/.test(i.currentSrc || i.src || ""));
      const nameAt = m.name ? lines.indexOf(m.name) : -1;
      const typeLine = m.type ?? lines.find((l) => /^(Condo|Apartment|HDB.*|Executive Condo|Landed|Terrace|Semi-D|Bungalow|Cluster House|Townhouse)$/i.test(l)) ?? null;
      listings.push({
        source: "99co",
        source_id: path.split("-").pop(),
        url,
        title: m.name ?? (nameAt >= 0 ? lines[nameAt] : null),
        building: m.name ?? null,
        address: addressLine,
        postal,
        district: district ? `${district}` : null,
        property_type: typeLine,
        bedrooms: beds ? Number(beds.match(/\d+/)[0]) : lines.some((l) => /^studio$/i.test(l)) ? 0 : null,
        bathrooms: num(lines.find((l) => /^\d+ Baths?$/i.test(l))),
        sqft: num(lines.find((l) => /^[\d,]+ sqft$/i.test(l))),
        // Rent cards say "S$3,200/mo", sale cards "S$ 888,888".
        price: num(lines.find((l) => /^S\$\s?[\d,]+(\/mo)?$/i.test(l))),
        furnishing: lines.find((l) => /furnished/i.test(l) && l.length < 30) ?? null,
        availability: avail ? `Available from ${Number(d)} ${MONTHS[Number(mo) - 1]} 20${y}` : lines.some((l) => /^READY TO MOVE$/i.test(l)) ? "Ready to move" : null,
        built_year: lines.join(" ").match(/Built:\s*(\d{4})/)?.[1] ?? null,
        source_mrts: mrt ? [{ name: mrt.split("·")[0].trim(), walk: mrt.split("·")[1]?.trim() ?? null }] : [],
        photos: photo ? [{ src: photo.currentSrc || photo.src, kind: "photo" }] : []
      });
    }
    return { kind: "search", listings, skipped, error: listings.length || skipped ? null : "no listing cards found on this 99.co page" };
  }

  if (/^\/singapore\/(rent|sale)\/?$/.test(location.pathname)) return n99Search(opts, districtOf);
  const lds = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => { try { return JSON.parse(s.textContent); } catch { return null; } })
    .filter(Boolean)
    .flatMap((x) => (Array.isArray(x) ? x : x["@graph"] ?? [x]));
  const p = lds.find((x) => [].concat(x["@type"]).includes("Product"));
  const m = location.pathname.match(/^\/singapore\/(?:rent|sale)\/property\/(.+)$/);
  if (!p || !m) return { kind: "none", listings: [], error: "not a 99.co listing page" };
  const props = Object.fromEntries((p.additionalProperty ?? []).map((a) => [a.name, a.value]));
  const locality = p.address?.addressLocality ?? null;
  const h1 = (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim();
  const lines = document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
  const at = lines.findIndex((l) => l.replace(/\s+/g, " ") === h1);
  // The facts line ("2 Beds · 1 Bath · 635 sqft · Built: 1974 · Avail. 01 Dec '26 ·
  // Fully furnished") renders as separate pieces with "·" between them; read
  // until the MRT or address line.
  const facts = [];
  for (const l of at >= 0 ? lines.slice(at + 1, at + 25) : []) {
    if (/MRT|LRT|View on map|\b\d{6}\b/.test(l)) break;
    // Skip separators, price/contact buttons and MRT line badges ("CC 13").
    if (/^[·•]$/.test(l) || /^(S\$|Call|Whatsapp|STARTING PRICE|VIEW TO OFFER)/i.test(l) || /^[A-Z]{2,3}\s?\d{1,2}$/.test(l)) continue;
    facts.push(l.replace(/^[·•]\s*|\s*[·•]$/g, ""));
  }
  const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  // Gallery photos (loaded or still lazy), once each: thumbnails of the same photo
  // share its pic2 id. Small images (agent avatar, icons) are left out.
  const seenPhoto = new Set();
  const photos = [...document.querySelectorAll("img")]
    .filter((i) => /pic2\.99\.co/.test(i.currentSrc || i.src || "") && !/logo|avatar|agent/i.test(i.src))
    .filter((i) => i.naturalWidth >= 400 || i.getBoundingClientRect().width >= 150)
    .map((i) => i.currentSrc || i.src)
    .filter((src) => { const key = new URL(src).pathname; if (seenPhoto.has(key)) return false; seenPhoto.add(key); return true; })
    .slice(0, 12)
    .map((src) => ({ src, kind: "photo" }));
  const agentLinks = [...document.querySelectorAll('a[href*="/agents/"], a[href*="/agent/"]')];
  const agent = agentLinks.map((a) => a.textContent.trim()).find(Boolean) ?? null;
  // Other agents (similar listings) can appear too: prefer the one whose
  // profile_page_url is the agent link on this page.
  const profile = agentLinks[0] ? new URL(agentLinks[0].href).pathname : null;
  const flight = [...document.scripts].map((s) => s.textContent).filter((t) => t.includes("whatsapp_number")).join("\n").replace(/\\"/g, '"');
  const agentData = [...flight.matchAll(/\{[^{}]*"whatsapp_number":"(\+?\d[\d ]{7,})"[^{}]*\}/g)];
  const lister = agentData.find((m) => profile && m[0].includes(`"profile_page_url":"${profile}"`)) ?? agentData[0];
  return {
    kind: "listing",
    listings: [{
      source: "99co",
      source_id: m[1].split("-").pop(),
      url: location.origin + location.pathname,
      title: p.name ?? h1,
      building: h1.replace(/^.*?\bfor (Rent|Sale) in\s+/i, "").trim() || null,
      address: locality,
      postal: locality?.match(/\b(\d{6})\b/)?.[1] ?? null,
      district: p.address?.addressRegion ?? districtOf(locality?.match(/\b(\d{6})\b/)?.[1]),
      property_type: props["Property category"] ?? null,
      bedrooms: /studio/i.test(h1) ? 0 : num(props.Bedrooms),
      bathrooms: num(props.Bathrooms),
      sqft: num(p.floorSize?.value),
      price: num(p.offers?.price),
      furnishing: facts.find((f) => /furnish/i.test(f)) ?? null,
      availability: facts.find((f) => /avail/i.test(f))?.replace(/^Avail\.?\s*/i, "Available from ") ?? null,
      built_year: facts.join(" ").match(/Built:?\s*(\d{4})/i)?.[1] ?? null,
      facts,
      agent_name: agent,
      agent_phone: lister?.[1].replace(/\s/g, "") ?? null,
      lat: num(p.geo?.latitude),
      lng: num(p.geo?.longitude),
      photos,
      details_at: new Date().toISOString()
    }]
  };
}
