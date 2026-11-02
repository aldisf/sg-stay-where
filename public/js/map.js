import { shortPrice } from "/lib/intro.js";
import { $, detailedMap, esc, fittedFor, icon, openDetail, openId, placesFor, projectId, savePrefs, setDetailedMap, setFittedFor, setHTML, setPlacesFor, STATUS_LABEL, tab } from "./core.js";
import { allBoxes, commutes, criterionOfType, filtered, nameOf, nearbys } from "./listing.js";
import { enquiries } from "./enquiries.js";

function pinsForTab() {
  // Captions count what is on the map: listings without a location have no pin.
  const n = (rows, what) => { const k = rows.filter((l) => l.lat != null && l.lng != null).length; return `${k} ${what}${k === 1 ? "" : "s"}`; };
  if (tab === "review") {
    const rows = filtered({ review: true });
    return { rows, caption: rows.length ? `${n(rows, "listing")} to review · the card on top is highlighted` : "Nothing new to review" };
  }
  // Ended enquiries are collapsed in the list and left off the map.
  if (tab === "enquiries") { const rows = enquiries().filter((e) => e.section !== "ended").map((e) => e.listing); return { rows, caption: `${n(rows, "home")} you're in touch about` }; }
  const rows = filtered();
  return { rows, caption: tab === "listings" ? `${n(rows, "listing")} you're watching` : `${n(rows, "followed listing")} on the map` };
}

// MapLibre + OpenFreeMap vector tiles, no key.
export let map = null;
const markers = new Map();
let placeMarkers = [];
let amenityMarkers = [];
const SINGAPORE = { center: [103.8198, 1.3021], zoom: 11.4 };
export const pinById = new Map();
const DARK = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : DARK.matches);
// Simple (positron, or dark) keeps the pins readable; Detailed (liberty) shows
// buildings, POIs and road names, and has no dark variant.
const styleUrl = () => `https://tiles.openfreemap.org/styles/${detailedMap ? "liberty" : isDark() ? "dark" : "positron"}`;
// Liberty draws buildings but not house numbers; HDB block numbers are how people find a flat.
const HOUSENUMBERS = {
  id: "housenumber", type: "symbol", source: "openmaptiles", "source-layer": "housenumber", minzoom: 17,
  layout: { "text-field": ["get", "housenumber"], "text-size": 11, "text-font": ["Noto Sans Regular"] },
  paint: { "text-color": "#55555c", "text-halo-color": "rgba(255, 255, 255, 0.9)", "text-halo-width": 1.2 }
};

let mapStyle = null;
// A full reload (not a diff), so "style.load" adds the house numbers again.
// Detailed ignores the theme, so a theme change there loads nothing.
function setMapStyle() {
  if (!map || mapStyle === styleUrl()) return;
  mapStyle = styleUrl();
  map.setStyle(mapStyle, { diff: false });
}

function setMapDetail(on) {
  setDetailedMap(on);
  const button = $(".map-detail button");
  if (button) {
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Back to the simple map" : "Detailed map: buildings, block numbers and road names. Always light, even in dark mode.";
  }
  setMapStyle();
}

class MapDetailControl {
  onAdd() {
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-group map-detail";
    this.el.innerHTML = `<button type="button" aria-pressed="false">${icon("building-2")}<span>Detailed</span></button>`;
    this.el.firstElementChild.addEventListener("click", () => { setMapDetail(!detailedMap); savePrefs(); });
    return this.el;
  }
  onRemove() { this.el.remove(); }
}

const THEMES = { auto: ["sun-moon", "Theme: follows your system"], light: ["sun", "Theme: light"], dark: ["moon", "Theme: dark"] };
export function applyTheme(theme) {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const [name, label] = THEMES[theme] ?? THEMES.auto;
  $("#theme").innerHTML = icon(name);
  $("#theme").title = label;
  $("#theme").dataset.theme = theme;
  setMapStyle();
}

function statusClass(status) {
  if (status === "viewing_scheduled") return "pin-viewing";
  if (["viewed", "applied"].includes(status)) return "pin-viewed";
  if (["contacted", "replied"].includes(status)) return "pin-contacted";
  return "";
}

function initMap() {
  if (map || !window.maplibregl) return;
  map = new maplibregl.Map({
    container: "map", style: styleUrl(), ...SINGAPORE,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false
  });
  mapStyle = styleUrl();
  map.addControl(new MapDetailControl(), "bottom-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  setMapDetail(detailedMap);
  // Test styles have no OpenMapTiles source; there is nothing to number then.
  map.on("style.load", () => { if (detailedMap && map.getSource("openmaptiles") && !map.getLayer("housenumber")) map.addLayer(HOUSENUMBERS); });
  map.touchZoomRotate.disableRotation();
  // Keep the (required) attribution as the small "i" until someone opens it.
  map.once("load", () => $(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
  DARK.addEventListener("change", setMapStyle);
}

function addMarker(el, lng, lat) {
  return new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([lng, lat]).addTo(map);
}

function pinLabel(l) {
  const price = l.price ? shortPrice(l.price, l.price % 1000 ? 1 : 0) : "?";
  if (tab === "enquiries" && l.summary?.viewing?.at) {
    return `${esc(new Date(l.summary.viewing.at).toLocaleString("en-SG", { weekday: "short", hour: "numeric", minute: "2-digit" }))} · ${price}`;
  }
  return `<b>${esc(l.score.total)}</b>${price}`;
}

function renderPlaces() {
  const key = JSON.stringify(commutes().map((c) => [c.key, c.lat, c.lng, c.label, c.icon]));
  if (key === placesFor) return;
  setPlacesFor(key);
  for (const m of placeMarkers) m.remove();
  placeMarkers = commutes().filter((c) => c.lat != null).map((c) => {
    const el = document.createElement("div");
    el.className = "place-pin";
    el.innerHTML = `${icon(c.icon)}<span>${esc(c.label)}</span>`;
    el.title = c.query;
    return addMarker(el, c.lng, c.lat);
  });
}

export function renderMap() {
  if (!$(".map-wrap").getClientRects().length) return;
  initMap();
  if (!map) return;
  const { rows, caption } = pinsForTab();
  $("#map-caption").textContent = caption;
  // In the review deck the map follows the card on top.
  const focus = openId ?? (tab === "review" ? rows[0]?.id ?? null : null);
  const visible = new Set(rows.filter((l) => l.lat != null && l.lng != null).map((l) => l.id));
  for (const [id, marker] of markers) {
    if (visible.has(id)) continue;
    marker.remove();
    markers.delete(id);
    pinById.delete(id);
  }
  for (const l of rows) {
    if (l.lat == null || l.lng == null) continue;
    let marker = markers.get(l.id);
    if (!marker) {
      const el = document.createElement("button");
      el.type = "button";
      el.addEventListener("click", (ev) => { ev.stopPropagation(); openDetail(l.id); });
      marker = addMarker(el, l.lng, l.lat);
      markers.set(l.id, marker);
      pinById.set(l.id, el);
    }
    const el = marker.getElement();
    el.classList.add("pin");
    for (const cls of ["pin-viewing", "pin-viewed", "pin-contacted"]) el.classList.toggle(cls, cls === statusClass(l.status));
    el.classList.toggle("focus", l.id === focus);
    el.classList.toggle("all", allBoxes(l));
    setHTML(el, `<span class="pin-face">${pinLabel(l)}</span>`);
    el.title = `${nameOf(l)} · score ${l.score.total} · ${STATUS_LABEL[l.status] ?? l.status}`;
    el.setAttribute("aria-label", el.title);
    el.style.zIndex = l.id === focus ? 999 : l.score.total;
    const pos = marker.getLngLat();
    if (pos.lng !== l.lng || pos.lat !== l.lat) marker.setLngLat([l.lng, l.lat]);
  }
  renderPlaces();
  if (openId) return;
  const top = tab === "review" ? rows[0] : null;
  if (top?.lat != null) {
    if (fittedFor !== `review:${top.id}`) {
      map.easeTo({ center: [top.lng, top.lat], zoom: Math.max(map.getZoom(), 13.4), duration: 500 });
      setFittedFor(`review:${top.id}`);
    }
    return;
  }
  // Re-frame when the tab (or filter set) changes, not on every refresh.
  const frame = `${projectId}:${tab}:${rows.map((l) => l.id).join(",")}`;
  if (fittedFor === frame) return;
  const points = [...rows.filter((l) => l.lat != null).map((l) => [l.lng, l.lat]), ...commutes().filter((c) => c.lat != null).map((c) => [c.lng, c.lat])];
  const duration = fittedFor ? 500 : 0;
  // Nothing to show (a new project): Singapore, not the last project's streets.
  if (!points.length) map.easeTo({ ...SINGAPORE, duration });
  else map.fitBounds(points.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(points[0], points[0])), { padding: 70, maxZoom: 14.5, duration });
  setFittedFor(frame);
}

// Places the agent found on Google Maps for the open listing.
export function showAmenities(l) {
  for (const m of amenityMarkers) m.remove();
  amenityMarkers = [];
  const e = l?.enrichment;
  if (!e || !map) return;
  const add = (p, label, ic) => {
    if (p.lat == null || p.lng == null) return;
    const el = document.createElement("div");
    el.className = "amenity-pin";
    el.innerHTML = icon(ic);
    el.title = `${label}: ${p.name}${p.walk_min != null ? ` · ${p.walk_min} min walk` : ""}`;
    amenityMarkers.push(addMarker(el, p.lng, p.lat));
  };
  const station = criterionOfType("station");
  for (const m of e.mrt ?? []) add(m, station?.label ?? "Station", station?.icon ?? "train-front");
  for (const c of nearbys()) for (const p of e.facilities?.[c.key] ?? []) add(p, c.label, c.icon);
}
