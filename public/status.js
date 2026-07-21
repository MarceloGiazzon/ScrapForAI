import { apiFetch, el, formatBytes, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

function row(label, value) {
  return el('tr', {}, [el('td', { class: 'muted', text: label }), el('td', { class: 'mono', text: String(value) })]);
}

async function load() {
  const status = await apiFetch('/v1/status');
  const root = document.getElementById('status-root');
  const nodes = [];

  if (status.allowEvaluate) {
    nodes.push(el('div', { class: 'danger-banner', text: 'ALLOW_EVALUATE is ON — arbitrary in-page JavaScript is permitted.' }));
  }
  if (status.host === '0.0.0.0') {
    nodes.push(el('div', { class: 'warn-banner', text: 'Listening on 0.0.0.0 — this service is reachable from your network.' }));
  }

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'Service' }),
    el('table', {}, [el('tbody', {}, [
      row('PID', status.pid),
      row('Node', status.nodeVersion),
      row('Platform', status.platform),
      row('Uptime', `${status.uptimeSeconds}s`),
      row('Environment', status.nodeEnv),
      row('Listening on', `${status.host}:${status.port}`),
      row('Browser', status.browser),
      row('Active UI sessions', status.activeSessions),
    ])]),
  ]));

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'Storage' }),
    el('table', {}, [el('tbody', {}, [
      row('Data directory', status.dataDir),
      row('Artifact directory', status.artifactDir),
      row('Artifact disk usage', formatBytes(status.artifactDiskBytes)),
      row('Evidence retention', `${status.artifactRetentionHours} hours`),
      row('History retention', `${status.history.retentionDays} days / ${status.history.maxRuns} runs`),
      row('Runs indexed', `${status.history.totalRuns} (${status.history.passedRuns} passed, ${status.history.failedRuns} failed)`),
      row('Oldest run', status.history.oldestRunAt ? formatDateTime(status.history.oldestRunAt) : '—'),
    ])]),
  ]));

  const mcpSnippet = JSON.stringify({
    mcpServers: { scrapforai: { command: 'npx', args: ['tsx', 'src/mcp/server.ts'] } },
  }, null, 2);

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'MCP client configuration' }),
    el('p', { class: 'muted', text: 'Add this to your agent MCP config to reach this server.' }),
    el('pre', { text: mcpSnippet }),
  ]));

  root.replaceChildren(...nodes);
}

load().catch((error) => console.error(error));
