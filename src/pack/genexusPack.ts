import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZip, type ZipEntry } from '../evidence/zip.js';

/**
 * T10.2 GeneXus pack: the templates (target profiles, routines), the guides and the agent skill, as something a company can install in minutes.
 *
 * Templates are plain JSON with `REPLACE_*` placeholders. `planPack` fills them from an answers file and checks the result BEFORE anything is sent:
 * a placeholder left over, a value that makes an invalid profile or routine, an unknown template. Nothing is sent unless every selected item
 * is complete (all or nothing: a half-installed pack, a profile that names a login routine that was never saved, is worse than none).
 * Pure apart from reading the template folder; the script (`scripts/genexus-pack.ts`) does the HTTP.
 */

/**
 * Where the templates are: `<root>/templates`, two folders up from this module in a checkout (src/pack) and in a release (dist/pack, with the
 * templates copied next to dist). Resolved from the module, never from the working directory.
 */
export const packRoot = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const packTemplatesDir = (): string => path.join(packRoot(), 'templates');

export const PLACEHOLDER = /REPLACE_[A-Z0-9_]+/g;
const TARGET_SUFFIX = '.target.json';
const ROUTINE_SUFFIX = '.routine.json';
const ROUTINE_PREFIX = 'gx-';
export const LOGIN_ROUTINE_ID = 'login';

export type PackJson = null | boolean | number | string | PackJson[] | { [key: string]: PackJson };

export interface PackTemplate {
  kind: 'target' | 'routine';
  /** Name of the template: `genexus-dev` for a target; the routine id for a routine (`gx-work-with-search.routine.json` -> `work-with-search`). */
  name: string;
  file: string;
  body: { [key: string]: PackJson };
}

export interface PackAnswers {
  /** `REPLACE_X` -> value. `REPLACE_TARGET_PROFILE` defaults to `target.id`. */
  values: Record<string, string>;
  /**
   * Values that differ per routine, over `values`: `REPLACE_PAGE_URL` is the page under test in one routine, the insert form in another and the
   * form with the prompt in a third. Key = routine id (`transaction-insert`).
   */
  routineValues?: Record<string, Record<string, string>>;
  /** Which target profile template to install, and under which id. */
  target: { template: string; id: string };
  /** Routine ids to install (`login`, `smoke-page`, `work-with-search`, ...). `login` is always installed first. */
  routines: string[];
}

export interface PlannedItem {
  kind: 'target' | 'routine';
  id: string;
  /** `PUT` this path with `body`. */
  path: string;
  body: { [key: string]: PackJson };
  template: string;
}

export interface PackPlan {
  items: PlannedItem[];
  /** Why nothing may be sent. Empty = the plan is complete. */
  problems: string[];
}

export function placeholdersIn(value: PackJson): string[] {
  return [...new Set(JSON.stringify(value).match(PLACEHOLDER) ?? [])].sort();
}

/** Replaces placeholders inside the STRING values of parsed JSON (so a value with a quote or a backslash cannot break the document). */
export function fillJson(value: PackJson, values: Record<string, string>, missing: Set<string>): PackJson {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (name) => {
      const found = values[name];
      if (found === undefined || found.trim() === '') {
        missing.add(name);
        return name;
      }
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillJson(item, values, missing));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillJson(item, values, missing)]));
  }
  return value;
}

export async function loadTemplates(templatesDir: string): Promise<PackTemplate[]> {
  const found: PackTemplate[] = [];
  const read = async (folder: string, suffix: string, kind: PackTemplate['kind'], keep: (file: string) => boolean, nameOf: (file: string) => string): Promise<void> => {
    let files: string[];
    try {
      files = await fs.readdir(path.join(templatesDir, folder));
    } catch {
      return;
    }
    for (const file of files.filter((candidate) => candidate.endsWith(suffix) && keep(candidate)).sort()) {
      const body = JSON.parse(await fs.readFile(path.join(templatesDir, folder, file), 'utf8')) as { [key: string]: PackJson };
      found.push({ kind, name: nameOf(file), file: `${folder}/${file}`, body });
    }
  };
  await read('targets', TARGET_SUFFIX, 'target', () => true, (file) => file.slice(0, -TARGET_SUFFIX.length));
  // Only the GeneXus screen templates are installable by id; chaos- and concurrency- ones are adapted by hand (they need several decisions).
  await read('routines', ROUTINE_SUFFIX, 'routine', (file) => file.startsWith(ROUTINE_PREFIX), (file) => file.slice(ROUTINE_PREFIX.length, -ROUTINE_SUFFIX.length));
  return found;
}

export function parseAnswers(raw: unknown): { answers?: PackAnswers; problems: string[] } {
  const problems: string[] = [];
  const object = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!object) return { problems: ['the answers file must be a JSON object'] };

  const values: Record<string, string> = {};
  const rawValues = object.values;
  if (rawValues === null || typeof rawValues !== 'object' || Array.isArray(rawValues)) problems.push('"values" must be an object of REPLACE_X: "text"');
  else {
    for (const [key, value] of Object.entries(rawValues)) {
      if (!/^REPLACE_[A-Z0-9_]+$/.test(key)) problems.push(`"values.${key}": not a placeholder name (REPLACE_...)`);
      else if (typeof value !== 'string') problems.push(`"values.${key}" must be text`);
      else values[key] = value;
    }
  }

  const routineValues: Record<string, Record<string, string>> = {};
  const rawRoutineValues = object.routineValues;
  if (rawRoutineValues !== undefined) {
    if (rawRoutineValues === null || typeof rawRoutineValues !== 'object' || Array.isArray(rawRoutineValues)) problems.push('"routineValues" must be an object of routineId: { REPLACE_X: "text" }');
    else {
      for (const [routineId, group] of Object.entries(rawRoutineValues)) {
        if (group === null || typeof group !== 'object' || Array.isArray(group)) {
          problems.push(`"routineValues.${routineId}" must be an object of REPLACE_X: "text"`);
          continue;
        }
        routineValues[routineId] = {};
        for (const [key, value] of Object.entries(group)) {
          if (!/^REPLACE_[A-Z0-9_]+$/.test(key) || typeof value !== 'string') problems.push(`"routineValues.${routineId}.${key}": a placeholder name (REPLACE_...) with a text value is expected`);
          else routineValues[routineId]![key] = value;
        }
      }
    }
  }

  const target = object.target as { template?: unknown; id?: unknown } | undefined;
  if (!target || typeof target.template !== 'string' || typeof target.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(target.id)) {
    problems.push('"target" must be { "template": "genexus-dev", "id": "<profile id: letters, digits, _ and ->" }');
  }
  const routines = object.routines;
  if (!Array.isArray(routines) || routines.some((id) => typeof id !== 'string')) problems.push('"routines" must be a list of routine ids, e.g. ["login", "smoke-page"]');

  if (problems.length > 0) return { problems };
  return {
    answers: {
      values,
      ...(Object.keys(routineValues).length > 0 ? { routineValues } : {}),
      target: { template: String(target!.template), id: String(target!.id) },
      routines: [...new Set(routines as string[])],
    },
    problems,
  };
}

/** Fills and orders what was asked for. `validate` (optional) can add problems for an item that is complete but not valid (the script plugs the real schemas in). */
export function planPack(
  answers: PackAnswers,
  templates: PackTemplate[],
  validate?: (item: PlannedItem) => string[],
): PackPlan {
  const problems: string[] = [];
  const values = { REPLACE_TARGET_PROFILE: answers.target.id, ...answers.values };
  const items: PlannedItem[] = [];

  const targetTemplate = templates.find((template) => template.kind === 'target' && template.name === answers.target.template);
  if (!targetTemplate) {
    problems.push(`unknown target template "${answers.target.template}" (available: ${templates.filter((t) => t.kind === 'target').map((t) => t.name).join(', ') || 'none'})`);
  }

  const wanted = [...new Set([LOGIN_ROUTINE_ID, ...answers.routines])];
  const routineTemplates = new Map(templates.filter((t) => t.kind === 'routine').map((t) => [t.name, t]));
  for (const id of wanted) {
    if (!routineTemplates.has(id)) problems.push(`unknown routine template "${id}" (available: ${[...routineTemplates.keys()].join(', ') || 'none'})`);
  }

  for (const id of Object.keys(answers.routineValues ?? {})) {
    if (!wanted.includes(id)) problems.push(`routineValues for "${id}", which is not among the routines to install`);
  }

  const build = (template: PackTemplate, id: string): PlannedItem => {
    const missing = new Set<string>();
    const own = template.kind === 'routine' ? (answers.routineValues?.[id] ?? {}) : {};
    const body = fillJson(template.body, { ...values, ...own }, missing) as { [key: string]: PackJson };
    if (missing.size > 0) problems.push(`${template.file}: no value for ${[...missing].sort().join(', ')}`);
    return { kind: template.kind, id, path: template.kind === 'target' ? `/v1/targets/${id}` : `/v1/routines/${id}`, body, template: template.file };
  };

  // The profile first: saving a routine is refused (400 TargetProfileNotFound) while its profile does not exist. Then the login the profile names,
  // then the screens that include it.
  const ordered: Array<[PackTemplate, string]> = [];
  const login = routineTemplates.get(LOGIN_ROUTINE_ID);
  if (targetTemplate) ordered.push([targetTemplate, answers.target.id]);
  if (login) ordered.push([login, LOGIN_ROUTINE_ID]);
  for (const id of wanted.filter((candidate) => candidate !== LOGIN_ROUTINE_ID)) {
    const template = routineTemplates.get(id);
    if (template) ordered.push([template, id]);
  }
  for (const [template, id] of ordered) items.push(build(template, id));

  if (problems.length === 0 && validate) for (const item of items) problems.push(...validate(item).map((problem) => `${item.template}: ${problem}`));
  return { items, problems };
}

export interface PackFile {
  /** Path inside the zip. */
  name: string;
  data: Buffer;
}

/** The files of the pack, read from the repository: templates, guides, the agent skill. */
export async function collectPackFiles(root: string): Promise<PackFile[]> {
  const files: PackFile[] = [];
  const add = async (relative: string, as = relative): Promise<void> => {
    files.push({ name: as.replace(/\\/g, '/'), data: await fs.readFile(path.join(root, relative)) });
  };
  const addDir = async (relative: string, keep: (file: string) => boolean = () => true): Promise<void> => {
    for (const file of (await fs.readdir(path.join(root, relative))).sort()) if (keep(file)) await add(path.join(relative, file));
  };

  await addDir('templates/targets');
  await addDir('templates/routines');
  await add('templates/genexus-pack.answers.example.json', 'answers.example.json');
  await addDir('docs/genexus-pack');
  await add('docs/genexus-routine-conventions.md');
  await add('docs/a11y-platform-mapping.md');
  await add('.claude/skills/scrapforai/SKILL.md', 'skill/scrapforai/SKILL.md');
  return files;
}

export function buildPackZip(files: PackFile[], version: string, when = new Date()): Buffer {
  const manifest = files
    .map((file) => `${crypto.createHash('sha256').update(file.data).digest('hex')}  ${file.name}`)
    .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
    .join('\n');
  const info = `ScrapForAI GeneXus pack ${version}\nBuilt ${when.toISOString()}\n\nStart with docs/genexus-pack/README.es.md or README.pt.md.\nMANIFEST.sha256 lists the sha256 of every other file.\n`;
  const entries: ZipEntry[] = [
    { name: 'PACK-INFO.txt', data: Buffer.from(info, 'utf8') },
    { name: 'MANIFEST.sha256', data: Buffer.from(`${manifest}\n`, 'utf8') },
    ...files.map((file) => ({ name: file.name, data: file.data })),
  ];
  return createZip(entries, when);
}
