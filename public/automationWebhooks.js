import { apiFetch, el, formatDateTime } from './api.js';

// The webhooks half of the Automation screen. The URL of a webhook is a SECRET (anyone holding it can post as the channel): it is typed into a
// password input, sent once, and the input is cleared as soon as the server has answered "saved". No reply is read for it (the server returns only
// its origin), it is never put in the DOM from data, the URL, a log line or any storage.

const byId = (id) => document.getElementById(id);
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const PRESET_NAME = { generic: 'Generic JSON', slack: 'Slack', teams: 'Microsoft Teams', googlechat: 'Google Chat' };
/** Badge classes are fixed words from the stylesheet, never taken from the data. */
const DELIVERY_BADGE = { sent: 'badge passed', failed: 'badge failed', blocked: 'badge warn' };
const badge = (text, kind = 'badge neutral') => el('span', { class: kind, text });

export function setupWebhooks({ isAdmin, change, messages, onChanged }) {
  let views = [];
  let editing = '';

  // ---- the form

  function resetForm() {
    editing = '';
    byId('wh-url').value = '';
    for (const id of ['wh-id', 'wh-notes']) byId(id).value = '';
    byId('wh-id').readOnly = false;
    byId('wh-preset').value = 'generic';
    byId('wh-lang').value = 'en';
    byId('wh-ev-broken').checked = true;
    byId('wh-ev-recovered').checked = true;
    byId('wh-enabled').checked = true;
    byId('wh-summary-on').checked = false;
    byId('wh-summary-at').value = '08:00';
    byId('wh-summary-tz').value = 'America/Montevideo';
    byId('wh-url').required = true;
    byId('wh-form-title').textContent = 'Add a webhook';
    byId('wh-save').textContent = 'Save webhook';
    byId('wh-cancel').classList.add('hidden');
    byId('wh-url-help').textContent = 'The address the channel gave you. Its origin must be listed in ALLOWED_NOTIFY_ORIGINS on the server, or nothing is sent.';
  }

  function startEditing(view) {
    const { webhook } = view;
    messages.error('');
    messages.done('');
    resetForm();
    editing = webhook.id;
    byId('wh-id').value = webhook.id;
    byId('wh-id').readOnly = true;
    byId('wh-preset').value = webhook.preset;
    byId('wh-lang').value = webhook.lang;
    byId('wh-ev-broken').checked = webhook.events.includes('broken');
    byId('wh-ev-recovered').checked = webhook.events.includes('recovered');
    byId('wh-enabled').checked = webhook.enabled;
    byId('wh-summary-on').checked = webhook.dailySummary !== undefined;
    byId('wh-summary-at').value = webhook.dailySummary?.at ?? '08:00';
    byId('wh-summary-tz').value = webhook.dailySummary?.timezone ?? 'America/Montevideo';
    byId('wh-notes').value = webhook.notes ?? '';
    byId('wh-url').required = false;
    byId('wh-form-title').textContent = `Edit ${webhook.id}`;
    byId('wh-save').textContent = 'Save changes';
    byId('wh-cancel').classList.remove('hidden');
    byId('wh-url-help').textContent = `The stored address (${view.urlOrigin ?? 'none'}) is never shown. Leave this empty to keep it; type a new one to replace it.`;
    byId('wh-form-title').scrollIntoView({ block: 'start' });
  }

  /** The request body from the form, or `{ error }`. The body holds the URL: the caller must not keep it. */
  function buildBody() {
    const events = [byId('wh-ev-broken').checked && 'broken', byId('wh-ev-recovered').checked && 'recovered'].filter(Boolean);
    if (events.length === 0) return { error: 'Choose at least one thing it hears about: broken, recovered, or both.' };
    const body = { preset: byId('wh-preset').value, lang: byId('wh-lang').value, enabled: byId('wh-enabled').checked, events };
    const notes = byId('wh-notes').value.trim();
    if (notes) body.notes = notes;
    if (byId('wh-summary-on').checked) {
      const at = byId('wh-summary-at').value;
      const timezone = byId('wh-summary-tz').value.trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return { error: 'The daily summary needs a time of day (HH:MM).' };
      if (!timezone) return { error: 'The daily summary needs a time zone, e.g. America/Montevideo.' };
      body.dailySummary = { at, timezone };
    }
    const url = byId('wh-url').value.trim();
    if (!editing && !url) return { error: 'A new webhook needs its URL.' };
    if (url) {
      if (!/^https?:\/\//i.test(url)) return { error: 'The URL must start with https:// (or http:// for a local test receiver).' };
      body.url = url;
    }
    return { body };
  }

  byId('wh-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    messages.done('');
    const built = buildBody();
    if (built.error) {
      messages.error(built.error);
      return;
    }
    const id = editing || byId('wh-id').value.trim();
    if (!SAFE_NAME.test(id)) {
      messages.error('The id is letters, digits, _ and -, up to 64 characters.');
      return;
    }
    if (!editing && views.some((view) => view.webhook.id === id)) {
      messages.error(`A webhook called "${id}" already exists: use Edit in the list above.`);
      return;
    }
    const wasEditing = editing !== '';
    const replacesUrl = built.body.url !== undefined;
    const result = await change('PUT', `/v1/webhooks/${encodeURIComponent(id)}`, built.body);
    if (result === undefined) return; // refused: the reason is shown and what was typed stays, so it can be corrected

    // The URL leaves the page now.
    resetForm();
    messages.done(wasEditing ? `Saved ${id}.${replacesUrl ? ' The address was replaced.' : ' The stored address was kept.'}` : `Saved ${id}. Its address is now write-only: it cannot be shown again.`);
    await onChanged();
  });
  byId('wh-cancel').addEventListener('click', () => {
    messages.error('');
    messages.done('');
    resetForm();
  });
  byId('wh-show').addEventListener('change', () => {
    byId('wh-url').type = byId('wh-show').checked ? 'text' : 'password';
  });
  window.addEventListener('pagehide', () => {
    byId('wh-url').value = '';
  });

  // ---- the list

  function deliveryCell(view) {
    const last = view.lastDelivery;
    if (!last) return [el('span', { class: 'muted', text: 'none yet' })];
    return [badge(last.status, DELIVERY_BADGE[last.status] ?? 'badge neutral'), el('div', { class: 'muted', text: `${last.kind} · ${formatDateTime(last.at)}` }), last.reason ? el('div', { class: 'muted wrap', text: last.reason }) : null];
  }

  function actionsOf(view) {
    if (!isAdmin) return [];
    const { webhook } = view;
    return [
      el('div', { class: 'cell-actions' }, [
        el('button', { class: 'secondary', type: 'button', text: 'Edit', onClick: () => startEditing(view) }),
        el('button', {
          class: 'secondary',
          type: 'button',
          text: 'Send a test',
          onClick: async () => {
            if (!window.confirm(`Send a test message to "${webhook.id}"? It leaves the server and appears in the channel.`)) return;
            if ((await change('POST', `/v1/webhooks/${encodeURIComponent(webhook.id)}/test`)) === undefined) return;
            messages.done(`Sent a test message to ${webhook.id}.`);
            await onChanged();
          },
        }),
        el('button', {
          class: 'secondary',
          type: 'button',
          text: 'Delete',
          onClick: async () => {
            const used = view.schedules.length > 0 ? ` It is used by ${view.schedules.join(', ')}: the server refuses until they stop telling it.` : '';
            if (!window.confirm(`Delete the webhook "${webhook.id}"? Its stored address is removed too.${used}`)) return;
            if ((await change('DELETE', `/v1/webhooks/${encodeURIComponent(webhook.id)}`)) === undefined) return;
            if (editing === webhook.id) resetForm();
            messages.done(`Deleted ${webhook.id}.`);
            await onChanged();
          },
        }),
      ]),
    ];
  }

  function render() {
    const tbody = byId('wh-rows');
    tbody.replaceChildren();
    for (const view of views) {
      const { webhook } = view;
      const sends = [...webhook.events, webhook.dailySummary ? `daily summary ${webhook.dailySummary.at}` : null].filter(Boolean).join(', ');
      tbody.appendChild(
        el('tr', { class: 'static' }, [
          // The buttons live under the id, not in a column of their own: a table this wide pushes a last column off the screen.
          el('td', { class: 'wrap' }, [el('div', { class: 'mono', text: webhook.id }), webhook.notes ? el('div', { class: 'muted wrap', text: webhook.notes }) : null, webhook.enabled ? null : badge('disabled'), ...actionsOf(view)]),
          el('td', { class: 'wrap' }, [el('div', { text: `${PRESET_NAME[webhook.preset] ?? webhook.preset} · ${webhook.lang}` }), el('div', { class: 'muted', text: sends })]),
          el('td', { class: 'wrap' }, [
            el('div', { class: 'mono', text: view.urlOrigin ?? 'no address' }),
            view.hasUrl && !view.originAllowed ? badge('origin not allowed: nothing is sent', 'badge failed') : null,
          ]),
          el('td', { class: 'muted wrap', text: view.schedules.length > 0 ? view.schedules.join(', ') : 'no schedule' }),
          el('td', { class: 'wrap' }, deliveryCell(view)),
        ]),
      );
    }
    byId('wh-summary').textContent =
      views.length === 0
        ? isAdmin
          ? 'No webhook yet. Add the first one below.'
          : 'No webhook yet. An admin can add one.'
        : `${views.length} webhook(s). Only the origin of each address is shown: the address itself is write-only.`;
  }

  async function load() {
    views = (await apiFetch('/v1/webhooks')).webhooks;
    render();
  }

  resetForm();
  return { load, ids: () => views.map((view) => view.webhook.id) };
}
