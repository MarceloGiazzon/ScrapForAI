// First-use review (docs/INSTALL-AND-FIRST-USE-REVIEW.pt-BR.md, item 4): `cp .env.example .env` produced a configuration that was valid
// enough to start, with the API key every reader of the (public) repository knows and two allowlisted hosts nobody owns. The server then
// reached a sign-in page whose key the person never chose, or a TargetUrlNotAllowed on their real address. This detects an UNCHANGED
// copy of the example values so the server can refuse to start and say what to do.
//
// Pure: no configuration import, so `scripts/doctor.ts` and the tests can use it without booting the server.

export const EXAMPLE_API_KEY = 'replace-with-strong-random-value';
/** The origins `.env.example` ships for ALLOWED_TARGET_ORIGINS. */
export const EXAMPLE_TARGET_ORIGINS = ['https://dev.example.com', 'https://qa.example.com'] as const;

export interface ExampleConfigProblem {
  variable: 'SCRAPFORAI_API_KEY' | 'ALLOWED_TARGET_ORIGINS';
  message: string;
  /** What to do, as one or more lines a person can follow. */
  fix: string;
}

export interface ExampleConfigInput {
  SCRAPFORAI_API_KEY: string;
  ALLOWED_TARGET_ORIGINS: readonly string[];
}

export function findExampleConfig(config: ExampleConfigInput): ExampleConfigProblem[] {
  const problems: ExampleConfigProblem[] = [];

  // Any key that still starts like the placeholder is the example (a person who "improved" it by appending digits has not chosen a key).
  if (config.SCRAPFORAI_API_KEY.trim().toLowerCase().startsWith('replace-with')) {
    problems.push({
      variable: 'SCRAPFORAI_API_KEY',
      message: `SCRAPFORAI_API_KEY is still the example value from .env.example (anyone who has read the repository knows it).`,
      fix: 'Generate your own and put it in .env:\n      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    });
  }

  const origins = new Set(config.ALLOWED_TARGET_ORIGINS);
  if (origins.size === EXAMPLE_TARGET_ORIGINS.length && EXAMPLE_TARGET_ORIGINS.every((origin) => origins.has(origin))) {
    problems.push({
      variable: 'ALLOWED_TARGET_ORIGINS',
      message: 'ALLOWED_TARGET_ORIGINS still lists only the example hosts from .env.example (dev.example.com, qa.example.com).',
      fix:
        'List the exact origin(s) of the application you want to test: scheme + host + port, no wildcard, e.g.\n' +
        '      ALLOWED_TARGET_ORIGINS=http://localhost:5173\n' +
        '    Only those origins can ever be opened; a different port is a different origin.',
    });
  }

  return problems;
}

/** The text printed when the server refuses to start. Never includes the key's value. */
export function formatExampleConfigError(problems: readonly ExampleConfigProblem[]): string {
  const lines = ['ScrapForAI will not start with the values copied from .env.example:', ''];
  for (const problem of problems) {
    lines.push(`  - ${problem.message}`, `    ${problem.fix}`, '');
  }
  lines.push('Edit .env and start again. "npm run doctor" checks the whole setup and says what is still missing.');
  return lines.join('\n');
}
