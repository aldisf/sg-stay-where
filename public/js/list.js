import { $, $$, esc, icon, openId, setHTML, sgd, state, STATUS_LABEL } from "./core.js";
import { chips, leadLine, nameOf, scoreTag, sitesOf, statusPill, subOf, thumbOf } from "./listing.js";
import { drag, enableSwipe, springBack } from "./swipe.js";
import { pinById } from "./map.js";
import { decide } from "./deck.js";

// A row shows where the home stands (its status pill), not an action.
export function renderList(rows) {
  // Never redraw under a finger.
  if (drag?.live && drag.card.closest("#side-list")) return;
  setHTML($("#side-list"), rows.map((l) => {
    const photo = thumbOf(l);
    return `<li class="item${l.id === openId ? " selected" : ""}" data-id="${l.id}">
      <div class="swipe-trash" aria-hidden="true">${icon("trash-2")}<span>Not interested</span></div>
      <div class="item-card">
        <div class="item-photo">
          ${photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="noimg">${icon("house")}</div>`}
          ${scoreTag(l, "on-photo")}
        </div>
        <div class="item-body">
          <div class="item-head"><span class="price">${sgd(l.price)}</span>${statusPill(l)}${sitesOf(l) ? `<span class="sites" title="The same flat on both sites, shown once">${esc(sitesOf(l))}</span>` : ""}</div>
          <div class="item-name"><button type="button" class="item-open open" data-id="${l.id}">${esc(nameOf(l))}</button></div>
          <div class="item-sub">${esc(subOf(l))}</div>
          ${chips(l, { mustOnly: true })}
          <div class="lead">${leadLine(l)}</div>
        </div>
      </div>
    </li>`;
  }).join("") || `<li class="empty-state">${icon("eye")}${emptyListMessage(rows)}</li>`);
}

function emptyListMessage(rows) {
  const status = $("#filter-status").value;
  if (rows.filteredOut) return `<p>No listings match these filters.</p><p class="muted">Turn off a filter or try another name or area.</p>`;
  if (status === "rejected") return `<p>Nothing marked Not interested.</p><p class="muted">Listings you swipe left on in Review are kept here.</p>`;
  if (status && status !== "*") return `<p>No listings are at “${esc(STATUS_LABEL[status] ?? status)}”.</p><p class="muted">Choose another status to see more.</p>`;
  return `<p>Nothing on your watch list yet.</p><p class="muted">Swipe right on a listing in Review to add it here.</p>`;
}

// A two-stage swipe left: the trash zone shows as the row moves, and only
// REMOVE_AT of its width (or a fling past FLING_AT) marks it Not interested.
const REMOVE_AT = 0.75;
const FLING_AT = 0.4;
const FLING_SPEED = 0.6; // px per ms, leftwards
const removable = (id) => { const l = state.listings.find((x) => x.id === id); return Boolean(l) && l.status !== "rejected"; };
const listSwipe = {
  move(row, dx) {
    // Right, or a row that is already Not interested, only gives a little.
    const x = dx > 0 || !removable(Number(row.dataset.id)) ? dx / 6 : dx;
    row.classList.add("swiping");
    row.classList.toggle("armed", -x >= row.offsetWidth * REMOVE_AT);
    row.style.setProperty("--p", Math.min(1, Math.max(0, -x / 96)).toFixed(2));
    $(".item-card", row).style.transform = `translateX(${x}px)`;
    return x;
  },
  release(row, dx, { done, speed }) {
    const far = -dx >= row.offsetWidth * REMOVE_AT || (-dx >= row.offsetWidth * FLING_AT && -speed >= FLING_SPEED);
    if (done && far && removable(Number(row.dataset.id))) { removeRow(row); return; }
    row.classList.remove("armed");
    row.style.setProperty("--p", 0);
    springBack($(".item-card", row), () => row.classList.remove("swiping"));
  }
};

function removeRow(row) {
  if (row.dataset.flying) return;
  row.dataset.flying = "1";
  try { navigator.vibrate?.(12); } catch { /* device policy may disable vibration */ }
  const id = Number(row.dataset.id);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { decide(id, "hide"); return; }
  const card = $(".item-card", row);
  card.style.transition = "transform 0.18s ease-in";
  card.style.transform = `translateX(${-row.offsetWidth}px)`;
  row.style.height = `${row.offsetHeight}px`;
  setTimeout(() => {
    row.style.transition = "height 0.18s ease-in";
    row.style.height = "0px";
    setTimeout(() => decide(id, "hide"), 170);
  }, 170);
}

export function wireList() {
  enableSwipe($("#side-list"), ".item", listSwipe, { mouse: true });

  $("#side-list").addEventListener("mouseover", (ev) => {
    const item = ev.target.closest(".item");
    $$(".pin.hover").forEach((el) => el.classList.remove("hover"));
    if (item) pinById.get(Number(item.dataset.id))?.classList.add("hover");
  });
  $("#side-list").addEventListener("mouseleave", () => $$(".pin.hover").forEach((el) => el.classList.remove("hover")));
}
