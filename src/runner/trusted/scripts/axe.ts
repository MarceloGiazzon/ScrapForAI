import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * T7.1 / T7.4: the in-page accessibility audit. The page runs axe-core (Deque, MPL-2.0), loaded UNMODIFIED from node_modules/axe-core/axe.min.js and
 * embedded whole, header comment included, in the source of ONE trusted script. The registry pins the sha256 of that composed source, so a different
 * axe-core version (or an edited bundle) makes the server refuse to start until a person reviews it and pins the new hash on purpose
 * (`npx tsx scripts/trusted-hashes.ts`). Nothing of axe is copied into this repository, so the MPL-2.0 file-level obligations stay with the package.
 *
 * What leaves the page is small and value-free: for each violating element the rule id, impact, help text, WCAG tags and a CSS selector. NEVER the
 * element's HTML, its text, its value or axe's per-node failure message (those can hold what the page shows). Only the audited frame is checked
 * (`iframes: false`): axe would need to be injected into every iframe, and the walk of iframe contents is not done (same limit as the keyboard walk).
 */

const require = createRequire(import.meta.url);

/** Absolute path of the axe-core bundle the registry hashes. */
export const AXE_BUNDLE_PATH: string = require.resolve('axe-core/axe.min.js');

/** The vendored bundle, untouched. Exported so tests can tell our code apart from it. */
export const axeBundle: string = fs.readFileSync(AXE_BUNDLE_PATH, 'utf8');
export const AXE_VERSION: string = (JSON.parse(fs.readFileSync(require.resolve('axe-core/package.json'), 'utf8')) as { version: string }).version;

/** OUR part of the script. Like the other trusted scripts it uses no backtick and no placeholder syntax; axe's own text is axe's. */
const RUNNER = String.raw`
    var tags = args.tags;
    var scopeSelector = args.scope;
    var maxPerRule = args.maxNodesPerRule;
    var context = document;
    if (scopeSelector) {
      var scopeElement = null;
      try { scopeElement = document.querySelector(scopeSelector); } catch (e) { scopeElement = null; }
      if (!scopeElement) return { scopeFound: false };
      context = { include: [scopeElement] };
    }
    function wcagOf(list) {
      var out = [];
      (list || []).forEach(function (tag) {
        var m = /^wcag(\d)(\d)(\d+)$/.exec(tag);
        if (m) out.push(m[1] + '.' + m[2] + '.' + m[3]);
      });
      return out;
    }
    function selectorOf(node) {
      var parts = (node.target || []).map(function (item) { return Array.isArray(item) ? item.join(' ') : String(item); });
      return parts.join(' >> ').slice(0, 300);
    }
    return axe.run(context, {
      runOnly: { type: 'tag', values: tags },
      resultTypes: ['violations', 'incomplete'],
      iframes: false,
      elementRef: false,
      selectors: true,
      ancestry: false,
      xpath: false,
      absolutePaths: false
    }).then(function (results) {
      var truncated = false;
      var remaining = args.maxFindings;
      var violations = results.violations.map(function (rule) {
        // A rule is always listed with its real total; only the number of elements named under it is capped (per rule and in all).
        var take = Math.max(0, Math.min(rule.nodes.length, maxPerRule, remaining));
        if (take < rule.nodes.length) truncated = true;
        remaining -= take;
        return {
          ruleId: rule.id,
          impact: rule.impact || 'minor',
          help: String(rule.help || '').slice(0, 200),
          wcag: wcagOf(rule.tags),
          total: rule.nodes.length,
          targets: rule.nodes.slice(0, take).map(selectorOf)
        };
      });
      var needsReview = results.incomplete.map(function (rule) {
        return { ruleId: rule.id, help: String(rule.help || '').slice(0, 200), count: rule.nodes.length };
      });
      return {
        scopeFound: true,
        axeVersion: axe.version,
        violations: violations,
        needsReview: needsReview,
        passedRules: results.passes.length,
        inapplicableRules: results.inapplicable.length,
        truncated: truncated
      };
    });
`;

/**
 * A function expression `function (args) { ... }` (the contract of every trusted script). axe is injected once per document; a page that already
 * defines another `window.axe` of a different version does not get used by mistake, because the check is on the version too.
 */
export const axeAuditSource: string =
  'function (args) {\n' +
  `  if (!window.axe || window.axe.version !== ${JSON.stringify(AXE_VERSION)}) {\n` +
  // The bundle is inlined as statements. A line comment at its end must not swallow the next line, hence the newlines around it.
  `${axeBundle}\n` +
  '  }\n' +
  `${RUNNER}\n` +
  '}';
