// Runs inside google.com/maps (Claude in Chrome). gmHelpers() returns:
//
// places(origin, { match, limit }): the results of a Maps search ("laundromat",
// "hawker centre", ...) as [{ name, lat, lng, meters, walk_min }] nearest
// first, keeping names that match the `match` regex (case-insensitive) when
// given. Maps lists results by relevance and loads more as the list scrolls, so
// the nearest is often not among the first; it scrolls until 20 results or the
// list stops growing (at most 5 scrolls). Coordinates come from each result's
// link; meters is straight-line, walk_min an estimate (x1.3 detour at 80 m/min);
// route a walk with duration() when the exact time matters.
//
// duration(): the fastest suggested trip on a directions page, as
// { minutes, meters, summary }. Maps does not always suggest the fastest first.
function gmHelpers() {
  const rad = (d) => (d * Math.PI) / 180;
  const dist = (a, b) => {
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  const results = () => {
    const byName = new Map();
    for (const a of document.querySelectorAll('a[href*="/maps/place/"]')) {
      const m = a.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
      // Google appends "· Visited link" to places you opened before; it is not part of the name.
      const name = (a.getAttribute("aria-label") || a.textContent || "").replace(/\s*·?\s*Visited link\s*$/i, "").trim();
      if (m && name && !byName.has(name)) byName.set(name, { name, lat: Number(m[1]), lng: Number(m[2]) });
    }
    return [...byName.values()];
  };

  async function places(origin, { match = null, limit = 3 } = {}) {
    const feed = document.querySelector('[role="feed"]');
    for (let i = 0, count = results().length; feed && count < 20 && i < 5; i++) {
      feed.scrollTop = feed.scrollHeight;
      await new Promise((r) => setTimeout(r, 2000));
      const now = results().length;
      if (now === count) break;
      count = now;
    }
    const re = match ? new RegExp(match, "i") : null;
    return results()
      .filter((p) => !re || re.test(p.name))
      .map((p) => {
        const meters = Math.round(dist(origin, p));
        return { ...p, meters, walk_min: Math.max(1, Math.round((meters * 1.3) / 80)) };
      })
      .sort((x, y) => x.meters - y.meters)
      .slice(0, limit);
  }

  function duration() {
    const trips = new Map();
    for (const el of document.querySelectorAll("[data-trip-index]")) {
      const i = el.getAttribute("data-trip-index");
      if (trips.has(i)) continue;
      const text = el.innerText.replace(/\s+/g, " ").trim();
      // The trip's duration: "35 min", "1 hr 7 min" or a bare "1 hr".
      const m = text.match(/(\d+)\s*hr(?:\s*(\d+)\s*min)?|(\d+)\s*min/);
      const d = text.match(/(\d+(?:\.\d+)?)\s*(km|m)\b/);
      if (m) trips.set(i, {
        minutes: m[1] ? Number(m[1]) * 60 + Number(m[2] ?? 0) : Number(m[3]),
        meters: d ? Math.round(Number(d[1]) * (d[2] === "km" ? 1000 : 1)) : null,
        summary: text.slice(0, 120)
      });
    }
    return [...trips.values()].sort((a, b) => a.minutes - b.minutes)[0] ?? null;
  }

  return { places, duration };
}
