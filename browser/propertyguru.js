// Runs inside a propertyguru.com.sg page (Claude in Chrome, or the bookmarklet).
// Reads the page's __NEXT_DATA__ and returns tracker-shaped listings:
//   { kind: "listing" | "search", listings: [...] }
// A listing page yields full details incl. the agent's mobile and coordinates;
// a search page yields one summary per card (no phone, no coordinates).
function pgExtract() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return { kind: "none", listings: [], error: "no __NEXT_DATA__ (not a PropertyGuru page, or still loading)" };
  const data = JSON.parse(el.textContent)?.props?.pageProps?.pageData?.data ?? {};
  const canon = (u) => { try { const x = new URL(u, location.origin); return x.origin + x.pathname; } catch { return u; } };
  const beds = (n, text) => (/studio/i.test(text ?? "") ? 0 : Number.isFinite(Number(n)) && n !== "" && n != null ? Number(n) : null);
  const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const itemText = (i) => (typeof i === "string" ? i : i?.value ?? i?.text ?? i?.label ?? Object.values(i ?? {}).find((v) => typeof v === "string") ?? "");

  if (data.listingData && data.contactAgentData) {
    const L = data.listingData;
    const card = data.contactAgentData?.contactAgentCard?.agentInfoProps ?? {};
    const agent = card.agent ?? {};
    const loc = data.listingLocationData?.data ?? {};
    const facts = (data.detailsData?.metatable?.items ?? []).map(itemText).filter(Boolean);
    const find = (re) => facts.find((f) => re.test(f)) ?? null;
    const address = [L.propertyName, L.streetName && L.streetName !== L.propertyName ? L.streetName : null, L.postcode ? `Singapore ${L.postcode}` : null]
      .filter(Boolean).join(", ");
    return {
      kind: "listing",
      listings: [{
        source: "propertyguru",
        source_id: String(L.listingId),
        url: canon(location.href),
        title: L.localizedTitle ?? null,
        building: L.propertyName ?? null,
        address,
        street: L.streetName ?? null,
        postal: L.postcode ?? null,
        district: [L.districtCode, L.districtText].filter(Boolean).join(" ") || null,
        // Room rentals carry roomType ("Master Room"); the search wants whole units.
        property_type: [L.propertyType, L.roomType ? `${L.roomType} only` : null].filter(Boolean).join(" · ") || null,
        bedrooms: beds(L.bedrooms, L.studioOrRoomText),
        bathrooms: num(L.bathrooms),
        sqft: num(L.floorArea),
        price: num(L.price),
        furnishing: find(/furnish/i),
        // "1 year lease" is the rental term; "99-year lease" is the land tenure.
        lease: find(/\d+(\.\d+)?\s+(year|month)s?\s+lease/i),
        availability: find(/move in|available/i),
        built_year: (find(/TOP in|built/i) ?? "").match(/\d{4}/)?.[0] ?? null,
        facts,
        agent_name: agent.name ?? null,
        agent_phone: agent.mobile ?? null,
        lat: num(loc.center?.lat),
        lng: num(loc.center?.lng),
        source_mrts: (loc.nearestMRTs ?? []).map((m) => ({ name: m.name, lat: num(m.location?.latitude), lng: num(m.location?.longitude) })),
        photos: [
          ...(data.mediaGalleryData?.media?.images?.items ?? []).slice(0, 12).map((i) => ({ src: i.src, kind: "photo" })),
          ...(data.mediaGalleryData?.media?.floorPlans?.items ?? []).slice(0, 3).map((i) => ({ src: i.src, kind: "floor plan" }))
        ].filter((p) => p.src),
        posted_at: L.lastPosted?.date ?? null,
        details_at: new Date().toISOString()
      }]
    };
  }

  const cards = data.listingsData ?? [];
  return {
    kind: "search",
    resultCount: data.paginationData?.totalCount ?? null,
    listings: cards.map((c) => c.listingData).filter((L) => L?.id && L.url).map((L) => {
      const feats = (L.listingFeatures ?? []).flat().map((f) => f?.text).filter(Boolean);
      return {
        source: "propertyguru",
        source_id: String(L.id),
        url: canon(L.url),
        title: L.localizedTitle ?? null,
        building: L.localizedTitle ?? null,
        address: L.fullAddress ?? null,
        property_type: /^For (Rent|Sale)$/.test(L.property?.typeText ?? "") ? feats.find((f) => /HDB|Condo|Apartment|Landed|House|Shophouse|Terrace|Executive/i.test(f)) ?? null : L.property?.typeText ?? null,
        bedrooms: beds(L.bedrooms, feats.join(" ")),
        bathrooms: num(L.bathrooms),
        sqft: num(String(L.floorArea ?? feats.find((f) => /sqft/i.test(f)) ?? "").replace(/[^\d.]/g, "")),
        price: num(L.price?.value),
        availability: L.availabilityInfo ?? null,
        agent_name: L.agent?.name ?? null,
        facts: [L.mrt?.nearbyText, ...feats].filter(Boolean),
        posted_at: L.postedOn?.text ?? L.recency?.text ?? null
      };
    })
  };
}
