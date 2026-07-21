# ScrapForAI — Productization Implementation Plan

**Version:** 1.0
**Created:** 2026-07-20
**Target audience:** an AI coding assistant implementing this incrementally.
**Repository root:** `D:\WorkSpace\ScrapForAILegacy`

---

## 0. HOW TO USE THIS DOCUMENT

This plan turns ScrapForAI from a developer-run service into an installable product with a
minimal web UI (run history + configuration) and a Windows installer.

### 0.1 Rules for the implementing agent — READ FIRST

These rules are binding. Violating them will break the project.

1. **Work strictly in task order.** Tasks are numbered `T<phase>.<n>`. Do not skip ahead.
   Later tasks assume earlier ones are complete.
2. **One task per commit.** After each task, run the verification block. Do not start the
   next task until verification passes.
3. **Do not refactor code you were not told to touch.** No renaming, no reformatting, no
   "while I'm here" cleanups. This codebase has deliberate security properties.
4. **Do not add npm dependencies.** This entire plan is implementable with the packages
   already in `package.json` plus the Node standard library. If you believe you need a new
   dependency, STOP and report why instead of installing it.
5. **Do not upgrade existing dependencies.** Playwright is pinned to `1.60.0` on purpose —
   it must match the Docker base image tag.
6. **If a file's real content does not match what this document quotes, STOP** and report
   the difference. Do not guess. The quotes were taken from the working tree on 2026-07-20.
7. **Never weaken existing security controls.** Specifically: do not remove the bearer-token
   check, the origin allowlist, the private-IP/SSRF blocks, `helmet()`, or secret redaction.
   Several tasks *extend* these; none replace them.
8. **Never commit secrets.** `.env` and `local-api-key.txt` must never be added to version
   control. Task T0.2 handles this.
9. **Preserve the existing code style:** 2-space indent, single quotes, semicolons, named
   exports, `.js` extensions on relative imports (required by `NodeNext` module resolution),
   `import type` for type-only imports, trailing commas.

### 0.2 Codebase conventions you must follow

Observed from the existing source; match them exactly.

| Aspect | Convention | Example |
|---|---|---|
| Module system | ESM (`"type": "module"`) | — |
| Relative imports | **must** end in `.js`, even from `.ts` files | `import { env } from '../config/env.js';` |
| Type imports | separate `import type` | `import type { NextFunction } from 'express';` |
| Node builtins | `node:` prefix | `import path from 'node:path';` |
| Validation | Zod schemas in `src/schemas/` | `explorationRequestSchema` |
| Routers | `export const xRouter = Router();` in `src/routes/` | `schema.routes.ts` |
| Errors returned to clients | `{ error: { type, message, details? } }` | see `exploration.routes.ts` |
| Async filesystem | `node:fs/promises` | `artifactStore.ts` |
| Import order | builtins, blank line, external, blank line, internal | see `server.ts` |

### 0.3 Verification commands

Run these from the repo root. Every task's verification block references them.

```powershell
npm run typecheck     # tsc --noEmit — MUST pass with zero errors
npm run build         # tsc -> dist/ (runs generate:schema first)
npm test              # unit tests
npm run dev           # dev server with watch, on http://localhost:3000
```

### 0.4 Phase overview

| Phase | Goal | Tasks | Blocking? |
|---|---|---|---|
| **0** | Safety & hygiene | T0.1–T0.4 | Yes — do first |
| **1** | Data substrate: paths, run history, APIs | T1.1–T1.9 | Yes — UI needs this |
| **2** | Minimal web UI + session auth | T2.1–T2.10 | — |
| **3** | Windows installer | T3.1–T3.5 | — |
| **4** | Release hygiene | T4.1–T4.3 | — |

---

## 1. CONTEXT: WHY THESE CHANGES

Read this section before writing code. It explains the four problems the plan solves.

### 1.1 Problem: there is no run history

`src/runner/runExploration.ts:587` writes the job result:

```ts
const result = redactSecrets(rawResult, knownSecrets);
await saveJsonFile(artifactStore.resultPath().absolutePath, result);
return result;
```

That file lands in `<ARTIFACT_DIR>/<jobId>/result.json`. But
`src/artifacts/artifactStore.ts:73-92` (`pruneExpiredArtifacts`) deletes **any job directory**
older than `ARTIFACT_RETENTION_HOURS`, which defaults to **4 hours**. There is also no index
and no endpoint that lists past runs.

Net effect: history is unrecoverable after 4 hours, and even within that window nothing can
enumerate it.

**Solution — separate the index from the evidence.** Two independent retention policies:

| Store | Contents | Size per run | Retention |
|---|---|---|---|
| **Run index** (new) | jobId, scenario, target, status, timings, counts, error | ~500 bytes | 90 days / 5000 runs |
| **Evidence** (exists) | screenshots, `trace.zip`, DOM snapshots, `result.json` | 1–20 MB | `ARTIFACT_RETENTION_HOURS` |

5000 runs of index ≈ 2.5 MB. The UI lists every run indefinitely and shows
"evidence expired" for rows whose artifact directory has been pruned.

### 1.2 Problem: configuration is frozen at process start

`src/config/env.ts:69`:

```ts
export const env = envSchema.parse(process.env);
```

This runs **once**, at module load. `process.env` is populated from `.env` only once, by
`dotenv.config()` at line 14. Editing `.env` at runtime therefore changes nothing.

This bug has already been hit in production and was worked around for exactly two keys via
`getLiveAllowedOrigins()` (`env.ts:81-85`), which re-reads the file from disk on every call.
Every other key — `PORT`, `HOST`, `ALLOW_EVALUATE`, `MAX_PARALLEL_JOBS`, all timeouts,
`CORS_ALLOWED_ORIGINS` — is still stale until the process restarts.

**Consequence for this plan:** a config UI whose Save button only writes `.env` would appear
to do nothing. This plan therefore adopts **explicit restart-to-apply** semantics: the UI
writes `.env`, marks which fields need a restart, and shows a banner. This is honest and far
simpler than making every config consumer reload-aware.

### 1.3 Problem: unsafe defaults for a shipped product

| Setting | Current default | Problem | New default |
|---|---|---|---|
| `HOST` (`env.ts:43`) | `0.0.0.0` | A bare-metal `npm start` exposes a browser-automation engine to the whole LAN behind one token | `127.0.0.1` |
| `ARTIFACT_DIR` (`env.ts:64`) | `/app/artifacts` | A Linux container path used as the default for a Windows-native install | OS-appropriate user data dir |
| Config location | `.env` beside the binary | Unwritable under `Program Files`; lost on upgrade | User data dir |

Docker is unaffected: `docker-compose.yml:34` already binds `127.0.0.1:3000:3000` on the host,
and the compose file will set `HOST=0.0.0.0` explicitly for the in-container listener.

### 1.4 Problem: adding a browser UI changes the threat model

The API today is **bearer-token only**, which makes it inherently CSRF-immune: a malicious
web page cannot make the victim's browser attach an `Authorization` header.

Introducing a cookie session breaks that property. Mitigations, all mandatory:

1. The API key is **never** stored in `localStorage`/`sessionStorage` or in JS. The login form
   exchanges it for an `httpOnly; SameSite=Strict` session cookie.
2. Any **cookie-authenticated**, state-changing request (non-`GET`/`HEAD`) must carry the
   header `X-ScrapForAI-UI: 1`. Cross-origin pages cannot set custom headers without a CORS
   preflight, and the CORS policy (`server.ts:27-38`) does not allow arbitrary origins.
   Bearer-authenticated requests are exempt — they are already CSRF-immune.
3. Security-critical config fields stay locked behind the **bearer API key**; a cookie session
   alone cannot widen the SSRF allowlist or enable arbitrary JS execution. (See T2.8.)
4. The global rate limiter is split so UI polling cannot starve the exploration API.
5. Artifact file serving uses `path.relative()` containment, not `startsWith()`.

> **Note on the existing `startsWith` check** (`artifactStore.ts:32`): it is *not* currently
> exploitable, because `safeFileName()` strips everything outside `[a-zA-Z0-9_-]` before the
> path is built. But `startsWith` is the wrong primitive — `/app/artifacts-evil` passes it.
> T1.8 introduces a route that serves user-supplied paths, where this matters for real.

### 1.5 Design decision: JSONL, not SQLite

The run index is stored as **append-only JSONL** (`runs.jsonl`, one JSON object per line).

Rationale:
- **Zero dependencies.** Rule 4 forbids adding packages; `better-sqlite3` would also require a
  native toolchain (node-gyp + VS Build Tools) on every install machine.
- **No experimental APIs.** Node's built-in `node:sqlite` loads on Node 22.17 but emits
  `ExperimentalWarning: SQLite is an experimental feature and might change at any time`. An
  installed product should not print that on every start, nor risk an API change on upgrade.
- **Adequate.** The whole index is loaded into memory once at boot. Filtering, sorting and
  pagination are plain array operations over ≤5000 objects — microseconds.

**Migration trigger:** if the index ever needs to exceed ~50,000 runs, or if multiple
processes must write it concurrently, replace `runHistoryStore.ts` with a SQLite-backed
implementation. The public interface defined in T1.4 is designed so that swap touches no
callers.

---

# PHASE 0 — SAFETY & HYGIENE

Small, fast, and blocking. Do these before anything else.

## T0.1 — Initialize version control

**Goal:** the project is not under version control at all. Every later task is unreviewable
and unrevertable until it is.

**Actions:**

1. Confirm there is no repo:
   ```powershell
   Test-Path "D:\WorkSpace\ScrapForAILegacy\.git"    # expect: False
   ```
2. Initialize and make the first commit **only after T0.2 is complete** (so no secret is ever
   in history):
   ```powershell
   git init
   git branch -M main
   ```

**Do not** run `git add` yet. Proceed to T0.2.

**Done when:** `.git/` exists and `git status` runs.

---

## T0.2 — Secret hygiene before the first commit

**Goal:** ensure no secret enters git history. Once committed, a secret must be treated as
compromised, so this must be right the first time.

**Current state:**
- `.env` exists (800 bytes) — already ignored by `.gitignore`.
- `local-api-key.txt` exists (25 bytes) — **NOT ignored**. It would be committed.

**Actions:**

1. Replace `.gitignore` with:

```gitignore
node_modules/
dist/
.env
.env.*
!.env.example
artifacts/
results/
logs/
data/
local-api-key.txt
*.key
*.pem
npm-debug.log*
.DS_Store
.vscode/settings.json
release/
installer/output/
installer/staging/
```

2. Verify nothing sensitive is staged:
   ```powershell
   git add -A
   git status --short
   git diff --cached --name-only | Select-String -Pattern '\.env$|local-api-key|\.key$|\.pem$'
   ```
   The last command must produce **no output**. If it prints anything, run
   `git rm --cached <file>`, fix `.gitignore`, and re-check.

3. Commit:
   ```powershell
   git commit -m "Initial commit: ScrapForAI security-first Playwright runner"
   ```

**Done when:** `git log` shows one commit and `git ls-files` contains neither `.env` nor
`local-api-key.txt`.

---

## T0.3 — Rotate the exposed API key

**Goal:** `local-api-key.txt` sat in plaintext in the working tree. Treat the key as burned.

**Actions:**

1. Generate a new key:
   ```powershell
   $key = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
   Write-Output $key
   ```
2. Set `SCRAPFORAI_API_KEY=<new key>` in `.env`.
3. Delete the loose file:
   ```powershell
   Remove-Item "D:\WorkSpace\ScrapForAILegacy\local-api-key.txt"
   ```
4. Update any local MCP client config that referenced the old key.

**Constraint:** the key must be ≥16 characters (`env.ts:44`). The command above produces 48.

**Done when:** `local-api-key.txt` no longer exists and the server starts with the new key.

---

## T0.4 — Remove the stale packaging scripts

**Goal:** two bundler scripts have drifted and actively mislead. `Create-ScrapForAIInstallBundle.ps1:4`
hardcodes `$Root = "D:\WorkSpace\ScrapForAI"` — a path that is not this project.

**Actions:**

1. Delete both:
   - `Create-CleanScrapForAIZip-v2.ps1`
   - `Create-ScrapForAIInstallBundle.ps1`
2. Keep `scripts/Install-ScrapForAI.ps1`, `scripts/Invoke-ScrapForAIRoutine.ps1`, and
   `scripts/Stop-ScrapForAI.ps1` — Phase 3 replaces `Install-ScrapForAI.ps1` and reuses the
   other two.
3. Commit: `git commit -am "Remove stale packaging scripts with hardcoded paths"`

**Done when:** neither file exists at the repo root.

---

# PHASE 1 — DATA SUBSTRATE

Nothing in the UI can work until runs are recorded and readable. This phase adds no UI.

## T1.1 — Create the path resolver

**Goal:** centralize all writable-location logic so config and data live in a user-writable
directory instead of beside the binary.

**Create file:** `src/config/paths.ts`

```ts
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves writable locations for config and data.
 *
 * IMPORTANT: every export here is a FUNCTION, not a constant. This module is imported by
 * config/env.ts, so its module body executes BEFORE dotenv.config() has run. Reading
 * process.env at module scope would therefore miss values defined in .env. Reading it
 * lazily inside a function is correct because callers run after dotenv has loaded.
 */

const APP_DIR_NAME = 'ScrapForAI';

/**
 * Base directory for all mutable state (config, history, artifacts, logs).
 *
 * Resolution order:
 *   1. SCRAPFORAI_DATA_DIR   — explicit override (used by Docker and the installer)
 *   2. %LOCALAPPDATA%\ScrapForAI          on Windows
 *   3. $XDG_DATA_HOME/scrapforai          on Linux/macOS when set
 *   4. ~/.local/share/scrapforai          fallback
 */
export function dataDir(): string {
  const override = process.env.SCRAPFORAI_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return path.join(localAppData, APP_DIR_NAME);
    }
    return path.join(os.homedir(), 'AppData', 'Local', APP_DIR_NAME);
  }

  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return path.join(xdgDataHome, 'scrapforai');
  }

  return path.join(os.homedir(), '.local', 'share', 'scrapforai');
}

/** Evidence: screenshots, traces, per-job result.json. Short retention. */
export function artifactsDir(): string {
  return path.join(dataDir(), 'artifacts');
}

/** Run index (runs.jsonl). Long retention. */
export function historyDir(): string {
  return path.join(dataDir(), 'history');
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs');
}

/**
 * Static UI assets, shipped with the code rather than stored as user data.
 *
 * Resolves to <projectRoot>/public from BOTH layouts, because the relative depth is the
 * same in each:
 *   src/config/paths.ts   -> ../../public
 *   dist/config/paths.js  -> ../../public
 */
export function publicDir(): string {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'public');
}
```

> **Note on `publicDir()`:** the regex strips the leading slash that `URL.pathname` puts in
> front of a Windows drive letter (`/D:/...` → `D:/...`). Do not simplify it away.

**Verify:**
```powershell
npm run typecheck
node -e "import('./src/config/paths.ts')" # not runnable directly; rely on typecheck
```

**Done when:** `npm run typecheck` passes.

---

## T1.2 — Wire the path resolver into the env config

**Goal:** default `ARTIFACT_DIR` to the user data dir, change the `HOST` default to loopback,
and add the new configuration keys this plan needs.

**Edit file:** `src/config/env.ts`

**Change 1 — add the import.** After the existing `import { z } from 'zod';` line, add a blank
line and then:

```ts
import { artifactsDir } from './paths.js';
```

**Change 2 — replace the `HOST` line** in `envSchema`:

```ts
// BEFORE
HOST: z.string().min(1).default('0.0.0.0'),

// AFTER
// Loopback by default: a bare-metal start must not expose the browser-automation engine
// to the LAN. Docker overrides this to 0.0.0.0 (the host-side bind is already restricted
// to 127.0.0.1 in docker-compose.yml).
HOST: z.string().min(1).default('127.0.0.1'),
```

**Change 3 — make `ARTIFACT_DIR` optional.** Replace:

```ts
// BEFORE
ARTIFACT_DIR: z.string().min(1).default('/app/artifacts'),

// AFTER
// Optional: resolved after parsing (see below) so the default can be platform-aware.
ARTIFACT_DIR: z.string().min(1).optional(),
```

**Change 4 — add new keys** to `envSchema`, immediately after the `ARTIFACT_RETENTION_HOURS`
line:

```ts
  // --- Run history index (separate retention from evidence above) ---
  HISTORY_RETENTION_DAYS: integerFromEnv.default(90),
  HISTORY_MAX_RUNS: integerFromEnv.default(5000),

  // --- Web UI ---
  UI_ENABLED: booleanFromEnv,
  SESSION_TTL_MINUTES: integerFromEnv.default(480),
```

**Change 5 — replace the `env` export** (currently line 69):

```ts
// BEFORE
export const env = envSchema.parse(process.env);

export type AppEnv = typeof env;

// AFTER
const parsedEnv = envSchema.parse(process.env);

// ARTIFACT_DIR is resolved after parsing so its default can depend on the platform.
// Zod defaults are evaluated when the schema is constructed, which is too early here.
export const env = {
  ...parsedEnv,
  ARTIFACT_DIR: parsedEnv.ARTIFACT_DIR ?? artifactsDir(),
};

export type AppEnv = typeof env;
```

**Important:** `booleanFromEnv` defaults to `false`, so `UI_ENABLED` is **off** unless set.
T1.9 sets it to `true` in `.env.example`.

**Verify:**
```powershell
npm run typecheck
```

**Done when:** typecheck passes and `env.ARTIFACT_DIR` is a `string` (not `string | undefined`).

---

## T1.3 — Define the run summary type

**Goal:** the compact record stored in the index. Must stay small — this is what makes long
retention cheap.

**Create file:** `src/history/runSummary.ts`

```ts
import { z } from 'zod';

/**
 * A compact, durable summary of one exploration run.
 *
 * Target size: ~500 bytes serialized. Do NOT add bulky fields (DOM snapshots, console
 * output, network logs, extracted values). Those live in the per-job result.json under
 * ARTIFACT_DIR and are pruned on a much shorter schedule.
 */
export const runSummarySchema = z.object({
  jobId: z.string(),
  scenarioName: z.string().optional(),
  status: z.enum(['passed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number(),
  targetUrl: z.string(),

  callerTool: z.string().optional(),
  callerAgent: z.string().optional(),

  stepCount: z.number(),
  passedSteps: z.number(),
  failedSteps: z.number(),
  skippedSteps: z.number(),
  failedStepIndex: z.number().optional(),

  errorType: z.string().optional(),
  errorMessage: z.string().optional(),

  screenshotCount: z.number(),
  consoleErrorCount: z.number(),
  networkFailureCount: z.number(),
  unexpectedExternalRequestCount: z.number(),

  /** Relative artifact root, e.g. "artifacts/job_abc123". */
  artifactRelativeRoot: z.string(),
});

export type RunSummary = z.infer<typeof runSummarySchema>;
```

**Verify:** `npm run typecheck`

---

## T1.4 — Implement the run history store

**Goal:** the append-only JSONL index, loaded into memory, with filtering and retention.

**Create file:** `src/history/runHistoryStore.ts`

```ts
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../config/env.js';
import { historyDir } from '../config/paths.js';
import { runSummarySchema, type RunSummary } from './runSummary.js';

/**
 * Append-only JSONL index of exploration runs.
 *
 * Layout: <dataDir>/history/runs.jsonl — one JSON object per line, oldest first.
 *
 * The whole file is read into memory once at startup. With HISTORY_MAX_RUNS at 5000 and
 * ~500 bytes per record that is ~2.5 MB, so filtering and pagination are plain array
 * operations. See docs/PRODUCTIZATION-PLAN.md §1.5 for why this is not SQLite, and for the
 * threshold at which it should become SQLite.
 *
 * Single-process only: appends assume no concurrent writer.
 */

let runs: RunSummary[] = [];
const byId = new Map<string, RunSummary>();
let initialized = false;
let initPromise: Promise<void> | undefined;

function historyFilePath(): string {
  return path.join(historyDir(), 'runs.jsonl');
}

async function loadFromDisk(): Promise<void> {
  await fs.mkdir(historyDir(), { recursive: true });

  const filePath = historyFilePath();
  if (!existsSync(filePath)) {
    runs = [];
    byId.clear();
    return;
  }

  const raw = await fs.readFile(filePath, 'utf8');
  const loaded: RunSummary[] = [];
  let corruptLines = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = runSummarySchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) {
        loaded.push(parsed.data);
      } else {
        corruptLines += 1;
      }
    } catch {
      // A partially-written final line is expected after an unclean shutdown. Skipping it
      // is correct: never abort startup because the history file has a bad tail.
      corruptLines += 1;
    }
  }

  runs = loaded;
  byId.clear();
  for (const run of runs) {
    byId.set(run.jobId, run);
  }

  if (corruptLines > 0) {
    process.stderr.write(`[history] skipped ${corruptLines} unreadable line(s) in runs.jsonl\n`);
  }
}

/** Idempotent; safe to call from multiple entry points. */
export async function initRunHistory(): Promise<void> {
  if (initialized) {
    return;
  }

  initPromise ??= loadFromDisk().then(() => {
    initialized = true;
  });

  await initPromise;
}

/**
 * Records one run. Never throws: a history failure must not fail an otherwise good job.
 */
export async function appendRun(summary: RunSummary): Promise<void> {
  try {
    await initRunHistory();

    runs.push(summary);
    byId.set(summary.jobId, summary);

    await fs.appendFile(historyFilePath(), `${JSON.stringify(summary)}\n`, 'utf8');

    // Compact only when meaningfully over budget, so this is not a per-run cost.
    if (runs.length > env.HISTORY_MAX_RUNS * 1.1) {
      await pruneHistory();
    }
  } catch (error) {
    process.stderr.write(`[history] failed to record run ${summary.jobId}: ${String(error)}\n`);
  }
}

export interface ListRunsQuery {
  status?: 'passed' | 'failed';
  scenario?: string;
  /** ISO date-time; inclusive lower bound on startedAt. */
  since?: string;
  /** ISO date-time; inclusive upper bound on startedAt. */
  until?: string;
  /** Case-insensitive substring over scenarioName, targetUrl and jobId. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface ListRunsResult {
  total: number;
  limit: number;
  offset: number;
  items: RunSummary[];
}

export async function listRuns(query: ListRunsQuery = {}): Promise<ListRunsResult> {
  await initRunHistory();

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const needle = query.q?.trim().toLowerCase();

  const filtered = runs.filter((run) => {
    if (query.status && run.status !== query.status) {
      return false;
    }
    if (query.scenario && run.scenarioName !== query.scenario) {
      return false;
    }
    if (query.since && run.startedAt < query.since) {
      return false;
    }
    if (query.until && run.startedAt > query.until) {
      return false;
    }
    if (needle) {
      const haystack = `${run.scenarioName ?? ''} ${run.targetUrl} ${run.jobId}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  });

  // Stored oldest-first; the UI wants newest-first.
  filtered.reverse();

  return {
    total: filtered.length,
    limit,
    offset,
    items: filtered.slice(offset, offset + limit),
  };
}

export async function getRun(jobId: string): Promise<RunSummary | undefined> {
  await initRunHistory();
  return byId.get(jobId);
}

/** Distinct scenario names, for the UI filter dropdown. */
export async function listScenarioNames(): Promise<string[]> {
  await initRunHistory();

  const names = new Set<string>();
  for (const run of runs) {
    if (run.scenarioName) {
      names.add(run.scenarioName);
    }
  }

  return [...names].sort();
}

export interface HistoryStats {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  oldestRunAt?: string;
  newestRunAt?: string;
  retentionDays: number;
  maxRuns: number;
}

export async function historyStats(): Promise<HistoryStats> {
  await initRunHistory();

  let passed = 0;
  for (const run of runs) {
    if (run.status === 'passed') {
      passed += 1;
    }
  }

  return {
    totalRuns: runs.length,
    passedRuns: passed,
    failedRuns: runs.length - passed,
    oldestRunAt: runs[0]?.startedAt,
    newestRunAt: runs[runs.length - 1]?.startedAt,
    retentionDays: env.HISTORY_RETENTION_DAYS,
    maxRuns: env.HISTORY_MAX_RUNS,
  };
}

/**
 * Enforces HISTORY_RETENTION_DAYS and HISTORY_MAX_RUNS, then rewrites the file.
 *
 * Rewrite is atomic: write a temp file, then rename over the original. A crash mid-prune
 * therefore leaves the previous good file intact.
 */
export async function pruneHistory(): Promise<{ removed: number; kept: number }> {
  await initRunHistory();

  const before = runs.length;
  const cutoff = new Date(Date.now() - env.HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let kept = runs.filter((run) => run.startedAt >= cutoff);
  if (kept.length > env.HISTORY_MAX_RUNS) {
    kept = kept.slice(kept.length - env.HISTORY_MAX_RUNS);
  }

  if (kept.length === before) {
    return { removed: 0, kept: before };
  }

  const filePath = historyFilePath();
  const tempPath = `${filePath}.tmp`;
  const payload = kept.map((run) => `${JSON.stringify(run)}\n`).join('');

  await fs.writeFile(tempPath, payload, 'utf8');
  await fs.rename(tempPath, filePath);

  runs = kept;
  byId.clear();
  for (const run of runs) {
    byId.set(run.jobId, run);
  }

  return { removed: before - kept.length, kept: kept.length };
}

/** Test-only: drops in-memory state so the next call reloads from disk. */
export function resetRunHistoryForTests(): void {
  runs = [];
  byId.clear();
  initialized = false;
  initPromise = undefined;
}
```

**Verify:** `npm run typecheck`

---

## T1.5 — Implement the result summarizer

**Goal:** convert a full `ExplorationResult` into a compact `RunSummary`.

**Create file:** `src/history/summarizeResult.ts`

```ts
import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type { RunSummary } from './runSummary.js';

const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * Projects a full ExplorationResult down to the compact index record.
 *
 * The input has ALREADY been passed through redactSecrets() by runExploration, so no
 * further redaction is needed here. Do not add fields that could reintroduce bulk.
 */
export function summarizeResult(result: ExplorationResult): RunSummary {
  let passedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;

  for (const step of result.steps) {
    if (step.status === 'passed') {
      passedSteps += 1;
    } else if (step.status === 'failed') {
      failedSteps += 1;
    } else {
      skippedSteps += 1;
    }
  }

  return {
    jobId: result.jobId,
    scenarioName: result.scenarioName,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    targetUrl: result.targetUrl,

    callerTool: result.caller?.tool,
    callerAgent: result.caller?.agent,

    stepCount: result.steps.length,
    passedSteps,
    failedSteps,
    skippedSteps,
    failedStepIndex: result.failedStepIndex,

    errorType: result.error?.type,
    errorMessage: result.error?.message.slice(0, MAX_ERROR_MESSAGE_CHARS),

    screenshotCount: result.evidence.screenshots.length,
    consoleErrorCount: result.evidence.consoleErrors.length,
    networkFailureCount: result.evidence.networkFailures.length,
    unexpectedExternalRequestCount: result.evidence.unexpectedExternalRequests.length,

    artifactRelativeRoot: `artifacts/${result.jobId}`,
  };
}
```

> **Check before writing:** open `src/schemas/explorationRequest.schema.ts` and confirm the
> field names on `callerSchema`. This plan assumes `tool` and `agent`. If they differ, use the
> real names and adjust `runSummary.ts` to match. Do not guess.

**Verify:** `npm run typecheck`

---

## T1.6 — Record every run

**Goal:** hook the summarizer into the runner. This is the smallest edit in the plan and the
one everything else depends on.

**Edit file:** `src/runner/runExploration.ts`

**Change 1 — add imports.** Alongside the existing internal imports near the top (the file
already has `import { createArtifactStore, saveJsonFile } from '../artifacts/artifactStore.js';`
at line 6), add:

```ts
import { appendRun } from '../history/runHistoryStore.js';
import { summarizeResult } from '../history/summarizeResult.js';
```

**Change 2 — record the run.** At the end of `runExplorationInner` (currently lines 586-588):

```ts
// BEFORE
  const result = redactSecrets(rawResult, knownSecrets);
  await saveJsonFile(artifactStore.resultPath().absolutePath, result);
  return result;
}

// AFTER
  const result = redactSecrets(rawResult, knownSecrets);
  await saveJsonFile(artifactStore.resultPath().absolutePath, result);

  // Record in the durable index. appendRun() swallows its own errors by design: a history
  // write must never turn a successful exploration into a failed request.
  await appendRun(summarizeResult(result));

  return result;
}
```

**Critical:** record **after** `redactSecrets`, never before. The summary must not contain
credentials.

**Verify:**
```powershell
npm run typecheck
npm test
```

**Manual verification:**
1. `npm run dev`
2. Run any exploration against an allowlisted origin.
3. Confirm the index exists and has one line per run:
   ```powershell
   Get-Content "$env:LOCALAPPDATA\ScrapForAI\history\runs.jsonl"
   ```

**Done when:** each completed run appends exactly one line.

---

## T1.7 — Harden artifact path containment

**Goal:** replace the `startsWith` check with correct containment, and add a reusable helper
for the file-serving route in T1.8.

**Edit file:** `src/artifacts/artifactStore.ts`

**Change 1 — add the helper.** After the `relativeArtifactPath` function (line 23-25), add:

```ts
/**
 * True when `candidate` is `root` itself or lies inside it.
 *
 * Uses path.relative rather than startsWith: "/app/artifacts-evil".startsWith("/app/artifacts")
 * is true, which is exactly the bug this avoids.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves a caller-supplied relative path against the artifact root, refusing anything
 * that escapes it. Returns undefined when the path is not contained.
 */
export function resolveArtifactPath(relativePath: string): string | undefined {
  const artifactsRoot = path.resolve(env.ARTIFACT_DIR);
  const absolute = path.resolve(artifactsRoot, relativePath);
  return isPathInside(artifactsRoot, absolute) ? absolute : undefined;
}
```

**Change 2 — use it in `createArtifactStore`.** Replace lines 32-34:

```ts
// BEFORE
  if (!rootDir.startsWith(artifactsRoot)) {
    throw new Error('Invalid artifact path');
  }

// AFTER
  if (!isPathInside(artifactsRoot, rootDir)) {
    throw new Error('Invalid artifact path');
  }
```

**Verify:** `npm run typecheck && npm test`

---

## T1.8 — Add the run history API

**Goal:** expose the index over HTTP. All routes sit behind the existing `apiAuth` middleware.

**Create file:** `src/routes/runs.routes.ts`

```ts
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import { resolveArtifactPath } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { getRun, historyStats, listRuns, listScenarioNames } from '../history/runHistoryStore.js';

export const runsRouter = Router();

const ALLOWED_ARTIFACT_EXTENSIONS = new Set(['.png', '.json', '.zip', '.txt']);

function badRequest(res: import('express').Response, message: string): void {
  res.status(400).json({ error: { type: 'ValidationError', message, details: [] } });
}

function notFound(res: import('express').Response, message: string): void {
  res.status(404).json({ error: { type: 'NotFound', message } });
}

function parseIntegerParam(value: unknown, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStatusParam(value: unknown): 'passed' | 'failed' | undefined {
  return value === 'passed' || value === 'failed' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** GET /v1/runs — paginated, filterable list of past runs. */
runsRouter.get('/', async (req, res, next) => {
  try {
    const result = await listRuns({
      status: parseStatusParam(req.query.status),
      scenario: optionalString(req.query.scenario),
      since: optionalString(req.query.since),
      until: optionalString(req.query.until),
      q: optionalString(req.query.q),
      limit: parseIntegerParam(req.query.limit, 50),
      offset: parseIntegerParam(req.query.offset, 0),
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/** GET /v1/runs/stats — aggregate counters for the dashboard header. */
runsRouter.get('/stats', async (_req, res, next) => {
  try {
    res.json(await historyStats());
  } catch (error) {
    next(error);
  }
});

/** GET /v1/runs/scenarios — distinct scenario names for the filter dropdown. */
runsRouter.get('/scenarios', async (_req, res, next) => {
  try {
    res.json({ scenarios: await listScenarioNames() });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId — summary plus the full result.json when evidence still exists.
 *
 * evidenceAvailable is computed from the filesystem at read time rather than stored on the
 * summary, so it cannot go stale when the artifact pruner runs.
 */
runsRouter.get('/:jobId', async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    const summary = await getRun(jobId);

    if (!summary) {
      notFound(res, 'Run not found');
      return;
    }

    const resultPath = resolveArtifactPath(path.join(jobId, 'result.json'));
    let detail: unknown;
    let evidenceAvailable = false;

    if (resultPath && existsSync(resultPath)) {
      evidenceAvailable = true;
      try {
        detail = JSON.parse(await fs.readFile(resultPath, 'utf8'));
      } catch {
        evidenceAvailable = false;
      }
    }

    res.json({
      summary,
      evidenceAvailable,
      evidenceRetentionHours: env.ARTIFACT_RETENTION_HOURS,
      detail,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/runs/:jobId/artifacts/<relative path> — serves one evidence file.
 *
 * Two independent guards:
 *   1. resolveArtifactPath() rejects anything escaping ARTIFACT_DIR (path.relative based).
 *   2. An extension allowlist, so an unexpected file type can never be served inline.
 */
runsRouter.get('/:jobId/artifacts/{*artifactPath}', async (req, res, next) => {
  try {
    const jobId = req.params.jobId;

    const rawSegments = (req.params as Record<string, unknown>).artifactPath;
    const segments = Array.isArray(rawSegments) ? rawSegments : [rawSegments];
    const relativePath = segments.filter((segment): segment is string => typeof segment === 'string').join('/');

    if (!relativePath) {
      badRequest(res, 'Artifact path is required');
      return;
    }

    const extension = path.extname(relativePath).toLowerCase();
    if (!ALLOWED_ARTIFACT_EXTENSIONS.has(extension)) {
      badRequest(res, `Artifact type "${extension}" is not served`);
      return;
    }

    const absolutePath = resolveArtifactPath(path.join(jobId, relativePath));
    if (!absolutePath || !existsSync(absolutePath)) {
      notFound(res, 'Artifact not found or expired');
      return;
    }

    res.sendFile(absolutePath);
  } catch (error) {
    next(error);
  }
});
```

> **Express 5 wildcard syntax:** Express 5 replaced `*` with named wildcards. The route above
> uses `{*artifactPath}`. If it fails to match at runtime, verify the installed Express major
> version (`npm ls express`) and consult its routing docs — **do not** downgrade Express.

**Edit file:** `src/server.ts`

**Change 1 — imports.** Add alongside the other route imports:

```ts
import { runsRouter } from './routes/runs.routes.js';
```

and alongside the config import:

```ts
import { initRunHistory, pruneHistory } from './history/runHistoryStore.js';
```

**Change 2 — mount the router.** After the existing `app.use('/v1/explorations/inspect-dom', domInspectionRouter);` line:

```ts
app.use('/v1/runs', runsRouter);
```

**Change 3 — initialize history at boot.** Replace the `app.listen(...)` block at the end:

```ts
// BEFORE
app.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT }, 'ScrapForAI API listening');
});

// AFTER
async function start(): Promise<void> {
  await initRunHistory();
  const pruned = await pruneHistory();
  if (pruned.removed > 0) {
    logger.info(pruned, 'Pruned expired run history entries');
  }

  app.listen(env.PORT, env.HOST, () => {
    logger.info({ host: env.HOST, port: env.PORT }, 'ScrapForAI API listening');
  });
}

start().catch((error: unknown) => {
  logger.error({ err: error }, 'Failed to start ScrapForAI');
  process.exit(1);
});
```

**Verify:**
```powershell
npm run typecheck
npm run dev
```

Then, with `$key` set to your `SCRAPFORAI_API_KEY`:
```powershell
$h = @{ Authorization = "Bearer $key" }
Invoke-RestMethod -Uri http://127.0.0.1:3000/v1/runs -Headers $h
Invoke-RestMethod -Uri http://127.0.0.1:3000/v1/runs/stats -Headers $h
Invoke-RestMethod -Uri http://127.0.0.1:3000/v1/runs -Headers @{}   # expect 401
```

**Done when:** the list endpoint returns recorded runs and an unauthenticated call returns 401.

---

## T1.9 — Update environment documentation and Docker

**Goal:** keep `.env.example` and the container in step with the new defaults.

**Edit file:** `.env.example`

Replace `HOST=0.0.0.0` with:

```dotenv
# Loopback only by default. Set to 0.0.0.0 ONLY if you intentionally want to expose the
# service on your network — it drives a real browser and is guarded by a single API key.
HOST=127.0.0.1
```

Replace `ARTIFACT_DIR=/app/artifacts` with:

```dotenv
# Leave both unset to use the per-user data directory:
#   Windows: %LOCALAPPDATA%\ScrapForAI
#   Linux:   ~/.local/share/scrapforai
# SCRAPFORAI_DATA_DIR=
# ARTIFACT_DIR=
```

Append a new section before the MCP block:

```dotenv
# --- Run history index ---
# The compact run index is kept far longer than the heavy evidence above: roughly 500 bytes
# per run versus 1-20 MB. Screenshots and traces expire on ARTIFACT_RETENTION_HOURS; the
# history list survives for HISTORY_RETENTION_DAYS.
HISTORY_RETENTION_DAYS=90
HISTORY_MAX_RUNS=5000

# --- Web UI ---
# Serves the history/config UI at http://127.0.0.1:<PORT>/ui
UI_ENABLED=true
SESSION_TTL_MINUTES=480
```

**Edit file:** `docker-compose.yml`

Change the `HOST` line so the container still binds all interfaces (the host-side bind is
already restricted to loopback on line 34):

```yaml
      # 0.0.0.0 inside the container is correct; the host-side publish below is limited
      # to 127.0.0.1, so this is not network-exposed.
      HOST: ${HOST:-0.0.0.0}
```

Add to the `environment:` block:

```yaml
      SCRAPFORAI_DATA_DIR: /app/data
      HISTORY_RETENTION_DAYS: ${HISTORY_RETENTION_DAYS:-90}
      HISTORY_MAX_RUNS: ${HISTORY_MAX_RUNS:-5000}
      UI_ENABLED: ${UI_ENABLED:-true}
      SESSION_TTL_MINUTES: ${SESSION_TTL_MINUTES:-480}
```

Replace the `volumes:` block so history persists across container rebuilds:

```yaml
    volumes:
      - ./data:/app/data
```

Remove the `ARTIFACT_DIR: ${ARTIFACT_DIR}` line — it is now derived from
`SCRAPFORAI_DATA_DIR`.

**Verify:**
```powershell
docker compose config     # must render with no errors
```

**Done when:** compose renders and `docker compose up` still serves `/health`.

---

# PHASE 2 — MINIMAL WEB UI

Three screens: **History**, **Config**, **Status**. No build step, no framework, no bundler —
plain HTML/CSS/JS served by the existing Express process.

## T2.1 — Cookie helpers

**Goal:** read and write cookies without adding `cookie-parser`.

**Create file:** `src/security/cookies.ts`

```ts
import type { Request, Response } from 'express';

/** Minimal cookie parser. Avoids a dependency for the two cookies this app uses. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    if (part.slice(0, separatorIndex).trim() === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }

  return undefined;
}

export function setSessionCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];

  // Secure would break plain-http loopback, which is the normal deployment. Add it only
  // when the request actually arrived over TLS.
  if (res.req.secure) {
    attributes.push('Secure');
  }

  res.setHeader('Set-Cookie', attributes.join('; '));
}

export function clearSessionCookie(res: Response, name: string): void {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
```

**Verify:** `npm run typecheck`

---

## T2.2 — In-memory session store

**Goal:** short-lived sessions so the API key never reaches browser JavaScript.

**Create file:** `src/security/sessionStore.ts`

```ts
import crypto from 'node:crypto';

import { env } from '../config/env.js';

/**
 * In-memory session store.
 *
 * Sessions intentionally do not survive a restart: this is a single-process, single-user
 * local tool, and forcing re-login after a restart is a feature, not a limitation. Do not
 * persist these to disk.
 */

interface Session {
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export const SESSION_COOKIE_NAME = 'sfa_session';

function sweepExpired(now: number): void {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function createSession(): { token: string; maxAgeSeconds: number } {
  const now = Date.now();
  sweepExpired(now);

  const maxAgeSeconds = env.SESSION_TTL_MINUTES * 60;
  const token = crypto.randomBytes(32).toString('base64url');

  sessions.set(token, { createdAt: now, expiresAt: now + maxAgeSeconds * 1000 });

  return { token, maxAgeSeconds };
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  const session = sessions.get(token);
  if (!session) {
    return false;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }

  return true;
}

export function destroySession(token: string | undefined): void {
  if (token) {
    sessions.delete(token);
  }
}

export function activeSessionCount(): number {
  sweepExpired(Date.now());
  return sessions.size;
}
```

**Verify:** `npm run typecheck`

---

## T2.3 — Extend authentication with sessions and CSRF protection

**Goal:** accept **either** a bearer token **or** a session cookie, and add CSRF protection
that applies only to cookie-authenticated requests.

**Edit file:** `src/security/apiAuth.ts` — replace the entire file:

```ts
import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';
import { readCookie } from './cookies.js';
import { SESSION_COOKIE_NAME, isValidSession } from './sessionStore.js';

/** Header the UI must send on state-changing, cookie-authenticated requests. */
export const UI_REQUEST_HEADER = 'x-scrapforai-ui';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** How this request authenticated. Set by apiAuth. */
      authMethod?: 'bearer' | 'session';
    }
  }
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/** Routes reachable without authentication. */
function isPublicPath(req: Request): boolean {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/v1/schema' || req.path.startsWith('/v1/schema/'))) {
    return true;
  }

  // The login endpoint cannot require the session it creates.
  if (req.method === 'POST' && req.path === '/v1/auth/login') {
    return true;
  }

  // Static UI assets contain no data; every data route behind them is authenticated.
  if (req.method === 'GET' && (req.path === '/ui' || req.path.startsWith('/ui/'))) {
    return true;
  }

  return false;
}

export function hasValidBearerToken(req: Request): boolean {
  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match) && timingSafeEqualText(match?.[1] ?? '', env.SCRAPFORAI_API_KEY);
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  if (isPublicPath(req)) {
    next();
    return;
  }

  if (hasValidBearerToken(req)) {
    req.authMethod = 'bearer';
    next();
    return;
  }

  if (isValidSession(readCookie(req, SESSION_COOKIE_NAME))) {
    req.authMethod = 'session';

    // CSRF: a cookie is attached automatically by the browser, so a cross-site page could
    // otherwise trigger state changes. SameSite=Strict already blocks most of this; the
    // custom header is the second layer, because cross-origin JS cannot set it without a
    // CORS preflight that this server's origin policy will refuse.
    //
    // Bearer requests skip this check: they are structurally CSRF-immune.
    const isStateChanging = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (isStateChanging && req.get(UI_REQUEST_HEADER) !== '1') {
      res.status(403).json({
        error: {
          type: 'CsrfProtection',
          message: `Missing ${UI_REQUEST_HEADER} header on a cookie-authenticated request`,
        },
      });
      return;
    }

    next();
    return;
  }

  res.status(401).json({
    error: {
      type: 'Unauthorized',
      message: 'Missing or invalid API token',
    },
  });
}
```

**Verify:** `npm run typecheck && npm test`

**Regression check — this must still hold:**
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/v1/runs -Headers @{}   # expect 401
```

---

## T2.4 — Authentication routes

**Create file:** `src/routes/auth.routes.ts`

```ts
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { hasValidBearerToken, timingSafeEqualText } from '../security/apiAuth.js';
import { clearSessionCookie, readCookie, setSessionCookie } from '../security/cookies.js';
import { env } from '../config/env.js';
import { SESSION_COOKIE_NAME, createSession, destroySession, isValidSession } from '../security/sessionStore.js';

export const authRouter = Router();

/** Deliberately strict: this endpoint guards the API key against brute force. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { type: 'TooManyRequests', message: 'Too many login attempts. Try again later.' } },
});

authRouter.post('/login', loginLimiter, (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : '';

  if (!apiKey || !timingSafeEqualText(apiKey, env.SCRAPFORAI_API_KEY)) {
    // Uniform message: never reveal whether the key was malformed or merely wrong.
    res.status(401).json({ error: { type: 'Unauthorized', message: 'Invalid API key' } });
    return;
  }

  const { token, maxAgeSeconds } = createSession();
  setSessionCookie(res, SESSION_COOKIE_NAME, token, maxAgeSeconds);

  res.json({ ok: true, expiresInSeconds: maxAgeSeconds });
});

authRouter.post('/logout', (req, res) => {
  destroySession(readCookie(req, SESSION_COOKIE_NAME));
  clearSessionCookie(res, SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

/** Lets the UI decide between rendering the app and redirecting to login. */
authRouter.get('/me', (req, res) => {
  const viaSession = isValidSession(readCookie(req, SESSION_COOKIE_NAME));
  const viaBearer = hasValidBearerToken(req);

  if (!viaSession && !viaBearer) {
    res.status(401).json({ error: { type: 'Unauthorized', message: 'Not authenticated' } });
    return;
  }

  res.json({ authenticated: true, method: viaBearer ? 'bearer' : 'session' });
});
```

**Verify:** `npm run typecheck`

---

## T2.5 — Configuration API

**Goal:** read and write `.env` safely, with restart-required semantics and locked fields.

**Create file:** `src/routes/config.routes.ts`

```ts
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Router } from 'express';

import { env } from '../config/env.js';
import { getLiveAllowedOrigins } from '../config/env.js';
import { hasValidBearerToken } from '../security/apiAuth.js';

export const configRouter = Router();

const dotEnvPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

/**
 * Fields a cookie session may NOT change. Each one is a security boundary:
 *   - SCRAPFORAI_API_KEY      : the credential itself
 *   - ALLOWED_*_ORIGINS       : the SSRF allowlist
 *   - ALLOW_EVALUATE          : arbitrary in-page JavaScript execution
 *   - HOST                    : network exposure
 *
 * Changing any of these requires presenting the bearer API key on the request, so a
 * hijacked UI session alone cannot escalate.
 */
const LOCKED_FIELDS = new Set([
  'SCRAPFORAI_API_KEY',
  'ALLOWED_TARGET_ORIGINS',
  'ALLOWED_RESOURCE_ORIGINS',
  'ALLOW_EVALUATE',
  'HOST',
]);

/** Fields that take effect only after a restart (see plan §1.2). */
const RESTART_REQUIRED_FIELDS = new Set([
  'NODE_ENV',
  'PORT',
  'HOST',
  'SCRAPFORAI_API_KEY',
  'CORS_ALLOWED_ORIGINS',
  'MAX_STEPS_PER_JOB',
  'JOB_TIMEOUT_MS',
  'STEP_TIMEOUT_MS',
  'MAX_REQUEST_BODY_SIZE',
  'MAX_PARALLEL_JOBS',
  'MAX_DOM_SNAPSHOT_CHARS',
  'ALLOW_EVALUATE',
  'MAX_EVALUATE_SCRIPT_CHARS',
  'MAX_EVALUATE_RESULT_CHARS',
  'EVALUATE_TIMEOUT_MS',
  'MAX_WATCH_DURATION_MS',
  'MIN_WATCH_INTERVAL_MS',
  'MAX_WATCH_SAMPLES',
  'ARTIFACT_RETENTION_HOURS',
  'ARTIFACT_DIR',
  'LOG_LEVEL',
  'PLAYWRIGHT_BROWSER',
  'HISTORY_RETENTION_DAYS',
  'HISTORY_MAX_RUNS',
  'UI_ENABLED',
  'SESSION_TTL_MINUTES',
]);

/** Every writable key, with UI metadata. Keep in sync with envSchema in config/env.ts. */
const EDITABLE_FIELDS: Array<{
  key: string;
  group: 'safety' | 'limits' | 'runtime' | 'history';
  type: 'string' | 'number' | 'boolean' | 'originList' | 'enum';
  options?: string[];
  help: string;
}> = [
  { key: 'ALLOWED_TARGET_ORIGINS', group: 'safety', type: 'originList', help: 'Origins the runner may navigate to. This is the SSRF allowlist.' },
  { key: 'ALLOWED_RESOURCE_ORIGINS', group: 'safety', type: 'originList', help: 'Extra origins pages may load sub-resources from.' },
  { key: 'ALLOW_EVALUATE', group: 'safety', type: 'boolean', help: 'DANGER: allows arbitrary in-page JavaScript. Keep false unless local and trusted.' },
  { key: 'CORS_ALLOWED_ORIGINS', group: 'safety', type: 'originList', help: 'Browser origins permitted to call this API.' },
  { key: 'HOST', group: 'safety', type: 'string', help: 'Listen address. 127.0.0.1 keeps the service off the network.' },

  { key: 'MAX_STEPS_PER_JOB', group: 'limits', type: 'number', help: 'Maximum steps in a single routine.' },
  { key: 'JOB_TIMEOUT_MS', group: 'limits', type: 'number', help: 'Hard timeout for a whole job.' },
  { key: 'STEP_TIMEOUT_MS', group: 'limits', type: 'number', help: 'Default timeout for one step.' },
  { key: 'MAX_PARALLEL_JOBS', group: 'limits', type: 'number', help: 'Concurrent explorations allowed.' },
  { key: 'MAX_DOM_SNAPSHOT_CHARS', group: 'limits', type: 'number', help: 'Cap on captured DOM text.' },
  { key: 'MAX_REQUEST_BODY_SIZE', group: 'limits', type: 'string', help: 'Express body limit, e.g. 1mb.' },

  { key: 'PORT', group: 'runtime', type: 'number', help: 'HTTP port.' },
  { key: 'LOG_LEVEL', group: 'runtime', type: 'enum', options: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], help: 'Log verbosity.' },
  { key: 'PLAYWRIGHT_BROWSER', group: 'runtime', type: 'enum', options: ['chromium', 'firefox', 'webkit'], help: 'Browser engine.' },
  { key: 'SESSION_TTL_MINUTES', group: 'runtime', type: 'number', help: 'UI session lifetime.' },

  { key: 'ARTIFACT_RETENTION_HOURS', group: 'history', type: 'number', help: 'How long screenshots and traces are kept.' },
  { key: 'HISTORY_RETENTION_DAYS', group: 'history', type: 'number', help: 'How long the run index is kept.' },
  { key: 'HISTORY_MAX_RUNS', group: 'history', type: 'number', help: 'Hard cap on indexed runs.' },
];

const EDITABLE_KEYS = new Set(EDITABLE_FIELDS.map((field) => field.key));

/**
 * Rewrites .env in place, preserving comments, ordering and unknown keys.
 * Keys not already present are appended.
 */
function upsertEnvLines(content: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));

  const lines = content.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)([A-Za-z0-9_]+)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[2] ?? '';
    if (!remaining.has(key)) {
      return line;
    }

    const value = remaining.get(key) ?? '';
    remaining.delete(key);
    return `${match[1] ?? ''}${key}=${value}`;
  });

  if (remaining.size > 0) {
    lines.push('');
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join('\n');
}

function currentValueFor(key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];

  if (Array.isArray(value)) {
    return value.join(',');
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return value === undefined || value === null ? '' : String(value);
}

/** GET /v1/config — effective configuration. Secrets are never returned. */
configRouter.get('/', (_req, res) => {
  res.json({
    fields: EDITABLE_FIELDS.map((field) => ({
      ...field,
      value: currentValueFor(field.key),
      locked: LOCKED_FIELDS.has(field.key),
      restartRequired: RESTART_REQUIRED_FIELDS.has(field.key),
    })),
    // Masked, never the real value.
    apiKeyConfigured: env.SCRAPFORAI_API_KEY.length >= 16,
    envFilePath: dotEnvPath,
    envFileWritable: existsSync(dotEnvPath),
    liveAllowedTargetOrigins: getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS'),
    liveAllowedResourceOrigins: getLiveAllowedOrigins('ALLOWED_RESOURCE_ORIGINS'),
  });
});

/** PUT /v1/config — writes .env. Body: { updates: { KEY: "value", ... } } */
configRouter.put('/', async (req, res, next) => {
  try {
    const updates = req.body?.updates;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Body must be { updates: object }', details: [] } });
      return;
    }

    const entries = Object.entries(updates as Record<string, unknown>);
    const rejected: Array<{ key: string; reason: string }> = [];
    const accepted: Record<string, string> = {};

    const privileged = hasValidBearerToken(req);

    for (const [key, rawValue] of entries) {
      if (!EDITABLE_KEYS.has(key)) {
        rejected.push({ key, reason: 'Not an editable field' });
        continue;
      }

      if (LOCKED_FIELDS.has(key) && !privileged) {
        rejected.push({ key, reason: 'This field requires the API key (send it as a Bearer token)' });
        continue;
      }

      if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
        rejected.push({ key, reason: 'Value must be a string, number or boolean' });
        continue;
      }

      const value = String(rawValue).trim();

      // Reject anything that would break out of a single .env line.
      if (/[\r\n]/.test(value)) {
        rejected.push({ key, reason: 'Value must not contain newlines' });
        continue;
      }

      accepted[key] = value;
    }

    if (rejected.length > 0) {
      res.status(400).json({
        error: { type: 'ValidationError', message: 'Some fields were rejected', details: rejected.map((item) => ({ path: item.key, message: item.reason })) },
      });
      return;
    }

    if (!existsSync(dotEnvPath)) {
      res.status(500).json({ error: { type: 'ConfigError', message: `.env not found at ${dotEnvPath}` } });
      return;
    }

    const original = await fs.readFile(dotEnvPath, 'utf8');
    const updated = upsertEnvLines(original, accepted);

    // Back up before overwriting, so a bad edit is always recoverable.
    await fs.writeFile(`${dotEnvPath}.bak`, original, 'utf8');
    await fs.writeFile(dotEnvPath, updated, 'utf8');

    const changedKeys = Object.keys(accepted);
    res.json({
      ok: true,
      updated: changedKeys,
      restartRequired: changedKeys.some((key) => RESTART_REQUIRED_FIELDS.has(key)),
      note: 'Allowlist changes apply immediately. Other fields apply after a restart.',
    });
  } catch (error) {
    next(error);
  }
});
```

> **Validation gap to be aware of:** this endpoint validates shape (type, no newlines,
> editable, unlocked) but does not re-run `envSchema` against the merged result, so it is
> possible to write a value the server will reject on next boot. Mitigation: the `.env.bak`
> backup, plus the Status screen surfacing startup failures. Re-validating the full merged
> environment before writing is a worthwhile follow-up, but is out of scope here.

**Verify:** `npm run typecheck`

---

## T2.6 — Status API

**Create file:** `src/routes/status.routes.ts`

```ts
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Router } from 'express';

import { env } from '../config/env.js';
import { dataDir } from '../config/paths.js';
import { historyStats } from '../history/runHistoryStore.js';
import { activeSessionCount } from '../security/sessionStore.js';

export const statusRouter = Router();

async function directorySizeBytes(directory: string): Promise<number> {
  if (!existsSync(directory)) {
    return 0;
  }

  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else {
      const stats = await fs.stat(entryPath).catch(() => undefined);
      total += stats?.size ?? 0;
    }
  }

  return total;
}

statusRouter.get('/', async (_req, res, next) => {
  try {
    const history = await historyStats();

    res.json({
      service: 'ScrapForAI',
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      uptimeSeconds: Math.round(process.uptime()),
      nodeEnv: env.NODE_ENV,
      host: env.HOST,
      port: env.PORT,
      browser: env.PLAYWRIGHT_BROWSER,

      // Surfaced prominently in the UI: this one is dangerous when true.
      allowEvaluate: env.ALLOW_EVALUATE,

      dataDir: dataDir(),
      artifactDir: env.ARTIFACT_DIR,
      artifactDiskBytes: await directorySizeBytes(env.ARTIFACT_DIR),
      artifactRetentionHours: env.ARTIFACT_RETENTION_HOURS,

      history,
      activeSessions: activeSessionCount(),
    });
  } catch (error) {
    next(error);
  }
});
```

**Verify:** `npm run typecheck`

---

## T2.7 — Wire the new routes, split rate limiting, and serve the UI

**Edit file:** `src/server.ts`

**Change 1 — imports.** Add:

```ts
import express from 'express';           // already imported; do not duplicate
import { authRouter } from './routes/auth.routes.js';
import { configRouter } from './routes/config.routes.js';
import { statusRouter } from './routes/status.routes.js';
import { publicDir } from './config/paths.js';
```

**Change 2 — replace the global rate limiter.** The current limiter
(`server.ts:39-46`) applies 30 requests/minute to *everything*; UI polling would starve the
exploration API. Replace it with:

```ts
// Generous ceiling for read-only and UI traffic.
const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// The original strict budget, now scoped to the endpoints that actually drive a browser.
const explorationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);
```

**Change 3 — tighten the Content Security Policy.** Replace `app.use(helmet());` with:

```ts
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No inline scripts or styles: everything lives in external files under /ui.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Screenshots are served same-origin from /v1/runs/:jobId/artifacts/...
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }),
);
```

**Change 4 — mount routers.** Replace the existing mounts with:

```ts
app.use('/v1/auth', authRouter);
app.use('/v1/schema', schemaRouter);

app.use('/v1/explorations', explorationLimiter, explorationRouter);
app.use('/v1/explorations/inspect-dom', explorationLimiter, domInspectionRouter);

app.use('/v1/runs', runsRouter);
app.use('/v1/config', configRouter);
app.use('/v1/status', statusRouter);

if (env.UI_ENABLED) {
  app.use('/ui', express.static(publicDir(), { index: 'index.html', maxAge: 0 }));
  app.get('/', (_req, res) => res.redirect('/ui/'));
}
```

> **Ordering matters:** `apiAuth` is already installed at `server.ts:62`, before the routers.
> Leave it there. `authRouter` works because `isPublicPath()` (T2.3) exempts
> `POST /v1/auth/login` and `GET /ui/*`.

**Verify:**
```powershell
npm run typecheck
npm run dev
```
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3000/health
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/v1/auth/login -ContentType application/json -Body '{"apiKey":"WRONG"}'   # expect 401
```

---

## T2.8 — UI shared assets

**Create directory:** `public/` at the repo root.

**Create file:** `public/app.css`

```css
:root {
  --bg: #ffffff;
  --surface: #f6f7f9;
  --border: #dfe3e8;
  --text: #1b1f24;
  --muted: #5b6673;
  --accent: #2b5fd9;
  --pass: #1a7f45;
  --fail: #c2352b;
  --warn: #8a6100;
  --radius: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --surface: #1c2126;
    --border: #2c343b;
    --text: #e8ecef;
    --muted: #9aa5b1;
    --accent: #6f97ff;
    --pass: #4ec27e;
    --fail: #ff7a70;
    --warn: #e0b355;
  }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
}

header.topbar {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

header.topbar h1 { font-size: 16px; margin: 0; }
header.topbar nav { display: flex; gap: 14px; flex: 1; }
header.topbar nav a { color: var(--muted); text-decoration: none; padding: 4px 2px; }
header.topbar nav a.active { color: var(--accent); border-bottom: 2px solid var(--accent); }

main { padding: 20px; max-width: 1200px; margin: 0 auto; }

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  margin-bottom: 16px;
}

.stat-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.stat { flex: 1 1 140px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.stat .value { font-size: 22px; font-weight: 600; margin-top: 4px; }

.filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
input, select, button, textarea {
  font: inherit;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
button { cursor: pointer; background: var(--accent); color: #fff; border-color: transparent; }
button.secondary { background: transparent; color: var(--text); border-color: var(--border); }
button:disabled { opacity: .55; cursor: not-allowed; }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg); }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.badge.passed { background: color-mix(in srgb, var(--pass) 18%, transparent); color: var(--pass); }
.badge.failed { background: color-mix(in srgb, var(--fail) 18%, transparent); color: var(--fail); }

.danger-banner {
  background: color-mix(in srgb, var(--fail) 14%, transparent);
  border: 1px solid var(--fail);
  color: var(--fail);
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 16px;
  font-weight: 600;
}
.warn-banner {
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  border: 1px solid var(--warn);
  color: var(--warn);
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 16px;
}

.muted { color: var(--muted); }
.mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
.hidden { display: none !important; }

dialog { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); max-width: 900px; width: 92vw; }
dialog::backdrop { background: rgba(0,0,0,.5); }

.field { margin-bottom: 14px; }
.field label { display: block; font-weight: 600; margin-bottom: 3px; }
.field .help { color: var(--muted); font-size: 12px; margin-bottom: 5px; }
.field input, .field select { width: 100%; }
.field.locked input, .field.locked select { opacity: .6; }

.login-wrap { max-width: 380px; margin: 12vh auto; }
.screenshot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.screenshot-grid img { width: 100%; border: 1px solid var(--border); border-radius: 6px; }
pre { overflow-x: auto; background: var(--bg); padding: 10px; border-radius: 6px; border: 1px solid var(--border); }
```

**Create file:** `public/api.js`

```js
// Shared API client for the ScrapForAI UI.
//
// The API key is NEVER stored in JavaScript or localStorage. Authentication is a
// httpOnly SameSite=Strict cookie issued by POST /v1/auth/login, so this code cannot
// read the credential even if it wanted to.

const UI_HEADER = 'X-ScrapForAI-UI';

export async function apiFetch(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});

  // Required by the server's CSRF check on cookie-authenticated state changes.
  headers.set(UI_HEADER, '1');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(pathname, { ...options, headers, credentials: 'same-origin' });

  if (response.status === 401 && !pathname.startsWith('/v1/auth/')) {
    window.location.href = '/ui/login.html';
    throw new Error('Not authenticated');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed (${response.status})`;
    const error = new Error(message);
    error.details = payload?.error?.details ?? [];
    throw error;
  }

  return payload;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Always build DOM via textContent, never innerHTML, so run data cannot inject markup. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function markActiveNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';
  for (const link of document.querySelectorAll('header.topbar nav a')) {
    if (link.getAttribute('href') === current) link.classList.add('active');
  }
}

export async function logout() {
  await apiFetch('/v1/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/ui/login.html';
}
```

> **Security requirement:** all UI code must build DOM with `textContent` / the `el()` helper.
> **Never** use `innerHTML` with run data — target URLs and error messages come from remote
> pages and are attacker-influenced.

**Verify:** files exist under `public/`.

---

## T2.9 — UI pages

Create these five files in `public/`. Each page is a plain HTML document loading `app.css`
and one ES module; there are no inline scripts, as the CSP forbids them.

**`public/login.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ScrapForAI — Sign in</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <main class="login-wrap">
    <div class="card">
      <h1>ScrapForAI</h1>
      <p class="muted">Enter your API key to open the console.</p>
      <form id="login-form">
        <div class="field">
          <label for="api-key">API key</label>
          <input type="password" id="api-key" autocomplete="current-password" required>
        </div>
        <button type="submit">Sign in</button>
      </form>
      <p id="login-error" class="hidden" style="color: var(--fail); margin-top: 12px;"></p>
      <p class="muted mono" style="margin-top: 16px;">
        The key is exchanged for a short-lived session cookie and is never stored in the browser.
      </p>
    </div>
  </main>
  <script type="module" src="login.js"></script>
</body>
</html>
```

**`public/login.js`**

```js
import { apiFetch } from './api.js';

const form = document.getElementById('login-form');
const input = document.getElementById('api-key');
const errorBox = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.classList.add('hidden');

  try {
    await apiFetch('/v1/auth/login', { method: 'POST', body: JSON.stringify({ apiKey: input.value }) });
    window.location.href = '/ui/index.html';
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
    input.value = '';
  }
});
```

**`public/index.html`** — History screen

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ScrapForAI — Run history</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <header class="topbar">
    <h1>ScrapForAI</h1>
    <nav>
      <a href="index.html">History</a>
      <a href="config.html">Configuration</a>
      <a href="status.html">Status</a>
    </nav>
    <button class="secondary" id="logout">Sign out</button>
  </header>

  <main>
    <div class="stat-row" id="stats"></div>

    <div class="filters">
      <input type="search" id="filter-q" placeholder="Search scenario, URL or job id">
      <select id="filter-status">
        <option value="">All statuses</option>
        <option value="passed">Passed</option>
        <option value="failed">Failed</option>
      </select>
      <select id="filter-scenario"><option value="">All scenarios</option></select>
      <button class="secondary" id="refresh">Refresh</button>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Started</th><th>Scenario</th><th>Target</th><th>Status</th>
              <th>Steps</th><th>Duration</th><th>Issues</th>
            </tr>
          </thead>
          <tbody id="runs-body"></tbody>
        </table>
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:12px;">
        <button class="secondary" id="prev">Previous</button>
        <span class="muted" id="page-info"></span>
        <button class="secondary" id="next">Next</button>
      </div>
    </div>
  </main>

  <dialog id="detail"><div id="detail-body"></div>
    <div style="padding:0 16px 16px;"><button class="secondary" id="detail-close">Close</button></div>
  </dialog>

  <script type="module" src="history.js"></script>
</body>
</html>
```

**`public/history.js`**

```js
import { apiFetch, el, formatDateTime, formatDuration, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const PAGE_SIZE = 50;
let offset = 0;

const body = document.getElementById('runs-body');
const dialog = document.getElementById('detail');
const detailBody = document.getElementById('detail-body');

document.getElementById('detail-close').addEventListener('click', () => dialog.close());

function buildQuery() {
  const params = new URLSearchParams();
  const q = document.getElementById('filter-q').value.trim();
  const status = document.getElementById('filter-status').value;
  const scenario = document.getElementById('filter-scenario').value;

  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (scenario) params.set('scenario', scenario);
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String(offset));

  return params.toString();
}

async function loadStats() {
  const stats = await apiFetch('/v1/runs/stats');
  const container = document.getElementById('stats');
  container.replaceChildren(
    stat('Total runs', String(stats.totalRuns)),
    stat('Passed', String(stats.passedRuns)),
    stat('Failed', String(stats.failedRuns)),
    stat('Oldest kept', stats.oldestRunAt ? formatDateTime(stats.oldestRunAt) : '—'),
  );
}

function stat(label, value) {
  return el('div', { class: 'stat' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value })]);
}

async function loadScenarios() {
  const { scenarios } = await apiFetch('/v1/runs/scenarios');
  const select = document.getElementById('filter-scenario');
  const current = select.value;
  select.replaceChildren(el('option', { value: '', text: 'All scenarios' }));
  for (const name of scenarios) select.appendChild(el('option', { value: name, text: name }));
  select.value = current;
}

async function loadRuns() {
  const data = await apiFetch(`/v1/runs?${buildQuery()}`);

  body.replaceChildren();
  if (data.items.length === 0) {
    body.appendChild(el('tr', {}, [el('td', { colspan: '7', class: 'muted', text: 'No runs match these filters.' })]));
  }

  for (const run of data.items) {
    const issues = [];
    if (run.consoleErrorCount) issues.push(`${run.consoleErrorCount} console`);
    if (run.networkFailureCount) issues.push(`${run.networkFailureCount} network`);
    if (run.unexpectedExternalRequestCount) issues.push(`${run.unexpectedExternalRequestCount} external`);

    const row = el('tr', { onclick: () => showDetail(run.jobId) }, [
      el('td', { text: formatDateTime(run.startedAt) }),
      el('td', { text: run.scenarioName ?? '—' }),
      el('td', { class: 'mono', text: run.targetUrl }),
      el('td', {}, [el('span', { class: `badge ${run.status}`, text: run.status })]),
      el('td', { text: `${run.passedSteps}/${run.stepCount}` }),
      el('td', { text: formatDuration(run.durationMs) }),
      el('td', { class: 'muted', text: issues.join(', ') || '—' }),
    ]);
    body.appendChild(row);
  }

  document.getElementById('page-info').textContent =
    `${data.total === 0 ? 0 : offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)} of ${data.total}`;
  document.getElementById('prev').disabled = offset === 0;
  document.getElementById('next').disabled = offset + PAGE_SIZE >= data.total;
}

async function showDetail(jobId) {
  detailBody.replaceChildren(el('div', { class: 'card', text: 'Loading…' }));
  dialog.showModal();

  const data = await apiFetch(`/v1/runs/${encodeURIComponent(jobId)}`);
  const { summary, detail, evidenceAvailable, evidenceRetentionHours } = data;

  const nodes = [
    el('div', { class: 'card' }, [
      el('h2', { text: summary.scenarioName ?? summary.jobId }),
      el('p', { class: 'mono muted', text: summary.targetUrl }),
      el('p', {}, [
        el('span', { class: `badge ${summary.status}`, text: summary.status }),
        el('span', { class: 'muted', text: `  ${formatDateTime(summary.startedAt)} · ${formatDuration(summary.durationMs)}` }),
      ]),
      summary.errorMessage ? el('pre', { text: `${summary.errorType ?? 'Error'}: ${summary.errorMessage}` }) : null,
    ]),
  ];

  if (!evidenceAvailable) {
    nodes.push(el('div', { class: 'warn-banner', text: `Evidence expired. Screenshots and traces are kept for ${evidenceRetentionHours} hours; the run record is kept far longer.` }));
  }

  if (detail?.steps?.length) {
    const rows = detail.steps.map((step) =>
      el('tr', {}, [
        el('td', { text: String(step.index) }),
        el('td', { text: step.label ?? step.id ?? '—' }),
        el('td', { class: 'mono', text: step.action }),
        el('td', {}, [el('span', { class: `badge ${step.status === 'passed' ? 'passed' : 'failed'}`, text: step.status })]),
        el('td', { text: formatDuration(step.durationMs) }),
        el('td', { class: 'muted', text: step.error?.message ?? '' }),
      ]),
    );
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Steps' }),
      el('div', { class: 'table-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: '#' }), el('th', { text: 'Label' }), el('th', { text: 'Action' }),
            el('th', { text: 'Status' }), el('th', { text: 'Duration' }), el('th', { text: 'Error' }),
          ])]),
          el('tbody', {}, rows),
        ]),
      ]),
    ]));
  }

  if (evidenceAvailable && detail?.evidence?.screenshots?.length) {
    const images = detail.evidence.screenshots.map((shot) =>
      el('figure', {}, [
        el('img', { src: `/v1/runs/${encodeURIComponent(jobId)}/artifacts/screenshots/${encodeURIComponent(shot.name)}.png`, alt: shot.name, loading: 'lazy' }),
        el('figcaption', { class: 'muted', text: shot.name }),
      ]),
    );
    nodes.push(el('div', { class: 'card' }, [el('h3', { text: 'Screenshots' }), el('div', { class: 'screenshot-grid' }, images)]));
  }

  if (detail?.evidence?.consoleErrors?.length) {
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Console errors' }),
      el('pre', { text: detail.evidence.consoleErrors.map((entry) => entry.text).join('\n') }),
    ]));
  }

  if (detail?.evidence?.networkFailures?.length) {
    nodes.push(el('div', { class: 'card' }, [
      el('h3', { text: 'Network failures' }),
      el('pre', { text: detail.evidence.networkFailures.map((entry) => `${entry.method} ${entry.origin}${entry.pathname} → ${entry.status ?? entry.failureText ?? 'failed'}`).join('\n') }),
    ]));
  }

  detailBody.replaceChildren(...nodes.filter(Boolean));
}

async function refresh() {
  await Promise.all([loadStats(), loadScenarios(), loadRuns()]);
}

document.getElementById('refresh').addEventListener('click', () => { offset = 0; refresh(); });
document.getElementById('filter-q').addEventListener('input', () => { offset = 0; loadRuns(); });
document.getElementById('filter-status').addEventListener('change', () => { offset = 0; loadRuns(); });
document.getElementById('filter-scenario').addEventListener('change', () => { offset = 0; loadRuns(); });
document.getElementById('prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); loadRuns(); });
document.getElementById('next').addEventListener('click', () => { offset += PAGE_SIZE; loadRuns(); });

refresh().catch((error) => console.error(error));
```

**`public/config.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ScrapForAI — Configuration</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <header class="topbar">
    <h1>ScrapForAI</h1>
    <nav>
      <a href="index.html">History</a>
      <a href="config.html">Configuration</a>
      <a href="status.html">Status</a>
    </nav>
    <button class="secondary" id="logout">Sign out</button>
  </header>

  <main>
    <div id="banners"></div>
    <form id="config-form"><div id="groups"></div>
      <button type="submit">Save changes</button>
      <span class="muted" id="save-state"></span>
    </form>
  </main>

  <script type="module" src="config.js"></script>
</body>
</html>
```

**`public/config.js`**

```js
import { apiFetch, el, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

const GROUP_TITLES = {
  safety: 'Safety',
  limits: 'Limits',
  runtime: 'Runtime',
  history: 'History & retention',
};

let fields = [];

function fieldControl(field) {
  if (field.type === 'boolean') {
    const select = el('select', { id: `f-${field.key}`, name: field.key });
    for (const option of ['false', 'true']) {
      select.appendChild(el('option', { value: option, text: option }));
    }
    select.value = String(field.value) === 'true' ? 'true' : 'false';
    if (field.locked) select.disabled = true;
    return select;
  }

  if (field.type === 'enum') {
    const select = el('select', { id: `f-${field.key}`, name: field.key });
    for (const option of field.options ?? []) select.appendChild(el('option', { value: option, text: option }));
    select.value = field.value;
    if (field.locked) select.disabled = true;
    return select;
  }

  const input = el('input', {
    id: `f-${field.key}`,
    name: field.key,
    type: field.type === 'number' ? 'number' : 'text',
    value: field.value,
  });
  if (field.locked) input.disabled = true;
  return input;
}

function renderField(field) {
  const notes = [];
  if (field.locked) notes.push('Locked — requires the API key to change');
  if (field.restartRequired) notes.push('Takes effect after restart');

  return el('div', { class: `field${field.locked ? ' locked' : ''}` }, [
    el('label', { for: `f-${field.key}`, text: field.key }),
    el('div', { class: 'help', text: field.help }),
    fieldControl(field),
    notes.length ? el('div', { class: 'help', text: notes.join(' · ') }) : null,
  ].filter(Boolean));
}

async function load() {
  const data = await apiFetch('/v1/config');
  fields = data.fields;

  const banners = document.getElementById('banners');
  banners.replaceChildren();

  const allowEvaluate = fields.find((field) => field.key === 'ALLOW_EVALUATE');
  if (allowEvaluate && String(allowEvaluate.value) === 'true') {
    banners.appendChild(el('div', { class: 'danger-banner', text: 'ALLOW_EVALUATE is ON. Routines can execute arbitrary JavaScript in the page. Turn this off unless this machine is local and fully trusted.' }));
  }

  banners.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'muted', text: 'Configuration file' }),
    el('div', { class: 'mono', text: data.envFilePath }),
    el('div', { class: 'muted', text: `Live target allowlist: ${data.liveAllowedTargetOrigins.join(', ') || '(none)'}` }),
  ]));

  const groups = document.getElementById('groups');
  groups.replaceChildren();

  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const groupFields = fields.filter((field) => field.group === group);
    if (groupFields.length === 0) continue;
    groups.appendChild(el('div', { class: 'card' }, [el('h2', { text: title }), ...groupFields.map(renderField)]));
  }
}

document.getElementById('config-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const state = document.getElementById('save-state');
  state.textContent = 'Saving…';

  const updates = {};
  for (const field of fields) {
    if (field.locked) continue;      // never submit locked fields from the UI
    const control = document.getElementById(`f-${field.key}`);
    if (control && control.value !== String(field.value)) updates[field.key] = control.value;
  }

  if (Object.keys(updates).length === 0) {
    state.textContent = 'No changes.';
    return;
  }

  try {
    const result = await apiFetch('/v1/config', { method: 'PUT', body: JSON.stringify({ updates }) });
    state.textContent = result.restartRequired
      ? `Saved ${result.updated.length} field(s). Restart ScrapForAI for these to take effect.`
      : `Saved ${result.updated.length} field(s).`;
    await load();
  } catch (error) {
    state.textContent = `Error: ${error.message}`;
  }
});

load().catch((error) => console.error(error));
```

**`public/status.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ScrapForAI — Status</title>
  <link rel="stylesheet" href="app.css">
</head>
<body>
  <header class="topbar">
    <h1>ScrapForAI</h1>
    <nav>
      <a href="index.html">History</a>
      <a href="config.html">Configuration</a>
      <a href="status.html">Status</a>
    </nav>
    <button class="secondary" id="logout">Sign out</button>
  </header>
  <main><div id="status-root"></div></main>
  <script type="module" src="status.js"></script>
</body>
</html>
```

**`public/status.js`**

```js
import { apiFetch, el, formatBytes, formatDateTime, logout, markActiveNav } from './api.js';

markActiveNav();
document.getElementById('logout').addEventListener('click', logout);

function row(label, value) {
  return el('tr', {}, [el('td', { class: 'muted', text: label }), el('td', { class: 'mono', text: String(value) })]);
}

async function load() {
  const status = await apiFetch('/v1/status');
  const root = document.getElementById('status-root');
  const nodes = [];

  if (status.allowEvaluate) {
    nodes.push(el('div', { class: 'danger-banner', text: 'ALLOW_EVALUATE is ON — arbitrary in-page JavaScript is permitted.' }));
  }
  if (status.host === '0.0.0.0') {
    nodes.push(el('div', { class: 'warn-banner', text: 'Listening on 0.0.0.0 — this service is reachable from your network.' }));
  }

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'Service' }),
    el('table', {}, [el('tbody', {}, [
      row('PID', status.pid),
      row('Node', status.nodeVersion),
      row('Platform', status.platform),
      row('Uptime', `${status.uptimeSeconds}s`),
      row('Environment', status.nodeEnv),
      row('Listening on', `${status.host}:${status.port}`),
      row('Browser', status.browser),
      row('Active UI sessions', status.activeSessions),
    ])]),
  ]));

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'Storage' }),
    el('table', {}, [el('tbody', {}, [
      row('Data directory', status.dataDir),
      row('Artifact directory', status.artifactDir),
      row('Artifact disk usage', formatBytes(status.artifactDiskBytes)),
      row('Evidence retention', `${status.artifactRetentionHours} hours`),
      row('History retention', `${status.history.retentionDays} days / ${status.history.maxRuns} runs`),
      row('Runs indexed', `${status.history.totalRuns} (${status.history.passedRuns} passed, ${status.history.failedRuns} failed)`),
      row('Oldest run', status.history.oldestRunAt ? formatDateTime(status.history.oldestRunAt) : '—'),
    ])]),
  ]));

  const mcpSnippet = JSON.stringify({
    mcpServers: { scrapforai: { command: 'npx', args: ['tsx', 'src/mcp/server.ts'] } },
  }, null, 2);

  nodes.push(el('div', { class: 'card' }, [
    el('h2', { text: 'MCP client configuration' }),
    el('p', { class: 'muted', text: 'Add this to your agent MCP config to reach this server.' }),
    el('pre', { text: mcpSnippet }),
  ]));

  root.replaceChildren(...nodes);
}

load().catch((error) => console.error(error));
```

**Verify:**
```powershell
npm run dev
Start-Process "http://127.0.0.1:3000/ui/"
```

**Manual test checklist:**
1. `/ui/` with no session → History page loads, API calls 401 → redirected to login.
2. Wrong key → "Invalid API key", no cookie set.
3. Correct key → redirect to history; runs listed.
4. Click a row → detail dialog with steps and screenshots.
5. Config page: `ALLOW_EVALUATE` is disabled (locked); editing a limit and saving shows the
   restart-required note.
6. Status page shows correct paths and disk usage.
7. DevTools → Application → Cookies: `sfa_session` is `HttpOnly` and `SameSite=Strict`.
8. DevTools → Console: no CSP violations.

---

## T2.10 — Regression test for the new auth paths

**Create file:** `test/auth-session.test.ts`

Follow the structure of the existing tests in `test/`. Cover:

1. `GET /v1/runs` with no credentials → 401.
2. `GET /v1/runs` with a valid bearer token → 200.
3. `POST /v1/auth/login` with a wrong key → 401 and no `Set-Cookie`.
4. `POST /v1/auth/login` with the correct key → 200 with an `HttpOnly` `SameSite=Strict` cookie.
5. `GET /v1/runs` with that cookie → 200.
6. `PUT /v1/config` with the cookie but **without** `X-ScrapForAI-UI: 1` → **403**.
7. `PUT /v1/config` with the cookie **and** the header, targeting `ALLOW_EVALUATE` → **400**
   (locked field, no bearer token).
8. `GET /v1/runs/<id>/artifacts/../../../.env` → 400 or 404, never file contents.

**Verify:** `npm test` — all pass.

Item 8 is the important one. If it ever returns file contents, stop and fix `resolveArtifactPath`
before continuing.

---

# PHASE 3 — WINDOWS INSTALLER

Produces a self-contained installer requiring no pre-installed Node, no npm registry access,
and no administrator rights.

## T3.1 — Build staging script

**Create file:** `installer/Build-Staging.ps1`

```powershell
<#
.SYNOPSIS
  Assembles a self-contained ScrapForAI payload under installer/staging.

.DESCRIPTION
  Output layout:
    staging/
      node/                 portable Node runtime
      app/dist/             compiled server
      app/public/           UI assets
      app/node_modules/     production dependencies only
      app/package.json
      browsers/             pre-downloaded Playwright Chromium
      docs/                 user manual
      .env.example
#>
[CmdletBinding()]
param(
    [string]$NodeVersion = "22.17.0",
    [switch]$SkipNodeDownload
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Path $PSScriptRoot -Parent
$Staging = Join-Path $PSScriptRoot "staging"

function Write-Section { param([string]$Text) Write-Host "`n==== $Text ====" }

Write-Section "Cleaning staging"
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $Staging -Force | Out-Null

Write-Section "Building application"
Push-Location $Root
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally { Pop-Location }

Write-Section "Copying application files"
$AppDir = Join-Path $Staging "app"
New-Item -ItemType Directory -Path $AppDir -Force | Out-Null

Copy-Item (Join-Path $Root "dist")            (Join-Path $AppDir "dist")   -Recurse
Copy-Item (Join-Path $Root "public")          (Join-Path $AppDir "public") -Recurse
Copy-Item (Join-Path $Root "package.json")    $AppDir
Copy-Item (Join-Path $Root "package-lock.json") $AppDir
Copy-Item (Join-Path $Root ".env.example")    $Staging

$DocsDir = Join-Path $Staging "docs"
New-Item -ItemType Directory -Path $DocsDir -Force | Out-Null
Copy-Item (Join-Path $Root "_userManual") (Join-Path $DocsDir "_userManual") -Recurse

Write-Section "Installing production dependencies"
Push-Location $AppDir
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci --omit=dev failed" }
}
finally { Pop-Location }

if (-not $SkipNodeDownload) {
    Write-Section "Downloading portable Node $NodeVersion"
    $NodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
    $NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

    if (-not (Test-Path $NodeZip)) {
        Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
    }

    $NodeExtract = Join-Path $env:TEMP "scrapforai-node-extract"
    if (Test-Path $NodeExtract) { Remove-Item $NodeExtract -Recurse -Force }
    Expand-Archive -Path $NodeZip -DestinationPath $NodeExtract -Force

    Copy-Item (Join-Path $NodeExtract "node-v$NodeVersion-win-x64") (Join-Path $Staging "node") -Recurse
    Remove-Item $NodeExtract -Recurse -Force
}

Write-Section "Pre-downloading Playwright Chromium"
# Shipping the browser is what makes offline and corporate installs work: no install-time
# network fetch, no npx, no registry access.
$BrowsersDir = Join-Path $Staging "browsers"
New-Item -ItemType Directory -Path $BrowsersDir -Force | Out-Null

$env:PLAYWRIGHT_BROWSERS_PATH = $BrowsersDir
Push-Location $AppDir
try {
    npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw "playwright install chromium failed" }
}
finally {
    Pop-Location
    Remove-Item Env:\PLAYWRIGHT_BROWSERS_PATH -ErrorAction SilentlyContinue
}

Write-Section "Verifying staging"
$Required = @(
    "app\dist\server.js",
    "app\public\index.html",
    "app\node_modules\express",
    "node\node.exe",
    ".env.example"
)
foreach ($Item in $Required) {
    if (-not (Test-Path (Join-Path $Staging $Item))) { throw "Missing from staging: $Item" }
}

$Forbidden = @("app\src", "app\test", "app\.env")
foreach ($Item in $Forbidden) {
    if (Test-Path (Join-Path $Staging $Item)) { throw "Staging must not contain: $Item" }
}

$SizeMb = [math]::Round((Get-ChildItem $Staging -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "OK. Staging size: $SizeMb MB"
```

**Verify:**
```powershell
.\installer\Build-Staging.ps1
```
Expect ~250–350 MB (Chromium dominates; this is unavoidable and cannot be embedded into a
single executable).

---

## T3.2 — Launcher and first-run script

**Create file:** `installer/assets/Start-ScrapForAI.ps1`

```powershell
<#
.SYNOPSIS
  Starts ScrapForAI using the bundled Node runtime and browsers.
  Generates a strong API key on first run.
#>
[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = "Stop"

$InstallRoot = Split-Path -Path $PSScriptRoot -Parent
$NodeExe     = Join-Path $InstallRoot "node\node.exe"
$ServerJs    = Join-Path $InstallRoot "app\dist\server.js"
$DataDir     = Join-Path $env:LOCALAPPDATA "ScrapForAI"
$EnvPath     = Join-Path $InstallRoot ".env"

New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# First run: create .env from the template with a freshly generated key. Generating it
# beats warning about a placeholder — one fewer step, and no chance of shipping a default.
if (-not (Test-Path $EnvPath)) {
    Write-Host "First run: creating configuration..."
    Copy-Item (Join-Path $InstallRoot ".env.example") $EnvPath

    $apiKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
    (Get-Content $EnvPath -Raw) `
        -replace '(?m)^SCRAPFORAI_API_KEY=.*$', "SCRAPFORAI_API_KEY=$apiKey" `
        -replace '(?m)^HOST=.*$', 'HOST=127.0.0.1' `
        | Set-Content $EnvPath -NoNewline

    Write-Host ""
    Write-Host "Your API key (also stored in $EnvPath):" -ForegroundColor Green
    Write-Host "  $apiKey"
    Write-Host ""
}

$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $InstallRoot "browsers"
$env:SCRAPFORAI_DATA_DIR      = $DataDir
$env:NODE_ENV                 = "production"

$port = 3000
$portLine = Select-String -Path $EnvPath -Pattern '^PORT=(\d+)' | Select-Object -First 1
if ($portLine) { $port = [int]$portLine.Matches[0].Groups[1].Value }

if (-not $NoBrowser) {
    Start-Job -ScriptBlock {
        param($u)
        Start-Sleep -Seconds 3
        Start-Process $u
    } -ArgumentList "http://127.0.0.1:$port/ui/" | Out-Null
}

Write-Host "Starting ScrapForAI on http://127.0.0.1:$port ..."
& $NodeExe $ServerJs
```

**Create file:** `installer/assets/Register-ScrapForAITask.ps1`

```powershell
<#
.SYNOPSIS
  Registers ScrapForAI to start at logon via Scheduled Task.

.NOTES
  A Scheduled Task is used rather than a Windows Service because it needs no administrator
  rights, which keeps the whole install per-user. For a machine-wide service install, wrap
  Start-ScrapForAI.ps1 with NSSM instead.
#>
[CmdletBinding()]
param([switch]$Unregister)

$ErrorActionPreference = "Stop"
$TaskName = "ScrapForAI"

if ($Unregister) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName'."
    return
}

$InstallRoot = Split-Path -Path $PSScriptRoot -Parent
$StartScript = Join-Path $PSScriptRoot "Start-ScrapForAI.ps1"

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`" -NoBrowser"
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered '$TaskName' to start at logon."
```

---

## T3.3 — Inno Setup script

**Prerequisite:** install Inno Setup 6 (https://jrsoftware.org/isdl.php).

**Create file:** `installer/ScrapForAI.iss`

```pascal
; ScrapForAI installer
; Build:  iscc installer\ScrapForAI.iss
; Requires installer\staging to exist (run Build-Staging.ps1 first).

#define AppName        "ScrapForAI"
#define AppVersion     "1.0.0"
#define AppPublisher   "Punto Exe"
#define AppExeName     "Start-ScrapForAI.ps1"

[Setup]
AppId={{7C3A5E10-2C4A-4C9E-9E1B-9A3F0B7D4E21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
; Per-user install into LocalAppData: no administrator rights required.
DefaultDirName={localappdata}\{#AppName}\app
DefaultGroupName={#AppName}
PrivilegesRequired=lowest
OutputDir=output
OutputBaseFilename=ScrapForAI-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"
Name: "pt"; MessagesFile: "compiler:Languages\Portuguese.isl"

[Tasks]
Name: "startatlogon"; Description: "Start ScrapForAI automatically at logon"; GroupDescription: "Startup"
Name: "desktopicon";  Description: "Create a desktop shortcut";               GroupDescription: "Shortcuts"; Flags: unchecked

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "assets\Start-ScrapForAI.ps1";          DestDir: "{app}\assets"; Flags: ignoreversion
Source: "assets\Register-ScrapForAITask.ps1";   DestDir: "{app}\assets"; Flags: ignoreversion

[Icons]
Name: "{group}\ScrapForAI Console"; \
  Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  WorkingDir: "{app}"

Name: "{group}\User Manual"; Filename: "{app}\docs\_userManual\index.html"

Name: "{group}\Uninstall ScrapForAI"; Filename: "{uninstallexe}"

Name: "{userdesktop}\ScrapForAI"; \
  Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Register-ScrapForAITask.ps1"""; \
  Tasks: startatlogon; Flags: runhidden

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Start-ScrapForAI.ps1"""; \
  Description: "Start ScrapForAI now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\assets\Register-ScrapForAITask.ps1"" -Unregister"; \
  Flags: runhidden; RunOnceId: "UnregisterTask"

[UninstallDelete]
; Remove generated config, but never the user's run history or artifacts.
Type: files; Name: "{app}\.env"
Type: files; Name: "{app}\.env.bak"
```

> **Deliberate choice:** uninstall removes `.env` but leaves `%LOCALAPPDATA%\ScrapForAI\`
> (history and artifacts) intact. Never delete user data on uninstall without asking.

---

## T3.4 — Release build script

**Create file:** `installer/Build-Release.ps1`

```powershell
[CmdletBinding()]
param([string]$Version = "1.0.0")

$ErrorActionPreference = "Stop"

Write-Host "==== ScrapForAI release build $Version ===="

& (Join-Path $PSScriptRoot "Build-Staging.ps1")
if ($LASTEXITCODE -ne 0) { throw "Staging failed" }

$Iscc = Get-Command iscc -ErrorAction SilentlyContinue
if (-not $Iscc) {
    $Candidate = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
    if (Test-Path $Candidate) { $Iscc = $Candidate }
    else { throw "Inno Setup (iscc) not found. Install from https://jrsoftware.org/isdl.php" }
}

$IssPath = Join-Path $PSScriptRoot "ScrapForAI.iss"
& $Iscc "/DAppVersion=$Version" $IssPath
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed" }

$Output = Join-Path $PSScriptRoot "output\ScrapForAI-Setup-$Version.exe"
$SizeMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)

Write-Host ""
Write-Host "Installer: $Output ($SizeMb MB)" -ForegroundColor Green
Write-Host "SHA256:    $((Get-FileHash $Output -Algorithm SHA256).Hash)"
```

**Verify:**
```powershell
.\installer\Build-Release.ps1 -Version 1.0.0
```

---

## T3.5 — Clean-machine install test

Test on a VM or a machine **without** Node installed. All of these must pass:

1. Installer runs without an administrator prompt.
2. Node is not required as a prerequisite.
3. First launch prints a generated API key and creates `.env`.
4. Browser opens `http://127.0.0.1:3000/ui/`.
5. Login with the printed key succeeds.
6. A routine runs end-to-end against an allowlisted origin (proves the bundled Chromium is
   found via `PLAYWRIGHT_BROWSERS_PATH`).
7. The run appears in History with screenshots.
8. Reboot → the service is running (if "start at logon" was selected).
9. Uninstall removes the program but leaves `%LOCALAPPDATA%\ScrapForAI\history\runs.jsonl`.
10. **Network check:** from another machine, `curl http://<ip>:3000/health` must **fail** —
    confirming the loopback default.

**Record the results in `docs/INSTALL-TEST-RESULTS.md`.**

---

# PHASE 4 — RELEASE HYGIENE

## T4.1 — Package metadata

**Edit file:** `package.json`

```json
{
  "name": "scrapforai",
  "version": "1.0.0",
  "description": "Security-first Playwright exploration runner for controlled development and test sites.",
  "author": "Punto Exe",
  "license": "UNLICENSED",
  "private": true,
  "engines": {
    "node": ">=22.0.0"
  }
}
```

Add these scripts to the `scripts` block (keep all existing ones):

```json
    "start:ui": "node dist/server.js",
    "release": "powershell -NoProfile -ExecutionPolicy Bypass -File installer/Build-Release.ps1"
```

> Change `license` and `author` to match the real intent. `UNLICENSED` + `private: true`
> prevents accidental publication to the public npm registry — deliberate for a commercial
> product. If this is meant to be open source, set an SPDX identifier instead.

---

## T4.2 — Documentation

**Edit `README.md`** — add these sections:

- **Install (end users):** download the installer, run it, sign in with the generated key.
- **Install (developers):** `npm ci`, `npx playwright install chromium`, `cp .env.example .env`, `npm run dev`.
- **Web UI:** what the three screens do; the API key → session cookie model.
- **Run history:** the two-tier retention model, with the table from §1.1 of this plan.
- **Building the installer:** `.\installer\Build-Release.ps1 -Version x.y.z`.

**Create `docs/SECURITY.md`** covering:

- The threat model: this drives a real browser and must only target allowlisted dev/test origins.
- Why `ALLOW_EVALUATE` is dangerous and must stay `false` outside trusted local use.
- Why `HOST` defaults to `127.0.0.1`.
- The bearer-token vs. session-cookie split, and why locked fields require the bearer key.
- How to rotate the API key.
- How to report a vulnerability.

**Update `_userManual/`** (en/es/pt) with screenshots of the three new screens.

---

## T4.3 — Release checklist

**Create `docs/RELEASE-CHECKLIST.md`:**

```markdown
# Release checklist

## Pre-release
- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] `npm run test:smoke` green
- [ ] Version bumped in package.json and ScrapForAI.iss
- [ ] README and user manual updated
- [ ] CHANGELOG entry written

## Security gate
- [ ] `.env` and `local-api-key.txt` are NOT in `git ls-files`
- [ ] No secret appears in `git log -p`
- [ ] Default `HOST` is `127.0.0.1`
- [ ] Default `ALLOW_EVALUATE` is `false`
- [ ] Unauthenticated `/v1/runs` returns 401
- [ ] Cookie-auth `PUT /v1/config` without `X-ScrapForAI-UI` returns 403
- [ ] Path traversal via `/v1/runs/:id/artifacts/..%2f..` returns 400/404
- [ ] No CSP violations in the browser console

## Build
- [ ] `.\installer\Build-Release.ps1 -Version x.y.z` succeeds
- [ ] Installer size is within ~50 MB of the previous release
- [ ] SHA256 recorded in release notes

## Clean-machine test
- [ ] All 10 checks in T3.5 pass
- [ ] Results recorded in docs/INSTALL-TEST-RESULTS.md

## Publish
- [ ] Git tag `vX.Y.Z`
- [ ] Installer + SHA256 attached to the release
```

---

# APPENDIX A — COMPLETE FILE MANIFEST

### New files

| Path | Task | Purpose |
|---|---|---|
| `src/config/paths.ts` | T1.1 | Platform-aware data locations |
| `src/history/runSummary.ts` | T1.3 | Compact run record schema |
| `src/history/runHistoryStore.ts` | T1.4 | JSONL index: load, append, filter, prune |
| `src/history/summarizeResult.ts` | T1.5 | ExplorationResult → RunSummary |
| `src/routes/runs.routes.ts` | T1.8 | History + artifact APIs |
| `src/security/cookies.ts` | T2.1 | Dependency-free cookie handling |
| `src/security/sessionStore.ts` | T2.2 | In-memory sessions |
| `src/routes/auth.routes.ts` | T2.4 | login / logout / me |
| `src/routes/config.routes.ts` | T2.5 | Read and write `.env` |
| `src/routes/status.routes.ts` | T2.6 | Runtime and storage status |
| `public/app.css` | T2.8 | Styles (light + dark) |
| `public/api.js` | T2.8 | Shared fetch client and DOM helpers |
| `public/login.html` / `login.js` | T2.9 | Sign-in |
| `public/index.html` / `history.js` | T2.9 | Run history |
| `public/config.html` / `config.js` | T2.9 | Configuration |
| `public/status.html` / `status.js` | T2.9 | Status |
| `test/auth-session.test.ts` | T2.10 | Auth, CSRF and traversal regressions |
| `installer/Build-Staging.ps1` | T3.1 | Assemble payload |
| `installer/assets/Start-ScrapForAI.ps1` | T3.2 | Launcher + first-run key generation |
| `installer/assets/Register-ScrapForAITask.ps1` | T3.2 | Logon autostart |
| `installer/ScrapForAI.iss` | T3.3 | Inno Setup definition |
| `installer/Build-Release.ps1` | T3.4 | One-command release |
| `docs/SECURITY.md` | T4.2 | Threat model |
| `docs/RELEASE-CHECKLIST.md` | T4.3 | Release gate |

### Modified files

| Path | Tasks | Nature of change |
|---|---|---|
| `.gitignore` | T0.2 | Add secret and build-output patterns |
| `src/config/env.ts` | T1.2 | New keys; `HOST` → loopback; `ARTIFACT_DIR` resolution |
| `src/runner/runExploration.ts` | T1.6 | Append to run history after redaction |
| `src/artifacts/artifactStore.ts` | T1.7 | `path.relative` containment + resolver export |
| `src/server.ts` | T1.8, T2.7 | Mount routers, split limiters, CSP, static UI, async start |
| `src/security/apiAuth.ts` | T2.3 | Session auth + CSRF check |
| `.env.example` | T1.9 | Document new keys and defaults |
| `docker-compose.yml` | T1.9 | `SCRAPFORAI_DATA_DIR`, data volume, new keys |
| `package.json` | T4.1 | Metadata, engines, release script |
| `README.md` | T4.2 | Install, UI, history docs |

### Deleted files

| Path | Task | Reason |
|---|---|---|
| `Create-CleanScrapForAIZip-v2.ps1` | T0.4 | Superseded by `installer/` |
| `Create-ScrapForAIInstallBundle.ps1` | T0.4 | Superseded; hardcoded a wrong root path |
| `local-api-key.txt` | T0.3 | Plaintext secret |

---

# APPENDIX B — NEW ENVIRONMENT VARIABLES

| Key | Default | Restart? | Purpose |
|---|---|---|---|
| `SCRAPFORAI_DATA_DIR` | platform-specific | Yes | Overrides the data root |
| `HISTORY_RETENTION_DAYS` | `90` | Yes | Run index retention |
| `HISTORY_MAX_RUNS` | `5000` | Yes | Hard cap on indexed runs |
| `UI_ENABLED` | `false`¹ | Yes | Serve the web UI at `/ui` |
| `SESSION_TTL_MINUTES` | `480` | Yes | UI session lifetime |

¹ `booleanFromEnv` defaults to `false`. `.env.example` sets `UI_ENABLED=true` (T1.9), and the
installer copies that template, so shipped installs have the UI on.

### Changed defaults

| Key | Old | New | Why |
|---|---|---|---|
| `HOST` | `0.0.0.0` | `127.0.0.1` | Do not expose a browser-automation engine to the LAN by default |
| `ARTIFACT_DIR` | `/app/artifacts` | user data dir | The old value was a Linux container path used as a Windows default |

---

# APPENDIX C — API SURFACE AFTER THIS PLAN

| Method | Path | Auth | Added by |
|---|---|---|---|
| GET | `/health` | none | existing |
| GET | `/v1/schema/*` | none | existing |
| GET | `/ui/*` | none (static assets only) | T2.7 |
| POST | `/v1/auth/login` | none (rate limited 10/15min) | T2.4 |
| POST | `/v1/auth/logout` | session | T2.4 |
| GET | `/v1/auth/me` | bearer or session | T2.4 |
| POST | `/v1/explorations/run` | bearer or session (30/min) | existing |
| POST | `/v1/explorations/inspect-dom` | bearer or session (30/min) | existing |
| GET | `/v1/runs` | bearer or session | T1.8 |
| GET | `/v1/runs/stats` | bearer or session | T1.8 |
| GET | `/v1/runs/scenarios` | bearer or session | T1.8 |
| GET | `/v1/runs/:jobId` | bearer or session | T1.8 |
| GET | `/v1/runs/:jobId/artifacts/*` | bearer or session | T1.8 |
| GET | `/v1/config` | bearer or session | T2.5 |
| PUT | `/v1/config` | session + CSRF header; **bearer for locked fields** | T2.5 |
| GET | `/v1/status` | bearer or session | T2.6 |
| GET | `/v1/debug/config` | bearer or session | existing |

---

# APPENDIX D — TROUBLESHOOTING

**`Cannot find module './paths.js'`** — relative imports must end in `.js` even in TypeScript
source, because `moduleResolution` is `NodeNext`. Check the extension.

**`env.ARTIFACT_DIR is possibly undefined`** — T1.2 Change 5 was not applied. The `env` export
must spread `parsedEnv` and supply the `ARTIFACT_DIR` fallback.

**UI loads but every request 401s** — confirm `isPublicPath()` in T2.3 exempts `/ui/*`, and
that the cookie exists in DevTools → Application → Cookies.

**`PUT /v1/config` returns 403** — the `X-ScrapForAI-UI: 1` header is missing. `api.js` sets it
on every request; verify the page uses `apiFetch` rather than bare `fetch`.

**Screenshots 404 in the detail dialog** — the artifact directory was pruned
(`ARTIFACT_RETENTION_HOURS`, default 4). Expected for older runs; the UI shows the
"Evidence expired" banner. If it happens for a run seconds old, check that `ARTIFACT_DIR` in
`/v1/status` matches where the runner actually wrote.

**CSP violations in the console** — an inline `<script>` or `style` attribute crept in. All JS
must live in external `.js` files under `public/`.

**`playwright install chromium` fails during staging** — corporate proxy. Set
`HTTPS_PROXY` before running, or copy a working `%LOCALAPPDATA%\ms-playwright` into
`installer/staging/browsers`.

**Installer built but the app will not start on a clean machine** — almost always a missing
`PLAYWRIGHT_BROWSERS_PATH`. Confirm `Start-ScrapForAI.ps1` sets it before launching Node, and
that `staging/browsers/` was populated.
