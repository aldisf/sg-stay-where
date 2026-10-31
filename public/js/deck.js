import { $, $$, api, copyText, deck, esc, icon, isRent, openId, pending, refresh, render, renderHeader, renderListings, sgd, state, toast } from "./core.js";
import { chips, commuteLine, commutes, criterionOfType, filtered, foundAgo, nameOf, nearbyLine, readyToReview, scoreTag, sitesOf, slidesOf, stationLine, subOf } from "./listing.js";
import { drag, enableSwipe, springBack } from "./swipe.js";
import { closeDetail } from "./detail.js";

// "hide" sets rejected, not deleted, so a later poll that sees the listing
// again does not bring it back.
export async function decide(id, choice, said = "") {
  const l = state.listings.find((x) => x.id === id);
  if (!l) return;
  const previous = l.status;
  const next = choice === "watch" ? "shortlisted" : "rejected";
  if (previous === next) return;
  l.status = next;
  // Fast swipes overlap: keep this choice over any refresh sent before it was saved.
  const mark = { status: next, savedAt: null };
  pending.set(id, mark);
  if (openId === id) closeDetail();
  else renderListings();
  renderHeader();
  try {
    // Hiding also hides the same flat listed by other agents.
    const { alsoHidden = [] } = await api(`/api/listings/${id}`, { method: "PATCH", body: { status: next } });
    mark.savedAt = Date.now();
    await refresh();
    const extra = alsoHidden.length ? ` (+${alsoHidden.length} repeat${alsoHidden.length === 1 ? "" : "s"} from other agents)` : "";
    toast(`${said}${choice === "watch" ? "Watching" : "Hidden"}: `, async () => {
      await api(`/api/listings/${id}`, { method: "PATCH", body: { status: previous } });
      for (const r of alsoHidden) await api(`/api/listings/${r.id}`, { method: "PATCH", body: { status: r.status, notes: r.notes ?? "" } });
      await refresh();
      toast(`${previous === "new" ? "Back to review" : "Restored"}: `, null, nameOf(l), extra);
    }, nameOf(l), extra);
  } catch (error) {
    if (pending.get(id) === mark) {
      pending.delete(id);
      const current = state.listings.find((x) => x.id === id);
      if (current) current.status = previous;
      render();
    }
    await refresh().catch(() => {});
    toast(`Not saved: ${error.message}`);
  }
}

const STAMPS = `<span class="stamp stamp-watch" aria-hidden="true">Interested</span><span class="stamp stamp-nope" aria-hidden="true">Not interested</span>`;
const swipeThreshold = (card) => Math.min(130, card.offsetWidth * 0.3);

export function flyOff(card, choice) {
  if (card.dataset.flying) return;
  card.dataset.flying = "1";
  // Called while the gesture still has user activation. Unsupported browsers
  // (including iPhone Safari) retain the same visual confirmation.
  try { navigator.vibrate?.(12); } catch { /* device policy may disable vibration */ }
  const id = Number(card.dataset.id);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { decide(id, choice); return; }
  const dir = choice === "watch" ? 1 : -1;
  card.dataset.dir = choice;
  card.style.setProperty("--p", 1);
  card.style.transition = "transform 0.24s cubic-bezier(.4,0,.6,1), opacity 0.24s";
  card.style.transform = `translateX(${dir * (card.offsetWidth + 80)}px) rotate(${dir * 12}deg)`;
  card.style.opacity = "0";
  setTimeout(() => (choice === "watch" ? askToContact(id) : decide(id, choice)), 210);
}

function restoreCard(id) {
  for (const el of $$(`[data-id="${id}"][data-flying]`)) {
    delete el.dataset.flying;
    delete el.dataset.dir;
    for (const prop of ["transition", "transform", "opacity", "--p"]) el.style.removeProperty(prop);
  }
}

const deckSwipe = {
  move(card, dx) {
    card.dataset.dir = dx > 0 ? "watch" : "hide";
    card.style.setProperty("--p", Math.min(1, Math.abs(dx) / swipeThreshold(card)).toFixed(2));
    card.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
    return dx;
  },
  release(card, dx, { done }) {
    if (done && Math.abs(dx) >= swipeThreshold(card)) { flyOff(card, dx > 0 ? "watch" : "hide"); return; }
    card.style.setProperty("--p", 0);
    springBack(card, () => delete card.dataset.dir);
  }
};

// A right swipe on a listing nobody has messaged yet shows the intro first.
// Sending is the user's click here (or in their own WhatsApp). Polls never
// reach this.
const contact = { id: null, phone: null };

async function askToContact(id) {
  const l = state.listings.find((x) => x.id === id);
  if (!l || l.sends.some((s) => !s.error)) { decide(id, "watch"); return; }
  let draft;
  try { draft = await api(`/api/listings/${id}/draft`); } catch { decide(id, "watch"); return; }
  const wa = state.whatsapp;
  const linked = wa.state === "live";
  const profileSet = Boolean(state.project.message?.name);
  Object.assign(contact, { id, phone: draft.phone });
  $("#contact-to").textContent = draft.phone
    ? `To ${l.agent_name || "the agent"} · +${draft.phone}`
    : `To ${l.agent_name || "the agent"} · no number yet`;
  $("#contact-text").value = draft.text;
  $("#contact-note").textContent = !profileSet
    ? `Your intro isn't set up yet: fill in About you in the Project tab, or ask your agent to interview you for it.${draft.phone && !linked ? " You can still open the chat in WhatsApp and write it there." : ""}`
    : !draft.phone
      ? "No WhatsApp number for this agent yet (the next poll reads it from the listing page). Copy the message and paste it into the listing site's chat."
      : linked
        ? "Send goes from your linked WhatsApp now."
        : "Open in WhatsApp opens the chat (the app, or WhatsApp Web) with this message ready. You press send there.";
  const hasPhone = Boolean(draft.phone);
  $("#contact-send").hidden = !linked;
  $("#contact-send").disabled = !(profileSet && hasPhone);
  // The wa.me link opens the app or WhatsApp Web with the message as a draft; it needs only a number.
  $("#contact-open").hidden = !hasPhone;
  $("#contact-open").classList.toggle("ghost", linked);
  $("#contact-copy").classList.toggle("ghost", linked || hasPhone);
  updateContactLink();
  $("#contact").showModal();
  const text = $("#contact-text");
  text.focus({ preventScroll: true });
  text.setSelectionRange(0, 0);
  text.scrollTop = 0;
}

function updateContactLink() {
  if (contact.phone) $("#contact-open").href = `https://wa.me/${contact.phone}?text=${encodeURIComponent($("#contact-text").value)}`;
}

function closeContact(outcome) {
  const id = contact.id;
  contact.id = null;
  if ($("#contact").open) $("#contact").close();
  if (id == null) return;
  if (outcome === "cancel") restoreCard(id);
  else decide(id, "watch");
}

// Copying sends nothing: the user pastes it into WhatsApp or the site's chat.
async function copyContact() {
  const id = contact.id;
  if (!(await copyText($("#contact-text")))) {
    $("#contact-note").textContent = "Couldn't copy here. Select the message, copy it, then choose Just watch.";
    return;
  }
  contact.id = null;
  $("#contact").close();
  decide(id, "watch", "Message copied · ");
}

async function sendContact() {
  const id = contact.id;
  const button = $("#contact-send");
  button.disabled = true;
  $("#contact-note").textContent = "Sending…";
  try {
    await api(`/api/listings/${id}`, { method: "PATCH", body: { status: "shortlisted" } });
    await api(`/api/listings/${id}/send`, { method: "POST", body: { text: $("#contact-text").value } });
  } catch (error) {
    $("#contact-note").textContent = `Not sent: ${error.message}`;
    button.disabled = false;
    await refresh().catch(() => {});
    return;
  }
  const l = state.listings.find((x) => x.id === id);
  contact.id = null;
  $("#contact").close();
  await refresh();
  toast("Sent: ", null, l ? nameOf(l) : "");
}

function deckCard(l, photo, { under = false, still = false } = {}) {
  const slides = slidesOf(l);
  const slide = slides[photo] ?? slides[0];
  const nearby = nearbyLine(l);
  return `<article class="swipe-card ${under ? "under" : "top"}${still ? " still" : ""}" data-id="${l.id}"${under ? ` aria-hidden="true"` : ""}>
    <div class="sc-photo">
      ${slide ? `<img src="${esc(slide.src)}" alt="" draggable="false" referrerpolicy="no-referrer">` : `<div class="noimg">${icon("house")}</div>`}
      ${scoreTag(l, "on-photo big")}
      <span class="sc-found">Found ${esc(foundAgo(l))}</span>
      ${!under && slides.length > 1 ? `<button type="button" class="photo-btn dk-photo dk-prev" data-step="-1" aria-label="Previous photo">${icon("chevron-left")}</button><button type="button" class="photo-btn dk-photo dk-next" data-step="1" aria-label="Next photo">${icon("chevron-right")}</button><span class="photo-count">${photo + 1} / ${slides.length}</span>` : ""}
      ${STAMPS}
    </div>
    <div class="sc-body">
      <div class="sc-head">
        <div><div class="price big">${sgd(l.price)}${isRent() ? `<span class="per">/mo</span>` : ""}</div><div class="item-name">${esc(nameOf(l))}</div></div>
        ${l.budget ? `<div class="quote" title="The range your intro message would quote">quote ${esc(l.budget.text)}</div>` : ""}
      </div>
      <div class="item-sub">${esc([subOf(l), l.district].filter(Boolean).join(" · "))}${sitesOf(l) ? ` · <span class="sites">${esc(sitesOf(l))}</span>` : ""}</div>
      ${chips(l, { labels: true })}
      <dl class="facts">
        ${criterionOfType("station") ? `<div><dt>${esc(criterionOfType("station").label)}</dt><dd>${stationLine(l)}</dd></div>` : ""}
        ${commutes().map((c) => `<div><dt>${esc(c.label)}</dt><dd>${commuteLine(l, c)}</dd></div>`).join("")}
      </dl>
      ${nearby ? `<p class="small muted">${nearby}</p>` : ""}
    </div>
  </article>`;
}

export function renderDeck(rows) {
  $("#review-count").textContent = rows.length || "";
  // Never redraw under a finger.
  if (drag?.live) return;
  const top = rows[0];
  // Only a new card on top slides in; a redraw of the same one (next photo) doesn't.
  const entering = (top?.id ?? null) !== deck.topId;
  if (entering) { deck.topId = top?.id ?? null; deck.photo = 0; }
  // Ready listings the search box or a filter keeps out of the deck.
  const hidden = readyToReview().length - rows.length;
  const pendingNote = rows.pending ? ` ${rows.pending} more will appear once the poll has checked ${rows.pending === 1 ? "it" : "them"}.` : "";
  const missing = state.profileMissing ?? [];
  const profileNote = missing.length ? `<p class="profile-note">${icon("user")}<span>Your intro is missing ${esc(missing.join(", "))}. <a href="#/project">Complete your profile</a> or ask your agent.</span></p>` : "";
  const html = profileNote + (top ? `
    <div class="deck">
      ${rows[1] ? deckCard(rows[1], 0, { under: true }) : ""}
      ${deckCard(top, deck.photo, { still: !entering })}
    </div>
    <div class="deck-actions">
      <button type="button" class="deck-btn nope" data-decide="hide">${icon("x")}<span>Not interested</span></button>
      <button type="button" class="deck-btn more open" data-id="${top.id}">Details</button>
      <button type="button" class="deck-btn watch" data-decide="watch">${icon("message-circle")}<span>Interested</span></button>
    </div>
    <p class="deck-hint">Swipe or press ← → to decide. Interested shows you the message before anything is sent.</p>`
    : hidden
      ? `<div class="empty-state">${icon("sparkles")}<p>No listings match these filters.</p><p class="muted">${hidden} ${hidden === 1 ? "listing is" : "listings are"} waiting. Turn off a filter or clear the search to see ${hidden === 1 ? "it" : "them"}.${pendingNote}</p></div>`
      : `<div class="empty-state">${icon("sparkles")}<p>${rows.pending ? "Listings are being checked." : "You're all caught up."}</p><p class="muted">New listings from your searches land here first.${pendingNote}</p></div>`);
  if (html !== deck.html) {
    $("#deck").innerHTML = html;
    deck.html = html;
  }
}

export function stepDeckPhoto(delta) {
  const l = state.listings.find((x) => x.id === deck.topId);
  const slides = l ? slidesOf(l) : [];
  if (slides.length < 2) return;
  deck.photo = (deck.photo + delta + slides.length) % slides.length;
  renderDeck(filtered({ review: true }));
}

export function wireDeck() {
  $("#contact-cancel").addEventListener("click", () => closeContact("cancel"));
  $("#contact-watch").addEventListener("click", () => closeContact("watch"));
  $("#contact-open").addEventListener("click", () => closeContact("opened"));
  $("#contact-send").addEventListener("click", sendContact);
  $("#contact-copy").addEventListener("click", copyContact);
  $("#contact-text").addEventListener("input", updateContactLink);
  // Escape cancels like the button.
  $("#contact").addEventListener("cancel", (ev) => { ev.preventDefault(); closeContact("cancel"); });

  enableSwipe($("#deck"), ".swipe-card.top", deckSwipe, { mouse: true });
}
