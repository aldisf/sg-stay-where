import { $, $$, api, DEFAULT_FILTERS, loadPrefs, openId, projectId, refresh, savePrefs, setDetailedMap, setFittedFor, setPage, setProjectId, setTab, state, STATUS_LABEL, tab, toast, wireToast } from "./js/core.js";
import { criterionOfType, filtered, readyToReview } from "./js/listing.js";
import { drag, lastSwipeAt } from "./js/swipe.js";
import { renderEnquiries, wireEnquiries } from "./js/enquiries.js";
import { applyTheme, map, renderMap } from "./js/map.js";
import { carousel, closeDetail, lightbox, mergeWith, navState, openDetail, openDupPicker, parseHash, pushNav, splitCopy, urlFor, wireDetail } from "./js/detail.js";
import { decide, flyOff, renderDeck, stepDeckPhoto, wireDeck } from "./js/deck.js";
import { renderList, wireList } from "./js/list.js";
import { renderHeader, renderProject, renderSearches, toggleMenu, wireSettings } from "./js/settings.js";

let editing = false;

function renderListings() {
  if (!state) return;
  const rows = filtered();
  const review = filtered({ review: true });
  if (tab === "listings") renderList(rows);
  if (tab === "review") renderDeck(review);
  const shown = tab === "review" ? review : rows;
  const total = tab === "review" ? readyToReview().length : shown.length + shown.filteredOut;
  $("#filter-note").textContent = `${shown.length < total ? `${shown.length} of ${total}` : shown.length} ${tab === "review" ? "to review" : "shown"}${shown.pending ? ` · ${shown.pending} being checked` : ""}`;
  const changed = Object.entries(DEFAULT_FILTERS).filter(([id, on]) => $(`#filter-${id}`).checked !== on && (id !== "station" || criterionOfType("station")));
  const active = [...changed, $("#listing-query").value, tab === "listings" && $("#filter-status").value].filter(Boolean).length;
  $("#active-filters").textContent = active ? `· ${active} on` : "";
  $("#clear-filters").hidden = !active;
  renderMap();
}

function render() {
  renderHeader();
  renderListings();
  if (tab === "enquiries") renderEnquiries();
  if (tab === "searches") renderSearches();
  if (tab === "project") renderProject();
}

// Old links may name the Viewings, Chats or Updates tabs, which Enquiries replaced.
const OLD_TABS = { viewings: "enquiries", chats: "enquiries", updates: "enquiries" };

function showTab(name, { push = true } = {}) {
  if (!state) return;
  name = OLD_TABS[name] ?? name;
  if (!$(`#tab-${name}`)) name = "listings";
  const changed = name !== tab;
  setTab(name);
  if (push && changed) pushNav();
  $$(".tabs button").forEach((x) => {
    x.classList.toggle("active", x.dataset.tab === name);
    if (x.dataset.tab === name) x.setAttribute("aria-current", "page");
    else x.removeAttribute("aria-current");
  });
  // Phones scroll the tab strip: bring the chosen tab into it.
  const strip = $(".tabs");
  const active = $(".tabs button.active");
  if (active && (active.offsetLeft < strip.scrollLeft || active.offsetLeft + active.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
    strip.scrollLeft = active.offsetLeft - (strip.clientWidth - active.offsetWidth) / 2;
  }
  $$(".panel > .tab").forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  $(".filters").hidden = !["review", "listings"].includes(name);
  $("#filter-status").hidden = name === "review";
  document.body.dataset.tab = name;
  setFittedFor(null);
  render();
  setTimeout(() => map?.resize(), 0);
}

async function applyNav(s) {
  if (s.tab && s.tab !== tab) showTab(s.tab, { push: false });
  if (s.listing == null) {
    lightbox.close({ fromHistory: true });
    if (openId != null) closeDetail({ fromHistory: true });
    return;
  }
  if (!state.listings.some((l) => l.id === s.listing)) {
    history.replaceState(navState(), "", urlFor(navState()));
    toast("That listing isn't in this project.");
    return;
  }
  if (openId !== s.listing) await openDetail(s.listing, { push: false });
  if (s.photo != null) lightbox.open(s.photo, { push: false });
  else lightbox.close({ fromHistory: true });
}

function wire() {
  const prefs = loadPrefs();
  const phoneLayout = matchMedia("(max-width: 860px)");
  $("#filter-options").open = !phoneLayout.matches;
  phoneLayout.addEventListener("change", (event) => { $("#filter-options").open = !event.matches; if (state) renderMap(); });
  for (const [id, on] of Object.entries(DEFAULT_FILTERS)) $(`#filter-${id}`).checked = typeof prefs[id] === "boolean" ? prefs[id] : on;
  if (prefs.project) setProjectId(prefs.project);
  // A new key: the old mapDetail was saved as false with every other preference.
  setDetailedMap(prefs.mapSimple !== true);
  applyTheme(prefs.theme ?? "auto");
  $("#theme").addEventListener("click", () => {
    const order = ["auto", "light", "dark"];
    applyTheme(order[(order.indexOf($("#theme").dataset.theme ?? "auto") + 1) % order.length]);
    savePrefs();
  });
  for (const s of Object.keys(STATUS_LABEL)) $("#filter-status").insertAdjacentHTML("beforeend", `<option value="${s}">${STATUS_LABEL[s]}</option>`);
  if (prefs.sort && [...$("#sort").options].some((o) => o.value === prefs.sort)) $("#sort").value = prefs.sort;
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  ["#filter-status", "#sort", "#filter-budget", "#filter-station", "#filter-coliving"].forEach((sel) => $(sel).addEventListener("change", () => { savePrefs(); setFittedFor(null); renderListings(); renderHeader(); }));
  $("#listing-query").addEventListener("input", () => { renderListings(); renderHeader(); });
  $("#clear-filters").addEventListener("click", () => {
    for (const [id, on] of Object.entries(DEFAULT_FILTERS)) $(`#filter-${id}`).checked = on;
    $("#listing-query").value = "";
    $("#filter-status").value = "";
    savePrefs();
    renderListings();
    renderHeader();
    if ($("#filter-options").open) $("#listing-query").focus();
    else $(".tabs button.active")?.focus();
  });
  $("#retry").addEventListener("click", async () => {
    $("#retry").disabled = true;
    try { if (state) await refresh(); else await start(); } catch { /* status explains how to retry */ }
    finally { $("#retry").disabled = false; }
  });

  wireDeck();
  wireList();

  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".project-menu")) toggleMenu(false);
    // The click that ends a drag is not a tap.
    if (Date.now() - lastSwipeAt < 400 && ev.target.closest(".swipe-card, #side-list .item")) { ev.preventDefault(); return; }
    const hide = ev.target.closest(".hide-btn");
    if (hide) { ev.preventDefault(); ev.stopPropagation(); decide(Number(hide.dataset.id), "hide"); return; }
    const watch = ev.target.closest(".watch-btn");
    if (watch) { decide(Number(watch.dataset.id), "watch"); return; }
    const choice = ev.target.closest("[data-decide]");
    if (choice) { const card = $("#deck .swipe-card.top"); if (card) flyOff(card, choice.dataset.decide); return; }
    const deckPhoto = ev.target.closest(".dk-photo");
    if (deckPhoto) { stepDeckPhoto(Number(deckPhoto.dataset.step)); return; }
    const topCard = ev.target.closest("#deck .swipe-card.top");
    if (topCard) { openDetail(Number(topCard.dataset.id)); return; }
    const picker = ev.target.closest("[data-dup-picker]");
    if (picker) { openDupPicker(Number(picker.dataset.dupPicker)); return; }
    if (ev.target.closest("[data-dup-close]")) { $("#dup-picker").hidden = true; return; }
    const mergeBtn = ev.target.closest("[data-merge-with]");
    if (mergeBtn) { mergeWith(openId, Number(mergeBtn.dataset.mergeWith)); return; }
    const splitBtn = ev.target.closest("[data-split]");
    if (splitBtn) {
      if (splitBtn.dataset.armed !== "1") { splitBtn.dataset.armed = "1"; splitBtn.textContent = "Click again to split"; return; }
      splitCopy(Number(splitBtn.dataset.split));
      return;
    }
    const jump = ev.target.closest("[data-scroll]");
    if (jump) { $(`#${jump.dataset.scroll}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (ev.target.closest(".cr-prev")) { carousel.step(-1); return; }
    if (ev.target.closest(".cr-next")) { carousel.step(1); return; }
    const thumb = ev.target.closest(".thumbs .thumb");
    if (thumb) { carousel.show(Number(thumb.dataset.slide)); return; }
    if (ev.target.closest("#detail-body .carousel-main")) { ev.preventDefault(); lightbox.open(carousel.index); return; }
    const shot = ev.target.closest("#detail-body a.lb");
    if (shot) { ev.preventDefault(); lightbox.open($$("#detail-body .lb-item").indexOf(shot)); return; }
    const open = ev.target.closest(".open");
    if (open) { ev.preventDefault(); openDetail(Number(open.dataset.id)); return; }
    const item = ev.target.closest("#side-list .item, #enquiries .enq-row");
    if (item) openDetail(Number(item.dataset.id));
  });

  wireSettings(showTab);
  wireEnquiries();
  wireDetail();
  wireToast();
  document.addEventListener("keydown", (ev) => {
    if (lightbox.index != null) {
      if (ev.key === "Escape") { ev.preventDefault(); lightbox.close(); }
      if (ev.key === "ArrowRight") lightbox.step(1);
      if (ev.key === "ArrowLeft") lightbox.step(-1);
      return;
    }
    if (ev.key === "Escape" && !$("#project-list").hidden) { toggleMenu(false); return; }
    if ($("#new-project").open || $("#contact").open) return;
    const typing = ev.target instanceof Element && ev.target.matches("input, textarea, select, [contenteditable]");
    if (ev.target.closest(".project-menu, .dk-photo")) return;
    if (openId == null && tab === "review" && !typing && !ev.repeat && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      const card = $("#deck .swipe-card.top");
      if (card) flyOff(card, ev.key === "ArrowRight" ? "watch" : "hide");
      return;
    }
    if (openId == null) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeDetail(); }
    if (!typing) {
      if (ev.key === "ArrowRight") carousel.step(1);
      if (ev.key === "ArrowLeft") carousel.step(-1);
    }
  });
  window.addEventListener("popstate", (ev) => { applyNav(ev.state ?? parseHash()); });
  $("#add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("/api/listings", { method: "POST", body: { url: $("#add-url").value, project: projectId } });
      $("#add-url").value = "";
      await refresh();
      openDetail(r.id);
    } catch (error) {
      $("#add-url").setCustomValidity(error.message);
      $("#add-url").reportValidity();
      setTimeout(() => $("#add-url").setCustomValidity(""), 3000);
    }
  });
  // Don't redraw under someone typing.
  document.addEventListener("focusin", (ev) => { editing = ev.target.matches("textarea, input:not([type=checkbox])"); });
  document.addEventListener("focusout", () => { editing = false; });
  const poll = () => { if (state && !document.hidden && !editing && !drag && !$("#new-project").open) refresh().catch(() => {}); };
  setInterval(poll, 15_000);
  document.addEventListener("visibilitychange", poll);
}

setPage({ render, renderListings, renderHeader, openDetail });
wire();
async function start() {
  await refresh();
  // Give a deep-linked sheet a tab beneath it in browser history.
  const initial = parseHash();
  showTab(initial.tab ?? (filtered({ review: true }).length ? "review" : "listings"), { push: false });
  history.replaceState(navState(), "", urlFor(navState()));
  if (initial.listing != null && !state.listings.some((l) => l.id === initial.listing)) toast("That listing isn't in this project.");
  else if (initial.listing != null) {
    await openDetail(initial.listing);
    if (initial.photo != null) lightbox.open(initial.photo);
  }
}
await start().catch(() => {});
