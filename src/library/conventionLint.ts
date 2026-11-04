import { DOC_TAG } from '../schemas/docStep.schema.js';
import type { ExplorationStep } from '../schemas/explorationRequest.schema.js';
import { isParallelStep, walkWithPath } from '../schemas/stepTree.js';

/**
 * T8.4: the authoring conventions (docs/genexus-routine-conventions.md) as code. PURE: no I/O, no configuration.
 *
 * Every finding has a RULE CODE, so a routine can suppress it on purpose with a written reason (`lintSuppress`), and a suppressed finding is still
 * listed (never silently dropped). Only `error` findings stop a save, and only the ones whose rule belongs to the profile's platform.
 *
 *   GX001 (error, genexus)   a login submit with no login gate after it
 *   GX002 (warning, genexus) a routine that logs in and has no teardown to log out (one active session per user)
 *   WT001 (warning)          a fixed waitForTimeout
 *   SEL001 (warning)         a positional selector (nth-child, nth-of-type, :first, :last, nth=), also in a step's doc.highlight
 *   DOC001 (warning)         a step carries `doc` but the routine is not tagged `doc`: `manual build` would not pick it up
 *   DOC002 (warning)         the routine is tagged `doc` but no step carries `doc`: its chapter would be empty
 *
 * Departure from the roadmap: SEL001 says "when a semantic selector exists"; the lint reads the routine, not the page, so it cannot know that. It
 * warns on every positional selector and the suggestion names what to look for.
 */

export type LintSeverity = 'error' | 'warning';

export interface ConventionFinding {
  rule: string;
  severity: LintSeverity;
  /** `steps.3` / `teardown.0` / `teardown`. */
  path: string;
  stepId?: string;
  message: string;
  suggestion?: string;
}

export interface SuppressedFinding extends ConventionFinding {
  reason: string;
}

export interface LintSuppression {
  rule: string;
  reason: string;
  /** Narrow the suppression to one step; without it the rule is suppressed for the whole routine. */
  stepId?: string;
}

export interface ConventionContext {
  platform: 'generic' | 'genexus' | 'npdev';
  /** The routine being linted is the profile's login routine and the profile has a `loginGate`: the gate is added after it. */
  gateProvidedByProfile?: boolean;
  /** The routine being linted IS the profile's login routine: its logout belongs to whoever includes it. */
  isLoginRoutine?: boolean;
  /** The profile's login routine, so an `include` of it counts as a login. */
  loginRoutineId?: string;
}

export interface ConventionLintResult {
  findings: ConventionFinding[];
  suppressed: SuppressedFinding[];
}

const POSITIONAL_SELECTOR = /:nth-(?:child|of-type|last-child|last-of-type)\s*\(|:(?:first|last)-(?:child|of-type)(?![-\w])|>>\s*nth=|(?:^|\s)nth=|:(?:first|last)(?![-\w])/i;
const SELECTOR_PROPERTIES = ['selector', 'scope', 'startSelector'] as const;

type Loose = Record<string, unknown> & { action: string; id?: string };

const typesCredential = (step: Loose): boolean => (step.action === 'fill' || step.action === 'selectOption') && typeof step.valueFromCredential === 'string';
const isSubmit = (step: Loose): boolean => step.action === 'click' || step.action === 'doubleClick' || step.action === 'press';
/** T6.4: the actor a step runs as. A routine without actors is all `main`, which is how the rules below behave exactly as before. */
const actorOf = (step: Loose): string => (typeof step.actor === 'string' ? step.actor : 'main');
const waitsForUrl = (condition: unknown): boolean => typeof condition === 'object' && condition !== null && 'urlContains' in condition;

/** Is this step itself a gate (it fails unless the URL is the expected one)? */
const isGateStep = (step: Loose): boolean => step.action === 'waitForUrlContains' || step.action === 'assertUrlContains' || waitsForUrl(step.waitFor);

/** A step with where it sits (`steps.3`, or `steps.3.branches.1.0` inside a parallel block). */
interface Located {
  step: Loose;
  path: string;
}

/**
 * The steps of a list that act on a page, in order, each with its path. The steps of a `parallel` block's branches come right where the block
 * is, branch 0 first (T6.5): every rule below is per step or per actor, and a branch is ONE actor's flow, so reading branches one after the other
 * gives the same answer as reading them side by side.
 */
function locate(list: 'steps' | 'teardown', items: readonly Loose[]): Located[] {
  return [...walkWithPath<Loose>(items, [list])].filter(({ step }) => !isParallelStep(step)).map(({ step, path }) => ({ step, path: path.join('.') }));
}

function where(entry: Located): Pick<ConventionFinding, 'path' | 'stepId'> {
  return { path: entry.path, ...(entry.step.id === undefined ? {} : { stepId: entry.step.id }) };
}

export function lintConventions(
  input: { steps: readonly ExplorationStep[]; teardown?: readonly ExplorationStep[]; lintSuppress?: readonly LintSuppression[]; tags?: readonly string[] },
  context: ConventionContext,
): ConventionLintResult {
  const steps = locate('steps', input.steps as readonly Loose[]);
  const teardown = locate('teardown', (input.teardown ?? []) as readonly Loose[]);
  const genexus = context.platform === 'genexus';
  const found: ConventionFinding[] = [];

  // GX001: the submit that follows typing a credential must be followed by a gate (or carry one).
  if (genexus && !context.gateProvidedByProfile) {
    // Per actor (T6.4): one actor's submit is not another's, and another actor's gate does not prove this login completed.
    const typedBy = new Set<string>();
    steps.forEach((entry, index) => {
      const { step } = entry;
      const actor = actorOf(step);
      if (typesCredential(step)) {
        typedBy.add(actor);
        return;
      }
      if (!typedBy.has(actor) || !isSubmit(step)) return;
      typedBy.delete(actor);

      const next = steps.slice(index + 1).map((later) => later.step).filter((later) => actorOf(later) === actor).slice(0, 3);
      const gated = waitsForUrl(step.afterWaitFor) || next.some(isGateStep);
      if (!gated) {
        found.push({
          rule: 'GX001',
          severity: 'error',
          ...where(entry),
          message: 'The login submit is not followed by a login gate: if the login does not complete, the failure shows up as a confusing timeout further on.',
          suggestion: 'Add a waitForUrlContains with a token unique to the post-login page (10-15 s), or set loginGate on the target profile.',
        });
      }
    });
  }

  // GX002: one active session per user; a routine that logs in and leaves no teardown keeps it open.
  if (genexus && !context.isLoginRoutine && teardown.length === 0) {
    const logsIn = steps.some(({ step }) => typesCredential(step) || (step.action === 'include' && context.loginRoutineId !== undefined && step.routineId === context.loginRoutineId));
    if (logsIn) {
      found.push({
        rule: 'GX002',
        severity: 'warning',
        path: 'teardown',
        message: 'The routine logs in and has no teardown: the session stays open, and a second login of the same user can bounce back to the login page.',
        suggestion: 'Add a teardown that logs out.',
      });
    }
  }

  // DOC001 / DOC002 (T9.2): only when the tags are known (a lint of bare steps says nothing about them).
  if (input.tags !== undefined) {
    const tagged = input.tags.includes(DOC_TAG);
    const withDoc = steps.filter(({ step }) => step.doc !== undefined);
    if (withDoc.length > 0 && !tagged) {
      found.push({
        rule: 'DOC001',
        severity: 'warning',
        ...where(withDoc[0]!),
        message: `${withDoc.length} step(s) carry doc but the routine is not tagged "${DOC_TAG}": scrapforai manual build only picks up routines with that tag.`,
        suggestion: `Add the tag "${DOC_TAG}" to the routine.`,
      });
    }
    if (tagged && withDoc.length === 0 && !steps.some(({ step }) => step.action === 'include')) {
      found.push({
        rule: 'DOC002',
        severity: 'warning',
        path: 'steps',
        message: `The routine is tagged "${DOC_TAG}" but no step carries doc: its chapter in the manual would be empty.`,
        suggestion: 'Add doc { caption: { en, pt, es }, highlight? } to the steps that should become a figure.',
      });
    }
  }

  const eachStep = (items: readonly Located[]) =>
    items.forEach((entry) => {
      const { step } = entry;
      if (step.action === 'waitForTimeout') {
        found.push({
          rule: 'WT001',
          severity: 'warning',
          ...where(entry),
          message: `A fixed wait of ${String(step.timeoutMs)} ms: it is slow when the page is ready sooner and flaky when it is not.`,
          suggestion: 'Use waitForQuiet (no XHR/fetch pending), or wait for the element or response you actually need.',
        });
      }
      const highlight = (step.doc as { highlight?: unknown } | undefined)?.highlight;
      const selectors: Array<[string, unknown]> = [...SELECTOR_PROPERTIES.map((property): [string, unknown] => [property, step[property]]), ['doc.highlight', highlight]];
      for (const [property, selector] of selectors) {
        if (typeof selector === 'string' && POSITIONAL_SELECTOR.test(selector)) {
          found.push({
            rule: 'SEL001',
            severity: 'warning',
            ...where(entry),
            message: `The ${property} is positional: it breaks when an element is added before it.`,
            suggestion: 'Prefer an id, a name, a data-* attribute, a label or a role (inspect_dom lists them).',
          });
        }
      }
    });
  eachStep(steps);
  eachStep(teardown);

  const findings: ConventionFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  for (const finding of found) {
    const suppression = (input.lintSuppress ?? []).find((item) => item.rule === finding.rule && (item.stepId === undefined || item.stepId === finding.stepId));
    if (suppression) suppressed.push({ ...finding, reason: suppression.reason });
    else findings.push(finding);
  }
  return { findings, suppressed };
}
