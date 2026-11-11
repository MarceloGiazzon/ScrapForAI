import { apiFetch, el } from './api.js';

// Changing a routine's status from the Health screen (quarantine, release, retire, draft, active). Kept apart from health.js, which only reads:
// the one write is POST /v1/routines/:id/status. A session of a runner or an admin may make it (a viewer sees no button), exactly as they could
// already save the routine again; the server stores the SAME steps as the next version, puts the person and the reason in the audit log, and
// answers which routines include a routine that was just retired. No inline style or handler: the CSP forbids them.

const STATUS_HELP = {
  active: 'Runs everywhere and counts in verdicts, schedules and the vault.',
  quarantined: 'Still runs, but is reported apart and is not in the verdict, the exit code or a target\'s colour.',
  draft: 'Not run by suites. For a routine still being written.',
  retired: 'Not run, and no other routine can include it any more.',
};
const STATUS_ORDER = ['active', 'quarantined', 'draft', 'retired'];
// What the flakiness analysis proposes (T3.5) and the status that would carry it out. Only a proposal: nothing is applied until the person presses Apply.
const SUGGESTED_STATUS = { quarantine: 'quarantined', release: 'active' };
const MAX_REASON = 300;

const byId = (id) => document.getElementById(id);

/** Whether this session may change a status: a runner or an admin. Anything that fails to answer is a viewer (no button). */
async function sessionMayChange() {
  try {
    const me = await apiFetch('/v1/auth/me');
    return me?.user?.role === 'runner' || me?.user?.role === 'admin';
  } catch {
    return false;
  }
}

/** Builds the editor once per page. `reload` re-reads the report after a change. `button(routine)` is the Status… button, or null for a viewer. */
export async function createStatusEditor(reload) {
  const canChange = await sessionMayChange();
  const dialog = byId('status-dialog');
  if (!canChange || !dialog) return { canChange: false, button: () => null };

  const select = byId('status-select');
  const reason = byId('status-reason');
  const error = byId('status-error');
  const apply = byId('status-apply');
  let current;

  function showHelp() {
    byId('status-help').textContent = STATUS_HELP[select.value] ?? '';
    apply.disabled = current === undefined || select.value === current.status;
  }

  function showError(message) {
    error.textContent = message;
    error.classList.toggle('hidden', !message);
  }

  function open(routine) {
    current = routine;
    const suggested = routine.suggestion ? SUGGESTED_STATUS[routine.suggestion.action] : undefined;
    byId('status-title').textContent = `Status of ${routine.id}`;
    byId('status-current').textContent = `Version ${routine.version} is ${routine.status}.${routine.suggestion ? ` The flakiness analysis suggests: ${routine.suggestion.action}.` : ''}`;
    select.replaceChildren(...STATUS_ORDER.map((status) => el('option', { value: status, text: status })));
    select.value = suggested && suggested !== routine.status ? suggested : STATUS_ORDER.find((status) => status !== routine.status);
    reason.value = suggested && suggested !== routine.status && routine.suggestion ? routine.suggestion.reason.slice(0, MAX_REASON) : '';
    showError('');
    showHelp();
    dialog.showModal();
    reason.focus();
  }

  function report(result) {
    const box = byId('status-message');
    const nodes = [];
    nodes.push(
      el('div', { class: 'card', text: result.changed ? `${result.routine.id} is now ${result.routine.status} (version ${result.routine.version}, was ${result.previousStatus}).` : `${result.routine.id} was already ${result.routine.status}: nothing changed.` }),
    );
    if (result.includedBy?.length) {
      nodes.push(el('div', { class: 'warn-banner', text: `Retired. These routines include it and will stop saving and running until they stop doing so: ${result.includedBy.map((item) => item.id).join(', ')}.` }));
    }
    box.replaceChildren(...nodes);
  }

  async function submit() {
    const text = reason.value.trim();
    if (text.length < 3) {
      showError('Say why, in a few words: it is kept in the audit log.');
      return;
    }
    apply.disabled = true;
    try {
      const result = await apiFetch(`/v1/routines/${encodeURIComponent(current.id)}/status`, { method: 'POST', body: JSON.stringify({ status: select.value, reason: text }) });
      dialog.close();
      report(result);
      await reload();
    } catch (failure) {
      showError(failure.message);
      showHelp();
    }
  }

  select.addEventListener('change', showHelp);
  apply.addEventListener('click', submit);
  byId('status-cancel').addEventListener('click', () => dialog.close());

  return {
    canChange: true,
    button: (routine) => el('button', { class: 'secondary', type: 'button', title: 'Quarantine, release, retire or park this routine: saves a new version with the same steps', text: 'Status…', onclick: () => open(routine) }),
  };
}
