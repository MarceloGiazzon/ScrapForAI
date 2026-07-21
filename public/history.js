import { apiFetch, el, formatDateTime, formatDuration, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const PAGE_SIZE = 50;
let offset = 0;

const body = document.getElementById('runs-body');
const dialog = document.getElementById('detail');
const detailBody = document.getElementById('detail-body');

document.getElementById('detail-close').addEventListener('click', () => dialog.close());

function buildQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById('filter-q').value.trim();
  const status = document.getElementById('filter-status').value;
  const scenario = document.getElementById('filter-scenario').value;

  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (scenario) params.set('scenario', scenario);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  return params.toString();
}

async function loadStats() {
  const stats = await apiFetch('/v1/runs/stats');
  const container = document.getElementById('stats');
  container.replaceChildren(
    stat('Total runs', String(stats.totalRuns)),
    stat('Passed', String(stats.passedRuns)),
    stat('Failed', String(stats.failedRuns)),
    stat('Oldest kept', stats.oldestRunAt ? formatDateTime(stats.oldestRunAt) : '—'),
  );
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value })]);
}

async function loadScenarios() {
  const { scenarios } = await apiFetch('/v1/runs/scenarios');
  const select = document.getElementById('filter-scenario');
  const current = select.value;
  select.replaceChildren(el('option', { value: '', text: 'All scenarios' }));
  for (const name of scenarios) select.appendChild(el('option', { value: name, text: name }));
  select.value = current;
}

async function loadRuns() {
  const data = await apiFetch(`/v1/runs?${buildQuery()}`);

  body.replaceChildren();
  if (data.items.length === 0) {
    body.appendChild(el('tr', {}, [el('td', { colspan: '7', class: 'muted', text: 'No runs match these filters.' })]));
  }

  for (const run of data.items) {
    const issues = [];
    if (run.consoleErrorCount) issues.push(`${run.consoleErrorCount} console`);
    if (run.networkFailureCount) issues.push(`${run.networkFailureCount} network`);
    if (run.unexpectedExternalRequestCount) issues.push(`${run.unexpectedExternalRequestCount} external`);

    const row = el('tr', { onclick: () => showDetail(run.jobId) }, [
      el('td', { text: formatDateTime(run.startedAt) }),
      el('td', { text: run.scenarioName ?? '—' }),
      el('td', { class: 'mono', text: run.targetUrl }),
      el('td', {}, [el('span', { class: `badge ${run.status}`, text: run.status })]),
      el('td', { text: `${run.passedSteps}/${run.stepCount}` }),
      el('td', { text: formatDuration(run.durationMs) }),
      el('td', { class: 'muted', text: issues.join(', ') || '—' }),
    ]);
    body.appendChild(row);
  }

  document.getElementById('page-info').textContent =
    `${data.total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)} of ${data.total}`;
  document.getElementById('prev').disabled = offset === 0;
  document.getElementById('next').disabled = offset + PAGE_SIZE >= data.total;
}

async function showDetail(jobId) {
  detailBody.replaceChildren(el('div', { class: 'card', text: 'Loading…' }));
  dialog.showModal();

  const data = await apiFetch(`/v1/runs/${encodeURIComponent(jobId)}`);
  const { summary, detail, evidenceAvailable, evidenceRetentionHours } = data;

  const nodes = [
    el('div', { class: 'card' }, [
      el('h2', { text: summary.scenarioName ?? summary.jobId }),
      el('p', { class: 'mono muted', text: summary.targetUrl }),
      el('p', {}, [
        el('span', { class: `badge ${summary.status}`, text: summary.status }),
        el('span', { class: 'muted', text: `  ${formatDateTime(summary.startedAt)} · ${formatDuration(summary.durationMs)}` }),
      ]),
      summary.errorMessage ? el('pre', { text: `${summary.errorType ?? 'Error'}: ${summary.errorMessage}` }) : null,
    ]),
  ];

  if (!evidenceAvailable) {
    nodes.push(el('div', { class: 'warn-banner', text: `Evidence expired. Screenshots and traces are kept for ${evidenceRetentionHours} hours; the run record is kept far longer.` }));
  }

  if (detail?.steps?.length) {
    const rows = detail.steps.map((step) =>
      el('tr', {}, [
        el('td', { text: String(step.index) }),
        el('td', { text: step.label ?? step.id ?? '—' }),
        el('td', { class: 'mono', text: step.action }),
        el('td', {}, [el('span', { class: `badge ${step.status === 'passed' ? 'passed' : 'failed'}`, text: step.status })]),
        el('td', { text: formatDuration(step.durationMs) }),
        el('td', { class: 'muted', text: step.error?.message ?? '' }),
      ]),
    );
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Steps' }),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: '#' }), el('th', { text: 'Label' }), el('th', { text: 'Action' }),
            el('th', { text: 'Status' }), el('th', { text: 'Duration' }), el('th', { text: 'Error' }),
          ])]),
          el('tbody', {}, rows),
        ]),
      ]),
    ]));
  }

  if (evidenceAvailable && detail?.evidence?.screenshots?.length) {
    const images = detail.evidence.screenshots.map((shot) =>
      el('figure', {}, [
        el('img', { src: `/v1/runs/${encodeURIComponent(jobId)}/artifacts/screenshots/${encodeURIComponent(shot.name)}.png`, alt: shot.name, loading: 'lazy' }),
        el('figcaption', { class: 'muted', text: shot.name }),
      ]),
    );
    nodes.push(el('div', { class: 'card' }, [el('h3', { text: 'Screenshots' }), el('div', { class: 'screenshot-grid' }, images)]));
  }

  if (detail?.evidence?.consoleErrors?.length) {
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Console errors' }),
      el('pre', { text: detail.evidence.consoleErrors.map((entry) => entry.text).join('\n') }),
    ]));
  }

  if (detail?.evidence?.networkFailures?.length) {
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Network failures' }),
      el('pre', { text: detail.evidence.networkFailures.map((entry) => `${entry.method} ${entry.origin}${entry.pathname} → ${entry.status ?? entry.failureText ?? 'failed'}`).join('\n') }),
    ]));
  }

  detailBody.replaceChildren(...nodes.filter(Boolean));
}

async function refresh() {
  await Promise.all([loadStats(), loadScenarios(), loadRuns()]);
}

document.getElementById('refresh').addEventListener('click', () => { offset = 0; refresh(); });
document.getElementById('filter-q').addEventListener('input', () => { offset = 0; loadRuns(); });
document.getElementById('filter-status').addEventListener('change', () => { offset = 0; loadRuns(); });
document.getElementById('filter-scenario').addEventListener('change', () => { offset = 0; loadRuns(); });
document.getElementById('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); loadRuns(); });
document.getElementById('next').addEventListener('click', () => { offset += PAGE_SIZE; loadRuns(); });

refresh().catch((error) => console.error(error));
