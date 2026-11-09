import { composeIntro, defaultTemplate, shortPrice } from "/lib/intro.js";
import { $, $$, ago, api, esc, icon, INACTIVE, projectId, refresh, savePrefs, setFittedFor, setHTML, setPlacesFor, setProjectId, SITE, state, toast, when } from "./core.js";
import { criteria, criterionOfType, filtered } from "./listing.js";
import { closeDetail } from "./detail.js";

// The search template: one set of filters → the same search on PropertyGuru, 99.co and Carousell.
let templateKey = null;
let templateDirty = false;
let briefDirty = false;
let briefKey = null;

function renderSearchBrief() {
  const brief = state.project.searchBrief;
  const key = JSON.stringify([projectId, brief]);
  if (!briefDirty && key !== briefKey) {
    $("#search-brief").value = brief?.text ?? "";
    briefKey = key;
  }
  const status = { pending: "Waiting for the next agent run.", applied: "Applied to searches and project criteria.", needs_input: "A little more detail is needed. Edit your brief and send it again.", overridden: "The template was edited manually after this brief." };
  $("#search-brief-status").textContent = [status[brief?.status], brief?.question, brief?.explanation].filter(Boolean).join(" ");
}

function renderTemplate() {
  // Buying: no template. The agent sets up each site's search and adds it by link.
  $("#template-form").hidden = !state.templateDraft;
  $("#buy-searches-note").hidden = !!state.templateDraft;
  if (!state.templateDraft) return;
  const { filters: f, sites, pages } = state.templateDraft;
  const key = JSON.stringify(state.templateDraft);
  if (key === templateKey || templateDirty) return;
  templateKey = key;
  const beds = [[0, "Studio"], [1, "1 bed"], [2, "2 bed"], [3, "3 bed"], [4, "4 bed"], [5, "5+ bed"]];
  const unit = f.wholeUnit === true ? "whole" : f.wholeUnit === false ? "room" : "either";
  $("#template-form").innerHTML = `
    <h3>Search template <span class="muted small">one set of filters, the same search on every site</span></h3>
    <div class="grid3">
      <label>From S$ <input name="minPrice" type="number" step="50" value="${esc(f.minPrice)}" required></label>
      <label>To S$ <input name="maxPrice" type="number" step="50" value="${esc(f.maxPrice)}" required></label>
      <label>Pages per poll <input name="pages" type="number" min="1" max="${state.pollLimits.pages.max}" value="${esc(pages)}"></label>
    </div>
    <fieldset class="checks"><legend>Bedrooms</legend>${beds.map(([v, label]) => `<label><input type="checkbox" name="bed" value="${v}" ${f.bedrooms.includes(v) ? "checked" : ""}>${label}</label>`).join("")}</fieldset>
    <fieldset class="checks"><legend>Unit</legend>${[["whole", "Whole unit"], ["room", "Room"], ["either", "Either"]].map(([v, label]) => `<label><input type="radio" name="unit" value="${v}" ${unit === v ? "checked" : ""}>${label}</label>`).join("")}</fieldset>
    <fieldset class="checks districts"><legend>Districts <span class="muted">(none = anywhere)</span></legend>${Object.entries(state.districts).map(([d, name]) => `<label title="${esc(name)}"><input type="checkbox" name="district" value="${d}" ${f.districts.includes(d) ? "checked" : ""}><b>${d}</b> <span class="muted">${esc(name)}</span></label>`).join("")}</fieldset>
    <fieldset class="checks"><legend>Sites</legend>${[["propertyguru", "PropertyGuru"], ["99co", "99.co"], ["carousell", "Carousell"]].map(([v, label]) => `<label><input type="checkbox" name="site" value="${v}" ${sites.includes(v) ? "checked" : ""}>${label}</label>`).join("")}</fieldset>
    <p><button type="submit">Apply to searches</button> <span id="template-note" class="muted small">${state.project.templates?.main ? "Re-applying keeps each search's on/off switch." : "Creates one search per site; your existing searches stay."}</span></p>`;
}

function readTemplate() {
  const form = new FormData($("#template-form"));
  const unit = form.get("unit");
  return {
    filters: {
      minPrice: Number(form.get("minPrice")), maxPrice: Number(form.get("maxPrice")),
      bedrooms: form.getAll("bed").map(Number), wholeUnit: unit === "whole" ? true : unit === "room" ? false : null,
      districts: form.getAll("district")
    },
    sites: form.getAll("site"),
    pages: Number(form.get("pages")) || state.pollLimits.pages.default
  };
}

export function renderSearches() {
  renderTemplate();
  renderSearchBrief();
  $("#search-form [name=pages]").max = state.pollLimits.pages.max;
  for (const name of ["listings", "rpm"]) {
    const input = $(`#poll-form [name=${name}]`);
    input.max = state.pollLimits[name].max;
    if (document.activeElement !== input) input.value = state.project.poll?.[name] ?? state.pollLimits[name].default;
  }
  const searches = state.project.searches ?? [];
  $("#searches").innerHTML = searches.map((s) => {
    const last = state.searchLast?.[s.title] ?? state.searchLast?.[s.id];
    return `<li class="search-card${s.active ? "" : " off"}">
      <div class="search-main">
        <div class="search-title"><span class="site">${esc(SITE[s.site] ?? s.site)}</span>${esc(s.title)}${s.template ? `<span class="muted small">from the template</span>` : ""}</div>
        <div class="muted small">${esc(s.pages)} page${s.pages === 1 ? "" : "s"} per poll · ${last ? `last poll ${esc(when(last.at))}: ${last.note ? esc(last.note) : `${esc(last.added)} new of ${esc(last.seen)}`}` : "not polled yet"}</div>
        ${s.why ? `<div class="small">${esc(s.why)}</div>` : ""}
        <div class="search-actions"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="link">${icon("external-link")}Open on ${esc(SITE[s.site] ?? "site")}</a><button type="button" class="link danger" data-del-search="${esc(s.id)}">Remove</button></div>
      </div>
      <label class="switch" title="${s.active ? "On: the poll runs it" : "Off: skipped"}"><input type="checkbox" data-toggle-search="${esc(s.id)}" ${s.active ? "checked" : ""} aria-label="Run ${esc(s.title)}"><span></span></label>
    </li>`;
  }).join("") || `<li class="empty-state">${icon("search")}<p>No searches yet.</p><p class="muted">Add one below, or ask your agent to set them up during the interview.</p></li>`;
  $("#polls").innerHTML = state.polls.map((p) => `<li>${esc(when(p.at))} — ${esc(p.search ?? "")}: ${p.seen} seen, ${p.added} new${p.note ? ` · ${esc(p.note)}` : ""}</li>`).join("") || `<li class="muted">No polls yet.</li>`;
}

let projectPageKey = null;
let projectDirty = false;

function messageFields(p) {
  const m = p.message ?? {};
  const b = p.budget ?? {};
  const field = (name, label, value, attrs = "") => `<label>${label}<input name="${name}" value="${esc(value ?? "")}" ${attrs}></label>`;
  return `
    <fieldset class="grid4">
      <legend>Budget (${p.deal === "buy" ? "S$" : "S$/month"})</legend>
      ${field("budget.min", "From", b.min, 'type="number"')}${field("budget.max", "Up to", b.max, 'type="number"')}
      ${field("budget.stretchMax", "Stretch", b.stretchMax, 'type="number"')}${field("budget.spread", "Quote ±", b.spread, 'type="number"')}
    </fieldset>
    <fieldset class="private-fields">
      <legend>About you (for the intro message)</legend>
      ${field("name", "First name", m.name)}
      ${field("household", "Household", m.household, 'placeholder="Couple, both working professionals"')}
      ${field("residency", "Residency", m.residency, 'placeholder="Singapore Citizen + Employment Pass"')}
      ${p.deal === "buy"
        ? `${field("financing", "Financing", m.financing, 'placeholder="HDB loan, HFE letter ready"')}${field("moveIn", "Timeline", m.moveIn, 'placeholder="Within 6 months"')}`
        : `${field("lifestyle", "Lifestyle (comma separated)", (m.lifestyle ?? []).join(", "), 'placeholder="Non-smokers, No pets"')}${field("moveIn", "Move-in", m.moveIn)}${field("lease", "Lease", m.lease)}`}
      ${field("closing", "Closing line", m.closing)}
      <label>Message template <textarea name="template" rows="11">${esc(m.template || defaultTemplate(p.deal))}</textarea></label>
      <p class="hint">Placeholders: {agentFirstName} {name} {site} {listingTitle} {listingPrice} {url} {household} {residency} {lifestyle} {financing} {moveIn} {lease} {budgetRange} {closing}. A line whose placeholders are all empty is left out.</p>
    </fieldset>`;
}

function readMessageForm() {
  const p = state.project;
  const out = { budget: { ...p.budget }, message: { ...(p.message ?? {}) } };
  for (const input of $$("#message-form input, #message-form textarea")) {
    const [a, b] = input.name.split(".");
    if (a === "budget") out.budget[b] = input.value === "" ? null : Number(input.value);
    else if (a === "lifestyle") out.message.lifestyle = input.value.split(",").map((x) => x.trim()).filter(Boolean);
    else if (a === "template") out.message.template = input.value.trim() === defaultTemplate(p.deal).trim() ? null : input.value;
    else out.message[a] = input.value;
  }
  return out;
}

function previewMessage() {
  const { budget, message } = readMessageForm();
  const buy = state.project.deal === "buy";
  const sample = buy
    ? { source: "propertyguru", price: 758000, bedrooms: 3, building: "Sample Court", url: "https://www.propertyguru.com.sg/listing/hdb-for-sale-sample-500000000", agent_name: "Alex Tan" }
    : { source: "propertyguru", price: 2800, bedrooms: 1, building: "Sample Residences", url: "https://www.propertyguru.com.sg/listing/for-rent-sample-500000000", agent_name: "Alex Tan" };
  $("#message-preview").textContent = composeIntro({ ...message, budget, deal: state.project.deal }, sample);
}

export function renderProject() {
  const p = state.project;
  const wa = state.whatsapp;
  const key = JSON.stringify([p, wa.state, wa.linked, wa.self]);
  if (key === projectPageKey || projectDirty) return;
  projectPageKey = key;
  const boxes = new Map(state.scoring.boxes.map((b) => [b.key, b]));
  const rows = state.scoring.parts.filter((x) => !x.bonus).map((part) => {
    const c = criteria().find((x) => x.key === part.key);
    const box = boxes.get(part.key);
    return `<li><span class="crit-icon">${icon(part.icon)}</span><div><strong>${esc(part.label)}</strong><div class="muted small">${box ? `Must-have: ${esc(box.label)}` : "Scored, not a must-have"}${c?.type === "commute" ? ` · from <span class="private">${esc(c.query)}</span>${c.departAt ? `, leaving ${esc(c.departAt)}` : ""}` : ""}${c?.type === "nearby" ? ` · Google Maps search “${esc(c.search)}”` : ""}</div></div><span class="pts">${esc(part.max)}</span></li>`;
  }).join("");
  const bonus = state.scoring.parts.filter((x) => x.bonus);
  $("#project-page").innerHTML = `
    <div class="project-head">
      <div><p class="eyebrow">Project</p><h2>${esc(p.title)}</h2></div>
      <div class="project-actions">
        <button type="button" class="ghost" id="project-rename">Rename</button>
        <button type="button" class="ghost" id="project-archive">${p.archived ? "Unarchive" : "Archive"}</button>
      </div>
    </div>

    <section class="block">
      <h3>What matters <span class="muted small">points out of 100</span></h3>
      <ul class="criteria-list">${rows}</ul>
      <p class="small muted">Plus ${bonus.map((b) => `${esc(b.label.replace("Bonus: ", ""))} (+${esc(b.max)})`).join(" and ")}. Missing data counts half. These come from the setup interview: ask your agent to “redo the criteria interview for ${esc(p.title)}”, or edit the JSON below.</p>
    </section>

    <section class="block">
      <h3>Budget and intro message</h3>
      <form id="message-form" class="form">${messageFields(p)}
        <p><button type="submit">Save</button> <span id="message-saved" class="muted small"></span></p>
      </form>
      <h4>Preview (a sample S$2,800 listing)</h4>
      <pre id="message-preview" class="message private"></pre>
    </section>

    <section class="block" id="whatsapp-section">
      <h3>WhatsApp <span class="muted small">optional, recommended</span></h3>
      ${wa.state === "disabled" ? `
        <p>Linking WhatsApp lets the tracker see which agents you've messaged, who replied, when viewings are agreed and when a unit is taken, and lets you send your intro from a listing. Only chats that start with a PropertyGuru or 99.co link, or a Carousell link to a listing here, are stored.</p>
        <p>To link it, stop the server and run <code>npm run whatsapp</code>, then scan the QR. Read <a href="https://github.com/WhiskeySockets/Baileys#disclaimer" target="_blank" rel="noopener noreferrer">the risks</a> first: it's an unofficial client and WhatsApp can ban numbers that message in bulk.</p>`
        : `<p>${wa.linked ? `Linked as <span class="private">+${esc(wa.self ?? "…")}</span> · ${esc(wa.state)}.` : "Not linked."} Messages go only when you click Send, and never twice to the same agent.</p>
        <button id="wa-relink" type="button" class="ghost">Unlink and show a new QR</button>`}
    </section>

    <section class="block">
      <h3>Send-to-tracker bookmarklet</h3>
      <p>Drag to your bookmarks bar: <a id="bookmarklet" class="bookmarklet">Send to sg-stay-where</a></p>
      <p class="muted small">On a PropertyGuru listing it imports the listing and the agent's number; on a search page, every card.</p>
    </section>

    <section class="block">
      <h3>Advanced: project JSON</h3>
      <p class="muted small">The whole project as your agent wrote it (data/projects/${esc(p.id)}.json). Saving checks it first.</p>
      <textarea id="project-json" class="private" rows="16" spellcheck="false">${esc(JSON.stringify(p, null, 2))}</textarea>
      <p><button type="button" id="project-json-save" class="ghost">Save JSON</button> <span id="project-json-note" class="small"></span></p>
    </section>`;
  previewMessage();
  bookmarklet();
}

// The server works out the poll's health (src/server.js pollStatus); this only words it.
const POLL_TEXT = {
  running: () => "Polling…",
  blocked: (last) => `Searches blocked${last ? ` · ${last}` : ""}`,
  failed: (last) => `Last poll failed${last ? ` · ${last}` : ""}`,
  stalled: (last) => `Polls stalled${last ? ` · ${last}` : ""}`,
  ok: (last, skipped) => `Polled ${last}${skipped.length ? ` · ${skipped.length} skipped` : ""}`,
  never: () => "Poll now"
};

function renderPollButton() {
  const { lastAt, health, skipped } = state.poll;
  const last = lastAt ? ago(Date.parse(lastAt) / 1000) : null;
  const button = $("#poll-now");
  setHTML(button, `${icon("refresh-cw")}<span>${esc(POLL_TEXT[health](last, skipped))}</span>`);
  button.disabled = health === "running";
  button.classList.toggle("stalled", ["stalled", "blocked", "failed"].includes(health));
  button.title = health === "running" ? "A poll is running" : `${health === "failed" ? `${state.poll.reason ?? "Poll did not finish"}. ` : ""}${health === "stalled" ? "No poll since the schedule expected one. " : ""}${skipped.map(s => `${s.search}: ${s.note}. `).join("")}Poll now`;
  button.setAttribute("aria-label", button.title);
}

export function renderHeader() {
  if (!state) return;
  const p = state.project;
  $("#project-title").textContent = p.title;
  document.title = `${p.title} · sg-stay-where`;
  const wa = state.whatsapp;
  const label = { live: "WhatsApp", qr: "Scan QR", connecting: "Connecting…", reconnecting: "Reconnecting…", unlinked: "WhatsApp not linked", stopped: "WhatsApp stopped", disabled: "WhatsApp off" }[wa.state] ?? wa.state;
  setHTML($("#wa-status"), `<span class="dot ${wa.state === "live" ? "on" : wa.state === "disabled" ? "off" : "warn"}"></span><span>${esc(label)}</span>`);
  $("#wa-status").setAttribute("aria-label", label);
  renderPollButton();
  $("#qr-panel").hidden = !wa.qr;
  if (wa.qr) $("#qr-img").src = wa.qr;
  // The Review badge and header count what the deck shows with the current search and filters.
  const toReview = filtered({ review: true }).length;
  $("#review-count").textContent = toReview || "";
  $("#enquiries-count").textContent = new Set(state.updates.items.filter((u) => u.unread).map((u) => u.listing_id)).size || "";
  const watching = state.listings.filter((l) => !INACTIVE.has(l.status) && l.status !== "new").length;
  const viewings = state.listings.filter((l) => !INACTIVE.has(l.status) && l.summary?.viewing?.at && Date.parse(l.summary.viewing.at) > Date.now()).length;
  $("#counts").textContent = `${toReview} to review · ${watching} watching · ${viewings} upcoming viewing${viewings === 1 ? "" : "s"}`;
  const station = criterionOfType("station");
  $("#chip-station").hidden = !station;
  if (station) $("#station-label").textContent = `${station.label} ≤${station.maxMinutes} min`;
  const ceiling = p.budget?.stretchMax || p.budget?.max;
  $("#budget-label").textContent = ceiling ? `≤ S${shortPrice(ceiling)}` : "In budget";
  setHTML($("#project-list"), [
    ...state.projects.filter((x) => !x.archived).map((x) => `<button type="button" role="menuitem" data-project="${esc(x.id)}" class="${x.id === p.id ? "current" : ""}">${x.id === p.id ? icon("check") : `<span class="ic-space"></span>`}<span>${esc(x.title)}</span><span class="muted small">${x.active}/${x.searches} searches</span></button>`),
    state.projects.some((x) => x.archived) ? `<div class="menu-label">Archived</div>` : "",
    ...state.projects.filter((x) => x.archived).map((x) => `<button type="button" role="menuitem" data-project="${esc(x.id)}" class="archived">${icon("archive")}<span>${esc(x.title)}</span></button>`),
    `<hr><button type="button" role="menuitem" data-new-project>${icon("plus")}<span>New project…</span></button>`
  ].join(""));
}

async function bookmarklet() {
  const el = $("#bookmarklet");
  if (!el) return;
  // One bookmarklet for every site: it runs the extractor for the page it is on.
  const src = (await Promise.all(["propertyguru", "99co", "carousell"].map((f) => fetch(`/browser/${f}.js`).then((r) => r.text())))).join(";");
  const code = `(()=>{${src};const h=location.hostname;const r=/99\\.co$/.test(h)?n99Extract():/carousell\\.sg$/.test(h)?cxExtract():pgExtract();if(!r.listings.length){alert(r.error||'No listings found on this page');return;}window.open('${location.origin}/import#'+encodeURIComponent(JSON.stringify(r)),'_blank');})()`;
  el.href = `javascript:${encodeURIComponent(code)}`;
}

async function switchProject(id) {
  if (id === projectId) return;
  setProjectId(id);
  savePrefs();
  closeDetail({ fromHistory: true });
  setFittedFor(null);
  setPlacesFor(null);
  projectPageKey = null;
  projectDirty = false;
  templateDirty = false;
  templateKey = null;
  briefDirty = false;
  briefKey = null;
  $("#listing-query").value = "";
  await api("/api/settings", { method: "PUT", body: { currentProject: id } }).catch(() => {});
  await refresh();
}

export function toggleMenu(open = $("#project-list").hidden) {
  $("#project-list").hidden = !open;
  $("#project-button").setAttribute("aria-expanded", String(open));
}

export function wireSettings(showTab) {
  $("#poll-now").addEventListener("click", async () => {
    try {
      await api("/api/poll", { method: "POST", body: {} });
      toast("Poll started in your Chrome. New listings appear in Review as it goes.");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });
  $("#project-button").addEventListener("click", (ev) => { ev.stopPropagation(); toggleMenu(); });
  $("#project-list").addEventListener("click", (ev) => {
    const pick = ev.target.closest("[data-project]");
    if (pick) { toggleMenu(false); switchProject(pick.dataset.project); return; }
    if (ev.target.closest("[data-new-project]")) {
      toggleMenu(false);
      $("#copy-from").textContent = state.project.title;
      $("#new-project-form").reset();
      $("#new-project").showModal();
    }
  });
  $("#new-project-cancel").addEventListener("click", () => $("#new-project").close());
  $("#new-project-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = new FormData(ev.target);
    try {
      const p = await api("/api/projects", { method: "POST", body: { title: form.get("title"), deal: form.get("deal"), copyFrom: form.get("copy") ? projectId : null } });
      $("#new-project").close();
      await switchProject(p.id);
      showTab("project");
      toast(`Created ${p.title}. Ask your agent to run the setup interview for it.`);
    } catch (error) {
      toast(error.message);
    }
  });

  $("#searches").addEventListener("change", async (ev) => {
    const sid = ev.target.dataset.toggleSearch;
    if (!sid) return;
    const input = ev.target;
    const hadFocus = document.activeElement === input;
    input.disabled = true;
    try {
      await api(`/api/projects/${projectId}/searches/${sid}`, { method: "PATCH", body: { active: input.checked } });
      await refresh();
    } catch (error) {
      input.checked = !input.checked;
      toast(`Search not saved: ${error.message}`);
    } finally {
      input.disabled = false;
      // Saving disables the switch and redraws the list; keyboard focus stays on it.
      const current = $(`[data-toggle-search="${CSS.escape(sid)}"]`);
      if (hadFocus && current && (document.activeElement === document.body || !document.activeElement)) current.focus();
    }
  });
  $("#poll-form").addEventListener("submit", (ev) => ev.preventDefault());
  $("#poll-form").addEventListener("change", async (ev) => {
    const input = ev.target;
    if (!input.checkValidity()) { input.reportValidity(); return; }
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: { poll: Object.fromEntries(["listings", "rpm"].map((name) => [name, Number($(`#poll-form [name=${name}]`).value)])) } });
      await refresh();
    } catch (error) {
      toast(`Not saved: ${error.message}`);
    }
  });
  $("#searches").addEventListener("click", async (ev) => {
    const del = ev.target.closest("[data-del-search]");
    if (!del) return;
    if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "Click again to remove"; return; }
    await api(`/api/projects/${projectId}/searches/${del.dataset.delSearch}`, { method: "DELETE" });
    await refresh();
  });
  $("#template-form").addEventListener("input", () => { templateDirty = true; });
  $("#search-brief").addEventListener("input", () => { briefDirty = true; });
  $("#search-brief-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    const button = ev.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await api(`/api/projects/${projectId}/search-brief`, { method: "PUT", body: { text: $("#search-brief").value } });
      briefDirty = false;
      await refresh();
      toast("Brief saved. Your sourcing agent will use it on its next run.");
    } catch (error) { $("#search-brief-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#template-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const draft = readTemplate();
    if (!draft.sites.length) { $("#template-note").textContent = "Pick at least one site."; return; }
    try {
      const r = await api(`/api/projects/${projectId}/templates/main`, { method: "PUT", body: draft });
      templateDirty = false;
      templateKey = null;
      await refresh();
      toast(`Searches updated: ${r.searches.map((x) => SITE[x.site]).join(" and ")}. The next poll runs them.`);
    } catch (error) {
      $("#template-note").textContent = error.message;
    }
  });
  $("#search-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = new FormData(ev.target);
    try {
      await api(`/api/projects/${projectId}/searches`, { method: "POST", body: { title: form.get("title"), url: form.get("url"), pages: Number(form.get("pages")) } });
      ev.target.reset();
      await refresh();
      toast("Search added. The next poll runs it.");
    } catch (error) {
      toast(error.message);
    }
  });

  // Project page (rebuilt when the project changes; held while you edit).
  const page = $("#project-page");
  page.addEventListener("input", (ev) => {
    if (ev.target.closest("#message-form")) { projectDirty = true; previewMessage(); }
    if (ev.target.id === "project-json") projectDirty = true;
  });
  page.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "message-form") return;
    ev.preventDefault();
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: readMessageForm() });
      projectDirty = false;
      $("#message-saved").textContent = "Saved.";
      await refresh();
    } catch (error) {
      $("#message-saved").textContent = error.message;
    }
  });
  page.addEventListener("click", async (ev) => {
    const id = ev.target.closest("button")?.id;
    if (id === "project-json-save") {
      try {
        await api(`/api/projects/${projectId}`, { method: "PUT", body: JSON.parse($("#project-json").value) });
        projectDirty = false;
        projectPageKey = null;
        await refresh();
        toast("Project saved.");
      } catch (error) {
        $("#project-json-note").textContent = error.message;
      }
    }
    if (id === "project-rename") {
      const h = $(".project-head h2");
      h.innerHTML = `<input id="rename-input" value="${esc(state.project.title)}" aria-label="Project title">`;
      const input = $("#rename-input");
      input.focus();
      // Enter or leaving the field saves; Escape cancels. Whichever comes first wins.
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const title = input.value.trim();
        try {
          if (save && title && title !== state.project.title) await api(`/api/projects/${projectId}`, { method: "PATCH", body: { title } });
        } catch (error) { toast(`Title not saved: ${error.message}`); }
        projectPageKey = null;
        await refresh();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") finish(false);
        if (e.key === "Enter") finish(true);
      });
      input.addEventListener("blur", () => finish(true));
    }
    if (id === "project-archive") {
      await api(`/api/projects/${projectId}`, { method: "PATCH", body: { archived: !state.project.archived } });
      await refresh();
    }
    if (id === "wa-relink") {
      const b = ev.target.closest("button");
      if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again to unlink"; return; }
      await api("/api/whatsapp/logout", { method: "POST", body: {} });
      refresh();
    }
  });
  $("#wa-status").addEventListener("click", () => { showTab("project"); setTimeout(() => $("#whatsapp-section")?.scrollIntoView({ behavior: "smooth" }), 50); });
}
