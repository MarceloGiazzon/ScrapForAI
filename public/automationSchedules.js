import { apiFetch, el, formatDateTime } from './api.js';

// The schedules half of the Automation screen. Lists come with the session; every change goes through `change()` (the admin key, see adminKey.js).
// A schedule of kind `suite` cannot be edited with this form (a suite request is a document of its own): it is listed, and can be enabled,
// disabled, run or deleted, which resend the stored definition as it is.

const byId = (id) => document.getElementById(id);
const SAFE_NAME = /^[a-zA-Z0-9_-]{1,80}$/;

const KIND_GROUPS = {
  routine: 'sch-kind-routine',
  vault: 'sch-kind-vault',
  evolutionSnapshot: 'sch-kind-snapshot',
  summary: 'sch-kind-summary',
};
const CRON_PRESETS = {
  'sch-preset-nightly': '0 2 * * *',
  'sch-preset-weekdays': '0 8 * * MON-FRI',
  'sch-preset-hourly': '0 * * * *',
  'sch-preset-monday': '0 8 * * MON',
};
/** Badge classes are fixed words from the stylesheet, never taken from the data. */
const OUTCOME_BADGE = { passed: 'badge passed', failed: 'badge failed', error: 'badge failed', started: 'badge neutral' };
const badge = (text, kind = 'badge neutral') => el('span', { class: kind, text });

const splitList = (value) => value.split(/[\s,]+/).filter(Boolean);
const optional = (id) => {
  const value = byId(id).value.trim();
  return value === '' ? undefined : value;
};
/** An object without the members that are undefined or empty: an optional field left blank is not sent. */
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== ''));

export function setupSchedules({ isAdmin, change, messages, choices }) {
  let views = [];
  let schedulerRunning = true;
  let editing = '';
  let webhookIds = [];

  const fill = (selectId, values, blank) => {
    const select = byId(selectId);
    select.replaceChildren();
    if (blank !== undefined) select.appendChild(el('option', { value: '', text: blank }));
    for (const value of values) select.appendChild(el('option', { value, text: value }));
  };
  fill('sch-routine', choices.routines);
  fill('sch-credset', choices.credentialSets, 'None (the routine\'s own)');
  fill('sch-profileid', choices.targets, 'None (the routine\'s own)');
  fill('sch-snap-target', choices.targets);

  // ---- the form

  function showKind() {
    const kind = byId('sch-kind').value;
    for (const [name, group] of Object.entries(KIND_GROUPS)) byId(group).classList.toggle('hidden', name !== kind);
  }
  byId('sch-kind').addEventListener('change', showKind);
  for (const [button, cron] of Object.entries(CRON_PRESETS)) {
    byId(button).addEventListener('click', () => {
      byId('sch-cron').value = cron;
    });
  }

  /** The webhook checkboxes: the existing webhooks, plus any id the schedule being edited names that no longer exists (so saving does not drop it silently). */
  function renderNotify(selected) {
    const box = byId('sch-notify');
    box.replaceChildren();
    const all = [...new Set([...webhookIds, ...selected])];
    if (all.length === 0) {
      box.appendChild(el('span', { class: 'muted', text: 'No webhook yet: add one below, then come back to tell it about this schedule.' }));
      return;
    }
    for (const id of all) {
      const input = el('input', { type: 'checkbox', value: id });
      input.checked = selected.includes(id);
      box.appendChild(el('div', {}, [el('label', { class: 'inline-check' }, [input, webhookIds.includes(id) ? id : `${id} (no such webhook)`])]));
    }
  }
  const selectedNotify = () => [...byId('sch-notify').querySelectorAll('input[type=checkbox]')].filter((input) => input.checked).map((input) => input.value);

  function resetForm() {
    editing = '';
    for (const id of ['sch-id', 'sch-version', 'sch-build', 'sch-vault-tags', 'sch-vault-build', 'sch-snap-build', 'sch-sum-targets', 'sch-cron']) byId(id).value = '';
    byId('sch-id').readOnly = false;
    byId('sch-kind').value = 'routine';
    byId('sch-kind').disabled = false;
    for (const id of ['sch-credset', 'sch-profileid', 'sch-runprofile']) byId(id).value = '';
    byId('sch-tz').value = 'America/Montevideo';
    byId('sch-retries').value = '1';
    byId('sch-jitter').value = '0';
    byId('sch-enabled').checked = true;
    byId('sch-sum-days').value = '7';
    byId('sch-sum-lang').value = 'en';
    byId('sch-sum-file').checked = true;
    byId('sch-form-title').textContent = 'Add a schedule';
    byId('sch-save').textContent = 'Save schedule';
    byId('sch-cancel').classList.add('hidden');
    renderNotify([]);
    showKind();
  }

  function startEditing(view) {
    const { schedule } = view;
    messages.error('');
    messages.done('');
    resetForm();
    editing = schedule.id;
    byId('sch-id').value = schedule.id;
    byId('sch-id').readOnly = true;
    const target = schedule.target;
    byId('sch-kind').value = target.kind;
    if (target.kind === 'routine') {
      byId('sch-routine').value = target.routineId;
      byId('sch-version').value = target.version === undefined ? '' : String(target.version);
      byId('sch-credset').value = target.credentialSet ?? '';
      byId('sch-profileid').value = target.targetProfile ?? '';
      byId('sch-runprofile').value = target.profile ?? '';
      byId('sch-build').value = target.buildId ?? '';
    } else if (target.kind === 'vault') {
      byId('sch-vault-tags').value = (target.tags ?? []).join(', ');
      byId('sch-vault-build').value = target.buildId ?? '';
    } else if (target.kind === 'evolutionSnapshot') {
      byId('sch-snap-target').value = target.targetProfile;
      byId('sch-snap-build').value = target.buildId ?? '';
    } else if (target.kind === 'summary') {
      byId('sch-sum-days').value = String(target.periodDays);
      byId('sch-sum-targets').value = (target.targets ?? []).join(', ');
      byId('sch-sum-lang').value = target.lang;
      byId('sch-sum-file').checked = target.file;
    }
    byId('sch-cron').value = schedule.cron;
    byId('sch-tz').value = schedule.timezone;
    byId('sch-retries').value = String(schedule.retries);
    byId('sch-jitter').value = String(schedule.jitterSeconds);
    byId('sch-enabled').checked = schedule.enabled;
    renderNotify(schedule.notify);
    byId('sch-form-title').textContent = `Edit ${schedule.id}`;
    byId('sch-save').textContent = 'Save changes';
    byId('sch-cancel').classList.remove('hidden');
    showKind();
    byId('sch-form-title').scrollIntoView({ block: 'start' });
  }

  /** The `target` of the request from the form, or `{ error }`. */
  function targetFromForm() {
    const kind = byId('sch-kind').value;
    if (kind === 'routine') {
      const routineId = byId('sch-routine').value;
      if (!routineId) return { error: 'Choose a routine of the library.' };
      const version = optional('sch-version');
      if (version !== undefined && !/^[1-9]\d*$/.test(version)) return { error: 'The version is a whole number from 1, or empty for the current one.' };
      return {
        target: compact({
          kind,
          routineId,
          version: version === undefined ? undefined : Number(version),
          credentialSet: optional('sch-credset'),
          targetProfile: optional('sch-profileid'),
          profile: optional('sch-runprofile'),
          buildId: optional('sch-build'),
        }),
      };
    }
    if (kind === 'vault') {
      const tags = splitList(byId('sch-vault-tags').value);
      return { target: compact({ kind, tags: tags.length > 0 ? tags : undefined, buildId: optional('sch-vault-build') }) };
    }
    if (kind === 'evolutionSnapshot') {
      const targetProfile = byId('sch-snap-target').value;
      if (!targetProfile) return { error: 'Choose the target profile to take the snapshot of.' };
      return { target: compact({ kind, targetProfile, buildId: optional('sch-snap-build') }) };
    }
    const days = Number(byId('sch-sum-days').value);
    if (!Number.isInteger(days) || days < 1 || days > 31) return { error: 'The summary covers a whole number of days from 1 to 31.' };
    const targets = splitList(byId('sch-sum-targets').value);
    if (targets.some((id) => !SAFE_NAME.test(id))) return { error: 'Target profile ids are letters, digits, _ and -.' };
    return { target: { kind: 'summary', periodDays: days, lang: byId('sch-sum-lang').value, file: byId('sch-sum-file').checked, ...(targets.length > 0 ? { targets } : {}) } };
  }

  function buildBody() {
    const cron = byId('sch-cron').value.trim();
    if (!cron) return { error: 'Give the schedule a cron expression, e.g. 0 2 * * * for every day at 02:00.' };
    const timezone = byId('sch-tz').value.trim();
    if (!timezone) return { error: 'Give a time zone, e.g. America/Montevideo.' };
    const jitter = Number(byId('sch-jitter').value);
    if (!Number.isInteger(jitter) || jitter < 0 || jitter > 600) return { error: 'The random delay is a whole number of seconds from 0 to 600.' };
    const built = targetFromForm();
    if (built.error) return built;
    return {
      body: {
        cron,
        timezone,
        enabled: byId('sch-enabled').checked,
        retries: Number(byId('sch-retries').value),
        jitterSeconds: jitter,
        notify: selectedNotify(),
        target: built.target,
      },
    };
  }

  byId('sch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    messages.done('');
    const built = buildBody();
    if (built.error) {
      messages.error(built.error);
      return;
    }
    const id = editing || byId('sch-id').value.trim();
    if (!SAFE_NAME.test(id)) {
      messages.error('The id is letters, digits, _ and -, up to 80 characters.');
      return;
    }
    if (!editing && views.some((view) => view.schedule.id === id)) {
      messages.error(`A schedule called "${id}" already exists: use Edit in the list above.`);
      return;
    }
    const wasEditing = editing !== '';
    if ((await change('PUT', `/v1/schedules/${encodeURIComponent(id)}`, built.body)) === undefined) return; // refused: the reason is shown and the form stays as it was
    resetForm();
    messages.done(wasEditing ? `Saved ${id}.` : `Saved ${id}.${schedulerRunning ? '' : ' The scheduler is not running on this server, so it will not fire until SCHEDULER_ENABLED=true.'}`);
    await load();
  });
  byId('sch-cancel').addEventListener('click', () => {
    messages.error('');
    messages.done('');
    resetForm();
  });

  // ---- the list

  function describe(target) {
    if (target.kind === 'routine') {
      const extra = [target.credentialSet && `as ${target.credentialSet}`, target.targetProfile && `on ${target.targetProfile}`, target.profile && target.profile].filter(Boolean).join(', ');
      return [el('div', { text: `Routine ${target.routineId} ${target.version === undefined ? '(current version)' : `v${target.version}`}` }), extra ? el('div', { class: 'muted', text: extra }) : null];
    }
    if (target.kind === 'vault') return [el('div', { text: 'Regression vault' }), el('div', { class: 'muted', text: target.tags ? `tags: ${target.tags.join(', ')}` : 'every active item' })];
    if (target.kind === 'evolutionSnapshot') return [el('div', { text: `Snapshot of ${target.targetProfile}` })];
    if (target.kind === 'summary') return [el('div', { text: `Summary of the last ${target.periodDays} day(s)` }), el('div', { class: 'muted', text: `${target.lang}${target.file ? ', also as a file' : ''}` })];
    return [el('div', { text: 'Suite' }), el('div', { class: 'muted', text: 'edit it with the API or the CLI' })];
  }

  function lastRunCell(view) {
    const last = view.lastRun;
    if (view.running) return [badge('running', 'badge neutral'), el('div', { class: 'muted', text: formatDateTime(view.running.startedAt) })];
    if (!last) return [el('span', { class: 'muted', text: 'never' })];
    return [
      badge(last.outcome, OUTCOME_BADGE[last.outcome] ?? 'badge warn'),
      last.passedOnRetry ? badge('passed on a new attempt', 'badge warn') : null,
      el('div', { class: 'muted', text: formatDateTime(last.firedAt ?? last.at) }),
    ];
  }

  function actionsOf(view) {
    if (!isAdmin) return [];
    const { schedule } = view;
    const buttons = [];
    if (schedule.target.kind !== 'suite') buttons.push(el('button', { class: 'secondary', type: 'button', text: 'Edit', onClick: () => startEditing(view) }));
    buttons.push(
      el('button', {
        class: 'secondary',
        type: 'button',
        text: schedule.enabled ? 'Disable' : 'Enable',
        onClick: async () => {
          const { id, ...definition } = schedule; // the id comes from the path; the definition is resent as stored
          if ((await change('PUT', `/v1/schedules/${encodeURIComponent(id)}`, { ...definition, enabled: !schedule.enabled })) === undefined) return;
          messages.done(`${id} is now ${schedule.enabled ? 'disabled' : 'enabled'}.`);
          await load();
        },
      }),
      el('button', {
        class: 'secondary',
        type: 'button',
        text: 'Run now',
        onClick: async () => {
          if (!window.confirm(`Run "${schedule.id}" now? It starts the same run the clock would, outside the clock.`)) return;
          if ((await change('POST', `/v1/schedules/${encodeURIComponent(schedule.id)}/run-now`)) === undefined) return;
          messages.done(`Started ${schedule.id}. Its outcome appears in the list when it finishes.`);
          await load();
        },
      }),
      el('button', {
        class: 'secondary',
        type: 'button',
        text: 'Delete',
        onClick: async () => {
          if (!window.confirm(`Delete the schedule "${schedule.id}"? Its history goes with it.`)) return;
          if ((await change('DELETE', `/v1/schedules/${encodeURIComponent(schedule.id)}`)) === undefined) return;
          if (editing === schedule.id) resetForm();
          messages.done(`Deleted ${schedule.id}.`);
          await load();
        },
      }),
    );
    return [el('div', { class: 'cell-actions' }, buttons)];
  }

  function render() {
    const tbody = byId('sch-rows');
    tbody.replaceChildren();
    for (const view of views) {
      const { schedule } = view;
      tbody.appendChild(
        el('tr', { class: 'static' }, [
          // The buttons live under the id, not in a column of their own: a table this wide pushes a last column off the screen.
          el('td', { class: 'wrap' }, [el('div', { class: 'mono', text: schedule.id }), badge(schedule.enabled ? 'enabled' : 'disabled', schedule.enabled ? 'badge passed' : 'badge neutral'), ...actionsOf(view)]),
          el('td', { class: 'wrap' }, describe(schedule.target)),
          el('td', { class: 'wrap' }, [el('div', { class: 'mono', text: schedule.cron }), el('div', { class: 'muted', text: schedule.timezone })]),
          el('td', { class: 'wrap' }, [el('div', { class: 'muted', text: `Next: ${view.next[0] ? formatDateTime(view.next[0]) : '—'}` }), ...lastRunCell(view)]),
          el('td', { class: 'muted wrap', text: schedule.notify.length > 0 ? schedule.notify.join(', ') : '—' }),
        ]),
      );
    }
    const text =
      views.length === 0 ? (isAdmin ? 'No schedule yet. Add the first one below.' : 'No schedule yet. An admin can add one.') : `${views.length} schedule(s).`;
    byId('sch-summary').textContent = schedulerRunning
      ? text
      : `${text} The scheduler is NOT running on this server (SCHEDULER_ENABLED is off): schedules are stored and listed, but nothing fires on its own.`;
  }

  async function load() {
    const data = await apiFetch('/v1/schedules');
    schedulerRunning = data.schedulerRunning;
    views = data.schedules;
    render();
  }

  resetForm();
  return {
    load,
    setWebhookChoices(ids) {
      const selected = selectedNotify();
      webhookIds = ids;
      renderNotify(selected);
    },
  };
}
