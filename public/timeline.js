import { apiFetch, el, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const KIND_LABEL = {
  'screen-added': 'screen added',
  'screen-removed': 'screen removed',
  added: 'added',
  removed: 'removed',
  changed: 'changed',
};

/** Badge classes are fixed words from the stylesheet, never taken from the data. */
function kindBadge(kind) {
  const label = KIND_LABEL[kind] ?? 'change';
  if (kind === 'added' || kind === 'screen-added') return el('span', { class: 'badge passed', text: label });
  if (kind === 'removed' || kind === 'screen-removed') return el('span', { class: 'badge failed', text: label });
  if (kind === 'changed') return el('span', { class: 'badge warn', text: label });
  return el('span', { class: 'badge neutral', text: label });
}

const byId = (id) => document.getElementById(id);

/** The events grouped by the build that introduced them, newest build first (the API answers oldest first). */
export function groupByBuild(events) {
  const groups = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (last && last.buildId === event.buildId && last.createdAt === event.createdAt) last.events.push(event);
    else groups.push({ buildId: event.buildId, createdAt: event.createdAt, events: [event] });
  }
  return groups.reverse();
}

function buildsBlock(answer) {
  if (answer.builds.length === 0) return el('div', { class: 'card' }, [el('h2', { text: 'Snapshots' }), el('p', { class: 'muted', text: 'No snapshot of this target yet. A person or CI takes them (scrapforai evolution snapshot).' })]);
  const rows = [...answer.builds].reverse().map((build) =>
    el('tr', { class: 'static' }, [
      el('td', { class: 'mono', text: build.buildId }),
      el('td', { text: formatDateTime(build.createdAt) }),
      el('td', {}, [el('span', { class: build.complete ? 'badge passed' : 'badge warn', text: build.complete ? 'complete' : 'partial' })]),
    ]),
  );
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Snapshots' }),
    el('p', { class: 'muted', text: `${answer.snapshots} snapshot(s), newest first. A partial snapshot could not capture every screen; a screen it lacks is never read as removed.` }),
    el('div', { class: 'table-wrap' }, [
      el('table', {}, [el('thead', {}, [el('tr', {}, ['Build', 'Taken', 'State'].map((label) => el('th', { text: label })))]), el('tbody', {}, rows)]),
    ]),
  ]);
}

function controlBlock(answer) {
  const control = answer.control;
  if (!control) return null;
  const lines = [];
  if (!control.firstSeenIn) {
    lines.push('This control was never seen in any snapshot with these filters.');
  } else {
    const first = control.firstSeenIn;
    lines.push(`First seen in build ${first.buildId} (${formatDateTime(first.createdAt)}).`);
    if (first.isFirstSnapshot) lines.push('That is the oldest snapshot, so when it really appeared is unknown: earlier history was not captured.');
    lines.push(control.presentInLatest ? `It is in the latest snapshot${control.screen ? `, on screen ${control.screen}` : ''}.` : 'It is not in the latest snapshot: it went away.');
  }
  return el('div', { class: 'card' }, [el('h2', { text: `Control ${control.key}` }), el('ul', { class: 'reasons' }, lines.map((line) => el('li', { text: line })))]);
}

function eventsBlock(answer) {
  if (answer.events.length === 0) {
    const text = answer.snapshots < 2 ? 'At least two snapshots are needed to compare builds.' : 'No change with these filters.';
    return el('div', { class: 'card' }, [el('h2', { text: 'Changes' }), el('p', { class: 'muted', text })]);
  }
  const cards = groupByBuild(answer.events).map((group) =>
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: `Build ${group.buildId}` }), el('span', { class: 'muted', text: formatDateTime(group.createdAt) })]),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['Change', 'Screen', 'What'].map((label) => el('th', { text: label })))]),
          el('tbody', {}, group.events.map((event) =>
            el('tr', { class: 'static' }, [
              el('td', {}, [kindBadge(event.kind)]),
              el('td', { text: event.screenName }),
              el('td', { class: 'wrap', text: event.text }),
            ]),
          )),
        ]),
      ]),
    ]),
  );
  if (answer.truncated) cards.push(el('p', { class: 'muted', text: 'More changes exist than are shown. Narrow the screen, the control or the date.' }));
  return el('div', {}, cards);
}

let targets = [];

function fillScreens() {
  const target = targets.find((item) => item.id === byId('timeline-target').value);
  const select = byId('timeline-screen');
  select.replaceChildren(el('option', { value: '', text: 'All screens' }), ...(target?.screens ?? []).map((screen) => el('option', { value: screen.id, text: screen.name })));
}

async function show() {
  const target = byId('timeline-target').value;
  const summary = byId('timeline-summary');
  if (!target) {
    summary.textContent = 'No target profile yet.';
    return;
  }
  const query = new URLSearchParams();
  for (const [name, id] of [['screen', 'timeline-screen'], ['key', 'timeline-key'], ['since', 'timeline-since']]) {
    const value = byId(id).value.trim();
    if (value) query.set(name, value);
  }
  summary.textContent = 'Loading…';
  try {
    const answer = await apiFetch(`/v1/evolution/${encodeURIComponent(target)}/timeline${query.size > 0 ? `?${query}` : ''}`);
    summary.textContent = `${answer.snapshots} snapshot(s), ${answer.events.length} change(s) shown.`;
    byId('timeline-builds').replaceChildren(buildsBlock(answer));
    const control = controlBlock(answer);
    byId('timeline-control').replaceChildren(...(control ? [control] : []));
    byId('timeline-events').replaceChildren(eventsBlock(answer));
  } catch (error) {
    summary.textContent = `Could not load the evolution of ${target}: ${error.message}`;
    for (const id of ['timeline-builds', 'timeline-control', 'timeline-events']) byId(id).replaceChildren();
  }
}

async function load() {
  targets = (await apiFetch('/v1/targets')).targets;
  const select = byId('timeline-target');
  select.replaceChildren(...targets.map((item) => el('option', { value: item.id, text: item.name ? `${item.name} (${item.id})` : item.id })));
  const wanted = new URLSearchParams(window.location.search).get('target');
  if (wanted && targets.some((item) => item.id === wanted)) select.value = wanted;
  fillScreens();
  select.addEventListener('change', () => {
    fillScreens();
    show();
  });
  byId('timeline-form').addEventListener('submit', (event) => {
    event.preventDefault();
    show();
  });
  await show();
}

load().catch((error) => {
  byId('timeline-summary').textContent = `Could not load the evolution screen: ${error.message}`;
});
