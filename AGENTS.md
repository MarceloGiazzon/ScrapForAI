# ScrapForAI

Security-first Playwright exploration runner for controlled development and test sites. It runs as an
authenticated REST API (Express) that drives a real browser (Playwright) against an **allowlisted** set
of target origins, and returns structured, redacted results — screenshots, console/network evidence,
extracted data — rather than raw page control.

## Setup

```
npm install
cp .env.example .env   # then set SCRAPFORAI_API_KEY and ALLOWED_TARGET_ORIGINS
npm run dev             # http://localhost:3000
npm test                # unit tests (test/*.test.ts)
npm run typecheck
```

`.env` is gitignored and required: the server refuses to start without a `SCRAPFORAI_API_KEY` (16+
chars) and at least one `ALLOWED_TARGET_ORIGINS` entry. See `.env.example` for every tunable (timeouts,
step limits, artifact retention, etc.).

## Security model — read before changing anything here

- **Target URL allowlisting** (`src/security/validateTargetUrl.ts`): every navigation, including
  mid-routine redirects, is re-checked against `ALLOWED_TARGET_ORIGINS`. Localhost, private IPs, and
  cloud metadata endpoints are blocked unless explicitly allowlisted. Don't add a navigation path that
  skips this check.
- **Secret redaction** (`src/security/redactSecrets.ts`): credential/variable values and sensitive-
  looking DOM attributes are redacted from every response and log line.
- **Credential vault** (`src/vault/credentials/`): secrets live encrypted (AES-256-GCM) on the server and are
  referenced by id: a request passes `credentialSet: 'gam-admin'`, the server loads the fields, and steps
  use `valueFromCredential` by name. Each set is **bound to origins**: a `fill` of a vault value on any other
  origin fails with `CredentialOriginMismatch`. Values are write-only (`POST/PUT/DELETE /v1/credentials/:id`,
  bearer only; `GET` returns metadata). The MCP `run_exploration` schema has **no** `credentials` field, so a
  model never writes or sees a secret on the MCP path. Key: `SCRAPFORAI_VAULT_KEY` or `<dataDir>/vault.key`.
  *Legacy:* the REST API still accepts inline `credentials` (deprecated, logged; set
  `ALLOW_INLINE_CREDENTIALS=false` to refuse them). Inline values are redacted from outputs but are not
  origin-bound. `samples/*.json` must only contain placeholders (`test/samples-hygiene.test.ts`).
- **Target profiles** (`src/targets/`): named app+environment definitions (`targetProfile: 'app-dev'`) that supply
  the default `targetUrl` and the credential sets a run may use. A profile can never widen
  `ALLOWED_TARGET_ORIGINS`; `PUT /v1/targets/:id` needs the bearer token.
- **Routine library** (`src/library/`): a routine is data. `PUT /v1/routines/:id` stores it as an immutable,
  numbered version (`<libraryDir>/<id>/v<N>.json`, digest in `sha256`; identical content creates no new version;
  a hand-edited version fails its integrity check). Saving **lints** the steps: a literal equal to a vault value, or
  shaped like a known secret (API keys, JWT, ...), is refused with `RoutineLintError` (422). `fromJobId` saves the
  steps of a run that passed while its evidence still exists (`request.json`, credentials stripped).
  `POST /v1/routines/:id/run[?version=N]` runs a pinned or current version; the result and history carry
  `routineId`/`routineVersion`. `ROUTINE_LIBRARY_DIR` may point into a git repo.
  **Composition** (`src/library/includeExpander.ts`): a step `{ action: 'include', routineId, version? }` is expanded
  server-side before the run (the runner never sees it); expanded ids are prefixed `<includeId>.<stepId>`. Max 3
  levels, cycles refused (also at save, including a routine that includes itself), an included routine must be on the
  same target profile and not `retired`, and the versions actually used are recorded in `result.includes`. Without
  `version` the CURRENT one is used, so pin it for reproducible proof. `teardown` (routine or request) always runs
  after the steps, like `finally`: own teardown first, then those of included routines, last-included first. Its
  results are in `result.teardown` and `result.teardownStatus`; they never change `status` (the verdict of the
  steps) and a teardown failure never replaces a step failure. Steps + teardown share `MAX_STEPS_PER_JOB`.
- **Evidence retention** (`src/evidence/`): every run writes `manifest.json` (sha256 of each file and of
  `result.json`). Classes: `ephemeral` (default, `ARTIFACT_RETENTION_HOURS`), `standard`
  (`options.retention: 'standard'`, `STANDARD_RETENTION_DAYS`) and `pinned`. `POST /v1/runs/:jobId/pin`
  (bearer only; `{ reason, ref?, keepTrace? }`) moves the evidence to `<dataDir>/evidence/pinned/<jobId>/`, outside
  the artifact root so no prune reaches it. A pin verifies the run's manifest first (tampered evidence is
  refused, 409), drops `trace.zip` unless `keepTrace`, and is refused with 409 `PinnedQuotaExceeded` past
  `PINNED_EVIDENCE_MAX_MB` — pinned evidence is never deleted automatically. `GET /v1/runs/:jobId/manifest`
  re-verifies on demand. Pinned runs also keep their history entry past `HISTORY_RETENTION_DAYS`.
- **Suites and the job queue** (`src/orchestrator/`): `POST /v1/suites` (routines × `variants.credentialSets` ×
  `variants.targetProfiles`) answers **202** with a `suiteRunId` and runs in the background; `GET /v1/suites/:id[?wait=N]`
  long-polls (max 55 s, so no client timeout is hit by a long suite), `POST /v1/suites/:id/cancel` stops starting new
  runs. State is persisted in `<dataDir>/suites/<id>.json`; a suite left `running` by a dead process is closed as
  `interrupted` at startup. Each variant has a readable `variantKey` (`crud@v2/cred:gam-admin/target:qa`), the
  routine version is pinned when the suite starts, and `active` and `quarantined` routines run (default `statuses`; draft/retired are listed as not run, and so is a quarantined one when `statuses` leaves it out).
  **Quarantine (T3.5)**: a quarantined routine (or a regression-vault item with status QUARANTINED) RUNS, marks its variant `quarantined: true` (pinned at planning) and is reported apart, but it is NOT in the verdict, `failFast`,
  the exit code or the report's counts: its result is in `state.quarantine` (`total/passed/failed/error/notRun`) and the verdict reason says how many did not pass. A suite where only quarantined routines ran is `infra-error` (nothing
  that counts was verified). `retries: 1` on the request tries a variant that FAILED once more (see Flakiness). `failFast` stops at the first red run. **One verdict**: `green` (exit 0),
  `red` (1: a run failed), `infra-error` (2: a run could not execute, nothing ran, or it was cancelled); a failed
  teardown is counted in `teardownFailures` but does not change it. All runs share one pool (`MAX_PARALLEL_JOBS`) with
  priority interactive > suite > scheduled, and `INTERACTIVE_RESERVED_SLOTS` are never given to suites. **A credential
  set is never in two sessions at once** (limit `flags.maxSessionsPerCredential` of the profile, default 1): suite
  variants wait for the lock, and a synchronous run that needs a busy credential gets **409 `CredentialInUse`**.
  **Samples (T5.4)**: `samples: N` (1-100) and `seed` on the suite request multiply every PARAMETRIC routine (own `parameters`, an inline
  generator, or parameters/generators of an included routine) by sample `0..N-1`, with `/sample:<i>` in the `variantKey`, after credential sets and
  target profiles; a routine that draws no value runs once. Samples count against the 500-run limit (`SuiteTooLarge`). All samples draw from ONE seed
  (the caller's, or a fresh one in `state.seed`; absent when the suite has neither `samples` nor `seed`), so replaying the suite with it repeats every
  row. Each parametric variant records `sample`, `parameters` (the values typed), `synthetic` and `extracted` (a flat copy, max 20 keys x 200 chars; the
  evidence stays in the run) = the parameters -> status -> extracted table; `scrapforai suite` prints it under each line. Edge samples are out of range ON
  PURPOSE: a routine that expects success for every sample turns red on them. Not done: cartesian combinations of several parameters (they still move
  together, one sample index for all), a samples table in the report, and the functional profile is the caller's choice (`profile: 'functional'`).
- **Signed evidence** (`src/evidence/signature.ts`, `chain.ts`, `verify.ts`, `export.ts`): every PINNED manifest is signed
  with the installation's Ed25519 key (`<dataDir>/signing/ed25519.key`, owner-only; `keyId` = sha256 of the public key) and
  carries `chain: { sequence, previousManifestSha256 }`, so removing or editing one manifest breaks the next link, a gap in
  the sequence shows a removal, and a high-water mark (`pinned/chain.json`) shows removal of the latest ones.
  `GET /v1/evidence/chain[?deep=1]` walks it; `GET /v1/runs/:jobId/export` (pinned only) returns a .zip with the files, the
  signed manifest, `public-key.pem` and a README; `scrapforai evidence verify <folder>` checks it with no server
  (`--expected-key-id` to also prove WHO signed: a key that travels with the files only proves the bundle is self-consistent).
  Evidence pinned before signing existed is listed as `unsigned`, not trusted, and cannot be exported.
  **What a signature proves**: integrity and origin (this installation signed exactly these files). **Not** that the test was
  correct, and not anything about a machine whose private key or whole data directory is compromised. `signature.ts` and
  `verify.ts` import no configuration on purpose, so verification works anywhere.
- **Reports** (`src/reports/`): `GET /v1/runs/:jobId/report` and `GET /v1/suites/:id/report` (`?format=html|pdf&lang=en|pt|es`;
  `scrapforai report <id> --out file`) give a homologation report: application, environment, build, date, executor, routine
  and version, verdict, steps with times, failure screenshot, console/network summary, teardown warning, and a footer with the
  signing `keyId`, manifest sha256 and chain position (or an explicit "not signed / expired"). The HTML is one
  self-contained file (screenshots embedded) under a CSP without scripts; EVERYTHING from a run is escaped (`esc()`), and the
  PDF is printed by the same Chromium with every network request aborted. A suite report is refused (409) while it runs. A
  report needs the run's evidence to still exist: pin what you will report on. `render.ts`/`i18n.ts` are pure.
- **Regression vault** (`src/vault/regression/`): a fixed bug or hard scenario kept as permanent proof, one
  `<ITEM-ID>.json` per item (`REGRESSION_VAULT_DIR` may point into a git repo). An item pins a library routine
  (id + version) and two pieces of PINNED evidence: `provenRed` (the failing run) and `firstGreen` (the first
  passing run on a fixed build), each with the sha256 of its pinned manifest and the `buildId`. **Evidence cannot be
  typed in**: `PUT /v1/vault/:id` writes only the definition; `POST /v1/vault/add-from-run` (bearer) takes a run that
  FAILED, saves its routine, pins it as RED and creates the item; `POST /v1/vault/:id/confirm-green` (bearer) runs the
  same routine version and, only if it passes, pins it as `firstGreen` (still red = 409, item untouched; `firstGreen`
  is never overwritten). An item without `provenRed` needs `redNotCapturedReason`. `POST /v1/vault/:id/run` runs one
  item and records `lastRun`. A suite item `{ vault: { status?, type?, tags?, surface? } }` expands to the matching
  items (default ACTIVE); with `order: 'impact'` they are ordered by: surface touched (explicit `impact.surfaces`, or a
  changed file matching the `surfaces` globs of the target profile) > failed in its last 5 runs > severity > id, and
  every run records the reasons (`POST /v1/vault/plan` shows the order without running). `buildId` (request/suite
  field) is recorded in results and in evidence references.
- **Permission matrix** (`src/permissions/`, T6.1): roles (credential sets of ONE target profile) x probes: `url` (open it
  directly, not through the menu), `control` (on the page at `url`, is `selector` hidden/enabled/disabled) and `action` (run a
  library routine). `deniedWhen` says how the app shows a denial (`urlContains` of the login/NotAuthorized page, `textVisible`,
  HTTP `status`). `PUT /v1/permissions/:id` stores it (roles must be in the profile's `credentialSets`, probe URLs inside the
  allowlist, paths like `/admin` resolve against `baseUrl`; a `loginRoutine` that fills with `valueFromCredential` is required);
  `POST /v1/permissions/:id/run` answers 202 with a `runId` (`GET /v1/permissions/runs/:runId[?wait=N]`). Sessions go through
  the job queue with suite priority and the credential lock: `perRole` = one login per role for its pages (chunked to
  `MAX_STEPS_PER_JOB`/`JOB_TIMEOUT_MS`), `perProbe` = one per page probe; each action is its own session. The read step is
  the new `probePage` (never fails: url, navigation status, which denial texts are present, selector count/visible/enabled).
  Each cell is allowed/denied/error (controls: hidden/enabled/disabled) with its `jobId`; `expected` (role -> probe) is checked
  (a control on a denied page counts as hidden), and every run is diffed against the previous completed run of the same
  matrix and profile: a gain of access that no expectation covers is an **alert**. Verdict: red (1) on an unmet expectation or
  an alert, and red wins over infra-error (2: a cell could not be answered, e.g. `LoginFailed`, or an action that failed with no
  denial signal); green (0) otherwise. Departures from Appendix A.7, because T4.1/T4.2/T8.1 do not exist yet: `control` takes
  a `url` (`screen` is only a label), the diff is against the previous run (not the previous release), the login routine is explicit.
  **Direct-URL probing (T6.2)**: the target profile's `screens` (minimal T4.2 shape: `{ id, name, reach: { url } | { routineId }, offeredTo? }`)
  feed the matrix. `screensFromCatalog: true` adds, at run time, a `url` probe `screen-<id>` per screen with `reach.url` for every
  role (screens reachable only by a routine are not probed; the stored matrix is not changed, the run records the effective one). `offeredTo`
  (also accepted on a hand-written `url` probe) lists the roles whose MENU shows the page: a role not listed is expected **denied**, and
  getting the page by URL anyway is red with `counts.unofferedAccess` and `expectedBy: 'menu'` on the cell. A written `expected` wins over
  the menu; a screen without `offeredTo` makes no claim. Catalogue URLs go through the same allowlist check. The catalogue is written by hand
  (`PUT /v1/targets/:id`) until T4.2's assisted discovery and T8.5's generation from the NPDev model exist.
- **Build context** (`src/runner/buildProbe.ts`, T3.1): the target profile's `buildInfo` (`httpHeader` | `jsonEndpoint` | `selectorText` |
  `provided`) says where the app reports its build. After the steps and teardown, when the caller gave no `buildId`, the runner reads it
  in the run's own browser context (so a value behind the login answers), on a second page / the context's request client, so the run's
  evidence is untouched. The URL is allowlist-checked, redirects are not followed, and any failure is `buildId: "unknown"`: a probe never
  fails a run. The value is made safe for `buildIdSchema` (spaces -> `_`, other characters dropped, 100 chars). `result.buildId` +
  `result.buildIdSource` (`provided` | `probe` | `unknown`) and the history summary carry it, and pinning records it in the manifest. A
  `buildId` in the request always wins. `jsonPath` takes `a.b[0].c`, `$.a`, and keys with dots in their name (`npdev.builtAt`).
  `wmsoffice-dev` uses `jsonEndpoint /actuator/info` + `npdev.builtAt`.
- **Structural diff** (`src/diff/`, T4.1): `structuralDiff(before, after, { config })` compares two JSON documents by IDENTITY, not
  index, and returns a `ChangeSet` (`added`, `removed`, `changed[{ path, before, after }]`, each with a short `summary`, sorted
  by path, `truncated` at `maxChanges`). An array of objects is matched on a key (`identityKeys[<generic path>]` in the config,
  else `key`/`id`/`name` present on every item), scalar arrays are multisets, and only `ordered` arrays (or ones with no usable
  identity) are compared by position, so reordering is never a change. Normalizers, per target profile (`diff`, schema in
  `src/schemas/diffConfig.schema.ts`): GeneXus grid row suffix (`vNAME_0001` -> `vNAME`; rows that collapse to one key are told
  apart as `key`, `key#2`...), web-component prefix (`W0012vNAME` -> `vNAME`), `maskPatterns` (regex -> constant), `numericTolerance`
  (absolute/relative) and `ignorePaths` (`*` one segment, `**` anything; tested against `fields[].id` and `fields[key=cep].id`).
  Row suffix and prefix apply to identities and to `keyProperties` (default key/id/name/selector/targetKey); masks apply to every
  string. A string over 2000 chars skips the user masks (bounded cost against a catastrophic regex) but is never truncated. Pure,
  no configuration import. Consumers still to come: T4.4 snapshots, T6.3, T7.5.
- **Screen inventory** (`src/inventory/`, `src/runner/extractStructure.ts`, T4.3): what a screen IS, never what it HOLDS. `inspect_dom` with
  `includeStructure: true` returns `structure` (fields with label/required/enabled/visible/maxLength/select option labels, actions,
  grids with header cells); `deriveScreenInventory(structure, { screenId, config })` turns it into the Appendix A.10 `ScreenInventory`
  (`src/schemas/screenInventory.schema.ts`). No field value, typed text or cell text is read: labels come from `<label>` own text, aria,
  placeholder or title (a wrapping label never includes the control's content), a select with more than 100 options is data and its
  options are left out, `type=hidden` inputs are excluded, layout tables (no header cells) are not grids. Key = `name`, else `id`, else
  a label slug, through the diff normalizers; same key twice -> `key`, `key#2` (document order), radios with one name are ONE field;
  controls with nothing to build a key from are counted in `unkeyed`. Lists are sorted by key (stable files in git).
  `diffInventories()` is `structuralDiff` with the inventory identities. `test/screen-inventory.smoke.ts` proves no seeded value leaks.
- **System evolution snapshots** (`src/evolution/`, T4.4): `POST /v1/evolution/snapshots` (202, then
  `GET /v1/evolution/snapshots/:id[?wait=N]`, `POST .../cancel`; `GET /v1/evolution/:target` lists what is stored;
  `scrapforai evolution snapshot|list`) reads every screen of the target profile's catalogue (`screens`) with the new read-only
  step `captureInventory` (`extracted[name]` = value-free structure, see Screen inventory) and writes
  `SYSTEM_EVOLUTION_DIR/<target>/<AAAA-MM-DD>_<buildId>/` = `snapshot.json` (build, `buildIdSource`, environment, per-file sha256, `complete`,
  `notCaptured`) + `screens/<id>.json` (inventory) + `screens/<id>.png`. Sessions go through the job queue (suite priority, credential
  lock) with ONE login per credential set (`screen.credentialSet`, else the profile's first set; the profile's `loginRoutine` is
  required when it has credential sets; a screen with `reach.routineId` is its own session, run after the login). The build is the
  caller's `buildId`, else the profile's `buildInfo` probe (T3.1), else `unknown` (never idempotent, folder `unknown-<HHMMSS>`).
  **Idempotent per build**: a build that already has a snapshot is refused (409 `SnapshotExists` up front when `buildId` is given,
  a `failed` run when it was probed) unless `force`, which replaces it. **All or nothing**: if any wanted screen could not be
  captured NOTHING is written (a missing screen would later read as "removed") unless `allowPartial`, which writes the rest, marks
  `complete: false`, lists `notCaptured` and exits 2. `screenshots: false` / `--no-screenshots` for environments with real data.
  The folder is assembled aside and renamed in; when `SYSTEM_EVOLUTION_DIR` is inside a git work tree the target's folder (and only
  it) is committed as `evolution(<target>): <buildId>` via `child_process` (no dependency); a git failure is a warning, never a
  failed capture. Run state: `<dataDir>/evolution-runs/<id>.json` (outside the evolution dir), left `running` by a dead process ->
  `interrupted` at startup. Exit 0 only for a complete snapshot; 2 otherwise (this is not a test verdict, there is no 1).
  **Comparing builds** (`src/evolution/compare.ts` pure, `evolutionService.ts` I/O; T4.5-T4.7): `GET /v1/evolution/:target/diff[?from=&to=&format=md]`
  (refs: build id, `latest`, `previous`; default = latest vs the one before it) reads both snapshots back **verifying each inventory against the
  sha256 in `snapshot.json`** (edited -> 409 `SnapshotTampered`, missing -> `SnapshotIncomplete`) and returns, per screen, `added`/`removed`/
  `changed`/`unchanged`/`unknown` with each change in plain deterministic words (`+ field Phone (phone) (text, optional)`, `~ field Zip (zip) is
  now required`, `+ column "Total" in grid orders`), in `markdown` too. A screen that failed to capture in either snapshot is `unknown`, never
  `removed`/`added`. The target profile's `diff` config applies. **Expected vs unexpected**: `PUT /v1/evolution/:target/expected/:buildId`
  (`{ buildId, expected: [{ screen|"*", kind: added|removed|changed|*, path?, ref?, note? }] }`, stored and committed as
  `<target>/expected/<build>.json`) declares what a build is supposed to change; the diff against it marks every change `expected` (with its
  `ref`) or `unexpected`, and `scrapforai evolution diff` exits **1** only when the newer build DECLARED its changes and others happened
  (a build with no declaration is not classified, so nothing is an alert). `POST /v1/evolution/:target/changes { from?, to?, narrative? }` writes
  `CHANGES.md` into the newer snapshot folder and commits it: the deterministic section always, and the agent's `narrative` (max 20 000 chars)
  after it under "Narrative (AI-generated summary, not verified)" (P7: the server calls no model). `GET .../timeline[?screen=&key=&since=&limit=]`
  lists the changes between consecutive snapshots oldest first, and with `key` says where that control is now and when it was first seen
  (`isFirstSnapshot: true` = earlier history unknown). Not done: the timeline in the web UI, deriving expected changes from the ledger,
  localizing CHANGES.md (English only). `test/evolution-history.test.ts` covers it end to end without a browser.
  Not in the snapshot yet: `perf.json` (the T3.4 series exists but is not wired in), accessibility summary (T7.5) and the permission matrix (T6.1 results) - those
  producers do not exist or are not wired. `test/evolution-snapshot.smoke.ts` proves no seeded value or password reaches disk, the
  run state or the git history.
- **Network routing** (`src/runner/routing.ts`, T5.1): the ONE `context.route('**/*')` of a browser context, created in
  `createPlaywrightContext` (so runs and `inspect_dom` share it). Policies are composed in a fixed order: allowlist guard
  (`BLOCK_UNEXPECTED_RESOURCES=true`: a sub-resource, websocket included, from an origin in neither `ALLOWED_TARGET_ORIGINS` nor
  `ALLOWED_RESOURCE_ORIGINS` is **aborted**), then fault injection (T7.2) and resource policy (T5.2) through the `faults` / `resources`
  slots of `buildPolicies`, then the request continues. **With no active policy nothing is installed**, so a default run is byte-for-byte
  what it was. Main-frame navigations are NOT the guard's business (`validateTargetUrl` still owns them) and `data:`/`blob:`/`about:`
  never leave the browser. Every request a policy touched is recorded in `result.evidence.routing` (`origin`, `pathname` without the
  query, `handledBy`, `action`; present only when non-empty, capped at 200); a request ABORTED or ANSWERED by policy (a stand-in) is still listed in
  `unexpectedExternalRequests` (that is the evidence) but a browser-side failure of it (an aborted block, or Chromium cancelling a media request answered with 204) is not counted in `networkFailures`, because the application did not fail.
  A policy that throws fails open for that request. Off by default: a page that depends on a CDN would break.
- **Functional profile** (`options.profile: 'full' | 'functional'`, `options.resourcePolicy.stub`, T5.2): `functional` answers images with a 1x1
  transparent PNG (a real picture, so `onload` fires and clickable icons still exist), media and fonts with 204, through the `resources` slot of the
  routing layer (T5.1), and turns **screenshots and trace off** whatever the options say (`result.profile: 'functional'` records it; a `full` run has
  no such field). **CSS is never stubbed** (the schema refuses `stylesheet` by name: visibility depends on it); fetch/xhr/script/document are not resources
  and are untouched. An explicit `resourcePolicy.stub` (subset of image/media/font) wins over the profile, so `stub: []` under `functional` stubs nothing
  (but screenshots/trace stay off). Available on a direct run, `POST /v1/routines/:id/run` / `run_routine` (`profile`), a suite (`profile`) and
  `scrapforai run --profile`; deliberately NOT on regression-vault runs (proof needs full evidence). **The acceptance benchmark is still pending**
  (3 real routines x 10 runs per profile on WmsOffice): `npm run bench:profile -- <routine>... --runs 10`. The speed-up is measured, not promised.
- **Transient file errors on Windows** (`src/storage/transientIo.ts`): Windows briefly answers `EPERM`/`EBUSY`/`EACCES` when another process (antivirus,
  indexer) holds a file that was just written. Evidence reads and writes (manifest hash and read, `result.json`, screenshots for reports and
  snapshots, pin, export) and the atomic rename go through `retryTransient` / `readFileRetry` (6 attempts, growing pause; any other error is thrown
  at once) and the manifest is now written atomically. A retry prints `[fs] <code> on <file>, retry n/m` on stderr, and a manifest that still cannot be
  written prints `[evidence] manifest of <job> could not be written` (the run still does not fail for it). **Why:** the full smoke suite failed in about
  4 of 7 runs with an unrelated test each time ("evidence not found" right after a run: a screenshot unreadable, `evidenceAvailable` false, a missing
  manifest), never in isolation; a real `EPERM` on a rename was captured in one run. After the change 3 consecutive full runs passed 52/52, with no
  `[fs]` line in the last two, so the cause is the best explanation, not a proven one. **UPDATE: it came back** (`routine-library.smoke`, "No manifest for this run", 404) in
  one full run after the fix, with NO `[fs]`/`[evidence]` line in the output, and passed 3 of 3 in isolation: so it is NOT (only) a transient EPERM. Still open.
  Next step if it matters: make the manifest route say whether the job folder exists and which files it holds, and log in `findJobDir` when a just-finished
  job's folder is missing.
- **Parameters and generators** (`src/generators/`, `src/schemas/parameters.schema.ts`, T5.3): a run or routine declares
  `parameters: [{ name, generator, includeBoundaries? } | { name, cases }]` and a fill/selectOption step takes `valueFromParameter: name`;
  `valueFromGenerator: { type: ... }` on a step is sugar for a parameter of its own (named `gen_<stepId>`, so give such steps an id). Generators:
  `int`, `decimal` (scale 0-8, exact steps), `date` (ISO `from`/`to`, output `format` of yyyy/yy/MM/dd, default `dd/MM/yyyy`), `string` (length in
  characters, charset `alpha|alnum|unicode|hostile`; hostile = quotes, `<script>`, SQL injection, format directives, emoji, a right-to-left override),
  `oneOf`, `document`. **Edge values first**, in this order and without repeats: int `min, min-1, max, max+1, 0, -1`; decimal the same in exact steps of 10^-scale;
  date `from`, the day before, `to`, the day after, empty; string empty, `min`, `min-1`, `max`, `max+1`; oneOf its values. Values just outside the range are
  INTENDED (they test validation); a test that wants only valid input uses `includeBoundaries: false` or `oneOf`/`cases`. After the edges, random values.
  `sample` (default 0) is which value of each parameter the run takes (all parameters move together; combinations are T5.4); a random value depends only
  on (seed, name, position), so any sample replays alone. `seed` is the caller's, or a fresh one that is returned: `result.parameters` = `{ seed, sample,
  values, sources }` (present only when the run used parameters; not secrets, shown as they are). Replay with the same `seed` + `sample`
  (`POST /v1/routines/:id/run`, `run_routine`, `scrapforai run --seed s --sample N`). A routine saves its `parameters` (optional, no default, so older digests
  hold) and, saved `fromJobId`, keeps the steps AS WRITTEN (generators intact), never the seed or the generated values. A `valueFromParameter` must name a declared
  parameter (checked at validation when the routine has no `include`, after expansion otherwise); `cases` and `oneOf` literals are linted like step values (a
  secret in them is refused, 422).
  **`document`** (`{ type: 'document', kind: 'cpf'|'cnpj'|'ci-uy'|'rut-uy', valid?: true, formatted?: false }`): synthetic identity documents with correct check digits
  (cpf: mod 11 over 10..2 and 11..2, never 11 equal digits; cnpj: base 8 digits + `0001` + 2 check digits, only fourteen equal digits are refused, so
  `00.000.000/0001-91` is valid; ci-uy: 7 digits + 1, weights 2,9,8,7,6,3,4, first digit 1-6; rut-uy: 12 digits, department 01-22, `001`, weights 4,3,2,9,8,7,6,5,4,3,2 mod 11)
  or, with `valid: false`, the same with only the LAST digit wrong (always invalid, since that digit is determined by the rest). A valid document has no edge values; an invalid one
  starts with empty, one digit short, one too long, letters, wrong check digit. `isValidDocument(kind, text)` checks any text (separators ignored). **Synthetic**: such a number is made
  up but can coincide with a real person's or company's, so `result.parameters.synthetic` lists the parameters that hold documents and the report (en/pt/es) tags them and
  warns: dev/QA only. **Reports** show a "Test data" section (seed, sample, each value and where it came from); values are escaped, clipped to 200 characters, and control and
  bidirectional characters are printed as `\uXXXX` (a right-to-left override in a hostile string must not reorder the report).
  **Included routines declare their own parameters**: each is renamed `<include path>_<name>` (dots become underscores: include id `a`, parameter `qty` -> `a_qty`), the included steps
  are rewritten to the new name, two includes of one routine draw independently, and an included routine does NOT see its includer's parameters (it could not be saved alone if it did).
  An implicit parameter from an inline generator in an included step is named `gen_<include>_<stepId>` (any character a name cannot hold becomes `_`; two ids that collapse to one
  name are a `DuplicateParameter`). A name already taken by the includer is a 400, never a silent overwrite.
- **Formula oracle** (`src/oracle/`, T5.5): the step `assertEquals { actual: { extracted: name }, expected: { expr } | { value }, tolerance?: { absolute?, relative? },
  locale?: 'en'|'pt'|'es' }` compares a number the page showed with what it SHOULD show. `expr` is a language of our own, parsed by hand (`expression.ts`, **no
  `eval`/`Function`**, pure, 500 chars, depth 60; a syntax error is refused when the request/routine is validated): numbers, `+ - * / ^` (`^` right-associative, tighter
  than unary minus), parentheses, `< <= > >= == != && || !` (1/0), `round(x[,d])` (half AWAY from zero, on the decimal text: `round(1.005,2)=1.01`), `floor`, `ceil`, `abs`,
  `min`, `max`, `if(c,a,b)` (lazy: only the branch taken runs, so `if(qty==0,0,t/qty)` is safe). Arithmetic is cleaned to 15 significant digits (0.1+0.2 = 0.3); division by zero
  and non-finite results are errors. **Variables** are the run's parameters (always PLAIN numbers: `-12.5`, because they were generated) and the extracted values (parsed with
  the step `locale`: `localeNumber.ts` never guesses, `1.234` is 1234 in `pt` and 1.234 in `en`, a currency symbol/code, a % sign, accounting parentheses and thousands spaces are
  accepted, anything else is an error, never a silent 0); a name that is both is an error. Names must be identifiers (a parameter called `my-qty` cannot be used). Default tolerance is
  floating-point noise (1e-9); `tolerance` replaces it. A failure says by how much and with which inputs (`total is 11549 but round(price * qty * 1.1, 2) gives 11550 (difference 1,
  tolerance 1e-9); with price=10.5, qty=1000`); a problem with the INPUTS (nothing extracted, not a number, unknown variable) is a step error that names it. In an included routine the
  formula follows the rename of its parameters (`qty` -> `<include>_qty`). Not done: the CSV case tables kept in the library (`expected: { table }`), a `sqrt`/`pow` family, and
  text (non-numeric) comparison. `test/oracle.test.ts` (grammar, safety, locales) and `test/oracle.smoke.ts` (a fixture with a boundary bug at quantity >= 1000).
- **Shrinking** (`src/shrink/`, `POST /v1/shrinks`, T5.6): from a failing sample to the smallest input that still fails. `{ fromJobId }` (a failed run of a library routine that drew
  values, e.g. a suite variant with `samples`; its evidence must still exist) or `{ routineId, version?, seed, sample }` answers **202** with a `shrinkId` (`GET /v1/shrinks/:id[?wait=N]`,
  `POST .../cancel`; state in `<dataDir>/shrinks/<id>.json`, a run left `running` by a dead process becomes `interrupted`). Every probe is a real run through the job queue (suite priority,
  one session per credential set) with **`parameterValues`** (new on requests and on `POST /v1/routines/:id/run`: exact values for named parameters, bypassing generators;
  `result.parameters.sources` says `fixed`; a name the run does not have is `UnknownParameter`). **Same failure** = same failing step id AND error type: a smaller input that fails
  elsewhere is not progress. Algorithm (`shrink.ts`, pure, probe injected): (1) confirm the failing values fail again (else `not-reproduced`); (2) reset every parameter that has a neutral
  baseline (int/decimal: 0 clamped to the range; string: "a" x max(minLength,1); oneOf/cases: first value; date: `from`; document: a valid one) and run Zeller's **ddmin** to find the minimal
  subset that must keep its failing value (everything reset still fails = `independent`: the parameters are not the cause); (3) per essential parameter, numbers: **binary search** between the
  baseline (passes) and the failing value down to two ADJACENT values (`boundaries[]`: fails 1000 / passes 999), strings: halves, then one character (code point) at a time. Budget:
  `maxShrinkRuns` (default 30, max 200, the confirmation counts) and `maxShrinkSeconds` (default 600); when it ends early (`budget`/`timeout`/`cancelled`/`error`) the best FAILING input so
  far is returned and an open numeric bracket is marked `precision: 'bracket'`. Invariant: `minimal` is a configuration a run really failed with (`minimalJobId`) and every pass/fail claim
  was observed. Limits: binary search assumes ONE failing interval (with several it still returns a true adjacent flip, not necessarily the only one); lists, dates and documents are reset,
  not shrunk. **Save to the vault**: `vault add-from-run` with `fromJobId = minimalJobId` and `type: 'SCENARIO'`: a run that carried `parameterValues` is saved with each declared parameter as
  a single case (and each inline generator as the literal it produced), so the item fails on every run; a value of an included routine's parameter cannot be pinned (422
  `ParametersNotPinnable`). The probes' evidence is ephemeral: save before it expires. MCP `shrink_failure` + `get_shrink_result`; CLI `scrapforai shrink --from-job <id> | <routine> --seed s
  --sample N` (exit 0 for `minimal`/`independent`, 2 otherwise: it is not a test verdict). Not done: a button in the web UI, shrinking inside a suite automatically, several failures at once.
- **Scheduler** (`src/scheduler/`, T3.2): `PUT /v1/schedules/:id` (bearer only: it makes the server start browsers on its own) stores `{ cron, timezone (default
  America/Montevideo), target, enabled, overlap: 'skip', jitterSeconds, notify }` in `<dataDir>/schedules/<id>.json`; the cursor, the run in progress and the last 100 outcomes live in
  `schedules/state/<id>.json`. `target` = `{ kind: 'routine', routineId, version?, credentialSet?, targetProfile?, profile?, buildId? }` | `{ kind: 'suite', suite }` | `{ kind: 'vault', tags? }`
  (every ACTIVE item, as a suite) | `{ kind: 'evolutionSnapshot', targetProfile, buildId? }`. Saving checks what can be checked without running: the cron and zone, that the expression can fire at all
  (not 31 February), that the routine / suite items / target profile exist (400/404). **`SCHEDULER_ENABLED=false` by default**: without it schedules are stored and listed but nothing fires, and `run-now`
  is 409 `SchedulerDisabled`; `SCHEDULER_TICK_SECONDS` (15). The cron parser is our own (`cron.ts`, pure, no dependency): 5 fields, lists/ranges/steps, JAN-DEC / SUN-SAT, `@daily`-style macros; day-of-month and
  day-of-week are OR when both are restricted, AND otherwise (Vixie); `?`, `L`, `W`, `#`, seconds and years are refused. Time zones come from Intl: a wall-clock time that does not exist (spring forward) is skipped
  that day, one that happens twice (fall back) fires once. **Decision** (`plan.ts`, pure): the occurrences in (cursor, now] whose jittered time has come are "ready"; **at most one run per tick per schedule**
  (the latest), the older ones are recorded as ONE `missed` entry with a `count`, and a run more than 2 minutes after its time is flagged `recovered`: this is the "at most one recovery" after downtime,
  since the cursor is persisted. `jitterSeconds` adds a stable pseudo-random delay per (schedule, occurrence). **Overlap**: if the previous run of that schedule is still going the occurrence is recorded
  `skipped-overlap` and consumed, never queued. A target that cannot start (routine gone, vault empty, ...) is recorded `error` with the reason and consumed (no retry loop). At startup a run left "in
  progress" by a dead process is settled: from the suite/snapshot state if it can be told, else `error`. Routine runs go through the job queue at `scheduled` priority with the credential lock.
  **Scheduled runs never use `evaluate`/`watch`** (also through an include, and in every routine of a suite) unless `SCHEDULED_ALLOW_EVALUATE=true`: recorded `skipped-evaluate`. Outcomes: `started`
  (running) -> `passed`/`failed`/`error`, `skipped-overlap`, `skipped-evaluate`, `missed`. `POST /v1/schedules/:id/run-now` (bearer) starts one outside the clock (honors overlap, does not move the
  cursor). `GET /v1/schedules[/:id]` return the next 3 occurrences, the run in progress, the last run and counts; MCP `list_schedules` (read-only: schedules are a person's decision); CLI
  `scrapforai schedules list|show|run-now`. `notify` lists webhook ids (T3.3, next bullet; an unknown id is a 404 at save). **Limit (D5)**: a scheduler inside the server only works while the process is up; on a dev machine
  register a Windows task that calls the CLI instead (`scripts/ops/Register-VaultNightlyTask.ps1`) or run the server somewhere always on. Not done: schedule editing in the web UI (the Health screen, T3.7, only shows them). **Retry (T3.5)**: `retries` (0|1, default **1**) on the schedule: a routine run that FAILED is tried once more, and for `suite`/`vault`
  targets the schedule's `retries` is passed to the suite (a suite's own `retries` wins). See Flakiness. `test/cron.test.ts` (case table, DST), `test/scheduler.test.ts` (fake clock and dispatcher), `test/scheduler.smoke.ts` (Chromium, HTTP).
- **Webhook notifications** (`src/integrations/`, T3.3): a webhook is a channel a schedule's `notify` names. It hears about a **CHANGE** of the
  schedule's verdict, never about every run: `passed` -> `failed`/`error`/`skipped-evaluate` is **broken**, the way back is **recovered**, red -> red is silence
  (`transitions.ts`, pure). What a channel "knows" (verdict + since, per `schedule:<id>`) is the verdict of its last **delivered** message, in
  `<dataDir>/webhooks/state/<id>.json`, so a webhook that was down is told at the next run instead of losing the change. A first result that is red is announced once
  (flagged "first result seen by this channel"); a first green is not. Overlap, `missed` and a run lost with its process (result unknown after a restart) are not verdicts
  and say nothing. `PUT /v1/webhooks/:id` (**bearer only**: it sends data out of the server) stores `{ preset: generic|slack|teams|googlechat, lang: en|pt|es,
  enabled, events: [broken, recovered], dailySummary?: { at: 'HH:MM', timezone }, notes, url }`. **The URL is a secret** (it lets anyone post as the channel): it is written into the
  credential vault as the set `webhook-<id>` (field `url`, bound to its origin) and **no read path returns it**, only `urlOrigin`; an update without `url` keeps the stored one.
  The definition (`webhooks/<id>.json`) and the state hold nothing secret. **Egress** (`notifyPolicy.ts`): the origin must be in `ALLOWED_NOTIFY_ORIGINS` (exact origins; empty = nothing
  leaves), checked at save and again at every send; no user:password, no fragment; redirects are never followed (a 3xx is a failure); `NOTIFY_TIMEOUT_MS`; one retry only for
  a network error, timeout, 429 or 5xx; the response body is never read or kept; errors name a code, never the URL. **Before anything leaves** (`scrub.ts`, `notifier.ts`): every
  string is cleaned (vault values, including every webhook URL, and the secret shapes of the routine lint become `[REDACTED]`; control and right-to-left characters are removed; length is bounded),
  the rendered payload is checked once more, and if a secret is still in it nothing is sent and the delivery is `blocked`. Personal data (T7.8) is masked there too: `scrubText` calls the PII detectors, so a CPF or e-mail in a message keeps its shape and loses its value.
  Presets (`presets.ts`, pure) escape for their markup so a page cannot write a mention: `generic` (JSON with `fields`), `slack` and `googlechat` (`{ text }`), `teams` (a Workflows webhook:
  message with an Adaptive Card). **Daily summary**: at `dailySummary.at` in its time zone, one message with the state of every schedule that notifies the webhook and its outcomes of the last
  24 h; at most one per day, nothing "made up" for the time before the webhook (or the time) was saved, a failed send is retried after 10 minutes, driven by the scheduler tick (so it needs
  `SCHEDULER_ENABLED=true`). `GET /v1/webhooks[/:id]` (origin, `originAllowed`, schedules, what the channel knows, the last 50 deliveries), `POST /v1/webhooks/:id/test` (bearer; 200 sent, 502 not),
  `DELETE` (409 `WebhookInUse` while a schedule notifies it; it removes the vault set), CLI `scrapforai webhooks list|show|test` (the URL is never an argument: it would end up in shell history),
  MCP `list_webhooks` (read-only). Delivery never touches a run: a webhook failure is only in the webhook's own log. Notification work runs apart from the schedule (a slow endpoint does not delay
  the next occurrence). Only **scheduled** runs notify: a run started by hand, a suite started by `POST /v1/suites` or the nightly wrapper do not (use a schedule, or `run-now`). Not done: Teams
  `@mentions`, links back to the report/UI (there is no configured public base URL), retries beyond one, editing webhooks in the web UI. `test/notify.test.ts` (pure parts + notifier + engine
  against a local receiver, including the sentinel test), `test/scheduler.smoke.ts` (Chromium, HTTP).
- **Performance series** (`src/metrics/`, T3.4): every run of a LIBRARY routine appends one line to `<dataDir>/metrics/<routineId>.jsonl`
  (`perfRecorder.ts`, called by `runLibraryRoutine`, so direct, suite, scheduled and vault runs all count): `{ jobId, at, version, profile, env, buildId?, status, durationMs,
  steps: [{ id, durationMs, status }] }`. Only ids, times and a build id: no URL path, no error text, no extracted value; teardown steps are not recorded; a step without an id is `#<index>`
  (include steps are `<includeId>.<stepId>`). Not recorded: a run with `parameterValues` (a shrink probe) and anything that is not a library routine. A write failure prints `[metrics]` on stderr and never
  fails the run; a corrupt line is skipped on read; the file keeps the newest `PERF_MAX_RECORDS` (500) lines. **Analysis** (`perfAnalysis.ts`, pure): per step and for the whole run `(run)`,
  *baseline* = median of up to `PERF_BASELINE_RUNS` (20) green samples that came BEFORE the last `PERF_RECENT_RUNS` (3) (so a regression is never averaged into its own baseline),
  *recent* = median of the last 3, **alert** = recent > baseline x `PERF_ALERT_RATIO` (1.3) AND at least `PERF_MIN_DELTA_MS` (100) slower (20 ms -> 40 ms is noise); no baseline until
  `PERF_MIN_BASELINE_RUNS` (5) + 3 green samples (the series says what it waits for). The whole-run series `(run)` includes the browser start-up, which varies by seconds, so it is the noisier one: trust the named STEP. Only GREEN runs and PASSED steps count (a failed run is cut short or waited for a timeout).
  A **population** is (routine version, profile, origin): a new version has other steps, `functional` runs stub images, another environment is another machine; the analysis uses the
  population of the latest run, `?version=&profile=&env=` selects another, `populations` lists them. A step added later has its own, shorter series. For an alert, `suspectBuild` is the build
  seen in the recent samples but not in the baseline ones, and `buildChanges` marks where the build changed in `points` (builds `unknown` are ignored). `GET /v1/metrics/routines` (one line each + alerts),
  `GET /v1/metrics/routines/:id[?limit=&version=&profile=&env=]` (points per series, baseline, recent, ratio, thresholds), `GET /v1/metrics/alerts` (all read-only, session ok), CLI
  `scrapforai perf list|alerts|show <routine>` (**exit 0 unless `--fail-on-alert`**: a slower step is a signal, not a failed test, so a guard opts in), MCP `get_performance`, and the **Performance**
  screen of the web console (`public/performance.html|js`: SVG sparklines per run and per step with the dashed baseline, a tick where the build changed and the recent dots in red on an alert; classes only,
  because of the CSP). Not done: notifying a webhook of a new alert (T3.3 only tells about verdict changes), `perf.json` in the evolution snapshot, alerts per target-profile thresholds (env only). The alerts also feed the Health panel (T3.7).
  `test/performance.test.ts` (rule, populations, privacy of a record, store cap), `test/ui-performance.test.ts` (CSP guards), `test/performance.smoke.ts` (Chromium: a slower navigation after a "new build" alerts on `open`
  and names `r101`; the screen renders under the server's CSP).
- **Flakiness, retry and quarantine** (`src/metrics/flakyAnalysis.ts` pure, `flakyService.ts`, `src/orchestrator/retry.ts`, T3.5): it reads the SAME series as the performance
  analysis (`metrics/<routineId>.jsonl`; a record now also carries `attempt`/`retryOf`, set from the run's `caller.metadata`, and `parametric: true`). **Score** = state changes (pass<->fail) between
  consecutive runs / **comparable** pairs, over the last `FLAKY_WINDOW` (20) runs of ONE population (routine version, profile, origin; the population of the latest run, `?version=&profile=&env=` picks another). A pair is
  comparable unless both runs know their build and the builds differ: a pass->fail across a new build is a regression (or a fix), never flakiness, and `skippedAtBuildChange` says how many pairs were left out. Departure
  from the roadmap text ("transitions / runs"): the denominator is the pairs actually compared, so an alternating series is exactly 1 and a build change does not dilute the score. Runs that drew generated
  values (`parametric`) are left out: an edge value fails ON PURPOSE. 1 switch (a real regression) in 20 runs is 0.05; two isolated failures are 0.21. **Suggestion** (never applied: a status is a new routine
  version, a person's decision): `quarantine` when the score is >= `FLAKY_THRESHOLD` (0.2) with >= `FLAKY_MIN_RUNS` (10) runs in the window and the routine is not quarantined; `release` when it is quarantined and its
  last `FLAKY_MIN_RUNS` runs all passed (note the window still holds the earlier instability, so an `active` routine with that history is also flaggable). A routine that fails EVERY time is broken, not flaky: nothing is suggested.
  `GET /v1/metrics/flaky` (one line each, suggestions first) and `GET /v1/metrics/flaky/:id[?version=&profile=&env=]` (the pass/fail strip, counts, `recoveredOnRetry`, the routine's current `status`), CLI
  `scrapforai flaky list|show <routine> [--fail-on-suggestion]` (**exit 0 by default**: a suggestion is information), MCP `get_flakiness`. **Automatic new attempt** (`retries`, 0|1): a schedule's default is 1; `POST /v1/suites`
  default is 0 (`retries: 1` opts in). Only a run whose steps FAILED is repeated (`status: failed`; a run that could not execute is not), once, through the queue again, never for a quarantined variant or a parametric
  sample, and not after a cancel. **The retry never hides the failure**: both attempts are runs of their own (own job id and evidence; the second has `caller.metadata.attempt/retryOf`), both are in the series, the schedule history
  entry carries `attempts[]` and `passedOnRetry`, the suite variant carries `attempts[]` (its own fields are those of the LAST attempt) and `passedOnRetry`, the suite has `passedOnRetry` (count), the verdict reason says
  "N passed only on a new attempt", and the suite report lists every attempt with its run id. A pass on the second attempt IS a pass (verdict green, schedule outcome `passed`, so a webhook is not told it broke); if the second
  attempt cannot run at all, the first failure stands and the error says why. **Quarantine in suites**: see Suites. Not done: a quarantined routine scheduled on its own still notifies webhooks of its breaks, a flakiness
  screen of its own in the web UI (the score, strip and suggestion are in the Health panel, T3.7), applying a suggestion with one call, flakiness per vault item or per step, and retries of more than one attempt. `test/flaky.test.ts` (score, builds, populations, suggestions, retry
  helper, service), `test/suite-plan.test.ts` (quarantine and retry in the verdict), `test/flaky-retry.smoke.ts` (Chromium: a page that fails its first N loads, counted server-side).
- **Health panel** (`src/health/`, `src/routes/health.routes.ts`, `public/health.html|js`, T3.7): `GET /v1/health[?target=<id>]` (read-only, session ok) answers the state of every target profile in one read.
  It only RE-READS what the other pieces store and groups it by target profile: the routines of the library (`targetProfile`), their series (T3.4/T3.5), the vault items (through the profile of their routine) and
  the schedules (`target.targetProfile`, else the profile of the routine; `evolutionSnapshot` by its profile). **Nothing new is decided**: no run is started, no status changed, no suggestion made that T3.5 did not.
  `healthAnalysis.ts` is pure (no I/O, no configuration), `healthService.ts` does the reading. **Routine state**: `failing` = its LAST run failed (a run that passed only on the automatic new attempt is a pass);
  else `flaky` (T3.5 flagged it or proposes quarantine); else `slower` (a T3.4 alert); else `passing`; `never-run`; `quarantined` and `inactive` (draft/retired) are counted apart. Each routine also carries
  the `streak` (trailing runs with the last result), the `trend` (share of failures in the older half vs the newer half of the window, `worsening`/`improving` at a 25-point change, `unknown` under 6 runs) and the
  strip of results. **Target status**: `red` when something that counts failed (a failing routine, an ACTIVE vault item whose last run failed, a schedule whose last occurrence failed); `yellow` when nothing
  failed but something needs a person (flaky, slower, a quarantine/release suggestion, an enabled schedule while the scheduler is not running); `green`; `empty` when nothing has ever run. `reasons[]` says why, red first.
  A quarantined routine or item **never turns a target red** (as in suites); an ACTIVE vault item that never ran is listed ("not run") but is not a warning by itself. A schedule that starts a suite or the whole
  vault is not tied to one profile: it is in `unscoped`, with the vault items whose routine no longer exists. `schedulerRunning=false` is shown as a banner: schedules are stored but nothing fires. A profile
  that routines still point at but is not stored gets a card with `known: false`. The report carries ids, statuses, times, build ids and reasons: no extracted value, no typed text. Web console **Health** screen
  (classes only, because of the CSP: badges map data to fixed class names, the strip is SVG), CLI `scrapforai health [--target id] [--fail-on-red]` (**exit 0 unless `--fail-on-red`**: a red target is information),
  MCP `get_health`. Not done: editing schedules, webhooks or statuses from the screen (it only reads; T3.7 asked for the panel, not for write paths), links from a row to the run/report/evidence, a history of
  the target's status over time (each read is the state NOW), per-target thresholds, a webhook for "target turned red". `test/health.test.ts` (rules), `test/health-service.test.ts` (real stores + route),
  `test/ui-health.test.ts` (CSP guards), `test/health.smoke.ts` (Chromium under the CSP).
- **Trusted scripts** (`src/runner/trusted/`, T7.1): the scripts THIS project injects into target pages, as a closed list `{ id, source, sha256, timeoutMs, maxOutputChars }` (`registry.ts`; the sources are
  in `scripts/*.ts` as strings so they ship with `tsc`). A dedicated step names an `id`; the caller never sends code, so they do **not** go through `ALLOW_EVALUATE` (which stays for caller code: `evaluate`/`watch`).
  `verifyTrustedScripts()` compares every source with its pinned sha256 **when the server boots** (first thing in `start()`): a mismatch throws and the server does not start; it also runs on first use. To change a script
  on purpose: edit it, `npx tsx scripts/trusted-hashes.ts`, paste the hash into the registry (so any change to what runs in a page is a reviewed change of that file; it does not protect against someone who can edit both).
  `runTrustedScript(frame, id, args)` sends the registered source plus `args` as one JSON literal (data only), abandons it after `timeoutMs`, REFUSES an answer over `maxOutputChars` (never cuts silently) and redacts
  the answer with the run's known secrets. Sources use no backtick and no `${`, and `test/trusted-scripts.test.ts` rejects `eval`, `fetch`, storage and cookie access in them. Today: `keyboard-active`,
  `keyboard-style`, `keyboard-candidates`, and `a11y-axe` (T7.4, below: the whole axe-core bundle is part of its source, so its pin moves with the axe-core version). And `pii-surfaces` (T7.8: reads storage and hidden inputs; the one script allowed to touch `localStorage`/`sessionStorage`, and only to read, which `test/trusted-scripts.test.ts` enforces).
- **Keyboard walk** (`keyboardWalk` step, `src/runner/keyboardWalk.ts` pure + trusted scripts, T7.6): `{ name, maxTabs (1-500, default 200), startSelector?, scope?, failOn?: ['neverFocused'|'focusTrap'|'invisibleFocus'][] }`
  presses Tab and writes `extracted[name]` = `{ order: [{ key, role, name?, focusVisible? }], tabs, completed, endedBy: 'wrap'|'left-document'|'trap'|'max-tabs'|'time-limit', trap?, neverFocused?, invisibleFocus, notes }`.
  `key` is `#id` or a structural path (`body>div:nth-of-type(2)>input`); `name` comes from label, aria, placeholder, title or the caption of a button/link, **never the value of a field**. **Never focused** = a control of the
  inventory families (T4.3: fields and actions) that is visible, not disabled, not inert and not `tabindex="-1"`, and that no Tab reached (a `div role="button"` without `tabindex` IS reported; the radios of one group count
  as one, reached through any member). It is only decided when the walk completed (the page wrapped to the first element or focus left the document): after a trap or a cut-off walk nothing is claimed and `notes` says why.
  **Trap** = the sequence came back to an element that is not where it started (a loop that never exits); a Tab that does not move focus counts (length 1). **Invisible focus** (heuristic) = outline, box-shadow and border are the
  same with and without focus; "without focus" is read right after Tab moved away, so the page gets no extra blur/focus event. An always-on indicator counts as invisible, one made of background or text colour is not seen.
  With `startSelector` the element is stop 0 and returning to it is a normal wrap (a dialog that keeps focus inside); no control is judged then unless `scope` is given. The step never fails on a finding unless `failOn`
  lists it (default `[]`: information first, like `probePage`); the walk is kept in `extracted` even when the step fails. Uses `page.keyboard.press('Tab')`, so in an iframe the walk goes through the frame that has focus
  but names only elements of the frame the step targets. Not done: Shift+Tab, Enter/Space/Escape behaviour, shadow DOM and iframe contents, the normalizers of T4.1 on `key`, and a keyboard section in the report (the accessibility one exists, see below; the walk is not in it yet).
  `test/keyboard-walk.test.ts` (rules with a scripted browser), `test/trusted-scripts.test.ts`, `test/keyboard-walk.smoke.ts` (Chromium: good page, unreachable div, invisible focus, trap, radios, no value leak, `ALLOW_EVALUATE` off).
- **Accessibility audit** (`auditAccessibility` step, `src/a11y/`, `src/runner/trusted/scripts/axe.ts`, T7.4/T7.5/T7.7): `{ name, scope?, standard: 'wcag2a'|'wcag2aa'(default)|'wcag21aa'|'wcag22aa', rules?, failOn: 'none'(default)|'any'|'serious'|'new', baseline?: { screen, build?, targetProfile? } }`
  runs **axe-core** (Deque, MPL-2.0, version pinned exactly in `package.json`, **unmodified**, see `THIRD-PARTY-NOTICES.md`) in the page as the trusted script `a11y-axe`: the caller sends no code, so it needs no `ALLOW_EVALUATE`. The script is the bundle read from `node_modules/axe-core/axe.min.js` plus a
  small runner; the registry pins the hash of the whole thing, so **upgrading axe-core makes the server refuse to start until you review it and pin the new hash** (`npx tsx scripts/trusted-hashes.ts`; `test/accessibility.test.ts` also fails). A WCAG level means its tags only (`wcag2aa` = A + AA); axe "best practice" rules belong to none.
  `extracted[name]` = `{ kind: 'accessibility-audit', axeVersion, standard, findings: [{ ruleId, impact, targetKey, target, help, wcag }], counts, needsReview, passedRules, truncated, notes, baseline? }`. **What leaves the page is value-free**: rule, impact, a CSS selector and the rule's help text; never the element's HTML, text,
  value or axe's failure messages (`test/accessibility.smoke.ts` seeds values and checks they are absent). `targetKey` is the selector after the T4.1 normalizers of the target profile's `diff` (grid row suffix `vNAME_0001` -> `vNAME`, web component prefix, masks); elements that normalize alike are told apart as `key`, `key#2`. Only the audited frame is checked (iframe contents are not);
  at most 50 elements per rule and 500 in all are listed (`truncated`; the totals in `counts` stay complete). `rules` filters what is REPORTED. Items axe cannot decide (`incomplete`) are counted per rule in `needsReview` and never compared. A scope that matches nothing is a step error. Without `failOn` the step only records.
  **Baseline (T7.5)**: `POST /v1/evolution/snapshots` with `accessibility: true` (+ `accessibilityStandard`; CLI `evolution snapshot --accessibility [--a11y-standard x]`) audits every catalogue screen after its inventory and keeps `screens/<id>.a11y.json` (sha256 in `snapshot.json`, `accessibility: { standard, axeVersion }`); an audit that is
  missing for a screen is a warning, never a failed capture. A step with `baseline` loads the NEWEST snapshot that audited that screen (or the build asked for; a build without it is an error, not a silent older one), verifies its sha256, and compares by (rule, normalized target): `baseline: { buildId, new, fixed, unchanged, incomplete, axeVersionChanged? }`.
  `failOn: 'new'` needs a baseline (refused at validation) and fails only on findings the baseline does not have. A baseline of another WCAG level or scope is **not comparable** (step error: the higher level would call everything new). If a list was cut or the axe version changed the result says so (`incomplete`, `axeVersionChanged`).
  `diffBuilds` / `GET /v1/evolution/:target/diff` / `CHANGES.md` add `accessibility: { screensCompared, new, fixed, notComparable }` and per screen the delta; it is kept OUT of `counts` and of the expected/unexpected classification (a new violation is not a structural change, and the CLI exit code is unchanged). A screen audited in only one of two snapshots is `first-audit` (a baseline, not a change).
  **Reports (T7.5/T7.7)**: the run report (`en`/`pt`/`es`) has an Accessibility section for every audit in `extracted` (recognised by `kind`): with a baseline only **new** and **fixed**, without one a warning and the 20 most serious findings. Each new finding carries the platform note from `src/a11y/platformGuidance.ts` (19 groups, all WCAG rules of axe, three languages);
  `docs/a11y-platform-mapping.md` is GENERATED from it (`npm run generate:a11y-doc`) and a test fails if they differ. The notes are orientation for GeneXus/NPDev, **not verified against a real NPDev build**; the doc and the report say so. Not done: `--fail-on-a11y-new` for `evolution diff`, accessibility in the suite report, iframes, a baseline per role.
  `test/accessibility.test.ts` (normalizing, comparing, schema, stored baseline, tamper, report, guidance, pin), `test/accessibility.smoke.ts` (Chromium: defects, GeneXus ids, failOn, scope, snapshot, regression gate, report).
- **Controlled chaos** (`injectFault` and `assertNoTextMatches` steps, `src/runner/faults.ts`, `src/runner/leakPatterns.ts`, T7.2): `injectFault { match: { urlContains, method? }, fault, times?, untilStep? }`
  answers matching requests wrongly on purpose, through the `faults` slot of the routing layer (T5.1). `fault` is ONE of `{ status, body?, contentType? }` (the answer is made up; the server is not called),
  `{ delayMs }` (the REAL request goes through, late), `{ abort: 'failed' | 'timedout' }` or `{ malformedJson: true }` (HTTP 200 with a truncated JSON body; the server is not called). It only touches
  requests to origins in `ALLOWED_TARGET_ORIGINS`/`ALLOWED_RESOURCE_ORIGINS` (another origin is left alone), and matches `urlContains` against the full URL. The first matching rule wins; `times` counts the
  requests a rule answered; `untilStep` is the id of a LATER step of the same list and the fault ends when it finishes (pass or fail; checked at validation, followed by the include rename); with neither it lasts until
  the steps end. **Faults are cleared before the teardown starts** (cleanup talks to the real application; a teardown may inject its own). **Evidence**: each touched request is in `result.evidence.routing`
  with `handledBy: 'fault'`, `action` (`fulfill`/`abort`/`delay`) and `detail` (`status 500`, `delay 10000 ms`, `abort timedout`, `malformed JSON`; never a body); a request a fault ABORTED or ANSWERED is not
  counted in `networkFailures` (the application did not fail; a 4xx/5xx written by a policy is skipped too), a DELAYED one is (it is a real request that can still fail). A stand-in answer to a cross-origin
  fetch carries CORS headers echoing the `Origin`, so the page sees the 500 and not a CORS error. A run installs the fault policy ONLY when it has an `injectFault` step, so any other run is unchanged.
  **Staging**: a target profile of `environment: 'staging'` refuses a run that has an `injectFault` step (also through an include) with **403 `FaultsNotAllowed`** unless `flags.allowFaults: true`
  (checked in `resolveExplorationRequest`, before any browser starts). `assertNoTextMatches { selector? (default body), kinds?: ['stackTrace'|'exception'|'sqlError'|'serverPath'][] (default all), contains?: string[] }`
  fails when the text shows a Java/.NET/JS/Python/PHP stack trace, an exception class, a database error (ORA-, SQLSTATE, MySQL/SQL Server messages) or a server file path. **The patterns are ours, never the
  caller's**: a caller regex over a page the caller does not control could stall the server (every pattern is bounded and linear, the text is cut at 200 000 chars, `test/faults.test.ts` times hostile input);
  `contains` adds literal fragments. The error names the kinds, counts and ONE example each (clipped to 100 chars, redacted) and does not copy the page. Templates: `templates/routines/chaos-save-500`,
  `chaos-search-slow`, `chaos-json-corrupt`. Not done: faults on a response BODY of a real call (only made-up or truncated ones), a `clearFaults` step, faults on websockets, matching by header or request body,
  fault injection in suites as a variant dimension. The faults of a run ARE in the run report ("Simulated conditions", see Fake clock). `test/faults.test.ts` (controller, routing, patterns, schema, staging), `test/fault-injection.smoke.ts`
  (Chromium: 500 once, delay, malformed JSON, aborts, a page that leaks, `untilStep`, teardown, cross-origin CORS, a run without faults).
- **Fake clock** (`setClock` step, T7.3): `{ fixedTime } | { installAt, fastForwardMs? }` changes the clock the PAGE sees (`Date`, timers, `requestAnimationFrame`) through Playwright's `context.clock` (so every page and
  frame of the run). `fixedTime`: `Date.now()`/`new Date()` return that instant at all times while timers keep running; it works before or after the page is open and can be repeated (each call moves it).
  `installAt`: the page's clock starts there and then runs at normal speed; `fastForwardMs` (up to ten years) jumps it forward once (due timers fire at most once). **`installAt` is refused the second time in a
  run**: Playwright would accept it and silently restart the time. Times are ISO 8601 **with a zone** (`Z` or an offset), years 1970-2100: a time with no zone would let the machine running the browser decide
  which day it is. `result.clock` = `[{ stepId?, mode: 'fixed'|'install', time, fastForwardMs? }]` (present only when the run changed the clock). **The limit that matters**: the SERVER's clock is the real one,
  and most GeneXus date rules run on the server; `test/clock.smoke.ts` proves it (the page lives in 2030, the server answers 2026). So the **run report** (en/pt/es) gets a "Simulated conditions" section with
  that warning whenever a clock was changed, and the same section lists the faults of T7.2 (grouped by request and effect, with counts), so a report never passes a simulated condition off as the real one.
  The `serverClock` hook of the roadmap needs an endpoint in the NPDev application (`[cross-repo]`): only a proposal exists, `docs/T7.3-NPDEV-SERVER-CLOCK-PROPOSAL.md`. `waitForTimeout`/`delayMs` are real time
  (Playwright side), not the fake clock. Not done: `runFor`/`pauseAt` (stepping a paused clock), a clock per suite variant, a time zone other than the machine's for the page's `Intl` (only the instant is set).
  `test/clock.test.ts` (accepted forms, zone, year range), `test/clock.smoke.ts` (Chromium), `test/reports.test.ts` (the section, three languages, escaped).
- **PII hunter** (`src/security/piiDetectors.ts`, `piiFindings.ts`, `piiSalt.ts`, `src/runner/piiScanner.ts`, T7.8): `options.piiScan: true` (whole run) and/or a step
  `scanForPii { name, surfaces?, failOn?: 'none'(default)|'high'|'medium'|'low'|'any' }` look for personal data and secrets where they should not be. It only READS (listeners on the page; no route,
  so a hunting run behaves like any other) and is attached only when the run asks. **Surfaces**: `url` (every request, plus the address bar with the fragment: query values, `#access_token=`, `;jsessionid=` in the
  path), `console` (log lines and page errors), `response-body` (JSON/HTML up to 256 KB of requests that carried NO Authorization and NO Cookie: what the app hands to anyone; a body fetched with the session
  is the user's own and is skipped), `storage` (local + session, through the trusted script `pii-surfaces`), `cookie` (only those WITHOUT HttpOnly: a script could take them) and `hidden-input`. Storage, cookies and
  hidden inputs are read once, at the end of the steps (before the teardown), or when a `scanForPii` step runs. **Detectors** (ours, bounded, never a caller regex): CPF, CNPJ, CI-UY (formatted, number < 7,000,000),
  RUT-UY (12 digits, department 01-22, series 001) all with correct check digits; card (Luhn, first digit 2-6); e-mail (not `logo@2x.png`); UY phone (with +598/00598 or the 09x mobile form; a bare 8-digit number is
  NOT matched); JWT, `Bearer`, API-key shapes (the routine lint's); `secret-named` (a value under a name like `token`, `password`, `api_key`, `jsessionid`; anti-forgery names such as `csrf`/`__RequestVerificationToken` are
  expected in a page and ignored); `known-secret` (the run's vault values, found anywhere); `cookie-no-httponly` (session/token cookie readable by scripts). **A finding never holds the value**:
  `{ detector, surface, location, maskedSample, fingerprint, severity, count }`; `location` is origin + path with matched values masked + parameter NAMES; `fingerprint` is HMAC-SHA256 under
  `<dataDir>/pii-fingerprint.key` (departure from the roadmap's plain sha256: an 11-digit CPF hashed plainly can be reversed by trying them all), so one value gives one fingerprint inside an installation.
  **Severity** (`defaultSeverity`): secrets in url/console/body = high, in storage/cookie/hidden = medium; identity documents in url/body/cookie = high, console/storage/hidden = medium; card = high; e-mail/phone: url medium,
  console/body/cookie low, storage/hidden info. `failOn` fails the step at that level or above (default: only records). `result.pii` (with `options.piiScan`) and `extracted[name]` (a step) hold the report:
  `{ kind: 'pii-scan', findings, counts, scanned, truncated, notes }`; `scanned` says what was looked at, so an empty list is never read as "checked everywhere". **A hunting run also masks what it keeps**: console text,
  page errors, the URL of a console line, the failure DOM text and `finalUrl` pass through `maskText`/`maskUrl`, otherwise the run would store the very value it reports (not done for `extracted` values the
  caller asked for, nor for `pathname` in the network evidence). `redactSecrets` blanks values by KEY NAME (`cookie`, `secret`...), which is why the counts are lists, not maps keyed by detector. The run report
  (en/pt/es) has a "Privacy scan" section; webhook messages mask personal data via `scrubText`. Not done: suppressions and per-profile severity (T7.9), the PII summary in suite reports and in the history, iframes, ci-uy
  without separators, names and addresses (no detector can tell them from text).
  `test/pii.test.ts` (detectors, masking, fingerprints, collector, schema), `test/pii.smoke.ts` (Chromium: a page that leaks through every surface; nothing raw on disk), `test/reports.test.ts`, `test/notify.test.ts`.
- **`ALLOW_EVALUATE`**: the `evaluate`/`watch` steps run arbitrary in-page JavaScript. Off by default;
  enable only for local, trusted use against allowlisted dev origins.

## HTTP API

Core endpoints, all behind `Authorization: Bearer <SCRAPFORAI_API_KEY>`:

- `POST /v1/explorations/inspect-dom` — navigate to a URL and return its forms/controls/selectors/labels
  without performing any actions. Use this first to discover what's on a page.
- `POST /v1/explorations/run` — execute a multi-step routine (goto/click/fill/assert\*/extractText/
  evaluate/watch/...) and return step results plus evidence (screenshots, console, network, trace).
- `GET /v1/credentials[/:id]` (metadata only) and `POST|PUT|DELETE /v1/credentials/:id` (bearer only) — the
  credential vault. `POST|GET /v1/suites`, `GET /v1/suites/:id`, `POST /v1/suites/:id/cancel` — suites.
  `GET|PUT /v1/routines[/:id]`, `POST /v1/routines/:id/run` — the routine library.
  `GET /v1/targets[/:id]` and `PUT /v1/targets/:id` (bearer only) — target profiles.
  `GET /v1/schedules[/:id]`, `PUT|DELETE /v1/schedules/:id`, `POST /v1/schedules/:id/run-now` (bearer for writes) — schedules.
  `GET /v1/webhooks[/:id]`, `PUT|DELETE /v1/webhooks/:id`, `POST /v1/webhooks/:id/test` (bearer for writes) — notification channels.
  `GET /v1/metrics/{routines[/:id],alerts}` — performance series of library routines; `GET /v1/metrics/flaky[/:id]` — flakiness and quarantine suggestions.
  `GET /v1/health[?target=<id>]` — the health of every target profile (routines, trend, flaky, slower, vault, schedules) in one read.
  `POST /v1/shrinks`, `GET /v1/shrinks/:id`, `POST /v1/shrinks/:id/cancel` — shrinking a failing sample.
  `GET /v1/runs/:jobId/{manifest,export,report}`, `GET /v1/evidence/{chain,public-key}`, `GET /v1/suites/:id/report`.
  `GET /v1/vault[/:id|/export]`, `PUT /v1/vault/:id`, `POST /v1/vault/{add-from-run,plan,:id/run,:id/confirm-green}` — regression vault.
  `GET|PUT /v1/permissions[/:id]`, `POST /v1/permissions/:id/run`, `GET /v1/permissions/runs[/:runId]`,
  `POST /v1/permissions/runs/:runId/cancel` — permission matrices.
  `POST /v1/evolution/snapshots`, `GET /v1/evolution/snapshots/:id`, `POST /v1/evolution/snapshots/:id/cancel`, `GET /v1/evolution/:target`,
  `GET /v1/evolution/:target/{diff,timeline}`, `POST /v1/evolution/:target/changes`, `GET|PUT /v1/evolution/:target/expected/:buildId` — system evolution.

JSON Schemas for both request bodies (and the `run_exploration` result) are served unauthenticated —
fetch these instead of hand-writing a request body against the schema files directly:

- `GET /v1/schema/` — index of the URLs below.
- `GET /v1/schema/routine.request.json` / `GET /v1/schema/routine.result.json` — for `run_exploration`.
- `GET /v1/schema/inspect-dom.request.json` — for `inspect-dom`.

## MCP server (for AI agents/tools)

`src/mcp/server.ts` is a stdio MCP server exposing the same two capabilities as MCP tools: `inspect_dom`
and `run_exploration`, plus `list_credential_sets`, `list_targets`, and the routine library tools `list_routines`, `get_routine`,
`save_routine` and `run_routine`, for suites `run_suite` (returns the id at once) and `get_suite_result`, for shrinking a failure `shrink_failure` and `get_shrink_result`, `list_schedules` and `list_webhooks` (both read-only), `get_performance` (step times, baseline and alerts; read-only), `get_flakiness` (pass/fail strip, score and quarantine suggestion; read-only), `get_health` (state of every target profile; read-only), and `get_run` (a past run by jobId), for system evolution `evolution_diff` (two builds; with `narrative` it stores the agent's summary in CHANGES.md) and `evolution_query` (when did X appear), the prompt `propose_screen_catalog` (the agent proposes a screen catalogue, a human approves), and for the regression vault `vault_list`, `vault_show`, `vault_add_from_run`, `vault_confirm_green`, `vault_run`, and for permission
matrices `list_permission_matrices`, `save_permission_matrix`, `run_permission_matrix`, `get_permission_matrix_result`. Their `inputSchema`s are the Zod
schemas from `src/schemas/`, imported directly rather than hand-copied, so they can never drift from what the
REST API actually accepts (`run_exploration` uses `mcpExplorationRequestSchema`: the same request minus inline
`credentials`). The
MCP server holds `SCRAPFORAI_API_KEY` itself and calls the REST API on the caller's behalf — the model
never sees the key.

This repo ships a project-scoped `.mcp.json` that registers it automatically. In Claude Code, opening
this project will prompt you to approve the `scrapforai` MCP server; approve it and both tools become
available. For any other MCP-capable client, register a stdio server with:

```
command: npx
args: ["tsx", "src/mcp/server.ts"]
```

`.env` resolution is anchored to the module's own file location, not `process.cwd()`, so the working
directory the client launches this from doesn't actually matter.

`.claude/skills/scrapforai/SKILL.md` is the agent-facing guide (T8.7): when to use each tool, the flow, the
GeneXus/NPDev conventions, how to read evidence and how to turn a reproduced bug into a vault item. Keep it in
sync when MCP tools or conventions change (`docs/genexus-routine-conventions.md` and `docs/npdev-testing-guide.md`
remain the detailed sources).

If your tool doesn't support MCP, call the REST API directly instead (see above) — the MCP server is
just a thin proxy over it.

## Web console

The UI (`UI_ENABLED=true`, `public/`) has History, **Health** (one card per target profile: status and reasons, each routine's state, streak, trend and result strip, the vault and the schedules; read-only), **Performance** (sparklines per routine and step, build changes, alerts), **Vault** (items with status, severity, RED/GREEN proof links, last run, per-item
"Run", and "Run by impact": paste changed files, see the order and reasons, run the vault as a suite and open its report),
Configuration and Status. It authenticates with a session cookie, so it can only use endpoints a session may call: capturing
evidence (`add-from-run`, `confirm-green`), pinning and credentials stay bearer-only. `test/ui-vault.test.ts` guards the CSP rules.

## CLI

`npm run cli -- <command>` (or `scrapforai` once installed: `bin` → `dist/cli.js`) is a thin REST client for terminals, CI and
ledger guards: `run <routineId> [--version N] [--target id] [--credential set] [--var k=v]`, `suite <file.json|->`,
`routines list`, `schedules list|show <id>|run-now <id>`, `webhooks list|show <id>|test <id>`, `perf list|alerts|show <routine> [--fail-on-alert]`, `flaky list|show <routine> [--fail-on-suggestion]`, `health [--target id] [--fail-on-red]`, `shrink --from-job <id>|<routine> --seed s --sample N`, `runs show <jobId>`, `pin <jobId> --reason ...`, `report <id> --out file`, `evidence verify|export|chain`, `vault list|show|export|run|confirm-green` (`vault run --impact --changed-files <file|->` runs the whole vault as an impact-ordered suite),
`permissions run <matrixId> [--build-id b] [--no-wait]` and `permissions show <runId>` (role x probe table, alerts, verdict),
`evolution snapshot <target> [--build-id b] [--screens a,b] [--no-screenshots] [--accessibility [--a11y-standard x]] [--force] [--allow-partial] [--no-wait]`, `evolution list <target>`,
`evolution diff <target> [--from r] [--to r] [--write] [--narrative-file f|-]` (exit 1 on an unexpected change of a build that declared its changes),
`evolution timeline <target> [--screen s] [--key k] [--since d]` and `evolution expected <target> <buildId> [--file f|-]`. Exit codes: **0** passed, **1** a test failed,
**2** anything else (API down, bad usage, a run that could not execute, wait timeout). `--json` prints exactly one JSON
object on stdout (`cliSchema: 1`, schema in `schema/cli.output.json`); progress and human errors go to stderr. The API
key comes from `.env`, never from the command line. Fields are only ever added to the JSON; a breaking change bumps
`cliSchema`.

`scripts/ops/` has the habit-forming wrappers: `Invoke-VaultPreMerge.ps1` (vault by impact for an app repo's diff, build id `<branch>.<sha>`),
`Invoke-VaultNightly.ps1` (dated JSON log, never starts the server) and `Register-VaultNightlyTask.ps1` (daily Windows task, `-WhatIf` supported).
`templates/routines/` holds the login and smoke-page routine templates (checked by `test/routine-templates.test.ts`).
**PowerShell gotcha:** do not pipe into `npm run cli -- ...` (npm drops the flags); write the list to a file, or splat as the scripts do.
Put the command first and global options (`--json`, `--url`) after it.

## Tests

- `npm test` — unit tests (`test/routine-v2.test.ts`): step validation, redaction, evaluate wrapping.
- `npm run test:smoke` — `test/routine-runner.smoke.ts` (frame/wait-condition helpers) and
  `test/credential-vault.smoke.ts` (vault secret end to end: origin binding, redaction, nothing on disk),
  `test/report-pdf.smoke.ts` (real PDFs in en/pt/es, nothing loaded from the network),
  `test/permission-matrix.smoke.ts` (3 roles x url/control/action probes, the three denial styles, a regression that gives a
  role new access turns the second run red),
  `test/regression-flow.smoke.ts` (RED pinned -> still red -> fix -> GREEN pinned, impact-ordered vault suite),
  `test/suite-run.smoke.ts` (credential locks measured server-side, failFast, verdicts, cancel, 409 vs interactive),
  `test/routine-library.smoke.ts` (pinned versions, history tagging, saving a run without its secret), all
  against a real headless Chromium instance. Tests must set `ARTIFACT_DIR` to a temp dir: `.env` may pin it.
- `test/inspect-dom.smoke.ts` spins up a local HTTP fixture and asserts `inspectDom` returns a correct
  snapshot; it isn't currently wired into an npm script, so run it directly with
  `tsx --test test/inspect-dom.smoke.ts` if you touch DOM-snapshot code.
