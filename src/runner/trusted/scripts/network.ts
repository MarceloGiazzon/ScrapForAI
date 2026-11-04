/**
 * T8.2: the in-page scripts of the network quiet wait.
 *
 *  - `net-tracker` is installed as an INIT script (it runs at the start of every document of every frame of the run, before the page's own code):
 *    it counts the XHR and fetch requests that are still pending. It wraps `fetch` and `XMLHttpRequest.prototype.send`, passes every call through
 *    unchanged (same arguments, same returned promise, same errors) and only counts. It keeps no URL, header, body or response: two numbers.
 *  - `net-state` only READS those two numbers.
 *
 * The counter is `{ pending, seq }` on a non-enumerable `window.__scrapforaiNet`. `seq` goes up at every start and every end, so the server can tell
 * "nothing pending now" from "nothing pending, and nothing has happened for a while" WITHOUT the page's clock (a fake clock, T7.3, changes
 * Date and performance.now; the server times the quiet itself).
 *
 * Not counted: websockets, EventSource, sendBeacon and navigation requests; images, scripts and styles (they are not XHR/fetch). A request that never
 * answers (long polling) keeps the page "busy" until the wait times out; the error says how many were pending.
 *
 * The sources use no backtick and no `${`. Change one and the registry hash stops matching, so the server refuses to start until the new hash is
 * pinned on purpose (`npx tsx scripts/trusted-hashes.ts`).
 */

export const netTrackerSource = String.raw`function () {
  var w = window;
  if (w.__scrapforaiNet) return;
  var state = { pending: 0, seq: 0 };
  Object.defineProperty(w, '__scrapforaiNet', { value: state, enumerable: false });
  function begin() { state.pending++; state.seq++; }
  function end() { if (state.pending > 0) state.pending--; state.seq++; }
  if (typeof w.fetch === 'function') {
    var originalFetch = w.fetch;
    w.fetch = function () {
      begin();
      var promise;
      try { promise = originalFetch.apply(this, arguments); } catch (error) { end(); throw error; }
      if (promise && typeof promise.then === 'function') promise.then(end, end); else end();
      return promise;
    };
  }
  var proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
  if (proto && typeof proto.send === 'function') {
    var originalSend = proto.send;
    proto.send = function () {
      var request = this;
      var finished = false;
      function finish() { if (!finished) { finished = true; end(); } }
      request.addEventListener('loadend', finish);
      begin();
      try { return originalSend.apply(this, arguments); } catch (error) { finish(); throw error; }
    };
  }
}`;

export const netStateSource = String.raw`function () {
  var state = window.__scrapforaiNet;
  return state ? { pending: state.pending, seq: state.seq } : null;
}`;
