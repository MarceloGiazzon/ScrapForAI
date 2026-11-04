import { apiFetch, el, formatDateTime, formatPercent, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const SVG_NS = 'http://www.w3.org/2000/svg';

const READINESS = {
  ready: { label: 'Ready for sign-off', kind: 'passed' },
  blocked: { label: 'Blocked', kind: 'failed' },
  incomplete: { label: 'Incomplete', kind: 'warn' },
  'no-data': { label: 'No results yet', kind: 'neutral' },
};
const HEALTH_LABEL = { red: 'needs attention', yellow: 'to watch', green: 'healthy', empty: 'no results yet' };
const TREND = {
  improving: { label: 'improving', kind: 'passed' },
  worsening: { label: 'getting worse', kind: 'failed' },
  steady: { label: 'steady', kind: 'neutral' },
  unknown: { label: 'not enough data', kind: 'neutral' },
};

/** Badge and bar classes are fixed words from the stylesheet, never built from the data. */
const BADGE = { passed: 'badge passed', failed: 'badge failed', warn: 'badge warn', neutral: 'badge neutral' };
const HEALTH_KIND = { red: 'failed', yellow: 'warn', green: 'passed', empty: 'neutral' };
const BAR = {
  good: 'bar-good',
  mid: 'bar-mid',
  bad: 'bar-bad',
  none: 'bar-none',
  goodPartial: 'bar-good bar-partial',
  midPartial: 'bar-mid bar-partial',
  badPartial: 'bar-bad bar-partial',
  nonePartial: 'bar-none bar-partial',
};

function badge(kind, text) {
  return el('span', { class: BADGE[kind] ?? BADGE.neutral, text });
}

const percent = formatPercent;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function barKey(week) {
  const partial = week.partial === true;
  if (week.rate === null) return partial ? 'nonePartial' : 'none';
  const level = week.rate >= 0.95 ? 'good' : week.rate >= 0.8 ? 'mid' : 'bad';
  return partial ? `${level}Partial` : level;
}

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** Day and month as numbers (28/10): short enough to sit under a bar. */
const axisDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

function chartLabel(text, x, y) {
  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('class', 'chart-label');
  label.setAttribute('x', String(x));
  label.setAttribute('y', String(y));
  label.textContent = text;
  return label;
}

/**
 * The share of passing runs per week, oldest first, as bars. SVG with classes only (the CSP forbids inline style).
 * With `labels`, each bar carries its percentage above and the start of its week below.
 */
export function weeklyChart(weekly, { width = 26, height = 72, gap = 6, labels = false } = {}) {
  const total = Math.max(weekly.length, 1) * (width + gap) - gap;
  const top = labels ? 16 : 0;
  const full = top + height + (labels ? 18 : 0);
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('class', 'chart');
  node.setAttribute('width', String(total));
  node.setAttribute('height', String(full));
  node.setAttribute('viewBox', `0 0 ${total} ${full}`);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', `Share of passing runs per week, oldest first: ${weekly.map((week) => percent(week.rate)).join(', ')}`);
  weekly.forEach((week, index) => {
    const bar = document.createElementNS(SVG_NS, 'rect');
    const barHeight = week.rate === null ? 2 : Math.max(2, Math.round(week.rate * height));
    bar.setAttribute('class', BAR[barKey(week)]);
    bar.setAttribute('x', String(index * (width + gap)));
    bar.setAttribute('y', String(top + height - barHeight));
    bar.setAttribute('width', String(width));
    bar.setAttribute('height', String(barHeight));
    const title = document.createElementNS(SVG_NS, 'title');
    const range = `${shortDate(week.from)} – ${shortDate(week.to)}`;
    title.textContent =
      week.rate === null ? `${range}: no runs` : `${range}: ${percent(week.rate)} passed (${week.runs} run${week.runs === 1 ? '' : 's'})${week.partial ? ', older runs are no longer kept' : ''}`;
    bar.appendChild(title);
    node.appendChild(bar);
    if (labels) {
      const centre = index * (width + gap) + width / 2;
      node.appendChild(chartLabel(week.rate === null ? '—' : percent(week.rate), centre, top + height - barHeight - 4));
      node.appendChild(chartLabel(axisDate(week.from), centre, full - 4));
    }
  });
  return node;
}

function trendLine(trend) {
  if (!trend.recent || !trend.before) return 'Not enough runs in the last four weeks to compare.';
  return `Last two weeks ${percent(trend.recent.rate)} (${trend.recent.runs} runs), the two before ${percent(trend.before.rate)} (${trend.before.runs} runs).`;
}

function stat(label, value, hint) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), hint ? el('div', { class: 'hint', text: hint }) : null]);
}

function renderStats(report) {
  const { totals } = report;
  const trend = TREND[report.trend.direction] ?? TREND.unknown;
  const tests = totals.tests;
  const stats = [
    stat('Systems ready for sign-off', `${totals.readiness.ready} of ${totals.systems}`, `${totals.readiness.blocked} blocked, ${totals.readiness.incomplete} incomplete, ${totals.readiness['no-data']} without results`),
    stat('Tests', String(tests.routines + tests.vaultItems), `${plural(tests.routines, 'routine', 'routines')}, ${plural(tests.vaultItems, 'regression-vault item', 'regression-vault items')}${tests.quarantined > 0 ? `; ${tests.quarantined} quarantined, not counted` : ''}`),
    stat('Test runs', String(tests.runs), `${percent(tests.passRate)} passed in the last ${report.period.days} days`),
    stat('Regressions caught', String(totals.regressions.caught), `${totals.regressions.resolved} fixed, ${totals.regressions.open} still open`),
    stat('Fixed bugs guarded', String(tests.guardedBugs), 'with permanent proof in the regression vault'),
    stat('Quality trend', trend.label, 'share of runs that passed: last two weeks against the two before'),
  ];
  document.getElementById('exec-stats').replaceChildren(...stats);
}

function renderTrend(report) {
  const section = document.getElementById('exec-trend');
  const trend = TREND[report.trend.direction] ?? TREND.unknown;
  const nodes = [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Quality trend' }), badge(trend.kind, trend.label)]),
    el('p', { class: 'muted', text: `Share of test runs that passed, per week (${report.weeks} weeks, oldest on the left). ${trendLine(report.trend)}` }),
    weeklyChart(report.trend.weekly, { width: 44, height: 96, gap: 10, labels: true }),
  ];
  if (report.trend.weekly.some((week) => week.partial)) nodes.push(el('p', { class: 'muted', text: 'Faded bars: some tests no longer keep runs that old, so those weeks show only the runs still kept.' }));
  section.replaceChildren(...nodes);
}

function evidenceText(homologation) {
  if (homologation.build === undefined) return 'not tied to a build';
  const { evidence } = homologation;
  if (!evidence || evidence.runs === 0) return `none pinned for build ${homologation.build}`;
  return `${evidence.runs} signed run${evidence.runs === 1 ? '' : 's'} of ${evidence.tests} test${evidence.tests === 1 ? '' : 's'} on build ${homologation.build}`;
}

function regressionText(regressions) {
  if (regressions.caught === 0 && regressions.unstable === 0) return 'none';
  const parts = [`${regressions.caught} caught (${regressions.resolved} fixed, ${regressions.open} still open)`];
  if (regressions.unstable > 0) parts.push(`${regressions.unstable} change${regressions.unstable === 1 ? '' : 's'} from unstable tests, not counted`);
  return parts.join('; ');
}

function recentTable(events) {
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Test', 'Broke', 'Build', 'Failed at', 'Now'].map((label) => el('th', { text: label })))]),
      el('tbody', {}, events.map((event) =>
        el('tr', { class: 'static' }, [
          el('td', { class: 'mono', text: event.routineId }),
          el('td', { text: formatDateTime(event.at) }),
          el('td', { class: 'mono', text: event.build ? (event.previousBuild && event.previousBuild !== event.build ? `${event.previousBuild} → ${event.build}` : event.build) : '—' }),
          el('td', { class: 'mono', text: event.failedStep ?? '—' }),
          el('td', {}, [event.resolvedAt ? badge('passed', 'fixed') : badge('failed', 'still failing')]),
        ]),
      )),
    ]),
  ]);
}

export function systemCard(system) {
  const readiness = READINESS[system.homologation.status] ?? READINESS['no-data'];
  const title = system.name ? `${system.name} (${system.id})` : system.id;
  const trend = TREND[system.trend.direction] ?? TREND.unknown;
  const { homologation, tests } = system;

  const nodes = [
    el('div', { class: 'card-head' }, [
      el('h2', { text: title }),
      badge(readiness.kind, readiness.label),
      system.environment ? el('span', { class: 'muted', text: system.environment }) : null,
    ]),
  ];
  if (!system.known) nodes.push(el('p', { class: 'muted', text: 'Not a stored target profile: tests still refer to this id.' }));
  if (homologation.reasons.length > 0) nodes.push(el('ul', { class: 'reasons' }, homologation.reasons.map((reason) => el('li', { text: reason }))));

  nodes.push(
    el('dl', { class: 'kv' }, [
      el('dt', { text: 'Latest build' }),
      el('dd', { text: homologation.build ?? 'not reported' }),
      el('dt', { text: 'Passing on it' }),
      el('dd', { text: homologation.total === 0 ? '—' : `${homologation.passed} of ${plural(homologation.total, 'test', 'tests')}` }),
      el('dt', { text: 'Signed evidence' }),
      el('dd', { text: evidenceText(homologation) }),
      el('dt', { text: 'Tests' }),
      el('dd', { text: `${plural(tests.routines, 'routine', 'routines')}, ${plural(tests.vaultItems, 'regression-vault item', 'regression-vault items')} (${plural(tests.guardedBugs, 'fixed bug', 'fixed bugs')} guarded)${tests.quarantined > 0 ? `; ${tests.quarantined} quarantined` : ''}` }),
      el('dt', { text: 'Runs in the period' }),
      el('dd', { text: tests.runs === 0 ? 'none' : `${plural(tests.runs, 'run', 'runs')}, ${percent(tests.passRate)} passed` }),
      el('dt', { text: 'Regressions caught' }),
      el('dd', { text: regressionText(system.regressions) }),
      el('dt', { text: 'Technical health' }),
      el('dd', {}, [badge(HEALTH_KIND[system.health.status], HEALTH_LABEL[system.health.status] ?? system.health.status)]),
      el('dt', { text: 'Quality trend' }),
      el('dd', { class: 'row' }, [badge(trend.kind, trend.label), weeklyChart(system.trend.weekly, { width: 12, height: 28, gap: 3 })]),
    ]),
  );
  if (system.health.status !== 'green' && system.health.reasons.length > 0) {
    nodes.push(el('h3', { text: 'Why the technical health is not green' }), el('ul', { class: 'reasons' }, system.health.reasons.map((reason) => el('li', { text: reason }))));
  }
  if (system.regressions.recent.length > 0) nodes.push(el('h3', { text: 'Recent regressions' }), recentTable(system.regressions.recent));
  if (homologation.notes.length > 0) nodes.push(el('p', { class: 'muted', text: homologation.notes.join(' · ') }));
  return el('div', { class: 'card' }, nodes);
}

function render(report) {
  const { totals } = report;
  document.getElementById('exec-summary').textContent =
    totals.systems === 0
      ? 'No system (target profile) yet.'
      : `${totals.systems} system(s), last ${report.period.days} days. Updated ${formatDateTime(report.generatedAt)}.`;
  document.getElementById('exec-banner').replaceChildren();
  renderStats(report);
  renderTrend(report);
  document.getElementById('exec-systems').replaceChildren(...report.systems.map(systemCard));
  document.getElementById('exec-notes').replaceChildren(...report.notes.map((note) => el('li', { text: note })));
}

async function load() {
  const days = document.getElementById('exec-days').value;
  render(await apiFetch(`/v1/executive?days=${days}`));
}

document.getElementById('exec-days').addEventListener('change', () => {
  load().catch(showError);
});

function showError(error) {
  document.getElementById('exec-summary').textContent = `Could not load the executive overview: ${error.message}`;
}

load().catch(showError);
