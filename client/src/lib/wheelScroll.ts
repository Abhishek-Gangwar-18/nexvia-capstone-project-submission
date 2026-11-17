/**
 * Mouse-wheel scrolling for horizontal rows: over a sideways-scrolling row with a hidden scrollbar
 * (`scrollbar-none`: category bar, product rails, filter tabs), a vertical wheel moves it left/right.
 * While the pointer is over the row the page never scrolls, even at the row's ends. Large rows that would
 * trap the page (product rails, which have arrow buttons) opt out with `data-wheel="page"`. Wide data
 * tables are left alone too (they keep their scrollbar, and the page must still scroll while hovering them).
 */
function horizontalRow(target) {
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (el.dataset?.wheel === 'page') return null;
    if (el.classList?.contains('scrollbar-none') && el.scrollWidth > el.clientWidth + 1) {
      const { overflowX } = getComputedStyle(el);
      if (overflowX === 'auto' || overflowX === 'scroll') return el;
    }
  }
  return null;
}

function onWheel(e) {
  // Trackpad sideways swipes, shift+wheel (native sideways) and ctrl+wheel (zoom) behave as usual.
  if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  const row = horizontalRow(e.target);
  if (!row) return;
  // Always swallow the wheel over the row: at an end it simply stops instead of scrolling the page.
  e.preventDefault();
  // deltaMode 1 = lines (some mice/Firefox): convert to pixels.
  row.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
}

/** Installs the handler once for the whole app. Non-passive so the page doesn't also scroll. */
export function installWheelScroll() {
  window.addEventListener('wheel', onWheel, { passive: false });
}
