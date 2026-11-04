import { captionTexts, DOC_LANGS, type RoutineDoc } from '../schemas/docStep.schema.js';
import type { ExplorationStep } from '../schemas/explorationRequest.schema.js';
import { walkWithPath } from '../schemas/stepTree.js';

export interface LintIssue {
  path: string;
  message: string;
}

/** Shapes of well-known secrets. Deliberately specific: false positives block legitimate saves. */
export const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'an OpenAI/Anthropic-style API key (sk-...)', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'a GitHub token (gh?_...)', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'a GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { name: 'a JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** String properties that can carry a literal an author might paste a secret into. */
const SCANNED_PROPERTIES = ['value', 'text', 'url', 'script'] as const;

/** Short values would match innocently inside longer text, so those only match exactly. */
const MIN_SUBSTRING_SECRET_LENGTH = 6;

function matchesVaultValue(text: string, secret: string): boolean {
  if (secret.length === 0) {
    return false;
  }

  return text === secret || (secret.length >= MIN_SUBSTRING_SECRET_LENGTH && text.includes(secret));
}

/** Why a piece of text may not be stored in a routine, or undefined when it is fine. Never echoes the text. */
function secretProblem(text: string, vaultValues: string[]): string | undefined {
  if (vaultValues.some((secret) => matchesVaultValue(text, secret))) {
    return 'contains a credential vault value; use valueFromCredential instead of a literal';
  }
  const known = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
  return known ? `looks like ${known.name}; secrets must not be stored in a routine` : undefined;
}

/** The literals a routine's parameters carry (`cases`, `oneOf` values) are stored with it, so they are checked like step values. */
export function lintParameters(parameters: Array<{ name: string; cases?: string[]; generator?: { type: string; values?: string[] } }>, vaultValues: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  parameters.forEach((parameter, index) => {
    const literals = parameter.cases ?? (parameter.generator?.type === 'oneOf' ? (parameter.generator.values ?? []) : []);
    literals.forEach((text, position) => {
      const problem = secretProblem(text, vaultValues);
      if (problem) issues.push({ path: `parameters.${index}.${parameter.cases ? 'cases' : 'generator.values'}.${position}`, message: problem });
    });
  });
  return issues;
}

/**
 * Refuses routines that embed a secret. Messages name the step and the kind of problem but never
 * echo the offending text, so an error response cannot leak what it is refusing.
 */
export function lintRoutineSteps(steps: readonly ExplorationStep[], vaultValues: string[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // The steps inside a `parallel` block's branches are routine content like any other (T6.5): a secret in a branch must not slip through.
  for (const { step, path } of walkWithPath<object>(steps, ['steps'])) {
    for (const property of SCANNED_PROPERTIES) {
      const text = (step as Record<string, unknown>)[property];
      if (typeof text !== 'string') {
        continue;
      }

      const problem = secretProblem(text, vaultValues);
      if (problem) issues.push({ path: [...path, property].join('.'), message: problem });
    }

    // T9.2: a caption ends up in a published manual, so it is held to the same rule as a typed value.
    const caption = (step as { doc?: { caption?: Record<string, string | undefined> } }).doc?.caption;
    for (const lang of DOC_LANGS) {
      const text = caption?.[lang];
      const problem = text === undefined ? undefined : secretProblem(text, vaultValues);
      if (problem) issues.push({ path: [...path, 'doc', 'caption', lang].join('.'), message: problem });
    }
  }

  return issues;
}

/** T9.2: the chapter title and introduction of a routine are published like the captions of its steps. */
export function lintRoutineDoc(doc: RoutineDoc | undefined, vaultValues: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const field of ['title', 'intro'] as const) {
    for (const lang of DOC_LANGS) {
      const text = doc?.[field]?.[lang];
      const problem = text === undefined ? undefined : secretProblem(text, vaultValues);
      if (problem) issues.push({ path: `doc.${field}.${lang}`, message: problem });
    }
  }
  return issues;
}
