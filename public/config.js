import { apiFetch, el, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const GROUP_TITLES = {
  safety: 'Safety',
  limits: 'Limits',
  runtime: 'Runtime',
  history: 'History & retention',
};

let fields = [];

function fieldControl(field) {
  if (field.type === 'boolean') {
    const select = el('select', { id: `f-${field.key}`, name: field.key });
    for (const option of ['false', 'true']) {
      select.appendChild(el('option', { value: option, text: option }));
    }
    select.value = String(field.value) === 'true' ? 'true' : 'false';
    if (field.locked) select.disabled = true;
    return select;
  }

  if (field.type === 'enum') {
    const select = el('select', { id: `f-${field.key}`, name: field.key });
    for (const option of field.options ?? []) select.appendChild(el('option', { value: option, text: option }));
    select.value = field.value;
    if (field.locked) select.disabled = true;
    return select;
  }

  const input = el('input', {
    id: `f-${field.key}`,
    name: field.key,
    type: field.type === 'number' ? 'number' : 'text',
    value: field.value,
  });
  if (field.locked) input.disabled = true;
  return input;
}

function renderField(field) {
  const notes = [];
  if (field.locked) notes.push('Locked — requires the API key to change');
  if (field.restartRequired) notes.push('Takes effect after restart');

  return el('div', { class: `field${field.locked ? ' locked' : ''}` }, [
    el('label', { for: `f-${field.key}`, text: field.key }),
    el('div', { class: 'help', text: field.help }),
    fieldControl(field),
    notes.length ? el('div', { class: 'help', text: notes.join(' · ') }) : null,
  ].filter(Boolean));
}

async function load() {
  const data = await apiFetch('/v1/config');
  fields = data.fields;

  const banners = document.getElementById('banners');
  banners.replaceChildren();

  const allowEvaluate = fields.find((field) => field.key === 'ALLOW_EVALUATE');
  if (allowEvaluate && String(allowEvaluate.value) === 'true') {
    banners.appendChild(el('div', { class: 'danger-banner', text: 'ALLOW_EVALUATE is ON. Routines can execute arbitrary JavaScript in the page. Turn this off unless this machine is local and fully trusted.' }));
  }

  banners.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'muted', text: 'Configuration file' }),
    el('div', { class: 'mono', text: data.envFilePath }),
    el('div', { class: 'muted', text: `Live target allowlist: ${data.liveAllowedTargetOrigins.join(', ') || '(none)'}` }),
  ]));

  const groups = document.getElementById('groups');
  groups.replaceChildren();

  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const groupFields = fields.filter((field) => field.group === group);
    if (groupFields.length === 0) continue;
    groups.appendChild(el('div', { class: 'card' }, [el('h2', { text: title }), ...groupFields.map(renderField)]));
  }
}

document.getElementById('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const state = document.getElementById('save-state');
  state.textContent = 'Saving…';

  const updates = {};
  for (const field of fields) {
    if (field.locked) continue;      // never submit locked fields from the UI
    const control = document.getElementById(`f-${field.key}`);
    if (control && control.value !== String(field.value)) updates[field.key] = control.value;
  }

  if (Object.keys(updates).length === 0) {
    state.textContent = 'No changes.';
    return;
  }

  try {
    const result = await apiFetch('/v1/config', { method: 'PUT', body: JSON.stringify({ updates }) });
    state.textContent = result.restartRequired
      ? `Saved ${result.updated.length} field(s). Restart ScrapForAI for these to take effect.`
      : `Saved ${result.updated.length} field(s).`;
    await load();
  } catch (error) {
    state.textContent = `Error: ${error.message}`;
  }
});

load().catch((error) => console.error(error));
