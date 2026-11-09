// Local web app + JSON API. Binds to 127.0.0.1 only; other devices reach it
// through an optional private tunnel such as `tailscale serve`.
//
// Cross-site protection: a page on another origin must not be able to drive
// this API (it can send WhatsApp messages). Every request must carry a known
// Host header (DNS rebinding), and every write must be JSON (forces a CORS
// preflight we never answer) from our own origin. Requests arriving through
// Tailscale must carry the Tailscale-User-Login that `tailscale serve` adds,
// and it must be one of data/server.json "allowedLogins".
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { assetServer } from "./assets.js";
import path from "node:path";
import { likeness, pickPrimary, sameListing, sameUnit } from "./dedupe.js";
import { haversine, walkEstimate } from "./geo.js";
import { budgetRange, composeIntro, DEFAULT_TEMPLATE } from "./intro.js";
import { leadSignals } from "./leads.js";
import { detailDue, hiddenByUser, mapsDue, needsRecheck, pollMaySetStatus, stage, STATUSES } from "./lifecycle.js";
import { parseListingUrl } from "./links.js";
import { normalizePhone } from "./phone.js";
import { checkProject, CRITERION_TYPES, criteriaOf, DEALS, mapCriteriaKey, messageProfile, profileMissing, slugify } from "./projects.js";
import { isColiving, scoreListing } from "./score.js";
import { applyTemplate, DISTRICTS, filtersFromPropertyGuru, newestFirst, POLL_LIMITS } from "./searches.js";
import { canHashOnServer, photoQueue, photoUrls } from "./photos.js";
import { JOBS, lockHolder, POLL_GAP_MIN, sitesGap } from "./poll.js";
import { PollRuns } from "./poll-runs.js";
import { PortalPacer } from "./poll-policy.js";

import { overrideSearchBrief, projectVersion, requestSearchBrief, resolveSearchBrief } from "./search-brief.js";

const PORT = Number(process.env.SSW_PORT || 7431);
const HOST = "127.0.0.1";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}

async function body(req) {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "send application/json");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new HttpError(413, "body too large");
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, "invalid JSON"); }
}

const SHARE_MAPS_DAYS = 90;
// The Maps agent stops taking work after this, so a run ends before the next
// scheduled poll (launchd, systemd and Task Scheduler skip a start while one runs).
const MAPS_RUN_MINUTES = 100;
// A scheduled poll every 2 hours; past 4 hours without one, something stopped it.
const POLL_STALLED_MS = 4 * 3600_000;
// The scheduled poll's job files (scripts/install-macos.sh, skills/schedule-polls).
const POLL_JOBS = [
  path.join(homedir(), "Library/LaunchAgents/sg-stay-where.poll.plist"),
  path.join(homedir(), ".config/systemd/user/sg-stay-where-poll.timer"),
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "Tasks", "sg-stay-where-poll"),
];

export async function startServer({ root, dataDir, store, projects, wa = null, log, pollCommand = [process.execPath, "--no-warnings=ExperimentalWarning", path.join(root, "src/cli.js"), "poll"], pollJobs = POLL_JOBS }) {
  let pollChild = null;
  const runs = new PollRuns(store.db);
  // Each poll job holds a lock with its pid (src/poll.js), so a scheduled poll counts too.
  const jobRunning = (job) => lockHolder(path.join(dataDir, JOBS[job].lock)) !== 0;
  const pollRunning = () => !!pollChild || Object.keys(JOBS).some(jobRunning);
  const pollScheduled = () => pollJobs.some((f) => existsSync(f));

  function pollStatus(p) {
    runs.reconcile();
    const latest = runs.recent("sites", 1)[0] ?? null;
    const latestMaps = runs.recent("maps", 1)[0] ?? null;
    const failure = [latest, latestMaps].filter(r => r && ["failed", "interrupted"].includes(r.state))
      .find(r => !latest || r.started_at >= latest.started_at || r.id === latest.id);
    const lastAt = latest?.finished_at ?? latest?.started_at ?? store.recentPolls(1)[0]?.at ?? null;
    const running = pollRunning();
    const scheduled = pollScheduled();
    const last = store.lastPollBySearch();
    const active = (p.searches ?? []).filter(s => s.active !== false);
    const skipped = latest
      ? latest.searches.filter(s => s.project_id === p.id && s.outcome === "skipped").map(s => ({ search: s.title, note: s.note, at: latest.finished_at }))
      : active.filter(s => /^skipped\s*:/i.test(last[s.title]?.note ?? "")).map(s => ({ search: s.title, note: last[s.title].note, at: last[s.title].at }));
    const health = running ? "running"
      : scheduled && (!lastAt || Date.now() - Date.parse(lastAt) > POLL_STALLED_MS) ? "stalled"
        : failure ? "failed"
          : latest?.state === "blocked" || (!latest && active.length && skipped.length === active.length) ? "blocked"
            : lastAt ? "ok" : "never";
    return { lastAt, running, scheduled, health, skipped, lastRun: latest, reason: failure?.reason ?? latest?.reason ?? null };
  }
  // data/server.json: { "remoteHosts": ["<node>.ts.net:8431"], "allowedLogins": ["you@example.com"] }
  const access = readJson(path.join(dataDir, "server.json"), {});
  const remoteHosts = new Set(access.remoteHosts ?? []);
  const allowedLogins = new Set(access.allowedLogins ?? []);
  // Filled in once listening, from the port actually bound (SSW_PORT=0 in tests).
  const LOCAL_HOSTS = new Set();
  const knownHost = (host) => LOCAL_HOSTS.has(host) || remoteHosts.has(host);
  function admitted(req) {
    const host = req.headers.host ?? "";
    if (LOCAL_HOSTS.has(host)) return true;
    if (!remoteHosts.has(host)) return false;
    return allowedLogins.has(req.headers["tailscale-user-login"] ?? "");
  }

  const settingsFile = path.join(dataDir, "settings.json");
  const settings = () => readJson(settingsFile, {});
  const saveSettings = (patch) => writeFileSync(settingsFile, `${JSON.stringify({ ...settings(), ...patch }, null, 2)}\n`);

  function project(id = null) {
    const all = projects.list();
    const chosen = all.find((p) => p.id === (id ?? settings().currentProject)) ?? all.find((p) => !p.archived) ?? all[0];
    if (!chosen) throw new HttpError(409, "no project yet: run the setup interview (see AGENTS.md) or create one in the app");
    return chosen;
  }
  const projectOf = (listing) => (listing.project_id && projects.get(listing.project_id)) || project();

  function skipReason(listing, p) {
    const { agents = [], titlePatterns = [] } = p.skip ?? {};
    if (agents.some((a) => a.toLowerCase() === (listing.agent_name ?? "").toLowerCase())) return `agent ${listing.agent_name}`;
    const text = [listing.title, listing.building, listing.property_type].filter(Boolean).join(" ");
    const hit = titlePatterns.find((pattern) => new RegExp(pattern, "i").test(text));
    if (hit) return `matches "${hit}"`;
    const districts = new Set((p.searches ?? []).filter((s) => s.site === listing.source && s.active !== false).flatMap((s) => s.districts ?? []));
    if (districts.size && listing.district && !districts.has(listing.district)) return `outside your districts (${listing.district})`;
    return null;
  }

  // A baseline until Google Maps numbers (enrichment) exist.
  function straightLine(listing, p) {
    if (listing.lat == null || listing.lng == null) return null;
    const here = { lat: listing.lat, lng: listing.lng };
    const places = Object.fromEntries(criteriaOf(p).filter((c) => c.type === "commute" && c.lat != null)
      .map((c) => [c.key, { km: +(haversine(here, c) / 1000).toFixed(1) }]));
    const stations = (listing.source_mrts ?? []).filter((m) => m.lat != null)
      .map((m) => ({ name: m.name, meters: Math.round(haversine(here, m)), walk: walkEstimate(haversine(here, m)) }))
      .sort((a, b) => a.meters - b.meters);
    return { places, stations };
  }


  // Maps results depend only on where the home is, and every result in a project
  // matches its current criteria (changing them clears all), so a listing in a
  // building already checked recently reuses that check.
  function shareMaps(listing) {
    if (listing.enriched_at || listing.merged_into || !listing.postal) return false;
    const twin = store.listListings(listing.project_id).find((o) => o.id !== listing.id && o.postal === listing.postal && o.enriched_at && !o.enrichment?.shared_from
      && Date.now() - Date.parse(o.enriched_at) < SHARE_MAPS_DAYS * 86_400_000
      && (listing.lat == null || o.lat == null || haversine(listing, o) < 150));
    if (!twin) return false;
    store.setEnrichment(listing.id, { ...twin.enrichment, shared_from: twin.id });
    return true;
  }

  function view(listing, p, conversation = store.followup(listing.id)) {
    const { messages, token } = conversation;
    const score = scoreListing(listing, p);
    const { photo_hashes: hashes, ...rest } = listing;
    const lead = leadSignals(messages);
    // Chat hints the user has already answered with a status choice stay answered.
    for (const hint of ["viewing", "unavailable"]) if (lead[hint] && (lead[hint].seq ?? Infinity) <= listing.manual_message_floor) lead[hint] = null;
    return {
      ...rest,
      // Photos only the browser can read (99.co's CDN) that haven't been fingerprinted yet.
      needsPhotoHashes: !listing.merged_into && listing.status !== "unavailable" && !hashes?.length && photoUrls(listing).some((u) => !canHashOnServer(u)),
      lead,
      chats: store.chatsForListing(listing.id).map((c) => ({ jid: c.jid, phone: c.phone, name: c.name, how: c.how })),
      sends: store.sendsForListing(listing.id).map((s) => ({ sent_at: s.sent_at, error: s.error })),
      straight: straightLine(listing, p),
      budget: listing.price ? budgetRange(listing.price, p.budget) : null,
      score,
      station: score.station,
      coliving: isColiving(listing),
      stage: stage(listing),
      needsDetails: !listing.details_at,
      needsMaps: !listing.enriched_at,
      needsRecheck: needsRecheck(listing),
      sites: [...new Set([listing.source, ...(listing.also ?? []).map((a) => a.source)].filter(Boolean))],
      // New chat messages since the agent last summarised.
      summaryStale: messages.length > 0 && listing.summary?.conversation_token !== token
    };
  }

  function state(projectId) {
    const p = project(projectId);
    const listings = store.listListings(p.id);
    const ids = new Set(listings.map((l) => l.id));
    const conversations = new Map(listings.map(l => [l.id, store.followup(l.id)]));
    return {
      whatsapp: wa ? wa.status() : { state: "disabled", linked: false },
      project: p,
      projectVersion: projectVersion(p),
      projects: projects.list().map((x) => ({ id: x.id, title: x.title, archived: !!x.archived, searches: (x.searches ?? []).length, active: (x.searches ?? []).filter((s) => s.active).length })),
      criterionTypes: Object.keys(CRITERION_TYPES),
      criteria: criteriaOf(p),
      scoring: scoreListing({}, p),
      defaultTemplate: DEFAULT_TEMPLATE,
      districts: DISTRICTS,
      pollLimits: POLL_LIMITS,
      profileMissing: profileMissing(p),
      templateDraft: p.deal === "buy" ? null : p.templates?.main ? { ...p.templates.main, pages: (p.searches ?? []).find((s) => s.template === "main")?.pages ?? p.templates.main.pages ?? POLL_LIMITS.pages.default } : (() => {
        const pg = (p.searches ?? []).find((x) => x.site === "propertyguru");
        return { filters: pg ? filtersFromPropertyGuru(pg.url) : { minPrice: p.budget?.min ?? 0, maxPrice: p.budget?.stretchMax || p.budget?.max || 0, bedrooms: [], wholeUnit: true, districts: [] }, sites: ["propertyguru", "99co", "carousell"], pages: pg?.pages ?? POLL_LIMITS.pages.default };
      })(),
      statuses: STATUSES,
      listings: listings.map((l) => view(l, p, conversations.get(l.id))),
      updates: store.updates(p.id, conversations),
      chats: store.listChats().filter((c) => !c.listing_ids.length || c.listing_ids.some((id) => ids.has(id))),
      polls: store.recentPolls(8),
      searchLast: store.lastPollBySearch(),
      poll: pollStatus(p)
    };
  }

  // Returns each hidden repeat's previous status and notes, for Undo.
  function hideRepeats(listing) {
    const hidden = [];
    for (const other of store.listListings(listing.project_id)) {
      if (["rejected", "unavailable"].includes(other.status) || !sameUnit(listing, other)) continue;
      hidden.push({ id: other.id, status: other.status, notes: other.notes });
      store.updateListing(other.id, { status: "rejected", notes: `Hidden with #${listing.id} (${listing.building ?? "same flat"}): same flat from another agent.` }, { by: "repeat" });
    }
    return hidden;
  }

  // Only a copy still waiting in Review is merged; anything the user has acted
  // on stays as it is. True when `listing` was the copy.
  const SITE = { propertyguru: "PropertyGuru", "99co": "99.co", carousell: "Carousell" };
  function mergeDuplicate(listing) {
    if (!listing || listing.merged_into) return false;
    for (const other of store.listListings(listing.project_id)) {
      if (other.merged_into || other.status === "unavailable" || store.isDistinct(listing.id, other.id) || !sameListing(listing, other)) continue;
      const [keep, copy] = pickPrimary(listing, other);
      if (copy.status !== "new") continue;
      store.mergeListing(copy.id, keep.id, `Auto-skipped: same flat as #${keep.id} (the ${SITE[copy.source] ?? copy.source} advert, merged into it).`);
      return copy.id === listing.id;
    }
    return false;
  }

  const photoHashes = photoQueue({
    store, log,
    done: (id, hashes) => { store.setPhotoHashes(id, hashes); mergeDuplicate(store.getListing(id)); }
  });

  function mergeAllDuplicates(projectId) {
    const merged = [];
    const rows = store.listListings(projectId).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const l of rows) {
      const fresh = store.getListing(l.id);
      if (fresh.status === "new" && !fresh.merged_into && mergeDuplicate(fresh)) merged.push([l.id, store.getListing(l.id).merged_into]);
    }
    return merged;
  }

  function hideIfRepeatOfHidden(listing) {
    const twin = store.listListings(listing.project_id).find((other) => hiddenByUser(other) && sameUnit(listing, other));
    if (!twin) return false;
    store.updateListing(listing.id, { status: "rejected", notes: `Auto-hidden: same flat as #${twin.id} you marked Not interested.` }, { by: "repeat" });
    return true;
  }

  if (projects.list().length) {
    // Listings from before projects existed join the current one.
    store.adoptOrphans(project().id);
    for (const listing of store.listListings()) if (hiddenByUser(listing)) hideRepeats(listing);
    for (const p of projects.list()) {
      const merged = mergeAllDuplicates(p.id);
      if (merged.length) log("info", `${p.id}: merged ${merged.length} duplicate adverts (${merged.map(([c, k]) => `#${c}→#${k}`).join(", ")})`);
    }
    for (const l of store.listListings()) if (!l.merged_into && l.status !== "unavailable") photoHashes.add(l);
    for (const l of store.listListings()) shareMaps(l);
  }

  function listingOr404(id) {
    const listing = store.getListing(Number(id));
    if (!listing) throw new HttpError(404, "no such listing");
    return listing;
  }

  function projectOr404(id) {
    const p = projects.get(id);
    if (!p) throw new HttpError(404, "no such project");
    return p;
  }

  function saveProject(p) {
    const errors = checkProject(p);
    if (errors.length) throw new HttpError(400, errors.join("; "));
    const previous = projects.get(p.id);
    if (previous && mapCriteriaKey(previous) !== mapCriteriaKey(p)) store.invalidateMaps(p.id);
    return projects.save(p);
  }

  function importListings(items, foundBy, projectId) {
    const p = project(projectId);
    const results = [];
    for (const item of items ?? []) {
      const parsed = item.url ? parseListingUrl(item.url) : {};
      const { alias, ...fields } = item;
      const input = { ...fields, project_id: p.id, source: item.source ?? parsed.source, source_id: item.source_id ?? parsed.sourceId, url: parsed.url ?? item.url, found_by: item.found_by ?? foundBy };
      if (!input.url) continue;
      const { listing, created } = store.upsertListing(input);
      // item.alias: the short-link key (e.g. "99co:e-AbC123") this page was opened from.
      if (item.alias) store.mergeAlias(item.alias, listing.id);
      // Re-checked when a poll adds details to a listing still waiting in Review:
      // Carousell gives the postal code and the room/whole-unit type only there.
      const skip = (created || listing.status === "new") && input.found_by === "poll" ? skipReason(listing, p) : null;
      if (skip) store.updateListing(listing.id, { status: "rejected", notes: `Auto-skipped by poll (${skip}). Set status to Watching to keep it.` }, { by: "skip" });
      // The same flat from the other site becomes one card. A link the user pasted
      // is theirs to keep; only polls' and imports' copies are merged away.
      else if (input.found_by !== "manual" && mergeDuplicate(store.getListing(listing.id))) { /* merged into the listing already tracked */ }
      else if (created && !hideIfRepeatOfHidden(listing) && input.found_by === "manual") {
        // A link the user pasted is already chosen; everything else waits in the review deck.
        store.updateListing(listing.id, { status: "shortlisted" });
      }
      store.refreshLead(listing.id);
      const saved = store.getListing(listing.id);
      if (input.found_by === "poll") store.markSeen([saved.id, saved.merged_into].filter(Boolean));
      shareMaps(saved);
      photoHashes.add(store.getListing(listing.id));
      results.push({ id: listing.id, created, url: listing.url });
    }
    return results;
  }

  // The deadline prevents overlap with the next scheduled run; unfinished work
  // stays queued. Legacy poll.listings values no longer limit either queue.
  function mapsQueue(since, limit) {
    const timeUp = !!since && Date.now() - Date.parse(since) > MAPS_RUN_MINUTES * 60_000;
    const ready = [];
    let waiting = 0;
    for (const p of projects.list().filter((x) => !x.archived)) {
      const all = store.listListings(p.id);
      const queued = all.filter(mapsDue);
      waiting += queued.length;
      if (!timeUp) ready.push(...queued);
    }
    ready.sort((a, b) => isColiving(a) - isColiving(b) || a.created_at.localeCompare(b.created_at));
    const listings = ready.slice(0, limit).map((l) => ({ id: l.id, project: l.project_id, title: l.title, address: l.address, postal: l.postal, lat: l.lat, lng: l.lng, source_mrts: l.source_mrts ?? [] }));
    return { now: new Date().toISOString(), listings, left: ready.length, waiting, timeUp, criteria: Object.fromEntries([...new Set(listings.map((l) => l.project))].map((id) => [id, criteriaOf(projects.get(id))])), sitesPollRunning: jobRunning("sites") };
  }

  const pacer = new PortalPacer(path.join(dataDir, "portal-pace.json"));
  // Rechecks handed out per run (keyed by `since`), at most RECHECKS_PER_RUN per project.
  const RECHECKS_PER_RUN = 5;
  const rechecks = new Map();
  const routes = [

    // One grant is one listing-site page load now. `wait` (seconds, up to 30) holds
    // the answer until a grant is due, so a paced agent needs one call per page.
    ["POST", /^\/api\/poll\/permit$/, async (req) => {
      const { site, wait = 0 } = await body(req);
      if (!["propertyguru", "99co", "carousell"].includes(site)) throw new HttpError(400, "site must be propertyguru, 99co or carousell");
      const active = projects.list().filter((p) => !p.archived);
      const rpm = Math.min(...active.map((p) => p.poll?.rpm ?? POLL_LIMITS.rpm.default), POLL_LIMITS.rpm.max);
      const until = Date.now() + Math.min(30, Math.max(0, Number(wait) || 0)) * 1000;
      for (;;) {
        const answer = pacer.permit(site, rpm);
        if (answer.allowed || Date.now() + answer.wait_ms > until) return answer;
        await new Promise((r) => setTimeout(r, answer.wait_ms));
      }
    }],

    // Listing pages to open: never-opened first, then up to 5 a run that no search
    // page has shown for 3 days. Since `since` (the run's start), each project gets
    // poll.listings pages; after MAPS_RUN_MINUTES, none. `exclude` and `excludeSites` skip pages
    // that failed and sites that showed a human check, for this run only.
    ["GET", /^\/api\/queue\/details$/, async (req, match, url) => {
      const since = url.searchParams.get("since");
      if (since && !Number.isFinite(Date.parse(since))) throw new HttpError(400, "since must be a timestamp");
      const timeUp = !!since && Date.now() - Date.parse(since) > MAPS_RUN_MINUTES * 60_000;
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 2));
      const excluded = new Set((url.searchParams.get("exclude") ?? "").split(",").map(Number));
      const blocked = new Set((url.searchParams.get("excludeSites") ?? "").split(","));
      const order = (a, b) => !!a.details_at - !!b.details_at || isColiving(a) - isColiving(b)
        || (a.details_at ? (a.seen_at ?? a.details_at).localeCompare(b.seen_at ?? b.details_at) : a.created_at.localeCompare(b.created_at)) || a.id - b.id;
      const ready = [];
      let waiting = 0;
      for (const p of projects.list().filter((x) => !x.archived)) {
        const all = store.listListings(p.id);
        const opened = since ? all.filter((l) => l.details_at >= since).length : 0;
        const left = timeUp ? 0 : Math.max(0, (p.poll?.listings ?? POLL_LIMITS.listings.default) - opened);
        const queued = all.filter((l) => detailDue(l));
        waiting += queued.length;
        const handed = rechecks.get(since)?.get(p.id) ?? new Set();
        const open = queued.filter((l) => !excluded.has(l.id) && !blocked.has(l.source)).sort(order);
        const fresh = open.filter((l) => !l.details_at);
        const due = open.filter((l) => l.details_at);
        const again = [...due.filter((l) => handed.has(l.id)), ...due.filter((l) => !handed.has(l.id)).slice(0, Math.max(0, RECHECKS_PER_RUN - handed.size))];
        ready.push(...[...fresh, ...again].slice(0, left));
      }
      ready.sort(order);
      const listings = ready.slice(0, limit).map((l) => ({ id: l.id, project: l.project_id, source: l.source, url: l.url, title: l.title, recheck: !!l.details_at, also: l.also ?? [] }));
      if (since) {
        if (!rechecks.has(since)) { rechecks.set(since, new Map()); if (rechecks.size > 20) rechecks.delete(rechecks.keys().next().value); }
        for (const l of listings.filter((x) => x.recheck)) {
          const byProject = rechecks.get(since);
          byProject.set(l.project, (byProject.get(l.project) ?? new Set()).add(l.id));
        }
      }
      return { now: new Date().toISOString(), listings, left: ready.length, waiting, timeUp };
    }],

    // `wait` (seconds, up to 60) holds an empty answer while the listing-site agent can still add work.
    ["GET", /^\/api\/queue\/maps$/, async (req, match, url) => {
      const since = url.searchParams.get("since");
      if (since && !Number.isFinite(Date.parse(since))) throw new HttpError(400, "since must be a timestamp");
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit")) || 2));
      const until = Date.now() + Math.min(60, Math.max(0, Number(url.searchParams.get("wait")) || 0)) * 1000;
      for (;;) {
        const answer = mapsQueue(since, limit);
        if (answer.listings.length || answer.timeUp || !answer.sitesPollRunning || Date.now() >= until) return answer;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }],

    ["POST", /^\/api\/projects$/, async (req) => {
      const { title, copyFrom, deal } = await body(req);
      if (!title?.trim()) throw new HttpError(400, "Give the project a title.");
      if (deal != null && !DEALS.includes(deal)) throw new HttpError(400, 'deal must be "rent" or "buy"');
      const p = projects.create({ title: title.trim(), copyFrom, deal });
      saveSettings({ currentProject: p.id });
      return p;
    }],
    ["GET", /^\/api\/projects\/([\w-]+)$/, (req, [id]) => projectOr404(id)],
    ["PUT", /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => {
      projectOr404(id);
      const next = await body(req);
      if (next.id !== id) throw new HttpError(400, "id cannot change");
      return saveProject(next);
    }],
    ["PATCH", /^\/api\/projects\/([\w-]+)$/, async (req, [id]) => {
      const patch = await body(req);
      const p = projectOr404(id);
      for (const key of ["title", "archived", "budget", "message", "filters", "home", "poll", "deal"]) if (key in patch) p[key] = patch[key];
      return saveProject(p);
    }],
    ["PUT", /^\/api\/settings$/, async (req) => {
      const { currentProject } = await body(req);
      projectOr404(currentProject);
      saveSettings({ currentProject });
      return settings();
    }],
    ["POST", /^\/api\/projects\/([\w-]+)\/dedupe$/, (req, [id]) => {
      projectOr404(id);
      return { merged: mergeAllDuplicates(id).map(([copy, keep]) => ({ copy, keep })) };
    }],
    ["POST", /^\/api\/projects\/([\w-]+)\/searches$/, async (req, [id]) => {
      const { title, url, pages = POLL_LIMITS.pages.default } = await body(req);
      const p = projectOr404(id);
      const parsed = parseListingUrl(url ?? "");
      if (!/^https:\/\/(www\.)?(propertyguru\.com\.sg|99\.co|carousell\.sg)\//.test(url ?? "")) throw new HttpError(400, "That isn't a PropertyGuru, 99.co or Carousell search address.");
      const search = { id: slugify(title), title, site: parsed.source ?? (/99\.co/.test(url) ? "99co" : /carousell\.sg/.test(url) ? "carousell" : "propertyguru"), url: newestFirst(url), pages: Number(pages) || POLL_LIMITS.pages.default, active: true };
      for (let n = 2; (p.searches ?? []).some((s) => s.id === search.id); n++) search.id = `${slugify(title)}-${n}`;
      p.searches = [...(p.searches ?? []), search];
      saveProject(p);
      return search;
    }],
    ["PUT", /^\/api\/projects\/([\w-]+)\/templates\/([\w-]+)$/, async (req, [id, name]) => {
      const input = await body(req);
      const p = projectOr404(id);
      let next;
      try { next = applyTemplate(p, name, input); } catch (error) { throw new HttpError(400, error.message); }
      saveProject(overrideSearchBrief(next));
      return { template: next.templates[name], searches: next.searches.filter(s => s.template === name) };
    }],
    ["PUT", /^\/api\/projects\/([\w-]+)\/search-brief$/, async (req, [id]) => {
      const { text } = await body(req);
      return saveProject(requestSearchBrief(projectOr404(id), text));
    }],
    ["PUT", /^\/api\/projects\/([\w-]+)\/search-plan$/, async (req, [id]) => {
      const plan = await body(req);
      return saveProject(resolveSearchBrief(projectOr404(id), plan));
    }],
    ["PATCH", /^\/api\/projects\/([\w-]+)\/searches\/([\w-]+)$/, async (req, [id, sid]) => {
      const patch = await body(req);
      const p = projectOr404(id);
      const search = (p.searches ?? []).find((s) => s.id === sid);
      if (!search) throw new HttpError(404, "no such search");
      for (const key of ["title", "url", "pages", "active", "why"]) if (key in patch) search[key] = patch[key];
      saveProject(p);
      return search;
    }],
    ["DELETE", /^\/api\/projects\/([\w-]+)\/searches\/([\w-]+)$/, (req, [id, sid]) => {
      const p = projectOr404(id);
      p.searches = (p.searches ?? []).filter((s) => s.id !== sid);
      saveProject(p);
      return { deleted: sid };
    }],

    ["POST", /^\/api\/listings$/, async (req) => {
      const input = await body(req);
      if (!input.url) throw new HttpError(400, "Paste a listing link first.");
      if (!parseListingUrl(input.url).source) throw new HttpError(400, "That isn't a PropertyGuru, 99.co or Carousell listing link.");
      return importListings([input], input.found_by ?? "manual", input.project)[0];
    }],

    ["POST", /^\/api\/import$/, async (req) => {
      const input = await body(req);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Send an object with a listings array.");
      if ("enrichment" in input) throw new HttpError(400, "Save Maps checks with PUT /api/listings/<id>/enrichment, using the enrichment object as the body. /api/import only accepts listings.");
      if (!Array.isArray(input.listings)) throw new HttpError(400, "Send a listings array (empty is allowed for a search with no matches).");
      store.db.exec("BEGIN IMMEDIATE");
      try {
        if (input.poll) runs.match({ search: input.poll, projectId: project(input.project).id, runId: req.headers["x-ssw-poll-run"] ?? input.runId ?? null });
        const results = importListings(input.listings, input.found_by ?? "import", input.project);
        if (input.poll) {
          runs.record({ search: input.poll, projectId: project(input.project).id, note: input.note ?? null, runId: req.headers["x-ssw-poll-run"] ?? input.runId ?? null });
          store.recordPoll({ search: input.poll, seen: results.length, added: results.filter((r) => r.created).length, note: input.note ?? null });
        }
        // Result pages are newest first: an oldest card never seen before means the
        // page stopped short of the last poll's listings, so the gap continues on the next page.
        const readNext = !!input.poll && !!results.at(-1)?.created;
        store.db.exec("COMMIT");
        return { imported: results.length, created: results.filter((r) => r.created).length, readNext, results };
      } catch (error) { store.db.exec("ROLLBACK"); throw error; }
    }],

    // "Not interested" (status → rejected) also hides the flat's repeats;
    // the response lists them so the UI can undo all of it.
    ["PATCH", /^\/api\/listings\/(\d+)$/, async (req, [id]) => {
      const patch = await body(req);
      const before = listingOr404(id);
      const poll = req.headers["x-ssw-actor"] === "poll";
      // Reviewing, watching and hiding are the user's choices, not the poll's.
      if (poll && patch.status && !pollMaySetStatus(before.status, patch.status)) {
        throw new HttpError(409, `the user decides ${before.status} → ${patch.status}; leave it`);
      }
      const listing = store.updateListing(Number(id), patch, { by: poll ? "poll" : "user" });
      // A poll's only status change is "the listing page is gone".
      if (patch.status && patch.status !== before.status) store.setGone(listing.id, poll && patch.status === "unavailable" ? new Date().toISOString() : null);
      const alsoHidden = patch.status === "rejected" && before.status !== "rejected" ? hideRepeats(listing) : [];
      return { ...listing, alsoHidden };
    }],

    ["DELETE", /^\/api\/listings\/(\d+)$/, (req, [id]) => {
      listingOr404(id);
      store.deleteListing(Number(id));
      return { deleted: Number(id) };
    }],

    // facilityWalks: { <criterion key>: { walk_min, walk_m } } is a routed walk
    // to that criterion's nearest place, replacing its estimate.
    ["PUT", /^\/api\/listings\/(\d+)\/enrichment$/, async (req, [id]) => {
      const { facilityWalks, mrtTransit, ...incoming } = await body(req);
      const listing = listingOr404(id);
      const merged = { ...(listing.enrichment ?? {}), ...incoming, facilities: { ...(listing.enrichment?.facilities ?? {}), ...(incoming.facilities ?? {}) }, commute: { ...(listing.enrichment?.commute ?? {}), ...(incoming.commute ?? {}) } };
      for (const [key, walk] of Object.entries(facilityWalks ?? {})) {
        const nearest = merged.facilities[key]?.[0];
        if (nearest && walk?.walk_min != null) Object.assign(nearest, { walk_min: walk.walk_min, walk_m: walk.walk_m ?? null, routed: true });
      }
      // mrtTransit: { transit_min, summary }, bus or transit to the nearest station,
      // checked when the walk is over the station criterion's limits.
      if (mrtTransit?.transit_min != null && merged.mrt?.[0]) {
        Object.assign(merged.mrt[0], { transit_min: mrtTransit.transit_min, transit_summary: mrtTransit.summary ?? null });
      }
      store.setEnrichment(Number(id), merged);
      // Results can arrive in several saves; copies follow their source.
      for (const l of listing.postal ? store.listListings(listing.project_id) : []) {
        if (l.postal !== listing.postal) continue;
        if (l.enrichment?.shared_from === listing.id) store.setEnrichment(l.id, { ...merged, shared_from: listing.id });
        else shareMaps(l);
      }
      return store.getListing(Number(id));
    }],

    ["PUT", /^\/api\/listings\/(\d+)\/media$/, async (req, [id]) => {
      const incoming = await body(req);
      const listing = listingOr404(id);
      const merged = { ...(listing.media ?? {}), ...incoming, maps: { ...(listing.media?.maps ?? {}), ...(incoming.maps ?? {}) } };
      store.setMedia(Number(id), merged);
      return store.getListing(Number(id));
    }],

    ["GET", /^\/api\/listings\/(\d+)\/duplicate-candidates$/, (req, [id]) => {
      const listing = listingOr404(id);
      return store.listListings(listing.project_id)
        .filter((o) => o.id !== listing.id && !o.merged_into && !store.isDistinct(o.id, listing.id))
        .map((o) => ({ id: o.id, building: o.building, title: o.title, price: o.price, bedrooms: o.bedrooms, sqft: o.sqft, source: o.source, status: o.status, photo: o.photos?.[0]?.src ?? null, ...likeness(listing, o) }))
        .sort((a, b) => b.score - a.score || (a.building ?? "").localeCompare(b.building ?? ""))
        .slice(0, 60);
    }],

    // Unlike the automatic merge, either listing can be in any status.
    ["POST", /^\/api\/listings\/(\d+)\/merge$/, async (req, [id]) => {
      const { with: otherId, keep = "auto" } = await body(req);
      const a = listingOr404(id);
      const b = listingOr404(otherId);
      if (a.id === b.id || a.merged_into || b.merged_into) throw new HttpError(409, "merge the listings they were merged into instead");
      const [kept, copy] = keep === "this" ? [a, b] : keep === "other" ? [b, a] : pickPrimary(a, b);
      store.mergeListing(copy.id, kept.id, `Merged by you: same flat as #${kept.id}.`);
      return { keep: kept.id, copy: copy.id };
    }],

    // A split pair is never merged automatically again.
    ["POST", /^\/api\/listings\/(\d+)\/split$/, (req, [id]) => {
      const copy = listingOr404(id);
      if (!copy.merged_into) throw new HttpError(409, "not a merged listing");
      const keepId = copy.merged_into;
      store.splitListing(copy.id);
      return { copy: copy.id, keep: keepId };
    }],

    // Fingerprints of 99.co photos, which only the browser can read.
    ["PUT", /^\/api\/listings\/(\d+)\/photo-hashes$/, async (req, [id]) => {
      listingOr404(id);
      const { hashes } = await body(req);
      if (!Array.isArray(hashes) || hashes.some((h) => !/^[0-9a-f]{16}$/.test(h))) throw new HttpError(400, "hashes: 16-hex-digit strings");
      store.setPhotoHashes(Number(id), hashes);
      const merged = mergeDuplicate(store.getListing(Number(id)));
      return { stored: store.getListing(Number(id)).photo_hashes.length, merged };
    }],

    ["GET", /^\/api\/listings\/(\d+)\/follow-up$/, (req, [id]) => {
      listingOr404(id);
      return store.followup(Number(id));
    }],
    // The summary, evidence and status outcome commit together.
    ["PUT", /^\/api\/listings\/(\d+)\/summary$/, async (req, [id]) => {
      listingOr404(id);
      return store.recordFollowup(Number(id), await body(req));
    }],
    ["POST", /^\/api\/projects\/([\w-]+)\/updates\/read$/, async (req, [id]) => {
      projectOr404(id);
      const { keys } = await body(req);
      store.readUpdates(id, keys);
      return store.updates(id);
    }],

    ["GET", /^\/api\/listings\/(\d+)\/messages$/, (req, [id]) => {
      listingOr404(id);
      return store.listingMessages(Number(id));
    }],

    ["GET", /^\/api\/listings\/(\d+)\/draft$/, (req, [id]) => {
      const listing = listingOr404(id);
      return { text: composeIntro(messageProfile(projectOf(listing)), listing), phone: normalizePhone(listing.agent_phone) };
    }],

    ["POST", /^\/api\/listings\/(\d+)\/send$/, async (req, [id]) => {
      const listing = listingOr404(id);
      if (!wa) throw new HttpError(409, "WhatsApp is not set up (optional; see docs/whatsapp.md)");
      const { text } = await body(req);
      try {
        return await wa.send(listing, text ?? composeIntro(messageProfile(projectOf(listing)), listing));
      } catch (error) {
        throw new HttpError(409, error.message);
      }
    }],

    // A search a poll could not read (a Cloudflare check), so the next run retries it first.
    ["POST", /^\/api\/polls$/, async (req) => {
      const { search, note, project: projectId, runId } = await body(req);
      if (typeof search !== "string" || !search.trim() || typeof note !== "string" || !note.trim() || note.length > 200) throw new HttpError(400, "Give the search title and a short note.");
      runs.record({ search: search.trim(), note: note.trim(), projectId: projectId ?? null, runId: req.headers["x-ssw-poll-run"] ?? runId ?? null });
      store.recordPoll({ search: search.trim(), seen: 0, added: 0, note: note.trim() });
      return { ok: true };
    }],
    ["POST", /^\/api\/poll$/, () => {
      if (pollChild || jobRunning("sites")) throw new HttpError(409, "A poll is already running.");
      const gap = sitesGap(dataDir);
      if (!gap.open) throw new HttpError(409, `The last poll started ${gap.minutes} min ago. Polls start at least ${POLL_GAP_MIN} minutes apart, so the sites don't see a burst.`);
      const [cmd, ...args] = pollCommand;
      pollChild = spawn(cmd, args, { cwd: root, env: { ...process.env, SSW_DATA_DIR: dataDir, SSW_PORT: String(server.address().port) }, detached: true, stdio: "ignore", windowsHide: true });
      pollChild.on("exit", () => { pollChild = null; });
      pollChild.on("error", (error) => { log("warn", `poll did not start: ${error.message}`); pollChild = null; });
      pollChild.unref();
      return { started: true };
    }],

    ["POST", /^\/api\/chats\/([^/]+)\/ignore$/, (req, [jid]) => {
      store.ignoreChat(decodeURIComponent(jid), "manual");
      return { ignored: decodeURIComponent(jid) };
    }],

    ["POST", /^\/api\/chats\/([^/]+)\/link$/, async (req, [jid]) => {
      const { listingId, unlink } = await body(req);
      const chat = decodeURIComponent(jid);
      if (!store.isFlagged(chat)) throw new HttpError(404, "not a property chat");
      listingOr404(listingId);
      if (unlink) store.unlinkChat(chat, Number(listingId));
      else store.linkChat(chat, Number(listingId), "manual");
      store.refreshLead(Number(listingId));
      return { ok: true };
    }],

    ["GET", /^\/api\/chats\/([^/]+)\/messages$/, (req, [jid]) => {
      const chat = decodeURIComponent(jid);
      if (!store.isFlagged(chat)) throw new HttpError(404, "not a property chat");
      return store.chatMessages(chat);
    }],

    ["POST", /^\/api\/whatsapp\/logout$/, async () => {
      if (!wa) throw new HttpError(409, "WhatsApp is not set up");
      await wa.logout();
      await wa.start();
      return wa.status();
    }]
  ];

  const publicDir = path.join(root, "public");
  const vendor = {
    "maplibre-gl.mjs": path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl.mjs"),
    "maplibre-gl-worker.mjs": path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs"),
    "maplibre-gl.css": path.join(root, "node_modules/maplibre-gl/dist/maplibre-gl.css")
  };

  const serveFile = assetServer();

  // The page asks for the state every 15 s. Its tag covers everything the state
  // is built from (the time only matters to lead signals, so to 5 minutes), so an
  // unchanged state costs a 304, and a changed one is built and gzipped once.
  // no-store: the state holds chat text, so the page keeps the tag itself rather
  // than leaving it in the browser's disk cache.
  let stateCache = { tag: null, json: null, gz: null };
  async function sendState(req, res, projectId) {
    const p = project(projectId);
    const tag = `"${createHash("sha1").update(JSON.stringify([
      store.changeKey(), projectVersion(p), projects.list(),
      settings(), wa?.status() ?? null, pollRunning(), pollScheduled(), Math.floor(Date.now() / 300_000)
    ])).digest("hex").slice(0, 20)}"`;
    const headers = { "content-type": "application/json", "cache-control": "no-store", etag: tag, vary: "accept-encoding" };
    if (req.headers["if-none-match"] === tag) { res.writeHead(304, headers); res.end(); return; }
    if (stateCache.tag !== tag) {
      const json = Buffer.from(JSON.stringify(state(projectId)));
      stateCache = { tag, json, gz: await promisify(gzip)(json) };
    }
    const zipped = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    const body = zipped ? stateCache.gz : stateCache.json;
    res.writeHead(200, { ...headers, ...(zipped ? { "content-encoding": "gzip" } : {}), "content-length": body.length });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!admitted(req)) {
        log("warn", `refused ${req.method} ${req.url} host=${req.headers.host} login=${req.headers["tailscale-user-login"] ?? "-"}`);
        throw new HttpError(knownHost(req.headers.host ?? "") ? 403 : 421, "not allowed");
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin && !knownHost(origin.replace(/^https?:\/\//, ""))) throw new HttpError(403, "cross-origin write refused");
      }
      if (req.method === "GET" && url.pathname === "/api/state") return await sendState(req, res, url.searchParams.get("project"));
      if (url.pathname.startsWith("/api/")) {
        for (const [method, pattern, handler] of routes) {
          const match = url.pathname.match(pattern);
          if (!match || method !== req.method) continue;
          const result = await handler(req, match.slice(1), url);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(result));
          return;
        }
        throw new HttpError(404, "no such route");
      }
      if (req.method !== "GET") throw new HttpError(405, "method not allowed");
      if (url.pathname === "/" || url.pathname === "/index.html") return await serveFile(req, res, path.join(publicDir, "index.html"));
      if (url.pathname === "/import") return await serveFile(req, res, path.join(publicDir, "import.html"));
      // The page previews intro messages with the same pure module the server sends.
      if (url.pathname === "/lib/intro.js") return await serveFile(req, res, path.join(root, "src/intro.js"));
      if (url.pathname === "/lib/photohash.js") return await serveFile(req, res, path.join(root, "src/photohash.js"));
      if (url.pathname === "/lib/lifecycle.js") return await serveFile(req, res, path.join(root, "src/lifecycle.js"));
      const name = path.basename(url.pathname);
      if (url.pathname.startsWith("/vendor/") && vendor[name]) return await serveFile(req, res, vendor[name]);
      // An icon not downloaded yet shows as a question mark, not as nothing.
      if (/^\/icons\/[a-z0-9-]+\.svg$/.test(url.pathname)) return await serveFile(req, res, path.join(publicDir, "icons", existsSync(path.join(publicDir, "icons", name)) ? name : "circle-help.svg"));
      if (/^\/js\/[a-z0-9-]+\.js$/.test(url.pathname)) return await serveFile(req, res, path.join(publicDir, "js", name));
      if (url.pathname.startsWith("/browser/")) return await serveFile(req, res, path.join(root, "browser", name));
      const media = url.pathname.match(/^\/media\/(\d+)\/([\w.-]+\.(?:jpe?g|png|webp|svg))$/);
      if (media) return await serveFile(req, res, path.join(dataDir, "media", media[1], media[2]), { privateMedia: true });
      return await serveFile(req, res, path.join(publicDir, name));
    } catch (error) {
      const status = error.status ?? 500;
      if (status === 500) log("error", error.stack ?? error.message);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, HOST, resolve); });
  const { port } = server.address();
  LOCAL_HOSTS.add(`127.0.0.1:${port}`).add(`localhost:${port}`);
  log("info", `sg-stay-where on http://${HOST}:${port}`);
  return server;
}
