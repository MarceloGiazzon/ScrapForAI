import { setupAdminKey } from './adminKey.js';
import { apiFetch, el, logout, markActiveNav } from './api.js';
import { setupSchedules } from './automationSchedules.js';
import { setupWebhooks } from './automationWebhooks.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

// Automation screen: schedules and webhooks. Reading (lists, who is signed in, the choices of the forms) goes with the session. Every CHANGE needs an
// admin's API key (adminKey.js: memory only), because a schedule makes the server start browsers on its own and a webhook sends data out of it.
// A webhook URL is a secret: it lives in its input until the server has answered "saved" and is cleared at once; it is never copied into a variable
// that outlives the call, the DOM, the URL or any storage, and no reply is read for it (the server returns only the origin).

const byId = (id) => document.getElementById(id);

/** A pair of message boxes (`<prefix>-error`, `<prefix>-done`) for one form. */
function messenger(prefix) {
  return {
    error(message) {
      const box = byId(`${prefix}-error`);
      box.textContent = message;
      box.classList.toggle('hidden', !message);
      if (message) byId(`${prefix}-done`).classList.add('hidden');
    },
    done(message) {
      const box = byId(`${prefix}-done`);
      box.textContent = message;
      box.classList.toggle('hidden', !message);
    },
  };
}

const messages = { sch: messenger('sch'), wh: messenger('wh') };
let active = messages.sch; // the box the admin-key module writes to: the form that is making the change

const { change: rawChange } = setupAdminKey({ showError: (message) => active.error(message) });

/** `change()` for one of the two sections: refusals are shown in that section's own box. */
const changeFor = (section) => (method, pathname, body) => {
  active = messages[section];
  return rawChange(method, pathname, body);
};

async function lookups() {
  const [routines, targets, credentials] = await Promise.all([apiFetch('/v1/routines'), apiFetch('/v1/targets'), apiFetch('/v1/credentials')]);
  return {
    routines: routines.routines.map((routine) => routine.id).sort(),
    targets: targets.targets.map((target) => target.id).sort(),
    credentialSets: credentials.credentialSets.map((set) => set.id).filter((id) => !id.startsWith('webhook-') && !id.startsWith('integration-')).sort(),
  };
}

async function start() {
  const me = await apiFetch('/v1/auth/me');
  const who = me.user ?? { id: '?', role: '?' };
  const isAdmin = who.role === 'admin';
  byId('auto-me').textContent = `Signed in as ${who.id} (${who.role}).`;
  if (isAdmin) byId('auto-admin').classList.remove('hidden');
  else byId('auto-banner').appendChild(el('div', { class: 'warn-banner', text: 'Adding, changing and deleting schedules and webhooks is for admins. You can see what exists and what happened; the webhook addresses are never shown to anyone.' }));

  const choices = await lookups();
  const schedules = setupSchedules({ isAdmin, change: changeFor('sch'), messages: messages.sch, choices });
  const webhooks = setupWebhooks({
    isAdmin,
    change: changeFor('wh'),
    messages: messages.wh,
    // A schedule form lists the webhooks it can tell; a deleted or added webhook changes that list, and a deleted one changes what a schedule tells.
    onChanged: async () => {
      await webhooks.load();
      schedules.setWebhookChoices(webhooks.ids());
      await schedules.load();
    },
  });
  await webhooks.load();
  schedules.setWebhookChoices(webhooks.ids());
  await schedules.load();
}

start().catch((error) => {
  byId('auto-banner').appendChild(el('div', { class: 'danger-banner', text: error.message }));
});
