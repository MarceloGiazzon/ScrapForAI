/**
 * T7.1 / T7.6: the in-page scripts of the keyboard walk. Each is a FUNCTION EXPRESSION kept as a string so it can be hashed (registry.ts pins the
 * sha256 of every source) and sent to the page as a fixed expression, never built from caller text. They only READ: no value of a field, no typed
 * text, no cell text; the accessible name of a control comes from its label, aria attributes, placeholder, title or (buttons, links) its own caption.
 *
 * The sources use no backtick and no `${`: they are written with String.raw so the regexes keep their backslashes. Change one and the registry hash
 * stops matching, so the server refuses to start until the new hash is pinned on purpose (`npx tsx scripts/trusted-hashes.ts`).
 */

/** Helpers shared by the three scripts. Duplicated into each source so every script is self-contained. */
const HELPERS = String.raw`
  function cssPath(el) {
    if (el.id && document.querySelectorAll('[id="' + el.id.replace(/(["\\])/g, '\\$1') + '"]').length === 1) return '#' + el.id;
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) { return child.tagName === node.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join('>');
  }
  function byPath(path) {
    if (path.charAt(0) === '#') return document.getElementById(path.slice(1));
    try { return document.documentElement.querySelector(':scope > ' + path.split('>').join(' > ')); } catch (e) { return null; }
  }
  function clip(text) {
    if (!text) return undefined;
    var value = String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
    return value || undefined;
  }
  function ownText(el) {
    var clone = el.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('input, select, textarea, button, script, style'), function (n) { n.remove(); });
    return clone.textContent;
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return tag;
  }
  function nameOf(el) {
    var tag = el.tagName.toLowerCase();
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var joined = by.split(/\s+/).map(function (id) { var t = document.getElementById(id); return t ? ownText(t) : ''; }).join(' ');
      if (clip(joined)) return clip(joined);
    }
    if (clip(el.getAttribute('aria-label'))) return clip(el.getAttribute('aria-label'));
    if (el.labels && el.labels.length) {
      var fromLabels = clip(Array.prototype.map.call(el.labels, ownText).join(' '));
      if (fromLabels) return fromLabels;
    }
    if (tag === 'input') {
      var kind = (el.getAttribute('type') || 'text').toLowerCase();
      if (kind === 'button' || kind === 'submit' || kind === 'reset') return clip(el.getAttribute('value')) || clip(el.getAttribute('title'));
      if (kind === 'image') return clip(el.getAttribute('alt')) || clip(el.getAttribute('title'));
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return clip(el.getAttribute('placeholder')) || clip(el.getAttribute('title'));
    var caption = clip(el.textContent);
    if (caption) return caption;
    var image = el.querySelector('img[alt]');
    return clip(image && image.getAttribute('alt')) || clip(el.getAttribute('title'));
  }
  function signature(el) {
    var s = window.getComputedStyle(el);
    return {
      outline: s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor,
      shadow: s.boxShadow,
      border: [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderRightWidth, s.borderRightStyle, s.borderRightColor, s.borderBottomWidth, s.borderBottomStyle, s.borderBottomColor, s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor].join(' ')
    };
  }
`;

/** The element that has focus now (null when focus is on the page itself), described without its value, and how it looks while focused. */
export const keyboardActiveSource = String.raw`(function () {${HELPERS}
  return function () {
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return { none: true };
    return { key: cssPath(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el), signature: signature(el) };
  };
})()`;

/** How the element at `args.path` looks now (used after focus moved away: the "without focus" half of the comparison). */
export const keyboardStyleSource = String.raw`(function () {${HELPERS}
  return function (args) {
    var el = typeof args.path === 'string' ? byPath(args.path) : null;
    return el ? { found: true, signature: signature(el) } : { found: false };
  };
})()`;

/**
 * The controls a keyboard user is expected to reach: the same families as the screen inventory (T4.3: fields and actions), visible, not disabled,
 * not inert and not marked tabindex="-1" on purpose. A div with role="button" and no tabindex IS listed: it cannot be reached, which is the finding.
 * Radios of one group count as one control (the arrow keys move inside the group), reached when any member got focus.
 */
export const keyboardCandidatesSource = String.raw`(function () {${HELPERS}
  var SELECTOR = [
    'input:not([type="hidden"])', 'textarea', 'select', 'button', 'a[href]',
    '[role="textbox"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="spinbutton"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[contenteditable="true"]'
  ].join(',');
  var MAX = 500;
  function visible(el) {
    var s = window.getComputedStyle(el);
    var r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
  }
  return function (args) {
    var root = document;
    if (typeof args.scope === 'string') {
      root = document.querySelector(args.scope);
      if (!root) return { scopeFound: false, candidates: [], truncated: false };
    }
    var list = [];
    var groups = {};
    var truncated = false;
    var nodes = root.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (el.getAttribute('tabindex') === '-1' || el.disabled || el.closest('[inert]') || !visible(el)) continue;
      if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'radio' && el.name) {
        var gk = (el.form ? cssPath(el.form) : '') + '|' + el.name;
        if (groups[gk]) { groups[gk].anyOf.push(cssPath(el)); continue; }
        var first = { key: cssPath(el), role: roleOf(el), name: nameOf(el), anyOf: [cssPath(el)] };
        groups[gk] = first;
        list.push(first);
        continue;
      }
      if (list.length >= MAX) { truncated = true; break; }
      var key = cssPath(el);
      list.push({ key: key, role: roleOf(el), name: nameOf(el), anyOf: [key] });
    }
    return { scopeFound: true, candidates: list, truncated: truncated };
  };
})()`;
