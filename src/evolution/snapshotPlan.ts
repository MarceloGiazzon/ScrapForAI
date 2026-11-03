import { createHash } from 'node:crypto';

import type { ExplorationStep } from '../schemas/explorationRequest.schema.js';
import type { Screen, TargetProfile } from '../schemas/targetProfile.schema.js';

/**
 * T4.4, the pure half: which catalogue screens are read in which browser sessions. No I/O, unit-tested without a browser.
 *
 * A session is one login (as one credential set) followed by several screens, so a catalogue of 40 screens is not 40
 * logins. A screen reachable only by a routine is its own session (the routine's step count is not known here).
 */

export class SnapshotPlanError extends Error {}

export interface PlannedScreenSession {
  /** Credential set the session logs in with; undefined = anonymous (the profile has none). */
  credentialSet?: string;
  screens: Screen[];
  steps: ExplorationStep[];
}

export interface PlanLimits {
  maxStepsPerJob: number;
  jobTimeoutMs: number;
  stepTimeoutMs: number;
}

export const LOGIN_STEP_ID = 'login';

/** Name under which a screen's structure is stored in `result.extracted`: neutral, so the redactor never masks the whole value. */
export const inventoryName = (screenId: string): string => `inv_${createHash('sha256').update(screenId).digest('hex').slice(0, 12)}`;
export const screenshotName = (screenId: string): string => `screen-${screenId}`;
const stepIdFor = (screenId: string, what: string): string => `snap-${screenId}-${what}`;

export function resolveUrl(url: string, baseUrl: string): string {
  return url.startsWith('/') ? new URL(url, baseUrl).toString() : url;
}

export function screensToCapture(profile: Pick<TargetProfile, 'id' | 'screens'>, only?: string[]): Screen[] {
  if (profile.screens.length === 0) {
    throw new SnapshotPlanError(`target profile "${profile.id}" has no screens (add a catalogue to its "screens")`);
  }
  if (!only) return profile.screens;
  const known = new Set(profile.screens.map((screen) => screen.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new SnapshotPlanError(`screen(s) not in the catalogue of "${profile.id}": ${unknown.join(', ')}`);
  }
  const wanted = new Set(only);
  return profile.screens.filter((screen) => wanted.has(screen.id));
}

/** Steps that read one screen: open it (or run the routine that reaches it), let it settle, capture, screenshot. */
export function screenSteps(screen: Screen, options: { baseUrl: string; settleMs: number; screenshots: boolean }): ExplorationStep[] {
  const open: ExplorationStep =
    'url' in screen.reach
      ? { id: stepIdFor(screen.id, 'open'), action: 'goto', url: resolveUrl(screen.reach.url, options.baseUrl) }
      : { id: stepIdFor(screen.id, 'reach'), action: 'include', routineId: screen.reach.routineId, ...(screen.reach.version === undefined ? {} : { version: screen.reach.version }) };
  return [
    open,
    ...(options.settleMs > 0 ? [{ id: stepIdFor(screen.id, 'settle'), action: 'waitForTimeout' as const, timeoutMs: options.settleMs }] : []),
    { id: stepIdFor(screen.id, 'capture'), action: 'captureInventory', name: inventoryName(screen.id), includeHidden: true },
    ...(options.screenshots ? [{ id: stepIdFor(screen.id, 'shot'), action: 'screenshot' as const, name: screenshotName(screen.id) }] : []),
  ];
}

/** How many URL screens fit in one session: bounded by MAX_STEPS_PER_JOB and, roughly, by JOB_TIMEOUT_MS. */
export function screensPerSession(options: { loginStepCount: number; settleMs: number; screenshots: boolean; limits: PlanLimits }): number {
  const stepsPerScreen = 2 + (options.settleMs > 0 ? 1 : 0) + (options.screenshots ? 1 : 0);
  const bySteps = Math.floor((options.limits.maxStepsPerJob - options.loginStepCount) / stepsPerScreen);
  const perScreenMs = Math.min(options.settleMs, options.limits.stepTimeoutMs) + 6000;
  const byTime = Math.floor((options.limits.jobTimeoutMs - 20_000) / perScreenMs);
  return Math.max(1, Math.min(bySteps, byTime));
}

export function planSnapshotSessions(
  profile: Pick<TargetProfile, 'id' | 'baseUrl' | 'credentialSets' | 'loginRoutine' | 'screens'>,
  screens: Screen[],
  context: { loginStepCount: number; settleMs: number; screenshots: boolean; limits: PlanLimits },
): PlannedScreenSession[] {
  const defaultSet = profile.credentialSets[0];
  const byCredential = new Map<string | undefined, Screen[]>();
  for (const screen of screens) {
    const credentialSet = screen.credentialSet ?? defaultSet;
    if (credentialSet !== undefined && !profile.credentialSets.includes(credentialSet)) {
      throw new SnapshotPlanError(`screen "${screen.id}" uses credential set "${credentialSet}", which is not one of target profile "${profile.id}"`);
    }
    byCredential.set(credentialSet, [...(byCredential.get(credentialSet) ?? []), screen]);
  }

  const chunk = screensPerSession(context);
  const sessions: PlannedScreenSession[] = [];
  const common = { baseUrl: profile.baseUrl, settleMs: context.settleMs, screenshots: context.screenshots };

  for (const [credentialSet, group] of byCredential) {
    if (credentialSet !== undefined && !profile.loginRoutine) {
      throw new SnapshotPlanError(`target profile "${profile.id}" has credential sets but no loginRoutine: a snapshot needs one to log in`);
    }
    const login: ExplorationStep[] =
      credentialSet !== undefined ? [{ id: LOGIN_STEP_ID, action: 'include', routineId: profile.loginRoutine! }] : [];

    const direct = group.filter((screen) => 'url' in screen.reach);
    const viaRoutine = group.filter((screen) => !('url' in screen.reach));
    for (let start = 0; start < direct.length; start += chunk) {
      const batch = direct.slice(start, start + chunk);
      sessions.push({ ...(credentialSet !== undefined ? { credentialSet } : {}), screens: batch, steps: [...login, ...batch.flatMap((screen) => screenSteps(screen, common))] });
    }
    for (const screen of viaRoutine) {
      sessions.push({ ...(credentialSet !== undefined ? { credentialSet } : {}), screens: [screen], steps: [...login, ...screenSteps(screen, common)] });
    }
  }
  return sessions;
}

const FOLDER_UNSAFE = /[^A-Za-z0-9._-]+/g;
/** A build id as a folder name: anything outside [A-Za-z0-9._-] becomes `_`. */
export const folderSafe = (text: string): string => text.replace(FOLDER_UNSAFE, '_').replace(/^\.+/, '_').slice(0, 100) || '_';

/** `<AAAA-MM-DD>_<buildId>`; the date is the UTC date of the snapshot. */
export function snapshotFolderName(createdAt: string, buildId: string): string {
  return `${createdAt.slice(0, 10)}_${folderSafe(buildId)}`;
}

/** The build a folder name stands for (everything after `<AAAA-MM-DD>_`), or undefined when it is not a snapshot folder. */
export function buildOfFolder(name: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}_.+/.test(name) ? name.slice(11) : undefined;
}
