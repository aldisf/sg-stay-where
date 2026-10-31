// Copies from rent-finding-2026; never modifies the old folder. Stop the old
// server first: two processes must not share one WhatsApp session.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ProjectFiles } from "./projects.js";

const read = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

// Old config keys stay the criterion keys, so stored Google Maps results line up.
const NEARBY = {
  laundromat: { icon: "washing-machine", bestMinutes: 3, worstMinutes: 15, maxMinutes: 10, weight: 3 },
  hawker: { icon: "soup", match: "hawker|food cent|market|food village|food court|tekka centre|lau pa sat|chinatown complex", bestMinutes: 5, worstMinutes: 20, maxMinutes: 15, weight: 5 },
  fitness_first: { icon: "dumbbell", match: "fitness first", bestMinutes: 10, worstMinutes: 30, maxMinutes: 20, weight: 2.5 }
};
const COMMUTE_ICONS = ["briefcase", "hotel", "building-2", "school"];

export function legacyProject({ targets, facilities, searches, skip, profile }) {
  const { budget = {}, ...message } = profile ?? {};
  return {
    id: "2026-rent",
    title: "2026 Rent",
    archived: false,
    created_at: new Date().toISOString(),
    budget: { min: budget.min ?? 0, max: budget.max ?? 0, stretchMax: budget.stretchMax ?? budget.max ?? 0, spread: budget.spread ?? 300 },
    home: { types: ["Studio", "1BR", "2BR"], wholeUnit: true },
    criteria: [
      ...targets.map((t, i) => ({ type: "commute", key: t.key, label: t.label, icon: COMMUTE_ICONS[i] ?? "map-pin", query: t.maps_query, lat: t.lat, lng: t.lng, bestMinutes: 20, worstMinutes: 50, maxMinutes: 35, weight: 15 })),
      { type: "station", key: "mrt", label: "MRT", weight: 13 },
      { type: "price", key: "price", weight: 17 },
      ...facilities.map((f) => ({ type: "nearby", key: f.key, label: f.label, search: f.maps_query, zoom: f.zoom, ...(NEARBY[f.key] ?? {}) })),
      { type: "size", key: "size", goodSqft: 750, smallSqft: 350, weight: 6 },
      { type: "furnishing", key: "furnishing", weight: 3.5 },
      { type: "move_in", key: "move_in", from: "2026-12", to: "2027-01", weight: 2.5 },
      { type: "lease", key: "lease", maxYears: 1.5, weight: 2.5 }
    ],
    bonus: { allBoxes: 10, proximity: 5 },
    filters: { hideColiving: true },
    searches: searches.map((s, i) => ({ id: i ? `search-${i + 1}` : "main", title: s.name, site: /99\.co/.test(s.url) ? "99co" : "propertyguru", url: s.url, pages: s.pages ?? 1, active: true, why: s.why })),
    skip: { agents: skip.agents ?? [], titlePatterns: skip.titlePatterns ?? [] },
    message
  };
}

export function importLegacy({ from, data }) {
  const config = path.join(from, "config");
  const state = path.join(from, "state");
  if (!existsSync(path.join(state, "rent.sqlite"))) throw new Error(`no state/rent.sqlite in ${from}`);
  const target = path.join(data, "sg-stay-where.sqlite");
  if (existsSync(target)) throw new Error(`${target} exists; import into an empty data folder`);
  mkdirSync(data, { recursive: true });
  const project = legacyProject({
    targets: read(path.join(config, "targets.json"), []),
    facilities: read(path.join(config, "facilities.json"), []),
    searches: read(path.join(config, "searches.json"), []),
    skip: read(path.join(config, "poll-skip.json"), {}),
    profile: read(path.join(state, "profile.json"), {})
  });
  new ProjectFiles(path.join(data, "projects")).save(project);
  // Listings join the project on first start.
  for (const name of ["rent.sqlite", "rent.sqlite-wal", "rent.sqlite-shm"]) {
    if (existsSync(path.join(state, name))) cpSync(path.join(state, name), path.join(data, name.replace("rent.sqlite", "sg-stay-where.sqlite")));
  }
  for (const dir of ["media", "whatsapp-auth"]) if (existsSync(path.join(state, dir))) cpSync(path.join(state, dir), path.join(data, dir), { recursive: true });
  const linked = existsSync(path.join(state, "whatsapp-auth", "creds.json"));
  writeFileSync(path.join(data, "whatsapp.json"), `${JSON.stringify({ deviceName: "rent-tracker", ...read(path.join(state, "whatsapp.json"), {}), enabled: linked }, null, 2)}\n`);
  if (existsSync(path.join(state, "server.json"))) cpSync(path.join(state, "server.json"), path.join(data, "server.json"));
  return `imported "${project.title}" (${project.criteria.length} criteria, ${project.searches.length} search) into ${data}; WhatsApp ${linked ? "stays linked" : "off"}`;
}
