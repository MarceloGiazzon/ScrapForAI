/**
 * T4.2 assisted discovery: the instructions an agent gets to PROPOSE a screen catalogue for a target profile. Pure text
 * building (no I/O), so it is unit-tested; the MCP server only fetches the profile and registers the prompt.
 *
 * The agent never saves the catalogue: a human reviews the proposal and applies it with `PUT /v1/targets/:id`, which needs
 * the bearer token the model does not have. That is the "a human approves" of the roadmap.
 */

export interface CatalogPromptProfile {
  id: string;
  name?: string;
  environment?: string;
  platform?: string;
  baseUrl?: string;
  credentialSets?: string[];
  loginRoutine?: string;
  screens?: Array<{ id: string; name: string; reach: { url: string } | { routineId: string }; credentialSet?: string; offeredTo?: string[] }>;
}

export function buildCatalogPrompt(targetProfile: string, profile: CatalogPromptProfile | undefined, focus?: string): string {
  const lines: string[] = [];
  lines.push(`Propose the screen catalogue of target profile "${targetProfile}". You PROPOSE; a human approves and saves it. Do not try to save it.`);
  lines.push('');

  if (profile) {
    lines.push('What the server knows about the profile:');
    lines.push(`- ${profile.name ?? profile.id}${profile.environment ? ` (${profile.environment})` : ''}${profile.platform ? `, platform ${profile.platform}` : ''}`);
    if (profile.baseUrl) lines.push(`- baseUrl: ${profile.baseUrl}`);
    lines.push(`- credential sets (roles): ${profile.credentialSets?.length ? profile.credentialSets.join(', ') : 'none (the app is explored anonymously)'}`);
    lines.push(`- loginRoutine: ${profile.loginRoutine ?? 'none'}`);
    const known = profile.screens ?? [];
    if (known.length > 0) {
      lines.push(`- already in the catalogue (${known.length}), keep them as they are and only add what is missing:`);
      for (const screen of known.slice(0, 100)) {
        lines.push(`    ${screen.id}: ${screen.name} -> ${'url' in screen.reach ? screen.reach.url : `routine ${screen.reach.routineId}`}${screen.credentialSet ? ` [as ${screen.credentialSet}]` : ''}`);
      }
      if (known.length > 100) lines.push(`    ... and ${known.length - 100} more`);
    } else {
      lines.push('- the catalogue is empty');
    }
  } else {
    lines.push(`Target profile "${targetProfile}" was not found: call list_targets first and use one of its ids.`);
  }

  if (focus) {
    lines.push('');
    lines.push(`Focus (from the person who asked): ${focus}`);
  }

  lines.push(
    '',
    'How to discover (READ ONLY: look, never click, never fill, never submit):',
    '1. inspect_dom on the baseUrl: the menu, the links and the page structure. For a page behind a login, use run_exploration with the',
    '   profile\'s credentialSet and an "include" of its loginRoutine, then goto the page and a `captureInventory` step: its `actions` are the',
    '   links and buttons (the menu) WITHOUT any data. Do this once per role you want to describe.',
    '2. Follow the menu entries you saw, one by one, with inspect_dom or `captureInventory`, to confirm each page opens and to learn its title.',
    '   Skip anything that changes state or ends the session (delete, logout, approve, pay, import, reset).',
    '3. Only list screens you actually saw. Do not guess URLs from naming patterns.',
    '',
    'What to propose: a JSON array for the profile\'s `screens`, each item exactly:',
    '  { "id": "customers", "name": "Customers", "reach": { "url": "/customers" }, "credentialSet": "<role>", "offeredTo": ["<role>", ...] }',
    '- id: [a-zA-Z0-9_-], at most 52 characters, unique, stable (it names files in the evolution history, so do not rename later).',
    '- reach: { "url": "/path" } (relative to baseUrl, or absolute inside the server allowlist) when the page opens by URL; { "routineId": "..." }',
    '  only when it can be reached just by running a saved routine (it must exist: list_routines).',
    '- credentialSet: the role the page was read with, when it is not the profile\'s first one.',
    '- offeredTo: the roles whose MENU showed this entry. Include it ONLY if you looked at the menu of each role; leaving it out makes no claim',
    '  (a wrong list makes the permission matrix report false alerts, a missing one just checks less).',
    '- Pages with a dynamic part in the URL (ids, dates) are not catalogue screens; pick one stable representative or leave it out and say so.',
    '',
    'Answer with: (1) the JSON array, ready to paste; (2) a short list of what you could NOT reach or were unsure about and why;',
    `(3) the one-line way to apply it: a person with the API key sends PUT /v1/targets/${targetProfile} with the profile plus this "screens" array.`,
  );

  return lines.join('\n');
}
