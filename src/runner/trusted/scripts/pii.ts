/**
 * T7.1 / T7.8: the in-page script of the PII hunt. It READS storage and hidden inputs and hands the text to the server, which scans it and throws it away:
 * the raw values are never stored. It is the only trusted script that touches `localStorage`/`sessionStorage` (test/trusted-scripts.test.ts allows it by
 * name and by nothing else), and it WRITES nothing, calls no network and builds no code from the page.
 *
 * Function expression kept as a string so the registry can pin its sha256. No backtick and no `${`.
 */

export const piiSurfacesSource = String.raw`(function () {
  var MAX_ENTRIES = 200;
  var MAX_VALUE = 2000;
  function clip(text) { return String(text == null ? '' : text).slice(0, MAX_VALUE); }
  function readStorage(area, name, out) {
    var store;
    try { store = window[name]; } catch (e) { return false; }
    if (!store) return false;
    var truncated = false;
    try {
      for (var i = 0; i < store.length; i += 1) {
        if (out.length >= MAX_ENTRIES) { truncated = true; break; }
        var key = store.key(i);
        out.push({ area: area, key: clip(key).slice(0, 200), value: clip(store.getItem(key)) });
      }
    } catch (e) { return truncated; }
    return truncated;
  }
  return function (args) {
    var storage = [];
    var hidden = [];
    var truncated = false;
    if (args.storage) {
      var a = readStorage('localStorage', 'localStorage', storage);
      var b = readStorage('sessionStorage', 'sessionStorage', storage);
      truncated = a || b;
    }
    if (args.hidden) {
      var inputs = document.querySelectorAll('input[type="hidden"]');
      for (var j = 0; j < inputs.length; j += 1) {
        if (hidden.length >= MAX_ENTRIES) { truncated = true; break; }
        var input = inputs[j];
        hidden.push({ name: clip(input.getAttribute('name') || input.id || ('#' + j)).slice(0, 200), value: clip(input.value) });
      }
    }
    return { storage: storage, hidden: hidden, truncated: truncated };
  };
})()`;
