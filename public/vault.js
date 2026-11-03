import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const body = document.getElementById('vault-body');
const summary = document.getElementById('vault-summary');
const impactResult = document.getElementById('impact-result');

// Every cell is built with textContent (see el()), so nothing from an item can inject markup. Links only ever
// point at this server's own /v1/runs/<jobId>/... endpoints, with the jobId taken from a validated field.
const JOB_ID = /^job_[A-Za-z0-9_-]{1,64}$/;

function reportLink(jobId, label) {
  if (!JOB_ID.test(jobId ?? '')) return el('span', { class: 'muted', text: '—' });
  return el('a', { href: `/v1/runs/${jobId}/report?lang=en`, target: '_blank', rel: 'noopener', text: label });
}

function evidenceCell(ref, missingText) {
  if (!ref) return el('span', { class: 'muted', text: missingText });
  return el('span', {}, [reportLink(ref.jobId, ref.buildId ? `build ${ref.buildId}` : 'report'), el('div', { class: 'muted mono', text: formatDateTime(ref.at) })]);
}

function badge(status) {
  return el('span', { class: `badge ${status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : ''}`, text: status });
}

async function runItem(id, button) {
  button.disabled = true;
  button.textContent = 'Running…';
  try {
    const outcome = await apiFetch(`/v1/vault/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({}) });
    impactResult.replaceChildren(el('p', { text: `${id}: ${outcome.result.status}` }));
  } catch (error) {
    // A failing run is HTTP 500 with a body; apiFetch reports it as an error with the message.
    impactResult.replaceChildren(el('div', { class: 'warn-banner', text: `${id}: ${error.message}` }));
  }
  await load();
}

function itemRow(item) {
  const runButton = el('button', { class: 'secondary', text: 'Run' });
  runButton.addEventListener('click', () => runItem(item.id, runButton));

  const redCell = item.provenRed ? evidenceCell(item.provenRed, '') : el('span', { class: 'muted', text: `not captured: ${item.redNotCapturedReason ?? ''}` });

  return el('tr', {}, [
    el('td', {}, [el('b', { text: item.id }), el('div', { text: item.title }), item.ledgerRef ? el('div', { class: 'muted mono', text: item.ledgerRef }) : null]),
    el('td', { text: item.status }),
    el('td', { text: item.severity ?? '—' }),
    el('td', { class: 'mono', text: item.surface }),
    el('td', {}, [redCell]),
    el('td', {}, [evidenceCell(item.firstGreen, 'awaiting fix')]),
    el('td', {}, item.lastRun ? [badge(item.lastRun.status), el('div', { class: 'muted mono', text: formatDateTime(item.lastRun.at) }), reportLink(item.lastRun.jobId, 'report')] : [el('span', { class: 'muted', text: 'never' })]),
    el('td', {}, [runButton]),
  ]);
}

async function load() {
  const { items } = await apiFetch('/v1/vault');
  const withGreen = items.filter((item) => item.firstGreen).length;
  summary.textContent = items.length === 0 ? 'The vault is empty. Items are created when an agent reproduces a bug (vault_add_from_run).' : `${items.length} item(s); ${withGreen} with a confirmed GREEN, ${items.length - withGreen} awaiting a fix.`;
  body.replaceChildren(...items.map(itemRow));
}

function impactInput() {
  const changedFiles = document.getElementById('changed-files').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const surfaces = document.getElementById('surfaces').value.split(',').map((value) => value.trim()).filter(Boolean);
  return { ...(changedFiles.length ? { changedFiles } : {}), ...(surfaces.length ? { surfaces } : {}) };
}

document.getElementById('plan').addEventListener('click', async () => {
  try {
    const plan = await apiFetch('/v1/vault/plan', { method: 'POST', body: JSON.stringify(impactInput()) });
    impactResult.replaceChildren(
      plan.count === 0
        ? el('p', { class: 'muted', text: 'No ACTIVE items.' })
        : el('ol', {}, plan.order.map((entry) => el('li', {}, [el('b', { text: entry.id }), el('span', { text: ` — ${entry.reasons.map((reason) => reason.detail).join('; ')}` })]))),
    );
  } catch (error) {
    impactResult.replaceChildren(el('div', { class: 'warn-banner', text: error.message }));
  }
});

document.getElementById('run-impact').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const impact = impactInput();
    const started = await apiFetch('/v1/suites', {
      method: 'POST',
      body: JSON.stringify({ name: 'vault (by impact)', items: [{ vault: {} }], order: 'impact', impact }),
    });
    impactResult.replaceChildren(el('p', { class: 'muted', text: `Suite ${started.suiteRunId} started (${started.total} run(s))…` }));

    let state;
    do {
      state = await apiFetch(`/v1/suites/${started.suiteRunId}?wait=20`);
    } while (state.status === 'running');

    impactResult.replaceChildren(
      el('p', {}, [badge(state.verdict === 'green' ? 'passed' : 'failed'), el('span', { text: ` ${state.verdict} — ${state.verdictReason ?? ''}` })]),
      el('ol', {}, state.variants.map((variant) => el('li', {}, [el('b', { text: variant.variantKey }), el('span', { text: ` ${variant.status}` }), variant.order ? el('span', { class: 'muted', text: ` (${variant.order.reasons.join('; ')})` }) : null]))),
      el('a', { href: `/v1/suites/${started.suiteRunId}/report?lang=en`, target: '_blank', rel: 'noopener', text: 'Open the suite report' }),
    );
  } catch (error) {
    impactResult.replaceChildren(el('div', { class: 'warn-banner', text: error.message }));
  } finally {
    button.disabled = false;
    await load();
  }
});

load().catch((error) => {
  summary.textContent = error.message;
});
