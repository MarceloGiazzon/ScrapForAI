import assert from 'node:assert/strict';
import test from 'node:test';

// T4.2: the assisted-discovery prompt is text built from the profile; it must tell the agent to propose (not save), to stay
// read-only, and to describe the shape the server will accept.

const { buildCatalogPrompt } = await import('../src/mcp/catalogPrompt.js');
const { screenSchema } = await import('../src/schemas/targetProfile.schema.js');

const profile = {
  id: 'app-dev',
  name: 'App',
  environment: 'dev',
  platform: 'genexus',
  baseUrl: 'https://dev.example.com',
  credentialSets: ['admin', 'viewer'],
  loginRoutine: 'login',
  screens: [{ id: 'home', name: 'Home', reach: { url: '/home' } }, { id: 'wizard', name: 'Wizard', reach: { routineId: 'open-wizard' }, credentialSet: 'admin' }],
};

test('the prompt carries what the server knows and the rules of the proposal', () => {
  const text = buildCatalogPrompt('app-dev', profile, 'the billing area');
  assert.match(text, /PROPOSE; a human approves and saves it/);
  assert.match(text, /baseUrl: https:\/\/dev\.example\.com/);
  assert.match(text, /credential sets \(roles\): admin, viewer/);
  assert.match(text, /loginRoutine: login/);
  assert.match(text, /already in the catalogue \(2\)/);
  assert.match(text, /home: Home -> \/home/);
  assert.match(text, /wizard: Wizard -> routine open-wizard \[as admin\]/);
  assert.match(text, /Focus \(from the person who asked\): the billing area/);
  assert.match(text, /READ ONLY: look, never click, never fill, never submit/);
  assert.match(text, /captureInventory/);
  assert.match(text, /Only list screens you actually saw/);
  assert.match(text, /PUT \/v1\/targets\/app-dev/);
});

test('the shape the prompt describes is one the server accepts (offeredTo, credentialSet, reach by url or routine)', () => {
  const example = { id: 'customers', name: 'Customers', reach: { url: '/customers' }, credentialSet: 'admin', offeredTo: ['admin', 'viewer'] };
  assert.ok(screenSchema.safeParse(example).success);
  assert.ok(screenSchema.safeParse({ id: 'wizard', name: 'Wizard', reach: { routineId: 'open-wizard' } }).success);
  assert.match(buildCatalogPrompt('app-dev', profile), /"id": "customers", "name": "Customers", "reach": \{ "url": "\/customers" \}/);
  assert.match(buildCatalogPrompt('app-dev', profile), /at most 52 characters/);
});

test('an empty catalogue, an anonymous app and an unknown profile are each said plainly', () => {
  const empty = buildCatalogPrompt('app-dev', { ...profile, screens: [], credentialSets: [], loginRoutine: undefined });
  assert.match(empty, /the catalogue is empty/);
  assert.match(empty, /none \(the app is explored anonymously\)/);
  assert.match(empty, /loginRoutine: none/);
  assert.doesNotMatch(empty, /Focus/);
  assert.match(buildCatalogPrompt('ghost', undefined), /was not found: call list_targets first/);
});

test('a very large existing catalogue is summarized, not dumped', () => {
  const screens = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, reach: { url: `/s${i}` } }));
  const text = buildCatalogPrompt('app-dev', { ...profile, screens });
  assert.match(text, /already in the catalogue \(300\)/);
  assert.match(text, /\.\.\. and 200 more/);
  assert.ok(!text.includes('s250:'));
});
