import { apiFetch, el, formatDateTime, formatDuration, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const ROUTINE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 260;
const HEIGHT = 40;
const PAD = 4;

const body = document.getElementById('perf-body');
const detail = document.getElementById('perf-detail');

/** SVG built with createElementNS and classes only: the page runs under a CSP with no inline style. */
function svg(tag, attributes = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  for (const child of children) node.appendChild(child);
  return node;
}

function title(text) {
  const node = document.createElementNS(SVG_NS, 'title');
  node.textContent = text;
  return node;
}

/** The sparkline of one series: the line, the dashed baseline, a tick where the build changed, and the recent points marked. */
export function sparkline(series, recentRuns) {
  const points = series.points;
  const values = points.map((point) => point.durationMs);
  if (series.baselineMs !== undefined) values.push(series.baselineMs);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index) => (points.length <= 1 ? WIDTH / 2 : PAD + (index * (WIDTH - 2 * PAD)) / (points.length - 1));
  const y = (value) => HEIGHT - PAD - ((value - min) * (HEIGHT - 2 * PAD)) / span;

  const children = [];
  for (const index of series.buildChanges) {
    children.push(svg('line', { class: 'spark-build', x1: x(index), x2: x(index), y1: 0, y2: HEIGHT }, [title(`build ${points[index].buildId ?? '?'}`)]));
  }
  if (series.baselineMs !== undefined) {
    children.push(svg('line', { class: 'spark-base', x1: PAD, x2: WIDTH - PAD, y1: y(series.baselineMs), y2: y(series.baselineMs) }, [title(`baseline ${formatDuration(series.baselineMs)}`)]));
  }
  if (points.length > 1) {
    children.push(svg('polyline', { class: 'spark-line', points: points.map((point, index) => `${x(index).toFixed(1)},${y(point.durationMs).toFixed(1)}`).join(' ') }));
  }
  points.forEach((point, index) => {
    const recent = index >= points.length - recentRuns;
    if (!recent && points.length > 1) return;
    children.push(svg('circle', { class: series.alert && recent ? 'spark-dot spark-alert' : 'spark-dot', cx: x(index), cy: y(point.durationMs), r: 2.5 }, [title(`${formatDuration(point.durationMs)} · ${formatDateTime(point.at)}${point.buildId ? ` · build ${point.buildId}` : ''}`)]));
  });

  return svg('svg', { class: 'spark', width: WIDTH, height: HEIGHT, viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', 'aria-label': `${series.id}: ${points.length} runs${series.alert ? ', slower than its baseline' : ''}` }, children);
}

function seriesRow(series, recentRuns) {
  const verdict = series.alert ? el('span', { class: 'badge failed', text: 'slower' }) : series.baselineMs === undefined ? el('span', { class: 'muted', text: 'waiting' }) : el('span', { class: 'badge passed', text: 'ok' });
  return el('tr', { class: 'static' }, [
    el('td', { class: 'mono', text: series.id }),
    el('td', {}, [sparkline(series, recentRuns)]),
    el('td', { text: series.baselineMs === undefined ? '—' : formatDuration(series.baselineMs) }),
    el('td', { text: series.recentMs === undefined ? '—' : formatDuration(series.recentMs) }),
    el('td', { text: series.ratio === undefined ? '—' : `x${series.ratio}` }),
    el('td', {}, [verdict]),
    el('td', { class: 'muted', text: series.suspectBuild ? `new build in the slow runs: ${series.suspectBuild}` : (series.note ?? '') }),
  ]);
}

function populationLabel(population) {
  return `v${population.version} · ${population.profile} · ${population.env} (${population.runs} runs)`;
}

async function showRoutine(routineId, select = {}) {
  if (!ROUTINE_ID.test(routineId)) return;
  detail.replaceChildren(el('div', { class: 'card', text: 'Loading…' }));

  const query = new URLSearchParams({ limit: '60' });
  if (select.version !== undefined) query.set('version', String(select.version));
  if (select.profile) query.set('profile', select.profile);
  if (select.env) query.set('env', select.env);
  const data = await apiFetch(`/v1/metrics/routines/${encodeURIComponent(routineId)}?${query.toString()}`);

  const nodes = [el('h2', { text: routineId })];
  if (data.populations.length > 1) {
    const chooser = el('select', {
      onchange: (event) => {
        const chosen = data.populations[Number(event.target.value)];
        showRoutine(routineId, { version: chosen.version, profile: chosen.profile, env: chosen.env }).catch((error) => console.error(error));
      },
    });
    data.populations.forEach((population, index) => {
      const option = el('option', { value: String(index), text: populationLabel(population) });
      if (data.population && population.version === data.population.version && population.profile === data.population.profile && population.env === data.population.env) option.selected = true;
      chooser.appendChild(option);
    });
    nodes.push(el('div', { class: 'field' }, [el('label', { text: 'Measured population' }), chooser]));
  } else if (data.population) {
    nodes.push(el('p', { class: 'muted', text: populationLabel(data.population) }));
  }

  if (data.alerts.length > 0) {
    nodes.push(el('div', { class: 'warn-banner', text: `Slower than usual: ${data.alerts.join(', ')}` }));
  }

  const series = [data.run, ...data.steps].filter(Boolean);
  nodes.push(
    el('div', { class: 'table-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, ['Step', 'Last runs', 'Baseline', 'Recent', 'Ratio', 'State', ''].map((label) => el('th', { text: label })))]),
        el('tbody', {}, series.map((item) => seriesRow(item, data.thresholds.recentRuns))),
      ]),
    ]),
    el('p', { class: 'muted', text: `Dashed line: baseline. Vertical tick: the build changed. Highlighted dots: the last ${data.thresholds.recentRuns} runs. An alert needs the recent median above baseline × ${data.thresholds.alertRatio} and at least ${data.thresholds.minDeltaMs} ms slower.` }),
  );
  detail.replaceChildren(el('div', { class: 'card' }, nodes));
}

async function load() {
  const { routines } = await apiFetch('/v1/metrics/routines');
  const alerting = routines.filter((routine) => routine.alerts.length > 0).length;
  document.getElementById('perf-summary').textContent =
    routines.length === 0 ? 'No data yet: run a routine from the library.' : `${routines.length} routine(s) measured, ${alerting} slower than usual.`;

  body.replaceChildren();
  for (const routine of routines) {
    const state = routine.alerts.length > 0 ? el('span', { class: 'badge failed', text: `${routine.alerts.length} slower` }) : routine.run?.baselineMs === undefined ? el('span', { class: 'muted', text: 'collecting' }) : el('span', { class: 'badge passed', text: 'ok' });
    body.appendChild(
      el('tr', { onclick: () => showRoutine(routine.routineId).catch((error) => console.error(error)) }, [
        el('td', { class: 'mono', text: routine.routineId }),
        el('td', { text: `${routine.greenRuns}/${routine.runs}` }),
        el('td', { text: routine.run?.baselineMs === undefined ? '—' : formatDuration(routine.run.baselineMs) }),
        el('td', { text: routine.run?.recentMs === undefined ? '—' : formatDuration(routine.run.recentMs) }),
        el('td', {}, [state]),
      ]),
    );
  }
  if (routines.length === 0) body.appendChild(el('tr', {}, [el('td', { colspan: '5', class: 'muted', text: 'Nothing recorded yet.' })]));
}

load().catch((error) => console.error(error));
