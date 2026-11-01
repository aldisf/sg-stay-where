import { isRent, $, $$, ago, api, copyText, DECISION_LABEL, deck, esc, icon, openId, pendingNotes, refresh, renderListings, setFittedFor, setOpenId, sgd, SITE, state, STATUS_LABEL, tab, toast, when } from "./core.js";
import { allBoxes, bedsOf, chips, commuteLine, commutes, criteria, criterionOfType, foundLine, nameOf, nearbys, slidesOf, stationLine, statusSelect, unscored, walkText } from "./listing.js";
import { markRead, unreadKeysOf, UPDATE_LABEL, updatesOf } from "./enquiries.js";
import { map, showAmenities } from "./map.js";

// One block per home: the newest reading of the chat (older readings are
// superseded, not listed), its outcome, and any agent reply that came after it.
function latestBlock(l, messageCount) {
  const updates = updatesOf(l.id);
  const s = l.summary;
  const review = updates.find((u) => u.kind !== "reply");
  const reading = s ? { text: s.text, next: s.next, outcome: s.outcome, at: Date.parse(s.updated_at) / 1000 }
    : review && { text: review.text, next: review.next, outcome: review.kind, at: review.at };
  // A reply update exists only while no reading covers that message.
  const reply = updates.find((u) => u.kind === "reply");
  const unread = updates.some((u) => u.unread);
  if (!reading && !reply) return `<h3 id="latest">Latest</h3><p class="muted">${messageCount ? "Not summarised yet." : "No chat yet."}</p>`;
  const v = s?.viewing;
  // The outcome stays the headline until the user chooses a status by hand (Watch again).
  const outcome = reading?.outcome && reading.outcome !== "none" && !s?.manually_adjusted ? UPDATE_LABEL[reading.outcome] : null;
  const headline = outcome ?? (s?.decision ? DECISION_LABEL[s.decision] ?? s.decision : null);
  return `<section class="latest${unread ? " unread" : ""}" aria-labelledby="latest">
    <h3 id="latest">Latest${unread ? ` <span class="latest-new">New</span>` : ""}</h3>
    ${headline ? `<p class="decision">${esc(headline)}</p>` : ""}
    ${v?.at ? `<p class="mark">Viewing ${esc(when(v.at))}${v.place ? ` · ${esc(v.place)}` : ""}${v.confirmed === false ? " (tentative)" : ""}</p>` : ""}
    ${reading ? `<p class="latest-text">${esc(reading.text)}</p>
    ${reading.next ? `<p class="latest-next"><strong>Next:</strong> ${esc(reading.next)}</p>` : ""}
    <p class="muted small">Your agent's read of the chat, ${esc(when(reading.at * 1000))}</p>` : `<p class="muted">Not summarised yet.</p>`}
    ${reply ? `<p class="latest-reply"><strong>Agent${reading ? ", since then" : ""}</strong> <span class="muted small">${ago(reply.at)}</span><span class="latest-reply-text">${esc(reply.text)}</span></p>` : ""}
  </section>`;
}

let detailRequest = 0;
let detailOpener = null;
export async function openDetail(id, { push = true } = {}) {
  const l = state.listings.find((x) => x.id === id);
  if (!l) return;
  const request = ++detailRequest;
  if (openId == null) detailOpener = document.activeElement;
  setOpenId(id);
  lightbox.close({ fromHistory: true });
  if (push) pushNav();
  renderListings();
  showAmenities(l);
  if (map && l.lat != null) map.easeTo({ center: [l.lng, l.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 500 });
  const sheet = $("#detail");
  $("#detail-body").innerHTML = `<p class="muted" role="status">Loading listing…</p>`;
  if (!sheet.open) sheet.showModal();
  $("#detail-close").focus({ preventScroll: true });
  let messages, draft;
  try {
    [messages, draft] = await Promise.all([api(`/api/listings/${id}/messages`), api(`/api/listings/${id}/draft`)]);
  } catch (error) {
    if (request === detailRequest && openId === id) {
      $("#detail-body").innerHTML = `<div class="empty-state"><p>Could not load this listing.</p><p class="muted">${esc(error.message)}</p><button type="button" class="detail-retry">Try again</button></div>`;
      $(".detail-retry").addEventListener("click", () => openDetail(id, { push: false }));
    }
    return;
  }
  if (request !== detailRequest || openId !== id) return;
  const wa = state.whatsapp;
  const sent = l.sends.filter((s) => !s.error);
  const canSend = wa.state === "live" && l.agent_phone;
  const facts = (l.facts ?? []).filter((f) => !/Listing ID|psf|^[·•]$/i.test(f));
  const e = l.enrichment;
  // Every carousel slide and Google Maps shot is also a lightbox item (.lb-item), in order.
  carousel.slides = slidesOf(l);
  carousel.index = l.id === deck.topId ? Math.min(deck.photo, Math.max(0, carousel.slides.length - 1)) : 0;
  const slideItems = carousel.slides.map((x) => `<span class="lb-item" data-src="${esc(x.src)}" data-caption="${esc(x.caption)}"></span>`).join("");
  const thumbs = carousel.slides.map((x, i) => `<button type="button" class="thumb" data-slide="${i}" aria-label="${esc(x.caption)}"><img src="${esc(x.src)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("");
  const gallery = carousel.slides.length ? `
    <div class="carousel">
      <a href="${esc(carousel.slides[0].src)}" class="carousel-main" aria-label="Open full screen"><img id="carousel-img" src="${esc(carousel.slides[0].src)}" alt="" referrerpolicy="no-referrer"></a>
      ${carousel.slides.length > 1 ? `<button type="button" class="photo-btn cr-prev" aria-label="Previous photo">${icon("chevron-left")}</button><button type="button" class="photo-btn cr-next" aria-label="Next photo">${icon("chevron-right")}</button>` : ""}
      <span id="carousel-count" class="photo-count"></span>
    </div>
    ${carousel.slides.length > 1 ? `<div class="thumbs">${thumbs}</div>` : ""}
    <div hidden>${slideItems}</div>` : "";
  // Results shared from another listing in the same building show that one's screenshots.
  const checked = state.listings.find((x) => x.id === e?.shared_from) ?? l;
  const mapShots = Object.entries(checked.media?.maps ?? {}).map(([key, file]) => {
    const label = criteria().find((c) => c.key === key)?.label ?? key;
    const src = `/media/${checked.id}/${esc(file)}`;
    return `<figure><a href="${src}" class="lb lb-item" data-src="${src}" data-caption="Google Maps: ${esc(label)}"><img src="${src}" alt="Google Maps: ${esc(label)}" loading="lazy"></a><figcaption>${esc(label)}</figcaption></figure>`;
  }).join("");
  const places = e?.facilities ? nearbys().map((c) => `
      <h4>${icon(c.icon)}${esc(c.label)}</h4>
      <ul class="plain">${(e.facilities[c.key] ?? []).map((p) => `<li>${esc(p.name)} — ${walkText(p, true)} <span class="muted small">${esc(p.meters)} m</span></li>`).join("") || `<li class="muted">None found nearby.</li>`}</ul>`).join("") : `<p class="muted">Google Maps check pending.</p>`;
  const breakdown = l.score.parts.map((p) => `
      <tr class="${p.bonus ? "bonus" : ""}"><td>${p.icon ? icon(p.icon) : ""}${esc(p.label)}</td><td class="muted">${esc(p.detail)}${p.missing ? " (half credit)" : ""}</td><td class="num">${p.bonus && p.points ? "+" : ""}${esc(p.points)}<span class="muted">/${esc(p.max)}</span></td></tr>`).join("");

  $("#detail-body").innerHTML = `
    ${gallery}
    ${l.merged_into ? `<div class="notice">${icon("layers")}<div>This advert was merged into <a href="#" class="open" data-id="${l.merged_into}">listing #${l.merged_into}</a>: the same flat. <button type="button" class="link" data-split="${l.id}">Not the same flat</button></div></div>` : ""}
    <p class="eyebrow">${esc([l.district, foundLine(l)].filter(Boolean).join(" · "))}</p>
    <h2 class="detail-title">${esc(nameOf(l))}</h2>
    <p class="price-line"><span class="price big">${sgd(l.price)}</span>${isRent() ? `<span class="muted">/month</span>` : ""}${l.budget ? `<span class="quote">quote ${esc(l.budget.text)}${l.budget.overBudget ? " · over your stretch budget" : ""}</span>` : ""}</p>
    <p>${esc([l.property_type, bedsOf(l), l.bathrooms ? `${l.bathrooms} bath` : null, l.sqft ? `${l.sqft} sqft` : null].filter(Boolean).join(" · "))}</p>
    <p class="muted">${esc(l.address ?? "")}</p>
    ${facts.length ? `<p class="small muted">${esc(facts.join(" · "))}</p>` : ""}
    <div class="actions">
      ${l.status === "new" ? `<button type="button" class="watch-btn" data-id="${l.id}">${icon("eye")}Watch</button>` : ""}
      <button type="button" class="hide-btn pill-btn" data-id="${l.id}">${icon("x")}Not interested</button>
      <button type="button" class="ghost" data-scroll="message-section">${icon("message-circle")}Message agent</button>
      ${[{ source: l.source, url: l.url }, ...(l.also ?? [])].filter((a, i, all) => all.findIndex((x) => x.source === a.source) === i).map((a) => `<a class="ghost" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${icon("external-link")}Open on ${esc(SITE[a.source] ?? "site")}</a>`).join("")}
      ${l.merged_into ? "" : `<button type="button" class="ghost" data-dup-picker="${l.id}">${icon("layers")}Same flat as…</button>`}
      ${statusSelect(l)}
    </div>
    <section id="dup-picker" class="dup-picker" hidden></section>
    ${l.also?.length ? `<div class="notice">${icon("layers")}<div><strong>Also advertised</strong> — the same flat, merged into this card:
      <ul class="plain">${l.also.map((a) => `<li>${esc(SITE[a.source] ?? a.source)} <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">open</a> <span class="muted small">#${esc(a.id)}</span> <button type="button" class="link danger" data-split="${esc(a.id)}">Not the same flat</button></li>`).join("")}</ul></div></div>` : ""}
    ${chips(l, { labels: true })}
    <p class="agent">Agent <strong>${esc(l.agent_name ?? "unknown")}</strong>${l.agent_phone ? ` · +${esc(l.agent_phone)}` : ` <span class="muted">· no phone yet</span>`}</p>

    ${unscored(l) ? `<h3>Score</h3>
    <p class="muted">Not scored yet. Open the listing page with the bookmarklet to fill in its details; the next poll checks Google Maps.</p>` : `<h3>Score <span class="score-tag ${allBoxes(l) ? "all" : ""}">${esc(l.score.total)}</span> <span class="muted small">/ 100 · ${esc(l.score.boxesTicked)} of ${esc(l.score.boxes.length)} must-haves</span></h3>
    <table class="breakdown">${breakdown}</table>`}

    ${latestBlock(l, messages.length)}

    <h3>Getting around <span class="muted small">${e?.checked_at ? `Google Maps, ${esc(when(e.checked_at))}${e.shared_from ? " · same building as another listing" : ""}` : ""}</span></h3>
    <dl class="facts">
      ${criterionOfType("station") ? `<div><dt>${icon(criterionOfType("station").icon)}${esc(criterionOfType("station").label)}</dt><dd>${stationLine(l)}</dd></div>` : ""}
      ${commutes().map((c) => `<div><dt>${icon(c.icon)}${esc(c.label)}</dt><dd>${commuteLine(l, c)}</dd></div>`).join("")}
    </dl>
    ${l.lat != null ? `<iframe class="gmap" title="Google Maps" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q=${l.lat},${l.lng}&z=16&output=embed"></iframe>` : ""}
    ${places}
    ${mapShots ? `<div class="shots">${mapShots}</div>` : ""}

    <h3>Notes</h3>
    <textarea id="notes" aria-label="Listing notes" rows="3" placeholder="Anything to remember about this one">${esc(l.notes)}</textarea>

    <h3 id="message-section">Message the agent</h3>
    ${sent.length ? `<p class="muted">Intro sent ${esc(when(sent[0].sent_at))}.</p>` : ""}
    <textarea id="draft" aria-label="Message to agent" rows="13">${esc(draft.text)}</textarea>
    <p class="send-row">
      <button id="send" type="button" ${canSend ? "" : "disabled"}>${sent.length ? "Send again" : "Send on WhatsApp"}</button>
      <button id="copy-draft" type="button" class="${canSend ? "ghost" : ""}">${icon("copy")}Copy</button>
      <span id="send-note" class="muted small">${wa.state === "disabled" ? "WhatsApp is off: copy the message and paste it into WhatsApp or the site's chat." : !l.agent_phone ? "No agent number yet: copy the message and paste it into the site's chat." : wa.state !== "live" ? `WhatsApp is ${esc(wa.state)}: copy the message and paste it into WhatsApp.` : "Click twice to send. One intro per listing; never bulk."}</span>
    </p>

    <h3>Chat <span class="muted small">${messages.length} messages</span></h3>
    ${l.chats.map((c) => `<p class="small muted chat-with">With ${esc(c.name ?? "the agent")}${c.phone ? ` · +${esc(c.phone)}` : ""} <button type="button" class="link danger ignore" data-jid="${esc(c.jid)}">Not an agent</button></p>`).join("")}
    <div class="thread">${messages.map((m) => `
      <div class="msg ${m.from_me ? "me" : "them"}"><div>${esc(m.text)}</div><div class="muted small">${esc(new Date(m.ts * 1000).toLocaleString("en-SG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }))}</div></div>`).join("") || `<p class="muted">No messages.</p>`}
    </div>
    <p class="muted small footnote">"Not interested" hides it and stops polls bringing it back. <button id="delete" type="button" class="link danger">Delete permanently</button></p>`;
  sheet.setAttribute("aria-label", nameOf(l));
  $("#detail").scrollTop = 0;
  carousel.show(carousel.index);
  // The latest state covers every update for this home, so opening the sheet reads them.
  markRead(unreadKeysOf(id));

  // Kept locally first, so reopening the sheet before the save returns shows it.
  $("#notes").addEventListener("change", async (ev) => {
    const mark = { notes: ev.target.value, savedAt: null };
    pendingNotes.set(id, mark);
    l.notes = mark.notes;
    await api(`/api/listings/${id}`, { method: "PATCH", body: { notes: mark.notes } });
    mark.savedAt = Date.now();
    await refresh();
  });
  let armed = false;
  $("#send").addEventListener("click", async (ev) => {
    if (!armed) { armed = true; ev.target.textContent = "Click again to send"; return; }
    ev.target.disabled = true;
    $("#send-note").textContent = "Sending…";
    try {
      await api(`/api/listings/${id}/send`, { method: "POST", body: { text: $("#draft").value } });
      $("#send-note").textContent = "Sent.";
      await refresh();
      openDetail(id, { push: false });
    } catch (error) {
      $("#send-note").textContent = error.message;
      ev.target.disabled = false;
      armed = false;
      ev.target.textContent = "Send on WhatsApp";
    }
  });
  $("#copy-draft").addEventListener("click", async () => {
    $("#send-note").textContent = (await copyText($("#draft")))
      ? "Copied. Paste it into WhatsApp or the site's chat; nothing was sent from here."
      : "Couldn't copy here. Select the message and copy it.";
  });
  let delArmed = false;
  $("#delete").addEventListener("click", async (ev) => {
    if (!delArmed) { delArmed = true; ev.target.textContent = "Click again to delete"; return; }
    await api(`/api/listings/${id}`, { method: "DELETE" });
    closeDetail();
    refresh();
  });
}

export async function openDupPicker(id) {
  const box = $("#dup-picker");
  if (!box) return;
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<p class="muted small">Finding likely matches…</p>`;
  const candidates = await api(`/api/listings/${id}/duplicate-candidates`);
  const row = (c) => `<li class="dup-row" data-name="${esc((c.building ?? c.title ?? "").toLowerCase())}">
      <div class="dup-thumb">${c.photo ? `<img src="${esc(c.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : icon("house")}</div>
      <div class="dup-info">
        <div class="dup-name">${esc(c.building ?? c.title ?? `#${c.id}`)}</div>
        <div class="muted small">${sgd(c.price)} · ${esc([c.bedrooms === 0 ? "Studio" : c.bedrooms ? `${c.bedrooms} bed` : null, c.sqft ? `${c.sqft} sqft` : null, SITE[c.source], STATUS_LABEL[c.status]].filter(Boolean).join(" · "))}</div>
        ${c.reasons.length ? `<div class="dup-reasons">${c.reasons.map((r) => `<span>${esc(r)}</span>`).join("")}</div>` : ""}
      </div>
      <button type="button" class="ghost" data-merge-with="${c.id}">Same flat</button>
    </li>`;
  box.innerHTML = `
    <div class="dup-head"><h4>${icon("layers")}Which listing is the same flat?</h4><button type="button" class="link" data-dup-close>Cancel</button></div>
    <input type="search" id="dup-filter" placeholder="Filter by name" aria-label="Filter listings">
    <div class="dup-keep"><span class="muted small">Keep:</span>
      <label><input type="radio" name="dup-keep" value="auto" checked> the one you've acted on</label>
      <label><input type="radio" name="dup-keep" value="this"> this card</label>
      <label><input type="radio" name="dup-keep" value="other"> the one you pick</label></div>
    <ul class="dup-list">${candidates.map(row).join("") || `<li class="muted">No other listings.</li>`}</ul>`;
  $("#dup-filter").addEventListener("input", (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    $$("#dup-picker .dup-row").forEach((r) => { r.hidden = !!q && !r.dataset.name.includes(q); });
  });
}

// The sheet shows `id` again after a merge or split (or the kept card, when this one was merged away).
async function reopen(id) {
  await openDetail(id, { push: false });
  history.replaceState(navState(), "", urlFor(navState()));
}

export async function mergeWith(id, otherId) {
  const keep = $("input[name=dup-keep]:checked")?.value ?? "auto";
  try {
    const r = await api(`/api/listings/${id}/merge`, { method: "POST", body: { with: otherId, keep } });
    await refresh();
    const kept = state.listings.find((x) => x.id === r.keep);
    await reopen(r.keep);
    toast("Merged into ", async () => {
      await api(`/api/listings/${r.copy}/split`, { method: "POST", body: {} });
      await refresh();
      if (openId != null) await reopen(openId);
      toast("Split again: two listings.");
    }, kept ? nameOf(kept) : `#${r.keep}`, ". One card now links to both adverts.");
  } catch (error) {
    toast(`Not merged: ${error.message}`);
  }
}

export async function splitCopy(copyId) {
  try {
    await api(`/api/listings/${copyId}/split`, { method: "POST", body: {} });
    await refresh();
    if (openId != null) await reopen(openId);
    toast("Split: they're separate listings again, and won't be merged automatically.");
  } catch (error) {
    toast(`Not split: ${error.message}`);
  }
}

// The close button and Escape go back in history when the sheet has its own
// entry, so the browser's Back and the page's close behave the same.
export function closeDetail({ fromHistory = false } = {}) {
  if (!fromHistory && history.state?.listing === openId && openId != null) { history.back(); return; }
  setOpenId(null);
  detailRequest += 1;
  lightbox.close({ fromHistory: true });
  $("#detail").close();
  showAmenities(null);
  setFittedFor(null);
  renderListings();
  const opener = detailOpener?.isConnected ? detailOpener : $(`#side-list .open[data-id="${detailOpener?.dataset.id}"]`);
  if (opener) opener.focus({ preventScroll: true });
  else $(tab === "review" ? ".deck-actions .more" : ".tabs button.active")?.focus({ preventScroll: true });
  detailOpener = null;
}

export const carousel = {
  slides: [],
  index: 0,
  show(i) {
    if (!this.slides.length || !$("#carousel-img")) return;
    this.index = (i + this.slides.length) % this.slides.length;
    const slide = this.slides[this.index];
    $("#carousel-img").src = slide.src;
    $(".carousel-main").setAttribute("href", slide.src);
    $("#carousel-count").textContent = `${slide.caption} · ${this.index + 1} / ${this.slides.length}`;
    $$(".thumbs .thumb").forEach((t) => t.classList.toggle("active", Number(t.dataset.slide) === this.index));
    $(`.thumbs .thumb[data-slide="${this.index}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    // Warm the next photo so paging feels instant.
    const next = this.slides[(this.index + 1) % this.slides.length];
    if (next) { const img = new Image(); img.referrerPolicy = "no-referrer"; img.src = next.src; }
  },
  step(delta) { this.show(this.index + delta); }
};

export const lightbox = {
  images: [],
  index: null,
  collect() {
    this.images = $$("#detail-body .lb-item").map((el) => ({ src: el.dataset.src ?? el.getAttribute("href"), caption: el.dataset.caption ?? "" }));
  },
  open(index, { push = true } = {}) {
    this.collect();
    if (!this.images.length) return;
    this.index = (index + this.images.length) % this.images.length;
    const image = this.images[this.index];
    $("#lb-img").referrerPolicy = "no-referrer";
    $("#lb-img").src = image.src;
    // Keep the sheet's carousel on the same photo.
    if (this.index < carousel.slides.length) carousel.show(this.index);
    $("#lb-caption").textContent = `${image.caption} · ${this.index + 1} / ${this.images.length}`;
    if (!$("#lightbox").open) {
      $("#lightbox").showModal();
      $("#lb-close").focus({ preventScroll: true });
    }
    if (push) pushNav();
    else history.replaceState(navState(), "", urlFor(navState()));
  },
  // Paging replaces the history entry, so Back closes the viewer in one step.
  step(delta) { if (this.index != null) this.open(this.index + delta, { push: false }); },
  close({ fromHistory = false } = {}) {
    if (this.index == null) return;
    if (!fromHistory && history.state?.photo != null) { history.back(); return; }
    this.index = null;
    $("#lightbox").close();
    $("#lb-img").removeAttribute("src");
  }
};

export const navState = () => ({ tab, listing: openId, photo: lightbox.index });

// "#/review", "#/listing-55/photo-2". The slash keeps fragments from matching element
// ids, which would make the browser scroll the panel to them.
export function urlFor(s) {
  if (s.listing != null) return `#/listing-${s.listing}${s.photo != null ? `/photo-${s.photo + 1}` : ""}`;
  return `#/${s.tab}`;
}

export function pushNav() {
  const s = navState();
  if (location.hash !== urlFor(s)) history.pushState(s, "", urlFor(s));
}

export function parseHash() {
  const m = location.hash.match(/^#\/?listing-(\d+)(?:\/photo-(\d+))?$/);
  if (m) return { tab, listing: Number(m[1]), photo: m[2] ? Number(m[2]) - 1 : null };
  const t = location.hash.match(/^#\/(\w+)$/) ?? location.hash.match(/^#tab-(\w+)$/);
  return { tab: t ? t[1] : null, listing: null, photo: null };
}

export function wireDetail() {
  document.addEventListener("change", async (ev) => {
    if (!ev.target.matches("select.status")) return;
    await api(`/api/listings/${ev.target.dataset.id}`, { method: "PATCH", body: { status: ev.target.value } });
    await refresh();
  });
  // "Not an agent" in Enquiries (unmatched chats) and in a home's sheet (its linked chats).
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".ignore");
    if (!btn) return;
    if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Click again: delete and block"; return; }
    await api(`/api/chats/${encodeURIComponent(btn.dataset.jid)}/ignore`, { method: "POST", body: {} });
    await refresh();
    if (btn.closest("#detail") && openId != null) openDetail(openId, { push: false });
  });
  $("#detail-close").addEventListener("click", () => closeDetail());
  $("#detail").addEventListener("cancel", (ev) => { ev.preventDefault(); closeDetail(); });
  $("#lightbox").addEventListener("cancel", (ev) => { ev.preventDefault(); lightbox.close(); });
  $("#lb-close").addEventListener("click", () => lightbox.close());
  $("#lb-prev").addEventListener("click", () => lightbox.step(-1));
  $("#lb-next").addEventListener("click", () => lightbox.step(1));
  $("#lightbox").addEventListener("click", (ev) => { if (ev.target.id === "lightbox") lightbox.close(); });
  let touchX = null;
  $("#lightbox").addEventListener("touchstart", (ev) => { touchX = ev.touches[0].clientX; }, { passive: true });
  $("#lightbox").addEventListener("touchend", (ev) => {
    const dx = ev.changedTouches[0].clientX - (touchX ?? 0);
    if (Math.abs(dx) > 50) lightbox.step(dx < 0 ? 1 : -1);
    touchX = null;
  });
  let carouselTouchX = null;
  $("#detail").addEventListener("touchstart", (ev) => {
    carouselTouchX = ev.target.closest(".carousel") ? ev.touches[0].clientX : null;
  }, { passive: true });
  $("#detail").addEventListener("touchend", (ev) => {
    if (carouselTouchX == null) return;
    const dx = ev.changedTouches[0].clientX - carouselTouchX;
    if (Math.abs(dx) > 40) carousel.step(dx < 0 ? 1 : -1);
    carouselTouchX = null;
  });
}
