import { $, ago, api, ENDED, esc, icon, IN_TOUCH, projectId, refresh, render, setHTML, sgd, state, STATUS_LABEL, toast, when } from "./core.js";
import { nameOf, statusPill, thumbOf } from "./listing.js";

export const UPDATE_LABEL = { reply: "New agent reply", none: "Chat summary", declined: "Enquiry declined", ended: "Enquiry ended", unavailable: "Agent says it's taken", viewing_cancelled: "Viewing cancelled", viewing_scheduled: "Viewing confirmed", viewed: "Viewing completed" };
// Rows are grouped in this order; Ended starts collapsed.
const SECTIONS = { attention: "Needs your attention", viewing: "Upcoming viewings", active: "In progress", ended: "Ended" };
let endedOpen = false;

export const updatesOf = (id) => state.updates.items.filter((u) => u.listing_id === id);
export const unreadKeysOf = (id) => updatesOf(id).filter((u) => u.unread).map((u) => u.key);
const viewingAtOf = (l) => { const at = Date.parse(l.summary?.viewing?.at ?? "") / 1000; return Number.isFinite(at) ? at : null; };

// The newest thing that happened: an interpreted update, the last chat message or the intro.
function latestActivity(l, updates) {
  const lead = l.lead;
  const intro = l.sends.find((s) => !s.error);
  const quiet = "Intro sent, no reply yet";
  const options = [
    updates[0] && { label: updates[0].kind === "reply" ? "Agent" : UPDATE_LABEL[updates[0].kind] ?? "Update", text: updates[0].text, at: updates[0].at },
    lead.lastAt && (!lead.lastFromMe ? { label: "Agent", text: lead.lastText, at: lead.lastAt }
      : lead.repliedAt ? { label: "You", text: lead.lastText, at: lead.lastAt } : { label: quiet, at: lead.lastAt }),
    intro && !lead.repliedAt && { label: quiet, at: Date.parse(intro.sent_at) / 1000 }
  ].filter(Boolean);
  // Stable sort: on a tie the interpretation of a message wins over the message.
  return options.sort((a, b) => b.at - a.at)[0] ?? { label: l.chats.length ? "Chat linked" : STATUS_LABEL[l.status] ?? l.status, at: null };
}

// The Enquiries view model: every home with a property chat, a sent intro, a
// viewing or an interpreted update. Not interested stays hidden.
export function enquiries() {
  const now = Date.now() / 1000;
  const order = Object.keys(SECTIONS);
  return state.listings
    .filter((l) => !l.merged_into && l.status !== "rejected")
    .map((l) => {
      const updates = updatesOf(l.id);
      const unread = updates.filter((u) => u.unread).map((u) => u.key);
      const viewingAt = viewingAtOf(l);
      const inTouch = l.chats.length || l.sends.some((s) => !s.error) || viewingAt || IN_TOUCH.has(l.status) || updates.length;
      if (!inTouch) return null;
      const section = unread.length ? "attention" : ENDED.has(l.status) ? "ended" : viewingAt > now ? "viewing" : "active";
      return { listing: l, section, unread, viewingAt, activity: latestActivity(l, updates) };
    })
    .filter(Boolean)
    .sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section)
      || (a.section === "viewing" ? a.viewingAt - b.viewingAt : (b.activity.at ?? 0) - (a.activity.at ?? 0)));
}

function enquiryRow(e) {
  const l = e.listing;
  const photo = thumbOf(l);
  const v = l.summary?.viewing;
  const upcoming = e.viewingAt > Date.now() / 1000;
  const { label, text, at } = e.activity;
  return `<li class="enq-row${e.unread.length ? " unread" : ""}" data-id="${l.id}">
    <div class="enq-photo">${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="noimg">${icon("house")}</div>`}</div>
    <div class="enq-body">
      <div class="item-head"><span class="price">${sgd(l.price)}</span>${statusPill(l)}${e.unread.length ? `<span class="enq-new">New</span>` : ""}</div>
      <button type="button" class="item-open open enq-name" data-id="${l.id}">${esc(nameOf(l))}</button>
      ${l.agent_name ? `<div class="enq-agent">${esc(l.agent_name)}</div>` : ""}
      ${e.viewingAt ? `<div class="enq-viewing${upcoming ? " upcoming" : ""}">${icon("calendar")}${upcoming ? "Viewing" : "Viewed"} ${esc(when(v.at))}${v.confirmed === false ? " (tentative)" : ""}${v.place ? ` · <span class="enq-place">${esc(v.place)}</span>` : ""}</div>` : ""}
      <p class="enq-activity"><strong>${esc(label)}</strong>${text ? ` <span class="enq-text">${esc(text)}</span>` : ""}</p>
      ${at ? `<div class="enq-when">${ago(at)}</div>` : ""}
      ${ENDED.has(l.status) ? `<div><button type="button" class="ghost watch-btn" data-id="${l.id}">Watch again</button></div>` : ""}
    </div>
  </li>`;
}

// Property chats no listing claims yet: link one to its listing, or drop it.
function unmatchedChats() {
  const chats = state.chats.filter((c) => !c.listing_ids.length);
  if (!chats.length) return "";
  const choices = state.listings.filter((l) => !l.merged_into && l.status !== "rejected").sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  return `<h3>Chats not matched to a listing</h3><ul class="rows">${chats.map((c) => `
    <li class="chat-row">
      <div><strong>${esc(c.name ?? "—")}</strong> <span class="muted small">${c.phone ? `+${esc(c.phone)}` : esc(c.jid.split("@")[0])}${c.kind === "portal" ? " · listing-site bot" : ""}</span></div>
      <div class="muted small">${c.message_count} message${c.message_count === 1 ? "" : "s"} · last ${ago(c.last_ts)}</div>
      <select class="link-chat" data-jid="${esc(c.jid)}" aria-label="Link this chat to a listing"><option value="">Link to a listing…</option>${choices.map((l) => `<option value="${l.id}">${esc(nameOf(l))} · ${sgd(l.price)}</option>`).join("")}</select>
      <button type="button" class="link danger ignore" data-jid="${esc(c.jid)}">Not an agent</button>
    </li>`).join("")}</ul>`;
}

export function renderEnquiries(rows = enquiries()) {
  const wa = state.whatsapp;
  $("#enquiries-status").textContent = wa.state === "live"
    ? "Agent replies arrive while WhatsApp is connected. Your scheduled agent reads them before sourcing new homes."
    : wa.state === "disabled"
      ? "WhatsApp is off. Homes you message from here still appear; linking it adds replies and viewings."
      : "WhatsApp is disconnected. Saved updates stay here; new replies appear after it reconnects.";
  $("#enquiries-read").disabled = !rows.some((e) => e.unread.length);
  const groups = Object.keys(SECTIONS).map((key) => [key, rows.filter((e) => e.section === key)]).filter(([, list]) => list.length);
  setHTML($("#enquiries"), [
    ...groups.map(([key, list]) => key === "ended"
      ? `<details class="enq-ended"${endedOpen ? " open" : ""}><summary><h3>${SECTIONS.ended} · ${list.length}</h3></summary><ol class="enq-list">${list.map(enquiryRow).join("")}</ol></details>`
      : `<section class="enq-section"><h3>${SECTIONS[key]}</h3><ol class="enq-list">${list.map(enquiryRow).join("")}</ol></section>`),
    groups.length ? "" : `<div class="empty-state">${icon("message-circle")}<p>No enquiries yet.</p><p class="muted">Swipe right on a listing to message its agent. Replies, viewings and follow-ups for each home collect here.</p></div>`,
    unmatchedChats()
  ].join(""));
}

export async function markRead(keys) {
  if (!keys.length) return;
  for (const u of state.updates.items) if (keys.includes(u.key)) u.unread = false;
  state.updates.unread = state.updates.items.filter((u) => u.unread).length;
  render();
  try {
    await api(`/api/projects/${projectId}/updates/read`, { method: "POST", body: { keys } });
  } catch (error) { toast(`Could not mark updates as read: ${error.message}`); }
  await refresh().catch(() => {});
}

export function wireEnquiries() {
  $("#enquiries-read").addEventListener("click", () => markRead(state.updates.items.filter((u) => u.unread).map((u) => u.key)));
  $("#enquiries").addEventListener("toggle", (ev) => { if (ev.target.matches(".enq-ended")) endedOpen = ev.target.open; }, true);
  $("#enquiries").addEventListener("change", async (ev) => {
    const select = ev.target.closest(".link-chat");
    if (!select?.value) return;
    try {
      await api(`/api/chats/${encodeURIComponent(select.dataset.jid)}/link`, { method: "POST", body: { listingId: Number(select.value) } });
    } catch (error) { toast(`Not linked: ${error.message}`); }
    await refresh().catch(() => {});
  });
}
