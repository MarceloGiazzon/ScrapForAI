import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';
import { createStatusEditor } from './healthStatus.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 7;
const GAP = 2;
const HEIGHT = 14;

const STATUS_LABEL = { red: 'needs attention', yellow: 'to watch', green: 'healthy', empty: 'no results yet' };
const STATE_LABEL = {
  failing: 'failing',
  flaky: 'flaky',
  slower: 'slower',
  passing: 'passing',
  'never-run': 'never run',
  quarantined: 'quarantined',
  inactive: 'inactive',
};
const SCHEDULE_LABEL = { ok: 'ok', failing: 'failed', disabled: 'disabled', 'not-firing': 'not firing', 'never-ran': 'not yet' };
const TREND_LABEL = { worsening: 'worse', improving: 'better', steady: 'steady', unknown: '—' };

/** Badge classes are fixed words from the stylesheet, never taken from the data. */
function badgeClass(kind) {
  if (kind === 'red' || kind === 'failing' || kind === 'failed') return 'badge failed';
  if (kind === 'yellow' || kind === 'flaky' || kind === 'slower' || kind === 'not-firing' || kind === 'worsening') return 'badge warn';
  if (kind === 'green' || kind === 'passing' || kind === 'ok' || kind === 'improving') return 'badge passed';
  return 'badge neutral';
}

function badge(kind, text) {
  return el('span', { class: badgeClass(kind), text });
}

/** The last results of a routine as small cells, oldest first: green passed, red failed. SVG with classes only (the CSP forbids inline style). */
export function strip(results) {
  const width = Math.max(results.length, 1) * (CELL + GAP);
  const node = document.createElementNS(SVG_NS, 'svg');
  node.setAttribute('class', 'strip');
  node.setAttribute('width', String(width));
  node.setAttribute('height', String(HEIGHT));
  node.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', results.length === 0 ? 'no runs' : `last ${results.length} runs: ${results.filter((result) => result === 'failed').length} failed`);
  results.forEach((result, index) => {
    const cell = document.createElementNS(SVG_NS, 'rect');
    cell.setAttribute('class', result === 'failed' ? 'strip-fail' : 'strip-pass');
    cell.setAttribute('x', String(index * (CELL + GAP)));
    cell.setAttribute('y', '0');
    cell.setAttribute('width', String(CELL));
    cell.setAttribute('height', String(HEIGHT));
    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = result;
    cell.appendChild(title);
    node.appendChild(cell);
  });
  return node;
}

// Links only ever point at this server's own report routes (a session may GET them, as the Vault screen already does), with an id that matches
// the server's pattern and is percent-encoded anyway. Evidence expires: the report then answers 404, which is harmless, so the id is always shown as text.
const JOB_ID = /^job_[A-Za-z0-9_-]{1,64}$/;
const SUITE_ID = /^suite_[A-Za-z0-9_-]{1,40}$/;
const EXPIRED_HINT = 'Opens the report of this run in a new tab (404 once its evidence has expired)';

function idLink(href, id) {
  return el('a', { class: 'mono', href, target: '_blank', rel: 'noopener', title: EXPIRED_HINT, text: id });
}

/** The job id as a link to its report, or plain muted text when it does not look like a job id. */
export function runLink(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return el('span', { class: 'muted', text: '—' });
  return idLink(`/v1/runs/${encodeURIComponent(jobId)}/report?lang=en`, jobId);
}

/** What a scheduled occurrence started: a run or a suite has a report; a snapshot or a summary has none here. */
export function scheduleRunLink(ref) {
  if (!ref || typeof ref.id !== 'string') return null;
  if (ref.kind === 'run') return runLink(ref.id);
  if (ref.kind === 'suite' && SUITE_ID.test(ref.id)) return idLink(`/v1/suites/${encodeURIComponent(ref.id)}/report?lang=en`, ref.id);
  return null;
}

function runsCell(routine) {
  if (!routine.lastRun) return el('span', { class: 'muted', text: '—' });
  const nodes = [el('div', {}, [runLink(routine.lastRun.jobId)])];
  if (routine.lastFailedRun) nodes.push(el('div', { class: 'muted' }, ['last failure: ', runLink(routine.lastFailedRun.jobId)]));
  return el('div', {}, nodes);
}

function routineNote(routine) {
  const notes = [];
  if (routine.suggestion) notes.push(`${routine.suggestion.action} suggested: ${routine.suggestion.reason}`);
  for (const item of routine.slower) notes.push(`${item.series} slower${item.ratio === undefined ? '' : ` x${item.ratio}`}${item.suspectBuild ? ` (new build ${item.suspectBuild})` : ''}`);
  if (routine.lastRun?.buildId) notes.push(`build ${routine.lastRun.buildId}`);
  return notes.join(' · ');
}

// The Status… button under the routine's id (a column of its own would be pushed off a narrow screen). Absent for a viewer, and until the editor is built.
let statusEditor;

function statusButtonCell(routine) {
  const button = statusEditor?.button(routine);
  return button ? el('div', { class: 'cell-actions' }, [button]) : null;
}

function routinesTable(routines) {
  if (routines.list.length === 0) return el('p', { class: 'muted', text: 'No library routine on this target.' });
  const rows = routines.list.map((routine) =>
    el('tr', { class: 'static' }, [
      el('td', {}, [el('div', { class: 'mono', text: `${routine.id} v${routine.version}` }), statusButtonCell(routine)]),
      el('td', {}, [badge(routine.state, STATE_LABEL[routine.state] ?? routine.state)]),
      el('td', { text: routine.lastRun ? formatDateTime(routine.lastRun.at) : '—' }),
      el('td', {}, [runsCell(routine)]),
      el('td', { text: routine.streak ? `${routine.streak.runs} ${routine.streak.status}` : '—' }),
      el('td', {}, [routine.results.length > 0 ? strip(routine.results) : el('span', { class: 'muted', text: '—' })]),
      el('td', {}, [badge(routine.trend, TREND_LABEL[routine.trend] ?? routine.trend)]),
      el('td', { text: routine.flakyScore === undefined ? '—' : String(routine.flakyScore) }),
      el('td', { class: 'muted wrap', text: routineNote(routine) }),
    ]),
  );
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Routine', 'State', 'Last run', 'Report', 'In a row', 'Last results', 'Trend', 'Flaky score', ''].map((label) => el('th', { text: label })))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

function vaultBlock(vault) {
  if (vault.total === 0) return el('p', { class: 'muted', text: 'No regression-vault item on this target.' });
  const parts = [`${vault.active} active: ${vault.passing} passing, ${vault.failing} failing, ${vault.notRun} not run yet`];
  if (vault.quarantined > 0) parts.push(`${vault.quarantined} quarantined${vault.quarantinedFailing > 0 ? ` (${vault.quarantinedFailing} failing, not counted)` : ''}`);
  if (vault.retired > 0) parts.push(`${vault.retired} retired`);
  const nodes = [el('p', { text: parts.join(' · ') })];
  if (vault.attention.length > 0) {
    nodes.push(
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['Item', 'State', 'Severity', 'Surface', 'Last run', 'Report'].map((label) => el('th', { text: label })))]),
          el('tbody', {}, vault.attention.map((item) =>
            el('tr', { class: 'static' }, [
              el('td', { class: 'mono', text: `${item.id} ${item.title}` }),
              el('td', {}, [badge(item.state === 'failing' ? 'failing' : 'neutral', item.state === 'failing' ? 'failing' : 'not run')]),
              el('td', { text: item.severity ?? '—' }),
              el('td', { text: item.surface }),
              el('td', { text: item.lastRun ? formatDateTime(item.lastRun.at) : '—' }),
              el('td', {}, [item.lastRun ? runLink(item.lastRun.jobId) : el('span', { class: 'muted', text: '—' })]),
            ]),
          )),
        ]),
      ]),
    );
  }
  return el('div', {}, nodes);
}

function schedulesBlock(schedules) {
  if (schedules.length === 0) return el('p', { class: 'muted', text: 'No schedule.' });
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, ['Schedule', 'What', 'When', 'State', 'Last', 'Report', 'Next'].map((label) => el('th', { text: label })))]),
      el('tbody', {}, schedules.map((schedule) =>
        el('tr', { class: 'static' }, [
          el('td', { class: 'mono', text: schedule.id }),
          el('td', { text: schedule.routineId ? `routine ${schedule.routineId}` : schedule.kind }),
          el('td', { class: 'mono', text: `${schedule.cron} (${schedule.timezone})` }),
          el('td', {}, [badge(schedule.state, SCHEDULE_LABEL[schedule.state] ?? schedule.state)]),
          el('td', { text: schedule.lastRun ? `${schedule.lastRun.outcome}${schedule.lastRun.passedOnRetry ? ' (on retry)' : ''} · ${formatDateTime(schedule.lastRun.at)}` : '—' }),
          el('td', {}, [(schedule.lastRun && scheduleRunLink(schedule.lastRun.run)) || el('span', { class: 'muted', text: '—' })]),
          el('td', { text: schedule.next ? formatDateTime(schedule.next) : '—' }),
        ]),
      )),
    ]),
  ]);
}

function countsLine(counts) {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${STATE_LABEL[state] ?? state}`)
    .join(' · ');
}

export function targetCard(target) {
  const title = target.name ? `${target.name} (${target.id})` : target.id;
  const nodes = [
    el('div', { class: 'card-head' }, [
      el('h2', { text: title }),
      badge(target.status, STATUS_LABEL[target.status] ?? target.status),
      target.environment ? el('span', { class: 'muted', text: target.environment }) : null,
    ]),
  ];
  if (!target.known) nodes.push(el('p', { class: 'muted', text: 'Not a stored target profile: routines or schedules still refer to this id.' }));
  if (target.reasons.length > 0) nodes.push(el('ul', { class: 'reasons' }, target.reasons.map((reason) => el('li', { text: reason }))));
  nodes.push(el('h3', { text: 'Routines' }));
  if (target.routines.total > 0) nodes.push(el('p', { class: 'muted', text: countsLine(target.routines.counts) }));
  nodes.push(routinesTable(target.routines), el('h3', { text: 'Regression vault' }), vaultBlock(target.vault), el('h3', { text: 'Schedules' }), schedulesBlock(target.schedules));
  return el('div', { class: 'card' }, nodes);
}

function render(report) {
  const { totals } = report;
  document.getElementById('health-summary').textContent =
    totals.targets === 0
      ? 'No target profile yet.'
      : `${totals.targets} target(s): ${totals.red} need attention, ${totals.yellow} to watch, ${totals.green} healthy, ${totals.empty} without results. Updated ${formatDateTime(report.generatedAt)}.`;

  const banner = document.getElementById('health-banner');
  banner.replaceChildren();
  if (!report.schedulerRunning && (report.targets.some((target) => target.schedules.length > 0) || report.unscoped.schedules.length > 0)) {
    banner.appendChild(el('div', { class: 'warn-banner', text: 'The scheduler is not running in this server (SCHEDULER_ENABLED=false): schedules are stored but nothing fires on its own.' }));
  }

  document.getElementById('health-targets').replaceChildren(...report.targets.map(targetCard));

  const unscoped = document.getElementById('health-unscoped');
  unscoped.replaceChildren();
  if (report.unscoped.schedules.length > 0 || report.unscoped.vault.total > 0) {
    unscoped.appendChild(
      el('div', { class: 'card' }, [
        el('h2', { text: 'Not tied to one target' }),
        el('p', { class: 'muted', text: 'Schedules that start a suite or the whole vault can span several targets; vault items whose routine is gone have no target.' }),
        el('h3', { text: 'Schedules' }),
        schedulesBlock(report.unscoped.schedules),
        report.unscoped.vault.total > 0 ? el('h3', { text: 'Vault items without a target' }) : null,
        report.unscoped.vault.total > 0 ? vaultBlock(report.unscoped.vault) : null,
      ]),
    );
  }
}

async function load() {
  statusEditor ??= await createStatusEditor(load);
  render(await apiFetch('/v1/health'));
}

load().catch((error) => {
  document.getElementById('health-summary').textContent = `Could not load the health panel: ${error.message}`;
});
