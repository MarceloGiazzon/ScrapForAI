/**
 * T9.2: the in-page script of the living manual. `doc-highlight` draws (or removes) a border around the rectangles it is given, so a figure shows
 * WHICH element the caption talks about.
 *
 * It receives numbers, never a selector: the server finds the element with Playwright's own locator (so every selector the runner understands works,
 * `text=`, `role=`, `>>`) and sends the bounding boxes. The overlay is one `div` per rectangle, marked with `data-scrapforai-doc-highlight`, absolutely
 * positioned in DOCUMENT coordinates (so it is right for a viewport shot and for a full-page one), `pointer-events: none` (it can never take a click),
 * styled through the CSSOM (a page with a strict CSP may forbid inline style attributes, but not this). `clear` removes every mark it ever drew, and
 * drawing always starts by clearing, so a failed run cannot leave a border behind for the next figure.
 *
 * The source uses no backtick and no `${`. Change it and the registry hash stops matching: the server refuses to start until the new hash is pinned on
 * purpose (`npx tsx scripts/trusted-hashes.ts`).
 */

export const docHighlightSource = String.raw`function (args) {
  var MARK = 'data-scrapforai-doc-highlight';
  var existing = document.querySelectorAll('[' + MARK + ']');
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
  }
  if (!args || args.action !== 'draw') return { cleared: existing.length, drawn: 0 };
  var rects = Array.isArray(args.rects) ? args.rects.slice(0, 20) : [];
  var scrollX = window.pageXOffset || 0;
  var scrollY = window.pageYOffset || 0;
  var pad = 4;
  var drawn = 0;
  for (var j = 0; j < rects.length; j++) {
    var r = rects[j];
    if (!r || !isFinite(r.x) || !isFinite(r.y) || !isFinite(r.width) || !isFinite(r.height) || r.width <= 0 || r.height <= 0) continue;
    var box = document.createElement('div');
    box.setAttribute(MARK, '1');
    box.setAttribute('aria-hidden', 'true');
    var s = box.style;
    s.position = 'absolute';
    s.left = (r.x + scrollX - pad) + 'px';
    s.top = (r.y + scrollY - pad) + 'px';
    s.width = (r.width + pad * 2) + 'px';
    s.height = (r.height + pad * 2) + 'px';
    s.boxSizing = 'border-box';
    s.border = '3px solid #e11d48';
    s.borderRadius = '6px';
    s.boxShadow = '0 0 0 3px rgba(225, 29, 72, 0.25)';
    s.background = 'transparent';
    s.margin = '0';
    s.padding = '0';
    s.pointerEvents = 'none';
    s.zIndex = '2147483647';
    document.documentElement.appendChild(box);
    drawn++;
  }
  return { cleared: existing.length, drawn: drawn };
}`;
