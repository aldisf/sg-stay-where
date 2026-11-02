import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POLL_LIMITS, validPages } from "./searches.js";

export const CRITERION_TYPES = {
  // Transit time to a place you go to often (work, school), by Google Maps at a fixed departure time.
  commute: { required: ["label", "query"], defaults: { icon: "briefcase", bestMinutes: 20, worstMinutes: 50, maxMinutes: 35, departAt: "08:30", weight: 15 } },
  // Walking time to the nearest place of a kind (gym chain, hawker centre, laundromat, park).
  nearby: { required: ["label", "search"], defaults: { icon: "map-pin", bestMinutes: 5, worstMinutes: 20, maxMinutes: 15, weight: 4 } },
  // Nearest train station: walk under maxWalkMeters, or a bus, within maxMinutes.
  station: { required: [], defaults: { label: "MRT", icon: "train-front", bestMinutes: 5, maxMinutes: 15, maxWalkMeters: 1000, allowBus: true, weight: 13 } },
  price: { required: [], defaults: { label: "Price", icon: "tag", weight: 17 } },
  size: { required: [], defaults: { label: "Size", icon: "ruler", goodSqft: 750, smallSqft: 350, mustHave: false, weight: 6 } },
  furnishing: { required: [], defaults: { label: "Furnishing", icon: "sofa", weight: 3.5 } },
  move_in: { required: [], defaults: { label: "Move-in", icon: "calendar", mustHave: false, weight: 2.5 } },
  lease: { required: [], defaults: { label: "Lease", icon: "file-text", maxYears: 1.5, weight: 2.5 } }
};

export const SITES = ["propertyguru", "99co", "carousell"];
export const DEALS = ["rent", "buy"];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ICON_RE = /^[a-z0-9-]{1,40}$/;
const ICON_DIR = fileURLToPath(new URL("../public/icons/", import.meta.url));

export function slugify(text) {
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "project";
}

// mustHave: part of the "all boxes ticked" check.
export function criterion(c) {
  const type = CRITERION_TYPES[c.type];
  return { mustHave: true, ...(type?.defaults ?? {}), ...c, key: c.key ?? c.type };
}

export function criteriaOf(project) {
  return (project?.criteria ?? []).map(criterion);
}

export function mapCriteriaKey(project) {
  return JSON.stringify(criteriaOf(project).filter(c => ["commute", "nearby", "station"].includes(c.type))
    .map(({ label, icon, weight, mustHave, ...route }) => route));
}

export function checkProject(p) {
  const errors = [];
  if (!p || typeof p !== "object") return ["project must be an object"];
  if (!SLUG_RE.test(p.id ?? "")) errors.push(`id "${p.id}" must be lowercase letters, digits and dashes`);
  if (!p.title) errors.push("title is required");
  const b = p.budget ?? {};
  for (const k of ["min", "max"]) if (!Number.isFinite(b[k])) errors.push(`budget.${k} must be a number`);
  if (b.min < 0 || b.max < b.min) errors.push("budget must have 0 ≤ min ≤ max");
  if (b.stretchMax != null && !Number.isFinite(b.stretchMax)) errors.push("budget.stretchMax must be a number");
  if (b.stretchMax != null && b.stretchMax < (b.max ?? 0)) errors.push("budget.stretchMax must be at least budget.max");
  const keys = new Set();
  for (const [i, raw] of (p.criteria ?? []).entries()) {
    const where = `criteria[${i}]`;
    const type = CRITERION_TYPES[raw.type];
    if (!type) { errors.push(`${where}.type "${raw.type}" is not one of ${Object.keys(CRITERION_TYPES).join(", ")}`); continue; }
    const c = criterion(raw);
    if (!KEY_RE.test(c.key)) errors.push(`${where}.key "${c.key}" must be snake_case`);
    if (keys.has(c.key)) errors.push(`${where}.key "${c.key}" is used twice`);
    keys.add(c.key);
    for (const field of type.required) if (!c[field]) errors.push(`${where} (${c.type}) needs ${field}`);
    if (!ICON_RE.test(c.icon ?? "")) errors.push(`${where}.icon "${c.icon}" must be a Lucide icon name`);
    else if (!existsSync(path.join(ICON_DIR, `${c.icon}.svg`))) errors.push(`${where}.icon "${c.icon}" is not in public/icons; add it: curl -o public/icons/${c.icon}.svg https://cdn.jsdelivr.net/npm/lucide-static@1.54.0/icons/${c.icon}.svg`);
    if (!(c.weight >= 0)) errors.push(`${where}.weight must be ≥ 0`);
    if (c.type === "commute" && (c.lat != null) !== (c.lng != null)) errors.push(`${where} needs both lat and lng (or neither)`);
    if (c.type === "nearby" && c.match) { try { new RegExp(c.match, "i"); } catch { errors.push(`${where}.match is not a valid regex`); } }
  }
  if (["station", "price"].some((t) => (p.criteria ?? []).filter((c) => c.type === t).length > 1)) errors.push("at most one station and one price criterion");
  if (p.deal != null && !DEALS.includes(p.deal)) errors.push('deal must be "rent" or "buy"');
  const ids = new Set();
  for (const [i, s] of (p.searches ?? []).entries()) {
    if (!SLUG_RE.test(s.id ?? "")) errors.push(`searches[${i}].id must be a slug`);
    if (ids.has(s.id)) errors.push(`searches[${i}].id "${s.id}" is used twice`);
    ids.add(s.id);
    if (!s.title) errors.push(`searches[${i}].title is required`);
    if (!/^https:\/\/(www\.)?(propertyguru\.com\.sg|99\.co|carousell\.sg)\//.test(s.url ?? "")) errors.push(`searches[${i}].url must be a PropertyGuru, 99.co or Carousell search URL`);
    if (s.pages != null && !validPages(s.pages)) errors.push(`searches[${i}].pages must be between 1 and ${POLL_LIMITS.pages.max} (polls stay gentle on the sites)`);
  }
  const listings = p.poll?.listings;
  if (listings != null && !(Number.isInteger(listings) && listings >= 1 && listings <= POLL_LIMITS.listings.max)) errors.push(`poll.listings must be between 1 and ${POLL_LIMITS.listings.max}`);
  const rpm = p.poll?.rpm;
  if (rpm != null && !(Number.isInteger(rpm) && rpm >= 1 && rpm <= POLL_LIMITS.rpm.max)) errors.push(`poll.rpm must be between 1 and ${POLL_LIMITS.rpm.max}`);
  for (const pattern of p.skip?.titlePatterns ?? []) { try { new RegExp(pattern, "i"); } catch { errors.push(`skip.titlePatterns "${pattern}" is not a valid regex`); } }
  return errors;
}

// The facts an intro needs before the user reviews listings, by deal.
const PROFILE_FIELDS = {
  rent: [["name", "first name"], ["household", "household"], ["residency", "residency"], ["moveIn", "move-in"], ["lease", "lease"]],
  buy: [["name", "first name"], ["household", "household"], ["residency", "residency"], ["financing", "financing"], ["moveIn", "timeline"]]
};

export function profileMissing(project) {
  const m = project?.message ?? {};
  return PROFILE_FIELDS[project?.deal === "buy" ? "buy" : "rent"].filter(([key]) => !String(m[key] ?? "").trim()).map(([, label]) => label);
}

export function messageProfile(project) {
  return { ...(project?.message ?? {}), budget: project?.budget ?? {}, deal: project?.deal ?? "rent" };
}

// No places yet: the interview adds those.
export function newProject({ title, copyFrom = null, deal = copyFrom?.deal ?? "rent" }) {
  const buy = deal === "buy";
  const base = copyFrom ? structuredClone(copyFrom) : {
    budget: { min: 0, max: 0, stretchMax: 0, spread: buy ? 20000 : 300 },
    home: {},
    // Buying has no furnishing or rental-lease criteria; the interview adds tenure if it matters.
    criteria: buy ? [{ type: "station" }, { type: "price" }, { type: "size" }, { type: "move_in" }]
      : [{ type: "station" }, { type: "price" }, { type: "size" }, { type: "furnishing" }, { type: "move_in" }, { type: "lease" }],
    bonus: { allBoxes: 10, proximity: 5 },
    filters: { hideColiving: true },
    searches: [],
    skip: { agents: [], titlePatterns: [] },
    message: {}
  };
  return { ...base, deal, id: slugify(title), title, archived: false, created_at: new Date().toISOString(), searches: copyFrom ? base.searches.map((s) => ({ ...s, active: false })) : base.searches };
}

export class ProjectFiles {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  file(id) {
    if (!SLUG_RE.test(id ?? "")) throw new Error(`bad project id ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort()
      .map((f) => { try { return JSON.parse(readFileSync(path.join(this.dir, f), "utf8")); } catch { return null; } })
      .filter(Boolean);
  }

  get(id) {
    const file = this.file(id);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  }

  save(project) {
    const errors = checkProject(project);
    if (errors.length) throw Object.assign(new Error(`invalid project: ${errors.join("; ")}`), { errors });
    writeFileSync(this.file(project.id), `${JSON.stringify(project, null, 2)}\n`);
    return project;
  }

  create({ title, copyFrom, deal }) {
    const project = newProject({ title, copyFrom: copyFrom ? this.get(copyFrom) : null, ...(deal ? { deal } : {}) });
    let id = project.id;
    for (let n = 2; this.get(id); n++) id = `${project.id}-${n}`;
    project.id = id;
    // A blank project has no budget yet; the interview fills it in.
    if (!project.budget.max) Object.assign(project.budget, { min: 0, max: 0 });
    return this.save(project);
  }
}
