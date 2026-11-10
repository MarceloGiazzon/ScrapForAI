import { setupAdminKey } from './adminKey.js';
import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

// Credentials screen. Reading the list (ids, origins, field NAMES, tags, dates) goes with the session; the server never returns a value.
// Every CHANGE needs an admin's API key (adminKey.js: memory only). A secret typed here lives in its input until the server has answered
// "saved", and is cleared from the page at once; it is never copied into a variable that outlives the call, the DOM, the URL or any storage.

const FIELD_NAME = /^[a-zA-Z0-9_-]{1,80}$/;
// Sets written by the webhook and integration screens/APIs (their URL and token). They are changed THROUGH those, which check where the data
// may be sent; editing or deleting them here would skip that check or leave the webhook without its URL.
const MANAGED_PREFIXES = [
  ['webhook-', 'a webhook'],
  ['integration-', 'an integration'],
];

const byId = (id) => document.getElementById(id);

let sets = [];
let isAdmin = false;
let editing = ''; // id of the set being edited; '' when a new one is being added
let rows = []; // the field rows of the form: { row, name, value }

/** Badge classes are fixed words from the stylesheet, never taken from the data. */
const badge = (text) => el('span', { class: 'badge neutral', text });

function showError(message) {
  const box = byId('cred-error');
  box.textContent = message;
  box.classList.toggle('hidden', !message);
  if (message) byId('cred-done').classList.add('hidden');
}

function showDone(message) {
  const box = byId('cred-done');
  box.textContent = message;
  box.classList.toggle('hidden', !message);
}

const { change } = setupAdminKey({ showError });

// ---- the form

function addFieldRow(name = '', { keep = false } = {}) {
  const nameInput = el('input', { type: 'text', placeholder: 'Field name', maxlength: '80', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Field name' });
  nameInput.value = name;
  const valueInput = el('input', {
    type: byId('cred-show').checked ? 'text' : 'password',
    placeholder: keep ? 'not shown: type to replace' : 'Secret value',
    maxlength: '5000',
    spellcheck: 'false',
    autocomplete: 'new-password',
    'aria-label': 'Field value',
  });
  const entry = { row: undefined, name: nameInput, value: valueInput };
  entry.row = el('div', { class: 'field-row' }, [
    nameInput,
    valueInput,
    el('button', {
      type: 'button',
      class: 'secondary',
      text: 'Remove',
      onClick: () => {
        rows = rows.filter((candidate) => candidate !== entry);
        entry.row.remove();
      },
    }),
  ]);
  rows.push(entry);
  byId('cred-fields').appendChild(entry.row);
  return entry;
}

function clearRows() {
  for (const entry of rows) entry.value.value = '';
  rows = [];
  byId('cred-fields').replaceChildren();
}

function resetForm() {
  editing = '';
  clearRows();
  for (const id of ['cred-id', 'cred-origins', 'cred-tags', 'cred-notes']) byId(id).value = '';
  byId('cred-id').readOnly = false;
  byId('cred-form-title').textContent = 'Add a credential set';
  byId('cred-save').textContent = 'Save credential set';
  byId('cred-cancel').classList.add('hidden');
  byId('cred-fields-help').textContent = 'A name and its secret value. The names are what routines use (valueFromCredential).';
  addFieldRow();
}

function startEditing(meta) {
  showError('');
  showDone('');
  resetForm();
  clearRows();
  editing = meta.id;
  byId('cred-id').value = meta.id;
  byId('cred-id').readOnly = true;
  byId('cred-origins').value = meta.boundOrigins.join('\n');
  byId('cred-tags').value = meta.tags.join(', ');
  byId('cred-notes').value = meta.notes ?? '';
  for (const name of meta.fields) addFieldRow(name, { keep: true });
  byId('cred-form-title').textContent = `Edit ${meta.id}`;
  byId('cred-save').textContent = 'Save changes';
  byId('cred-cancel').classList.remove('hidden');
  byId('cred-fields-help').textContent =
    'Values are write-only, so none is shown. Leave every value blank to keep the stored ones (only origins, tags and notes change). To change any value, type ALL of them again: they are replaced together.';
  byId('cred-form-title').scrollIntoView({ block: 'start' });
}

function addPreset(names) {
  // Drop untouched empty rows, then add the names that are not there yet.
  for (const entry of rows.filter((candidate) => candidate.name.value.trim() === '' && candidate.value.value === '')) {
    entry.row.remove();
    rows = rows.filter((candidate) => candidate !== entry);
  }
  for (const name of names) {
    if (!rows.some((entry) => entry.name.value.trim() === name)) addFieldRow(name);
  }
  rows.find((entry) => names.includes(entry.name.value.trim()) && entry.value.value === '')?.value.focus();
}

/** The request body from the form, or `{ error }`. The body holds the secrets: the caller must not keep it. */
function buildBody() {
  const origins = byId('cred-origins').value.split(/[\s,]+/).filter(Boolean);
  if (origins.length === 0) return { error: 'Give at least one bound origin, e.g. https://dev.example.com.' };
  const tags = byId('cred-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean);
  const notes = byId('cred-notes').value.trim();
  const body = { boundOrigins: origins, tags, ...(notes ? { notes } : {}) };

  const typedAny = rows.some((entry) => entry.value.value !== '');
  if (editing && !typedAny) {
    // Keeping the stored values: the fields must be exactly the ones the set has, or a removal/addition would be lost silently.
    const original = sets.find((set) => set.id === editing)?.fields ?? [];
    const current = rows.map((entry) => entry.name.value.trim()).filter(Boolean).sort();
    if (current.length !== original.length || current.some((name, index) => name !== original[index])) {
      return { error: 'Adding, renaming or removing a field means replacing the values: type the value of every field again.' };
    }
    return { body };
  }

  const filled = rows.filter((entry) => entry.name.value.trim() !== '' || entry.value.value !== '');
  if (filled.length === 0) return { error: 'Add at least one field with its value.' };
  const values = {};
  for (const entry of filled) {
    const name = entry.name.value.trim();
    if (!FIELD_NAME.test(name)) return { error: `"${name}" is not a valid field name: letters, digits, _ and -, up to 80 characters.` };
    if (entry.value.value === '') {
      return { error: `Field "${name}" has no value.${editing ? ' To change values, type all of them again (or remove the field).' : ''}` };
    }
    if (Object.hasOwn(values, name)) return { error: `The field "${name}" appears twice.` };
    values[name] = entry.value.value;
  }
  body.values = values;
  return { body };
}

byId('cred-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showDone('');
  const built = buildBody();
  if (built.error) {
    showError(built.error);
    return;
  }
  const id = editing || byId('cred-id').value.trim();
  if (!editing && sets.some((set) => set.id === id)) {
    showError(`A credential set called "${id}" already exists: use Edit in the list above.`);
    return;
  }

  const method = editing ? 'PUT' : 'POST';
  const replacesValues = built.body.values !== undefined;
  const result = await change(method, `/v1/credentials/${encodeURIComponent(id)}`, built.body);
  if (result === undefined) return; // refused: the reason is on the page and what was typed stays, so it can be corrected

  // The secrets leave the page now.
  const wasEditing = editing !== '';
  resetForm();
  showDone(wasEditing ? `Saved ${id}.${replacesValues ? ' The values were replaced.' : ' The stored values were kept.'}` : `Saved ${id}. Its values are now write-only: they cannot be shown again.`);
  await loadSets();
});

byId('cred-cancel').addEventListener('click', () => {
  showError('');
  showDone('');
  resetForm();
});
byId('cred-add-field').addEventListener('click', () => addFieldRow().name.focus());
byId('cred-preset-login').addEventListener('click', () => addPreset(['username', 'password']));
byId('cred-preset-genexus').addEventListener('click', () => addPreset(['loginUser', 'loginPassword']));
byId('cred-show').addEventListener('change', () => {
  for (const entry of rows) entry.value.type = byId('cred-show').checked ? 'text' : 'password';
});
window.addEventListener('pagehide', clearRows);

// ---- the list

const managedBy = (id) => MANAGED_PREFIXES.find(([prefix]) => id.startsWith(prefix))?.[1];

function actionsOf(set) {
  const owner = managedBy(set.id);
  if (owner) return [el('span', { class: 'muted', text: `managed by ${owner}` })];
  if (!isAdmin) return [];
  return [
    el('div', { class: 'row' }, [
      el('button', { class: 'secondary', type: 'button', text: 'Edit', onClick: () => startEditing(set) }),
      el('button', {
        class: 'secondary',
        type: 'button',
        text: 'Delete',
        onClick: async () => {
          if (!window.confirm(`Delete the credential set "${set.id}"? Routines, suites and schedules that use it fail until a set with this id exists again. The values cannot be recovered.`)) return;
          if ((await change('DELETE', `/v1/credentials/${encodeURIComponent(set.id)}`)) === undefined) return;
          if (editing === set.id) resetForm();
          showDone(`Deleted ${set.id}.`);
          await loadSets();
        },
      }),
    ]),
  ];
}

function renderSets() {
  const tbody = byId('cred-rows');
  tbody.replaceChildren();
  for (const set of sets) {
    tbody.appendChild(
      el('tr', { class: 'static' }, [
        el('td', {}, [el('div', { class: 'mono', text: set.id }), set.notes ? el('div', { class: 'muted wrap', text: set.notes }) : null]),
        el('td', { class: 'wrap' }, set.boundOrigins.map((origin) => el('div', { class: 'mono', text: origin }))),
        el('td', { class: 'wrap' }, set.fields.map((field) => badge(field))),
        el('td', { class: 'muted', text: set.tags.length > 0 ? set.tags.join(', ') : '—' }),
        el('td', { class: 'muted', text: formatDateTime(set.updatedAt) }),
        el('td', { class: 'muted', text: set.lastUsedAt ? formatDateTime(set.lastUsedAt) : 'never' }),
        el('td', {}, actionsOf(set)),
      ]),
    );
  }
  byId('cred-summary').textContent =
    sets.length === 0
      ? isAdmin
        ? 'No credential set yet. Add the first one below.'
        : 'No credential set yet. An admin can add one.'
      : `${sets.length} credential set(s). Only the field names are shown: the values are write-only.`;
}

async function loadSets() {
  sets = (await apiFetch('/v1/credentials')).credentialSets;
  renderSets();
}

// ---- start

async function start() {
  const me = await apiFetch('/v1/auth/me');
  const who = me.user ?? { id: '?', role: '?' };
  isAdmin = who.role === 'admin';
  byId('cred-me').textContent = `Signed in as ${who.id} (${who.role}).`;
  if (isAdmin) {
    byId('cred-admin').classList.remove('hidden');
    resetForm();
  } else {
    byId('cred-banner').appendChild(el('div', { class: 'warn-banner', text: 'Adding, changing and deleting credential sets is for admins. You can see which sets exist and where they are bound; the values are never shown to anyone.' }));
  }
  await loadSets();
}

start().catch((error) => {
  byId('cred-banner').appendChild(el('div', { class: 'danger-banner', text: error.message }));
});
