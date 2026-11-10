import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

// Tables screen. Unlike credentials, schedules or webhooks, saving a table is something a session may do (a runner or an admin; the API takes no admin
// key for it): a table is test data, never a secret, and the server refuses a cell that looks like one (422 TableLintError). Versions are immutable:
// "saving" always means the server stores the NEXT version, or nothing when the content is the current one.

const byId = (id) => document.getElementById(id);
const SAMPLE = 'qty,price,total\n1,10.00,10.00\n2,10.00,20.00\n999,10.00,9990.00\n1000,10.00,10000.00\n';
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

let tables = [];
let editing = ''; // id of the table being edited; '' when a new one is being added
let canWrite = false;

function showError(message, details = []) {
  const box = byId('tab-error');
  box.textContent = [message, ...details.map((detail) => (detail.path ? `${detail.path}: ${detail.message}` : detail.message))].filter(Boolean).join(' — ');
  box.classList.toggle('hidden', !message);
  if (message) byId('tab-done').classList.add('hidden');
}

function showDone(message) {
  const box = byId('tab-done');
  box.textContent = message;
  box.classList.toggle('hidden', !message);
}

const tablePath = (id, query = '') => `/v1/tables/${encodeURIComponent(id)}${query}`;

function resetForm() {
  editing = '';
  for (const id of ['tab-id', 'tab-title', 'tab-csv']) byId(id).value = '';
  byId('tab-id').readOnly = !canWrite;
  byId('tab-version-field').classList.add('hidden');
  byId('tab-version').replaceChildren();
  byId('tab-form-title').textContent = canWrite ? 'Add a table' : 'Open a table to see it';
  byId('tab-save').textContent = 'Save table';
  byId('tab-cancel').classList.add('hidden');
  byId('tab-download').classList.add('hidden');
}

/** Puts one stored version into the form. */
function fillForm(table, versions) {
  editing = table.id;
  byId('tab-id').value = table.id;
  byId('tab-id').readOnly = true;
  byId('tab-title').value = table.title ?? '';
  byId('tab-csv').value = table.csv;
  const select = byId('tab-version');
  select.replaceChildren(...versions.slice().sort((a, b) => b - a).map((version) => el('option', { value: String(version), text: `v${version}${version === Math.max(...versions) ? ' (current)' : ''}` })));
  select.value = String(table.version);
  byId('tab-version-field').classList.remove('hidden');
  byId('tab-form-title').textContent = `${canWrite ? 'Edit' : 'View'} ${table.id} (opened v${table.version})`;
  byId('tab-save').textContent = 'Save as a new version';
  byId('tab-cancel').classList.remove('hidden');
  const link = byId('tab-download');
  link.setAttribute('href', tablePath(table.id, `?version=${table.version}&format=csv`));
  link.setAttribute('download', `${table.id}-v${table.version}.csv`);
  link.classList.remove('hidden');
}

async function open(id, version) {
  showError('');
  showDone('');
  try {
    const data = await apiFetch(tablePath(id, version === undefined ? '' : `?version=${version}`));
    fillForm(data.table, data.versions);
    byId('tab-form-title').scrollIntoView({ block: 'start' });
  } catch (error) {
    showError(error.message, error.details);
  }
}

byId('tab-version').addEventListener('change', () => {
  if (editing) void open(editing, Number(byId('tab-version').value));
});
byId('tab-sample').addEventListener('click', () => {
  byId('tab-csv').value = SAMPLE;
});
byId('tab-cancel').addEventListener('click', () => {
  showError('');
  showDone('');
  resetForm();
});

byId('tab-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showDone('');
  const id = editing || byId('tab-id').value.trim();
  if (!SAFE_ID.test(id)) {
    showError('The id is letters, digits, _ and -, up to 80 characters.');
    return;
  }
  if (!editing && tables.some((table) => table.id === id)) {
    showError(`A table called "${id}" already exists: use Open in the list above to add a version.`);
    return;
  }
  const csv = byId('tab-csv').value;
  if (csv.trim() === '') {
    showError('The CSV is empty: it needs a header row of column names and at least one row.');
    return;
  }
  const title = byId('tab-title').value.trim();
  const wasEditing = editing !== '';
  try {
    const result = await apiFetch(tablePath(id), { method: 'PUT', body: JSON.stringify({ csv, ...(title ? { title } : {}) }) });
    showError('');
    const { table, created } = result;
    showDone(created ? `Saved ${id} as version ${table.version}.` : `${id} already has exactly this content: version ${table.version} is the current one, nothing was stored.`);
    await loadTables();
    await open(id);
    showDone(created ? `Saved ${id} as version ${table.version}.` : `${id} already has exactly this content: version ${table.version} is the current one, nothing was stored.`);
    if (!wasEditing) byId('tab-title').focus();
  } catch (error) {
    // The server names the line and column of a CSV problem, and never echoes a cell it refused as a secret.
    showError(error.message, error.details);
  }
});

function renderTables() {
  const tbody = byId('tab-rows');
  tbody.replaceChildren();
  for (const table of tables) {
    tbody.appendChild(
      el('tr', { class: 'static' }, [
        el('td', { class: 'mono', text: table.id }),
        el('td', { class: 'wrap', text: table.title ?? '—' }),
        el('td', { text: `v${table.version}` }),
        el('td', { class: 'wrap' }, table.columns.map((column) => el('span', { class: 'badge neutral', text: column }))),
        el('td', { text: String(table.rowCount) }),
        el('td', { class: 'muted', text: formatDateTime(table.createdAt) }),
        el('td', {}, [el('button', { class: 'secondary', type: 'button', text: canWrite ? 'Open' : 'View', onClick: () => open(table.id) })]),
      ]),
    );
  }
  byId('tab-summary').textContent =
    tables.length === 0 ? (canWrite ? 'No table yet. Add the first one below.' : 'No table yet.') : `${tables.length} table(s). Each shows its current version; Open shows any version.`;
}

async function loadTables() {
  tables = (await apiFetch('/v1/tables')).tables;
  renderTables();
}

async function start() {
  const me = await apiFetch('/v1/auth/me');
  const who = me.user ?? { id: '?', role: '?' };
  canWrite = who.role === 'runner' || who.role === 'admin';
  byId('tab-me').textContent = `Signed in as ${who.id} (${who.role}).`;
  byId('tab-editor').classList.remove('hidden');
  resetForm();
  if (!canWrite) {
    // A viewer can read every table and version, not save one: the same card, read-only, with no save button.
    for (const id of ['tab-id', 'tab-title', 'tab-csv']) byId(id).readOnly = true;
    for (const id of ['tab-save', 'tab-sample']) byId(id).classList.add('hidden');
    byId('tab-form-title').textContent = 'Open a table to see it';
    byId('tab-banner').appendChild(el('div', { class: 'warn-banner', text: 'Saving tables is for runners and admins. You can open any table and any version here.' }));
  }
  await loadTables();
}

start().catch((error) => {
  byId('tab-banner').appendChild(el('div', { class: 'danger-banner', text: error.message }));
});
