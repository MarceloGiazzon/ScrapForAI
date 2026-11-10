import { setupAdminKey } from './adminKey.js';
import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

// T10.1 Team screen. Reads go with the session. Every CHANGE needs an admin's API key as a Bearer token (a session alone is refused by the
// server): `change()` comes from adminKey.js, which keeps the typed key in memory only (see there).
const AUDIT_PAGE = 50;
const ROLES = ['viewer', 'runner', 'admin'];
const EXPIRY_CHOICES = [
  ['never', 'never expires', 0],
  ['30', 'expires in 30 days', 30],
  ['90', 'expires in 90 days', 90],
  ['365', 'expires in 1 year', 365],
];

let selectedUser = '';
let people = [];
let auditBefore = null; // `seq` the next page must be older than
let auditShown = 0;

const byId = (id) => document.getElementById(id);

/** Badge classes are fixed words from the stylesheet, never taken from the data. */
function badge(kind, text) {
  const cls = kind === 'bad' ? 'badge failed' : kind === 'good' ? 'badge passed' : kind === 'warn' ? 'badge warn' : 'badge neutral';
  return el('span', { class: cls, text });
}

// ---- admin key (memory only, see adminKey.js)

function showError(message) {
  const box = byId('team-error');
  box.textContent = message;
  box.classList.toggle('hidden', !message);
}

const { change } = setupAdminKey({ showError });

// ---- new key (shown once)

function showNewKey(person, key) {
  byId('new-key-for').textContent = `For ${person}.`;
  byId('new-key-value').value = key;
  byId('new-key-copied').textContent = '';
  byId('new-key-card').classList.remove('hidden');
  byId('new-key-value').select();
}

function hideNewKey() {
  byId('new-key-value').value = '';
  byId('new-key-card').classList.add('hidden');
}

byId('new-key-copy').addEventListener('click', async () => {
  const input = byId('new-key-value');
  try {
    await navigator.clipboard.writeText(input.value);
    byId('new-key-copied').textContent = 'Copied.';
  } catch {
    input.select();
    byId('new-key-copied').textContent = 'Could not copy automatically: the key is selected, press Ctrl+C.';
  }
});
byId('new-key-done').addEventListener('click', hideNewKey);

// ---- people

function keyLine(key) {
  const parts = [`created ${formatDateTime(key.createdAt)}`];
  if (key.lastUsedAt) parts.push(`last used ${formatDateTime(key.lastUsedAt)}`);
  if (key.expiresAt) parts.push(`${key.active || key.revokedAt ? 'expires' : 'expired'} ${formatDateTime(key.expiresAt)}`);
  if (key.revokedAt) parts.push(`revoked ${formatDateTime(key.revokedAt)}`);
  return parts.join(' · ');
}

function renderDetail() {
  const box = byId('person-detail');
  box.replaceChildren();
  const person = people.find((candidate) => candidate.id === selectedUser);
  if (!person) return;

  const rows = person.keys.map((key) =>
    el('tr', { class: 'static' }, [
      el('td', { class: 'mono', text: key.id }),
      el('td', { text: key.label ?? '—' }),
      el('td', {}, [key.revokedAt ? badge('bad', 'revoked') : key.active ? badge('good', 'active') : badge('neutral', 'expired')]),
      el('td', { class: 'muted wrap', text: keyLine(key) }),
      el('td', {}, [
        key.active
          ? el('button', {
              class: 'secondary',
              type: 'button',
              text: 'Revoke',
              onClick: async () => {
                if (!window.confirm(`Revoke key ${key.id} of ${person.id}? It stops working at once.`)) return;
                if (await change('DELETE', `/v1/team/users/${encodeURIComponent(person.id)}/keys/${encodeURIComponent(key.id)}`)) await loadPeople();
              },
            })
          : null,
      ]),
    ]),
  );

  const label = el('input', { type: 'text', placeholder: 'Label (e.g. laptop, CI)', maxlength: '80', 'aria-label': 'Key label' });
  const expiry = el('select', { 'aria-label': 'Key expiry' }, EXPIRY_CHOICES.map(([value, text]) => el('option', { value, text })));
  const add = el('button', {
    type: 'button',
    text: 'Create key',
    onClick: async () => {
      const days = EXPIRY_CHOICES.find(([value]) => value === expiry.value)?.[2] ?? 0;
      const body = {};
      if (label.value.trim()) body.label = label.value.trim();
      if (days > 0) body.expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
      const result = await change('POST', `/v1/team/users/${encodeURIComponent(person.id)}/keys`, body);
      if (result) {
        showNewKey(person.id, result.key);
        await loadPeople();
      }
    },
  });

  box.appendChild(
    el('div', { class: 'card' }, [
      el('h3', { text: `Keys of ${person.id}` }),
      rows.length === 0
        ? el('p', { class: 'muted', text: 'No key yet: this person cannot sign in until one is created.' })
        : el('div', { class: 'table-wrap' }, [
            el('table', {}, [
              el('thead', {}, [el('tr', {}, ['Key id', 'Label', 'State', 'When', ''].map((text) => el('th', { text })))]),
              el('tbody', {}, rows),
            ]),
          ]),
      el('div', { class: 'filters' }, [label, expiry, add]),
    ]),
  );
}

function renderPeople() {
  const tbody = byId('people');
  tbody.replaceChildren();
  for (const person of people) {
    const activeKeys = person.keys.filter((key) => key.active).length;
    const roleSelect = el('select', { 'aria-label': `Role of ${person.id}` }, ROLES.map((role) => el('option', { value: role, text: role })));
    roleSelect.value = person.role;
    roleSelect.addEventListener('change', async () => {
      const done = await change('PATCH', `/v1/team/users/${encodeURIComponent(person.id)}`, { role: roleSelect.value });
      if (done) await loadPeople();
      else roleSelect.value = person.role;
    });

    tbody.appendChild(
      el('tr', { class: 'static' }, [
        el('td', { class: 'mono', text: person.id }),
        el('td', { text: person.name }),
        el('td', {}, [roleSelect]),
        el('td', {}, [person.disabled ? badge('bad', 'disabled') : badge('good', 'active')]),
        el('td', { text: `${activeKeys} active${person.keys.length > activeKeys ? `, ${person.keys.length - activeKeys} old` : ''}` }),
        el('td', { class: 'muted', text: `${formatDateTime(person.createdAt)} · by ${person.createdBy}` }),
        el('td', {}, [
          el('div', { class: 'row' }, [
            el('button', {
              class: 'secondary',
              type: 'button',
              text: selectedUser === person.id ? 'Hide keys' : 'Keys',
              onClick: () => {
                selectedUser = selectedUser === person.id ? '' : person.id;
                renderPeople();
                renderDetail();
              },
            }),
            el('button', {
              class: 'secondary',
              type: 'button',
              text: person.disabled ? 'Enable' : 'Disable',
              onClick: async () => {
                if (!person.disabled && !window.confirm(`Disable ${person.id}? Their sessions end at once.`)) return;
                if (await change('PATCH', `/v1/team/users/${encodeURIComponent(person.id)}`, { disabled: !person.disabled })) await loadPeople();
              },
            }),
            el('button', {
              class: 'secondary',
              type: 'button',
              text: 'Delete',
              onClick: async () => {
                if (!window.confirm(`Delete ${person.id} and all their keys? This cannot be undone.`)) return;
                if (await change('DELETE', `/v1/team/users/${encodeURIComponent(person.id)}`)) {
                  if (selectedUser === person.id) selectedUser = '';
                  await loadPeople();
                }
              },
            }),
          ]),
        ]),
      ]),
    );
  }
  const admins = people.filter((person) => person.role === 'admin' && !person.disabled).length;
  byId('team-summary').textContent =
    people.length === 0
      ? 'No personal users yet: the installation key in .env acts as "root" (an admin) and is the only way in. Add the first person below.'
      : `${people.length} person(s), ${admins} active admin(s). The installation key in .env also acts as "root" and cannot be locked out.`;
}

async function loadPeople() {
  people = (await apiFetch('/v1/team/users')).users;
  renderPeople();
  renderDetail();
}

byId('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await change('POST', '/v1/team/users', { id: byId('add-id').value.trim(), name: byId('add-name').value.trim(), role: byId('add-role').value });
  if (!result) return;
  byId('add-id').value = '';
  byId('add-name').value = '';
  showNewKey(result.user.id, result.key);
  await loadPeople();
});

// ---- audit

function auditDetails(entry) {
  const parts = [];
  for (const [key, value] of Object.entries(entry.refs ?? {})) parts.push(`${key}=${value}`);
  for (const [key, value] of Object.entries(entry.detail ?? {})) parts.push(`${key}=${value}`);
  return parts.join(' ');
}

function statusBadge(status) {
  if (status === undefined) return el('span', { class: 'muted', text: '—' });
  return badge(status >= 500 ? 'bad' : status >= 400 ? 'warn' : 'good', String(status));
}

function auditQuery() {
  const params = new URLSearchParams({ limit: String(AUDIT_PAGE) });
  for (const [field, name] of [['audit-user', 'user'], ['audit-area', 'area'], ['audit-event', 'event']]) {
    const value = byId(field).value.trim();
    if (value) params.set(name, value);
  }
  if (auditBefore !== null) params.set('before', String(auditBefore));
  return params;
}

async function loadAudit(append) {
  if (!append) {
    auditBefore = null;
    auditShown = 0;
    byId('audit-rows').replaceChildren();
  }
  const data = await apiFetch(`/v1/audit?${auditQuery()}`);
  const tbody = byId('audit-rows');
  for (const entry of data.entries) {
    const who = entry.actor ? `${entry.actor.userId} (${entry.actor.role}, ${entry.actor.via})` : 'unknown';
    tbody.appendChild(
      el('tr', { class: 'static' }, [
        el('td', { class: 'mono', text: String(entry.seq) }),
        el('td', { text: formatDateTime(entry.at) }),
        el('td', { text: who }),
        el('td', { text: entry.event }),
        el('td', { class: 'mono', text: entry.method ? `${entry.method} ${entry.path ?? ''}` : '—' }),
        el('td', {}, [statusBadge(entry.status)]),
        el('td', { class: 'muted wrap mono', text: auditDetails(entry) }),
      ]),
    );
  }
  auditShown += data.entries.length;
  if (data.entries.length > 0) auditBefore = data.entries[data.entries.length - 1].seq;
  byId('audit-older').disabled = !data.hasMore;
  byId('audit-count').textContent = auditShown === 0 ? 'Nothing recorded with these filters.' : `${auditShown} shown, newest first${data.hasMore ? '' : ' (that is all)'}`;
}

async function verifyChain() {
  const box = byId('audit-verdict');
  box.replaceChildren();
  const result = await apiFetch('/v1/audit/verify');
  if (result.ok) {
    box.appendChild(
      el('p', { class: 'muted' }, [badge('good', 'chain intact'), ` ${result.entries} line(s), last #${result.lastSeq}. This finds an edited line or one removed from the middle; it cannot see lines cut off the end or a rewritten file.`]),
    );
    return;
  }
  box.appendChild(el('div', { class: 'danger-banner', text: `The chain is BROKEN (${result.problems.length} problem(s)): the log was edited or lines were removed.` }));
  box.appendChild(el('ul', { class: 'reasons' }, result.problems.map((problem) => el('li', { text: `${problem.seq === null ? 'a line' : `#${problem.seq}`}: ${problem.problem}` }))));
}

byId('audit-search').addEventListener('click', () => loadAudit(false).catch((error) => showError(error.message)));
byId('audit-older').addEventListener('click', () => loadAudit(true).catch((error) => showError(error.message)));
byId('audit-verify').addEventListener('click', () => verifyChain().catch((error) => showError(error.message)));

// ---- start

async function start() {
  const me = await apiFetch('/v1/auth/me');
  const who = me.user ?? { id: '?', role: '?' };
  byId('team-me').textContent = `Signed in as ${who.id} (${who.role}).`;
  if (who.role !== 'admin') {
    byId('team-banner').appendChild(el('div', { class: 'warn-banner', text: 'This screen is for admins: people, keys and the audit log are not shown to a viewer or a runner.' }));
    return;
  }
  byId('team-admin').classList.remove('hidden');
  await Promise.all([loadPeople(), loadAudit(false)]);
}

start().catch((error) => {
  byId('team-banner').appendChild(el('div', { class: 'danger-banner', text: error.message }));
});
