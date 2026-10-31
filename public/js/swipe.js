export let drag = null;
export let lastSwipeAt = 0;

export function springBack(el, after = () => {}) {
  el.style.transition = "transform 0.2s ease-out";
  el.style.transform = "";
  setTimeout(() => { el.style.transition = ""; after(); }, 220);
}

// Tracks a sideways drag on a card and hands its distance to `gesture`
// (deckSwipe or listSwipe), which draws it and decides what a release means.
// Vertical moves are left to the page so lists still scroll.
export function enableSwipe(container, selector, gesture, { mouse = false } = {}) {
  // Some WebKit versions still navigate history despite overscroll-behavior.
  // Cancel only a horizontal touch inside a card; scrolling and pinch zoom stay native.
  let touchStart = null;
  container.addEventListener("touchstart", (ev) => {
    const card = ev.target.closest(selector);
    touchStart = ev.touches.length === 1 && card && !ev.target.closest("button, a, select, input, textarea")
      ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null;
  }, { passive: true });
  container.addEventListener("touchmove", (ev) => {
    if (!touchStart || ev.touches.length !== 1) { touchStart = null; return; }
    const dx = Math.abs(ev.touches[0].clientX - touchStart.x);
    const dy = Math.abs(ev.touches[0].clientY - touchStart.y);
    if (dy > 12 && dy > dx) { touchStart = null; return; }
    if (dx > 12 && dx > dy && ev.cancelable) ev.preventDefault();
  }, { passive: false });
  container.addEventListener("touchend", () => { touchStart = null; }, { passive: true });
  container.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
  container.addEventListener("pointerdown", (ev) => {
    const card = ev.target.closest(selector);
    if (!ev.isPrimary || !card || drag || card.dataset.flying || ev.target.closest("button, a, select, input, textarea")) return;
    if (ev.pointerType === "mouse" && (!mouse || ev.button !== 0)) return;
    drag = { card, x: ev.clientX, y: ev.clientY, dx: 0, live: false, pointer: ev.pointerId, at: ev.timeStamp, speed: 0 };
  });
  container.addEventListener("pointermove", (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.live) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < 12) return;
      drag.live = true;
      try { drag.card.setPointerCapture(ev.pointerId); } catch { /* synthetic pointer */ }
      drag.card.classList.add("dragging");
    }
    const shown = gesture.move(drag.card, dx);
    drag.speed = (shown - drag.dx) / Math.max(1, ev.timeStamp - drag.at);
    drag.at = ev.timeStamp;
    drag.dx = shown;
  });
  const end = (ev) => {
    if (!drag || ev.pointerId !== drag.pointer) return;
    const { card, dx, live, at, speed } = drag;
    drag = null;
    if (!live) return;
    lastSwipeAt = Date.now();
    card.classList.remove("dragging");
    // A finger that stopped before lifting is not a fling.
    gesture.release(card, dx, { done: ev.type === "pointerup", speed: ev.timeStamp - at < 100 ? speed : 0 });
  };
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
  container.addEventListener("lostpointercapture", (ev) => {
    if (ev.target === drag?.card) end(ev);
  });
}
