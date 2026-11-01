import { hashImagesInBrowser } from "/lib/photohash.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Chat text and listing fields come from agents and listing sites: always escaped.
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const sgd = (n) => (n == null ? "–" : `S$${Number(n).toLocaleString("en-SG")}`);
// Rent is quoted a month; a purchase price is the whole price.
export const isRent = () => state?.project?.deal !== "buy";
// Icons are Lucide SVGs in /icons, drawn with CSS masks so they take the text colour.
export const icon = (name, cls = "") => `<i class="ic ${cls}" style="--icon:url(/icons/${/^[a-z0-9-]+$/.test(name ?? "") ? name : "circle-help"}.svg)" aria-hidden="true"></i>`;
export const STATUS_LABEL = {
  new: "To review", shortlisted: "Watching", contacted: "Contacted", replied: "Agent replied",
  viewing_scheduled: "Viewing set", viewed: "Viewed", applied: "Applied / offer", rejected: "Not interested", unavailable: "Taken", closed: "Enquiry ended"
};
export const DECISION_LABEL = { viewing: "Going to view", maybe: "Undecided", not_viewing: "Not viewing", waiting: "Waiting on agent", viewed: "Viewed" };
export const SITE = { propertyguru: "PropertyGuru", "99co": "99.co", carousell: "Carousell" };
export const INACTIVE = new Set(["rejected", "unavailable", "closed"]);
const PREFS_KEY = "ssw-prefs";

// ?blur=1 (screenshots, screen sharing): blurs photos, names, addresses, agents and chats.
if (new URLSearchParams(location.search).has("blur")) document.documentElement.dataset.blur = "";

export let state = null;
export let projectId = null;
export let openId = null;
export let tab = "listings";
export let detailedMap = true;
export let fittedFor = null;
export let placesFor = null;
export const deck = { html: "", topId: null, photo: 0 };
export const setProjectId = (id) => { projectId = id; };
export const setOpenId = (id) => { openId = id; };
export const setTab = (name) => { tab = name; };
export const setDetailedMap = (on) => { detailedMap = on; };
export const setFittedFor = (frame) => { fittedFor = frame; };
export const setPlacesFor = (key) => { placesFor = key; };

// app.js imports every feature, so these page-level functions (defined in app.js,
// settings.js and detail.js) reach the modules below through here, set at startup.
export let render, renderListings, renderHeader, openDetail;
export function setPage(page) { ({ render, renderListings, renderHeader, openDetail } = page); }

const renderedHTML = new WeakMap();
export function setHTML(el, html) {
  if (renderedHTML.get(el) === html) return;
  el.innerHTML = html;
  renderedHTML.set(el, html);
}

export const DEFAULT_FILTERS = { station: true, coliving: true, budget: false };

// Per-viewer conveniences only; the page works without storage.
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; }
}
export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ station: $("#filter-station").checked, coliving: $("#filter-coliving").checked, budget: $("#filter-budget").checked, sort: $("#sort").value, project: projectId, theme: $("#theme").dataset.theme ?? "auto", mapSimple: !detailedMap }));
  } catch { /* private window */ }
}

let pageRequests = new AbortController();
window.addEventListener("pagehide", () => pageRequests.abort());
window.addEventListener("pageshow", () => { if (pageRequests.signal.aborted) pageRequests = new AbortController(); });

const TAG = Symbol("etag");

// With `ifNoneMatch`, an unchanged resource answers 304 and this returns null.
export async function api(path, { method = "GET", body, ifNoneMatch } = {}) {
  pageRequests.signal.throwIfAborted();
  const res = await fetch(path, {
    method,
    signal: pageRequests.signal,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (res.status === 304) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  if (res.headers.get("etag")) data[TAG] = res.headers.get("etag");
  return data;
}

export function ago(ts) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-SG", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

let toastTimer = null;
let undoAction = null;

// `name` (a listing's name) is kept apart so blur mode can hide it.
export function toast(text, undo, name = null, suffix = "") {
  const host = $$('dialog[open]').at(-1) ?? document.body;
  if ($("#toast").parentElement !== host) host.append($("#toast"));
  $("#toast-text").innerHTML = name
    ? `<span class="toast-label">${esc(text)}</span><span class="toast-name">${esc(name)}</span>${suffix ? `<span class="toast-suffix">${esc(suffix)}</span>` : ""}`
    : `<span class="toast-message">${esc(text)}${esc(suffix)}</span>`;
  undoAction = undo;
  $("#toast-undo").hidden = !undo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; undoAction = null; }, 6000);
}

// Choices on their way to the server: id → { status, savedAt }.
export const pending = new Map();
// Notes on their way to the server: id → { notes, savedAt }.
export const pendingNotes = new Map();

// The clipboard API needs a secure context; over plain http (a Tailscale address)
// the selected textarea is copied the old way.
export async function copyText(textarea) {
  try {
    await navigator.clipboard.writeText(textarea.value);
    return true;
  } catch {
    textarea.focus({ preventScroll: true });
    textarea.select();
    try { return document.execCommand("copy"); } catch { return false; }
  }
}

// While the app is open it fingerprints 99.co photos the import page didn't get
// to (they can only be read in a browser), a few listings at a time, so the same
// flat on both sites becomes one card.
let fingerprinting = false;
async function fingerprintPhotos() {
  if (fingerprinting || !state || document.hidden || pageRequests.signal.aborted) return;
  const todo = state.listings.filter((l) => l.needsPhotoHashes).slice(0, 3);
  if (!todo.length) return;
  fingerprinting = true;
  try {
    let merged = 0;
    for (const l of todo) {
      if (document.hidden || pageRequests.signal.aborted) break;
      const urls = (l.photos ?? []).filter((p) => p.kind !== "floor plan" && !/pgimgs\.com/.test(p.src)).map((p) => p.src);
      const hashes = await hashImagesInBrowser(urls, { limit: 8 });
      // Nothing readable: store a marker so it isn't retried on every refresh.
      const r = await api(`/api/listings/${l.id}/photo-hashes`, { method: "PUT", body: { hashes: hashes.length ? hashes : ["0000000000000000"] } });
      if (r.merged) merged += 1;
    }
    if (merged) await refresh();
  } catch { /* try again on the next refresh */ } finally {
    fingerprinting = false;
  }
}

let refreshes = 0;
let shownRefresh = 0;

// `onlyIfChanged` is for the background timer: with 800+ listings, redrawing an
// unchanged state every 15 s is what made the page slow.
export async function refresh({ onlyIfChanged = false } = {}) {
  const n = ++refreshes;
  const sentAt = Date.now();
  let next;
  try {
    const tag = onlyIfChanged && !pending.size && !pendingNotes.size ? state?.[TAG] : null;
    next = await api(`/api/state${projectId ? `?project=${encodeURIComponent(projectId)}` : ""}`, { ifNoneMatch: tag });
  } catch (error) {
    if (n >= shownRefresh) {
      $("#connection-message").textContent = state ? "Updates paused. Your last loaded listings are still here." : error.status === 409 ? "No project yet. Ask your coding agent to set up sg-stay-where, then retry." : "Could not connect to the tracker. Check that it is running, then retry.";
      $("#connection-status").hidden = false;
    }
    throw error;
  }
  if (!next) return void ($("#connection-status").hidden = true);
  if (n < shownRefresh) return; // a later refresh already drew newer data
  if (projectId && next.project.id !== projectId && state?.projects.some((p) => p.id === projectId)) return;
  shownRefresh = n;
  $("#connection-status").hidden = true;
  for (const [id, mark] of pending) {
    if (mark.savedAt != null && mark.savedAt <= sentAt) { pending.delete(id); continue; }
    const l = next.listings.find((x) => x.id === id);
    if (l) l.status = mark.status;
  }
  for (const [id, mark] of pendingNotes) {
    if (mark.savedAt != null && mark.savedAt <= sentAt) { pendingNotes.delete(id); continue; }
    const l = next.listings.find((x) => x.id === id);
    if (l) l.notes = mark.notes;
  }
  const initial = !state;
  state = next;
  projectId = state.project.id;
  if (initial) renderHeader();
  else render();
  fingerprintPhotos();
}

export function wireToast() {
  for (const dialog of $$("dialog")) dialog.addEventListener("close", () => {
    if ($("#toast").parentElement === dialog) document.body.append($("#toast"));
  });
  $("#toast-undo").addEventListener("click", () => {
    const undo = undoAction;
    $("#toast").hidden = true;
    undoAction = null;
    undo?.().catch(error => toast(`Could not undo: ${error.message}`, undo));
  });
}
