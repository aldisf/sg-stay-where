// Fictional: made-up buildings and agents (+65 8000 00xx), drawn rooms.
// Nothing here comes from a listing site or a real chat.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./db.js";
import { ProjectFiles } from "./projects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function roomSvg(kind, palette) {
  const { wall, floor, accent, wood, sky } = palette;
  const windowBox = `<rect x="470" y="70" width="250" height="220" rx="8" fill="${sky}"/><rect x="490" y="200" width="40" height="90" fill="#9fb3c8" opacity=".55"/><rect x="540" y="160" width="55" height="130" fill="#8aa1b9" opacity=".55"/><rect x="605" y="185" width="45" height="105" fill="#9fb3c8" opacity=".55"/><rect x="470" y="70" width="250" height="220" rx="8" fill="none" stroke="#fff" stroke-width="10"/><line x1="595" y1="70" x2="595" y2="290" stroke="#fff" stroke-width="8"/>`;
  const plant = `<rect x="700" y="370" width="50" height="50" rx="6" fill="${wood}"/><circle cx="712" cy="350" r="26" fill="#4f7d5c"/><circle cx="740" cy="335" r="30" fill="#5d8f6a"/><circle cx="726" cy="310" r="24" fill="#6fa27a"/>`;
  const scenes = {
    living: `${windowBox}<rect x="120" y="110" width="150" height="100" rx="4" fill="${accent}" opacity=".35"/><ellipse cx="300" cy="470" rx="250" ry="40" fill="${accent}" opacity=".18"/>
      <rect x="70" y="250" width="330" height="80" rx="22" fill="${accent}" opacity=".85"/><rect x="60" y="300" width="350" height="100" rx="24" fill="${accent}"/><rect x="80" y="395" width="14" height="22" fill="${wood}"/><rect x="376" y="395" width="14" height="22" fill="${wood}"/>
      <rect x="190" y="440" width="190" height="16" rx="5" fill="${wood}"/><rect x="205" y="455" width="10" height="35" fill="${wood}"/><rect x="355" y="455" width="10" height="35" fill="${wood}"/>${plant}`,
    bedroom: `${windowBox}<rect x="60" y="230" width="380" height="60" rx="12" fill="${wood}"/><rect x="70" y="285" width="360" height="130" rx="14" fill="#fbfaf7"/><rect x="70" y="330" width="360" height="85" rx="14" fill="${accent}" opacity=".8"/>
      <rect x="95" y="290" width="120" height="40" rx="14" fill="#eceae4"/><rect x="235" y="290" width="120" height="40" rx="14" fill="#eceae4"/><rect x="455" y="340" width="70" height="70" rx="6" fill="${wood}"/><circle cx="490" cy="320" r="16" fill="#f3d58a"/>`,
    kitchen: `<rect x="40" y="90" width="720" height="110" rx="6" fill="${accent}" opacity=".8"/><rect x="40" y="290" width="720" height="130" rx="6" fill="${accent}"/><rect x="30" y="275" width="740" height="22" rx="4" fill="#e9e6df"/>
      <rect x="520" y="230" width="130" height="45" rx="8" fill="#c9ccd1"/><rect x="140" y="215" width="40" height="60" rx="6" fill="${wood}"/><circle cx="300" cy="250" r="22" fill="#d9dde2"/><line x1="40" y1="355" x2="760" y2="355" stroke="#fff" stroke-opacity=".25" stroke-width="3"/>
      ${[100, 280, 460, 640].map((x) => `<rect x="${x}" y="320" width="40" height="6" rx="3" fill="#fff" opacity=".6"/>`).join("")}`
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 550"><rect width="800" height="550" fill="${wall}"/><rect y="420" width="800" height="130" fill="${floor}"/>${scenes[kind]}</svg>`;
}

const PALETTES = [
  { wall: "#efe9df", floor: "#c9a77c", accent: "#5b7b8c", wood: "#8a6440", sky: "#cfe3f2" },
  { wall: "#e8eef0", floor: "#b9a48a", accent: "#7c8f6a", wood: "#6f5338", sky: "#d6e9f5" },
  { wall: "#f3ede6", floor: "#d2b48c", accent: "#b46a55", wood: "#7a5a3a", sky: "#e0eef7" },
  { wall: "#ebe7f0", floor: "#a89279", accent: "#6a6f9c", wood: "#5e4630", sky: "#d3e4f1" },
  { wall: "#eef0e8", floor: "#c4ad8f", accent: "#3f7f78", wood: "#80603f", sky: "#dbeaf5" }
];

// [building, area, type, beds, sqft, price, lat, lng, station, mrt walk, office, partner office, laundromat, hawker, gym, furnishing, lease, available, status, found hours ago]
const LISTINGS = [
  ["Kampong Bahru Lofts", "D03 Tiong Bahru / Redhill", "Condominium", 1, 560, 3100, 1.2745, 103.8352, "Outram Park", 6, 16, 27, 3, 5, 7, "Fully Furnished", 1, "Available from 1 Dec 2026", "new", 2],
  ["Everton Park Walk-up", "D02 Tanjong Pagar", "Apartment", 1, 480, 2900, 1.2769, 103.8389, "Outram Park", 5, 14, 29, 4, 3, 9, "Fully Furnished", 1, "Available from 15 Dec 2026", "new", 3],
  ["Tiong Bahru Courtyard", "D03 Tiong Bahru", "Apartment", 2, 720, 3400, 1.2851, 103.8320, "Tiong Bahru", 7, 18, 24, 5, 4, 11, "Partially Furnished", 2, "Ready to move", "new", 5],
  ["River Valley Terrace", "D09 River Valley", "Condominium", 0, 410, 2750, 1.2934, 103.8350, "Fort Canning", 9, 19, 26, 6, 9, 6, "Fully Furnished", 1, "Available from 1 Jan 2027", "new", 6],
  ["Novena Garden Suites", "D11 Novena", "Condominium", 1, 590, 3200, 1.3201, 103.8435, "Novena", 6, 24, 30, 8, 7, 5, "Fully Furnished", 1, "Available from 1 Dec 2026", "new", 9],
  ["Farrer Park Flats", "D08 Little India", "HDB Flat", 2, 750, 3000, 1.3122, 103.8540, "Farrer Park", 4, 21, 33, 2, 2, 14, "Fully Furnished", 1, "Available from 20 Dec 2026", "new", 20],
  ["Telok Ayer Shophouse Loft", "D01 Raffles Place", "Apartment", 1, 520, 3450, 1.2808, 103.8478, "Telok Ayer", 3, 8, 31, 9, 4, 4, "Fully Furnished", 1, "Available from 1 Dec 2026", "shortlisted", 30],
  ["Holland Grove Residences", "D10 Holland", "Condominium", 2, 820, 3500, 1.3110, 103.7960, "Holland Village", 8, 27, 12, 6, 6, 9, "Fully Furnished", 1, "Available from 1 Jan 2027", "shortlisted", 40],
  ["Queenstown Heights", "D03 Queenstown", "HDB Flat", 2, 700, 2800, 1.2952, 103.8060, "Queenstown", 5, 22, 15, 4, 3, 12, "Partially Furnished", 1, "Available from 1 Dec 2026", "shortlisted", 44],
  ["Outram Hill", "D03 Outram", "HDB Flat", 1, 540, 2700, 1.2786, 103.8322, "Outram Park", 7, 15, 26, 5, 2, 10, "Fully Furnished", 2, "Ready to move", "contacted", 52],
  ["Balestier Point Homes", "D12 Balestier", "Condominium", 1, 610, 2950, 1.3260, 103.8510, "Novena", 17, 32, 34, 3, 4, 15, "Fully Furnished", 1, "Available from 1 Dec 2026", "replied", 60],
  ["Kallang Riverside", "D12 Kallang", "Condominium", 2, 780, 3300, 1.3110, 103.8655, "Kallang", 6, 23, 36, 7, 8, 13, "Fully Furnished", 1, "Available from 15 Dec 2026", "viewing_scheduled", 70],
  ["Bukit Merah View", "D03 Bukit Merah", "HDB Flat", 1, 500, 2600, 1.2838, 103.8228, "Tiong Bahru", 12, 20, 22, 3, 2, 18, "Unfurnished", 2, "Ready to move", "rejected", 80]
];

const AGENTS = ["Rachel Tan", "Marcus Lee", "Siti Rahman", "Daniel Ong", "Priya Nair", "Jason Koh"];
const offset = (lat, lng, dLat, dLng) => ({ lat: +(lat + dLat).toFixed(5), lng: +(lng + dLng).toFixed(5) });

export async function seedDemo(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  // Marks the folder as demo: the server shows a stand-in WhatsApp that cannot send.
  writeFileSync(path.join(dir, "demo.json"), `${JSON.stringify({ demo: true }, null, 2)}\n`);
  const projects = new ProjectFiles(path.join(dir, "projects"));
  const example = JSON.parse(readFileSync(path.join(ROOT, "examples/2026-rent.project.json"), "utf8"));
  projects.save(example);
  projects.save({
    ...structuredClone(example), id: "parents-hdb", title: "Parents' HDB", archived: false, deal: "buy",
    budget: { min: 0, max: 650000, stretchMax: 700000, spread: 20000 },
    criteria: [
      { type: "commute", key: "clinic", label: "Polyclinic", icon: "stethoscope", query: "Bishan Polyclinic, Singapore", lat: 1.3519, lng: 103.8499, maxMinutes: 20, weight: 15 },
      { type: "station", key: "mrt", label: "MRT", maxMinutes: 10, allowBus: false, weight: 15 },
      { type: "nearby", key: "market", label: "Wet market", icon: "shopping-cart", search: "wet market", maxMinutes: 10, weight: 8 },
      { type: "nearby", key: "park", label: "Park", icon: "trees", search: "park", maxMinutes: 10, mustHave: false, weight: 4 },
      { type: "price", key: "price", weight: 15 }
    ],
    searches: [{ id: "pg-bishan", title: "PropertyGuru · Bishan 3-room HDB", site: "propertyguru", url: "https://www.propertyguru.com.sg/property-for-sale?market=residential&property_type=H&freetext=Bishan", pages: 1, active: false }],
    message: {}
  });
  writeFileSync(path.join(dir, "settings.json"), `${JSON.stringify({ currentProject: example.id }, null, 2)}\n`);

  const store = new Store(path.join(dir, "sg-stay-where.sqlite"));
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  for (const [i, row] of LISTINGS.entries()) {
    const [building, district, type, beds, sqft, price, lat, lng, station, mrtWalk, office, partner, laundromat, hawker, gym, furnishing, lease, available, status, hoursAgo] = row;
    const slug = building.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const agent = AGENTS[i % AGENTS.length];
    const { listing } = store.upsertListing({
      project_id: example.id, source: "propertyguru", source_id: `demo${900001 + i}`,
      url: `https://www.propertyguru.com.sg/listing/for-rent-${slug}-demo${900001 + i}`,
      title: `${beds === 0 ? "Studio" : `${beds} bedroom`} at ${building}`, building, district, address: `${building}, Singapore`,
      property_type: type, bedrooms: beds, bathrooms: Math.max(1, beds), sqft, price, furnishing, lease: `${lease} year${lease > 1 ? "s" : ""} lease`, availability: available,
      facts: [type, `${lease} year${lease > 1 ? "s" : ""} lease`, furnishing, available],
      agent_name: `${agent} (demo)`, agent_phone: `658000${String(10 + i).padStart(4, "0")}`, agent_agency: "Example Realty",
      lat, lng, found_by: "poll", details_at: new Date(now - hoursAgo * 3600e3).toISOString(),
      source_mrts: [{ name: `${station} MRT`, ...offset(lat, lng, 0.003, -0.002) }]
    });
    store.db.prepare("UPDATE listings SET created_at = ?, status = ? WHERE id = ?").run(new Date(now - hoursAgo * 3600e3).toISOString(), status, listing.id);
    const media = path.join(dir, "media", String(listing.id));
    mkdirSync(media, { recursive: true });
    const palette = PALETTES[i % PALETTES.length];
    for (const kind of ["living", "bedroom", "kitchen"]) writeFileSync(path.join(media, `${kind}.svg`), roomSvg(kind, palette));
    store.db.prepare("UPDATE listings SET photos = ? WHERE id = ?").run(JSON.stringify(["living", "bedroom", "kitchen"].map((k) => ({ src: `/media/${listing.id}/${k}.svg`, kind: "photo" }))), listing.id);
    // The drawings share one layout, so real fingerprints would match across flats
    // and merge them. Distinct stand-in fingerprints keep every fictional flat its own.
    store.setPhotoHashes(listing.id, ["living", "bedroom", "kitchen"].map((k) => createHash("sha256").update(`${slug}/${k}`).digest("hex").slice(0, 16)));
    const place = (name, walk, dLat, dLng) => [{ name, walk_min: walk, meters: walk * 80, routed: true, ...offset(lat, lng, dLat, dLng) }];
    store.setEnrichment(listing.id, {
      source: "demo", checked_at: new Date(now - (hoursAgo - 1) * 3600e3).toISOString(),
      mrt: [{ name: `${station} MRT`, walk_min: mrtWalk, walk_m: mrtWalk * 80, ...offset(lat, lng, 0.003, -0.002), ...(mrtWalk > 15 ? { transit_min: 11, transit_summary: "8:30 AM–8:41 AM bus 145" } : {}) }],
      commute: { office: { transit_min: office, summary: "MRT" }, partner_office: { transit_min: partner, summary: "MRT" } },
      facilities: {
        laundromat: place("Wash & Fold (demo)", laundromat, -0.0015, 0.001),
        hawker: place(`${district.split(" ").slice(1).join(" ")} Food Centre (demo)`, hawker, 0.001, 0.002),
        gym: place("Neighbourhood Gym (demo)", gym, -0.002, -0.0025)
      }
    });
    if (["contacted", "replied", "viewing_scheduled"].includes(status)) {
      const jid = `${listing.agent_phone}@s.whatsapp.net`;
      store.flagChat(jid, { reason: "link", phone: listing.agent_phone, name: `${agent} (demo)` });
      const t0 = nowS - hoursAgo * 3600 + 1800;
      const msgs = [{ id: `d${i}a`, fromMe: true, ts: t0, text: `Hi ${agent.split(" ")[0]}, I'm Alex. I'm interested in your listing on PropertyGuru: ${listing.title} (S$${price.toLocaleString("en-SG")}/month)\n${listing.url}\n\nDetails:\n- Couple, both working professionals\n- Move-in: Dec 2026 or Jan 2027\n\nCould we arrange a viewing? Thank you!` }];
      if (status !== "contacted") msgs.push({ id: `d${i}b`, fromMe: false, ts: t0 + 3600, text: "Hi Alex, yes it's still available. When would you like to view?" });
      if (status === "viewing_scheduled") {
        msgs.push({ id: `d${i}c`, fromMe: true, ts: t0 + 4000, text: "Tomorrow after 7pm works for us." });
        msgs.push({ id: `d${i}d`, fromMe: false, ts: t0 + 4600, text: "Ok see you tomorrow 7:15pm at the lobby." });
      }
      store.addMessages(jid, msgs);
      store.linkChat(jid, listing.id, "link");
      store.refreshLead(listing.id);
      store.db.prepare("UPDATE listings SET status = ? WHERE id = ?").run(status, listing.id);
      if (status === "viewing_scheduled") {
        const tomorrow = new Date(now + 86400e3);
        const at = `${tomorrow.toISOString().slice(0, 10)}T19:15:00+08:00`;
        store.setSummary(listing.id, { decision: "viewing", text: "The agent confirmed the unit is available and offered a viewing.", viewing: { at, place: "Lobby", confirmed: true }, next: "View tomorrow 7:15pm; bring IC and ask about the lease break clause.", through_ts: t0 + 4600 });
      }
      if (status === "replied") store.setSummary(listing.id, { decision: "maybe", text: "Available; agent asked when you'd like to view.", next: "Reply with a viewing time.", through_ts: t0 + 3600 });
    }
  }
  // What the WhatsApp filter keeps for chats it does not store: a reason or a count, never text.
  store.ignoreChat("6590000101@s.whatsapp.net", "personal");
  store.ignoreChat("6590000102@s.whatsapp.net", "excluded");
  store.set("wa.dropped_counts", { "6590000103@s.whatsapp.net": 4, "6590000104@s.whatsapp.net": 37, "6590000105@s.whatsapp.net": 212 });
  store.recordPoll({ search: example.searches[0].title, seen: 21, added: 6, note: null });
  store.close();
  return dir;
}
