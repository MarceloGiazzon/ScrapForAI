import { apiFetch } from './api.js';

// The admin key for CHANGES (Team, Credentials). Reads go with the session; every change needs an admin's API key as a Bearer token (a session
// alone is refused by the server), typed on the page and held in this module's variables only: not in storage, not in the DOM after it is typed,
// forgotten after IDLE_MS, on a rejected key and on leaving the page.
//
// The page must have: a form `#key-form` with the input `#admin-key` and a submit button, a button `#key-forget`, and a text `#key-state`.

const IDLE_MS = 5 * 60 * 1000;

/**
 * Wires the key form of the page. `showError(message)` is where a refusal is shown (an empty message clears it).
 * Returns `change(method, pathname, body?)`: one change with the key. It answers the parsed reply (`null` for an empty one, e.g. a 204)
 * or `undefined` after showing why it could not be done, so test for `!== undefined`, not for truthiness.
 */
export function setupAdminKey({ showError }) {
  let adminKey = '';
  let forgetTimer;

  const byId = (id) => document.getElementById(id);

  function setKeyState() {
    const has = adminKey !== '';
    byId('key-state').textContent = has ? 'Key in memory: changes are enabled for a few minutes.' : 'No key: this screen only reads.';
    byId('key-forget').classList.toggle('hidden', !has);
  }

  function forgetKey() {
    adminKey = '';
    clearTimeout(forgetTimer);
    setKeyState();
  }

  function touchKey() {
    clearTimeout(forgetTimer);
    forgetTimer = setTimeout(forgetKey, IDLE_MS);
  }

  byId('key-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = byId('admin-key');
    adminKey = input.value.trim();
    input.value = '';
    if (adminKey) touchKey();
    setKeyState();
  });
  byId('key-forget').addEventListener('click', forgetKey);
  window.addEventListener('pagehide', forgetKey);
  setKeyState();

  /** One change: needs the key; a rejected key is forgotten so a wrong one is not retried silently. */
  async function change(method, pathname, body) {
    showError('');
    if (!adminKey) {
      showError('Type an admin API key above first: changes are never made with the session alone.');
      return undefined;
    }
    touchKey();
    try {
      return await apiFetch(pathname, { method, bearer: adminKey, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      // A key the server does not recognise is ignored, and the session behind it is then refused as "not a key" (403 BearerTokenRequired);
      // a key of a lower role is refused as such. Either way it is forgotten, so it is not retried by accident.
      if (error.status === 401 || error.type === 'BearerTokenRequired' || error.type === 'InsufficientRole') forgetKey();
      const details = (error.details ?? []).map((detail) => `${detail.path}: ${detail.message}`);
      const message = error.type === 'BearerTokenRequired' ? 'That key was not accepted. Type a valid admin API key.' : error.message;
      showError([message, ...details].join(' — '));
      return undefined;
    }
  }

  return { change };
}
