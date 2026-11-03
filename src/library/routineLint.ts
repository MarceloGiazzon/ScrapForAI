import type { ExplorationStep } from '../schemas/explorationRequest.schema.js';

export interface LintIssue {
  path: string;
  message: string;
}

/** Shapes of well-known secrets. Deliberately specific: false positives block legitimate saves. */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
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

/**
 * Refuses routines that embed a secret. Messages name the step and the kind of problem but never
 * echo the offending text, so an error response cannot leak what it is refusing.
 */
export function lintRoutineSteps(steps: ExplorationStep[], vaultValues: string[]): LintIssue[] {
  const issues: LintIssue[] = [];

  steps.forEach((step, index) => {
    for (const property of SCANNED_PROPERTIES) {
      const text = (step as Record<string, unknown>)[property];
      if (typeof text !== 'string') {
        continue;
      }

      const where = `steps.${index}.${property}`;

      if (vaultValues.some((secret) => matchesVaultValue(text, secret))) {
        issues.push({ path: where, message: 'contains a credential vault value; use valueFromCredential instead of a literal' });
        continue;
      }

      const known = SECRET_PATTERNS.find(({ pattern }) => pattern.test(text));
      if (known) {
        issues.push({ path: where, message: `looks like ${known.name}; secrets must not be stored in a routine` });
      }
    }
  });

  return issues;
}
