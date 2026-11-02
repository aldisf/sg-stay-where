const EARTH_RADIUS_M = 6_371_000;

// Streets are not straight lines; 1.3x is a common urban detour factor.
export const WALK_DETOUR = 1.3;
export const WALK_M_PER_MIN = 80;

export function haversine(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function walkEstimate(straightMeters) {
  const meters = straightMeters * WALK_DETOUR;
  return { meters: Math.round(meters), minutes: Math.max(1, Math.round(meters / WALK_M_PER_MIN)) };
}

export function nearest(origin, points, { limit = 3, withinMeters = Infinity, groupBy = null } = {}) {
  const scored = points
    .map((p) => ({ ...p, meters: Math.round(haversine(origin, p)) }))
    .filter((p) => p.meters <= withinMeters)
    .sort((a, b) => a.meters - b.meters);
  // groupBy keeps only the closest entry per group (e.g. one exit per station).
  const seen = new Set();
  const picked = [];
  for (const p of scored) {
    const group = groupBy ? groupBy(p) : null;
    if (group != null) {
      if (seen.has(group)) continue;
      seen.add(group);
    }
    picked.push({ ...p, walk: walkEstimate(p.meters) });
    if (picked.length >= limit) break;
  }
  return picked;
}

export function isInSingapore({ lat, lng } = {}) {
  return lat > 1.15 && lat < 1.48 && lng > 103.6 && lng < 104.1;
}
