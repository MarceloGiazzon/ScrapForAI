import { z } from 'zod';

import { buildIdSchema, safeName } from './explorationRequest.schema.js';

/**
 * T6.1 permission matrix: roles (credential sets) x probes, with an optional expectation per cell.
 * Roadmap Appendix A.7, with these differences, all because the tasks they depend on do not exist yet:
 *  - a `control` probe takes the `url` of its screen (the screen catalogue of T4.2 does not exist; `screen` is a free label);
 *  - "diff against the previous release" is against the previous run of the same matrix (the structural diff of T4.1 does not exist);
 *  - `loginRoutine` is explicit (T8.1, the profile's automatic login, does not exist yet); it falls back to the profile's field.
 */

/** Probe ids become step ids and extracted names, so they are shorter than a safeName. */
/** Probe ids generated from the screen catalogue (T6.2) are `screen-<screenId>`. */
export const CATALOG_PROBE_PREFIX = 'screen-';

export const probeIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/, 'probe id: [a-zA-Z0-9_-]{1,60}');

/** Absolute http(s) URL, or a path starting with "/" resolved against the target profile's baseUrl. */
const probeUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => value.startsWith('/') || /^https?:\/\//i.test(value), { message: 'url must be absolute (http/https) or start with "/"' });

const label = z.string().min(1).max(160).optional();

export const permissionProbeSchema = z.discriminatedUnion('kind', [
  /** Open the URL directly (not through the menu): does the role get the page, or a denial? */
  z
    .object({
      kind: z.literal('url'),
      id: probeIdSchema,
      url: probeUrl,
      label,
      /**
       * T6.2: the roles whose MENU offers this page. A role not listed here is expected to be denied when it opens the
       * URL directly (unless `expected` says otherwise); getting the page anyway is an access-control alert.
       */
      offeredTo: z.array(safeName).max(20).optional(),
    })
    .strict(),
  /** On the page at `url`, the state of `selector` for the role: hidden, enabled or disabled (or the page is denied). */
  z
    .object({ kind: z.literal('control'), id: probeIdSchema, url: probeUrl, selector: z.string().min(1).max(500), screen: z.string().min(1).max(120).optional(), label })
    .strict(),
  /** Run a library routine as the role: it passes (allowed) or fails with a denial signal (denied). */
  z.object({ kind: z.literal('action'), id: probeIdSchema, routineId: safeName, version: z.number().int().positive().optional(), label }).strict(),
]);
export type PermissionProbe = z.infer<typeof permissionProbeSchema>;

export const deniedWhenSchema = z.union([
  /** The page ended on a URL containing this (e.g. bounced to the GAM login, or to /NotAuthorized). */
  z.object({ urlContains: z.string().min(1).max(500) }).strict(),
  /** The page shows this text ("Not authorized", "Acceso denegado"). */
  z.object({ textVisible: z.string().min(1).max(500) }).strict(),
  /** The page's own HTTP status (navigation), e.g. 403. */
  z.object({ status: z.number().int().min(100).max(599) }).strict(),
]);
export type DeniedWhen = z.infer<typeof deniedWhenSchema>;

export const expectationSchema = z.enum(['allowed', 'denied', 'visible', 'hidden', 'enabled', 'disabled']);
export type Expectation = z.infer<typeof expectationSchema>;

const URL_OR_ACTION_EXPECTATIONS: ReadonlySet<Expectation> = new Set(['allowed', 'denied']);

/** The object BEFORE its cross-field checks: derived schemas (the MCP tool's) are built from this one. */
export const permissionMatrixObjectSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    targetProfile: safeName,
    /** Library routine that logs in with fields valueFromCredential (same field names in every role's set). Default: the profile's loginRoutine. */
    loginRoutine: safeName.optional(),
    loginRoutineVersion: z.number().int().positive().optional(),
    /** Credential sets, one per role. Each must be listed in the target profile. */
    roles: z.array(safeName).min(1).max(20),
    deniedWhen: z.array(deniedWhenSchema).min(1).max(20),
    probes: z.array(permissionProbeSchema).max(200).default([]),
    /**
     * T6.2: also probe, for every role, the direct URL of each screen of the target profile's catalogue that has a
     * `reach.url` (probe id `screen-<screenId>`). A screen's `offeredTo` says which roles' menu shows it.
     */
    screensFromCatalog: z.boolean().optional(),
    /** role -> probe id -> what it should be. Cells without an expectation are only compared with the previous run. */
    expected: z.record(safeName, z.record(probeIdSchema, expectationSchema)).optional(),
    /** Pause after opening a probe's page, for pages that render or redirect after load. Capped by STEP_TIMEOUT_MS. */
    settleMs: z.number().int().min(0).max(30_000).default(1500),
    /** Control probes: how long to wait for the selector to appear before calling it hidden. Capped by STEP_TIMEOUT_MS. */
    controlWaitMs: z.number().int().min(0).max(30_000).default(3000),
    /**
     * `perRole` (default): one login per role, then its url/control probes in that session (in chunks that fit
     * MAX_STEPS_PER_JOB and JOB_TIMEOUT_MS). `perProbe`: a fresh login for every url/control probe: slower, but a
     * probe can never affect the next one. Action probes always get their own session.
     */
    isolation: z.enum(['perRole', 'perProbe']).default('perRole'),
  })
  .strict();

export const permissionMatrixSchema = permissionMatrixObjectSchema.superRefine((matrix, ctx) => {
    const roles = new Set<string>();
    matrix.roles.forEach((role, index) => {
      if (roles.has(role)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['roles', index], message: `role "${role}" is listed twice` });
      roles.add(role);
    });

    if (matrix.probes.length === 0 && !matrix.screensFromCatalog) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['probes'], message: 'a matrix needs at least one probe, or screensFromCatalog: true' });
    }

    const probes = new Map<string, PermissionProbe>();
    matrix.probes.forEach((probe, index) => {
      if (probe.kind === 'url') {
        (probe.offeredTo ?? []).forEach((role) => {
          if (!roles.has(role)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['probes', index, 'offeredTo'], message: `"${role}" is not one of the roles` });
        });
      }
      if (probes.has(probe.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['probes', index, 'id'], message: `probe id "${probe.id}" is used twice` });
      probes.set(probe.id, probe);
    });

    if (matrix.roles.length * matrix.probes.length > 500) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['probes'], message: 'roles x probes must not exceed 500 cells; split the matrix' });
    }

    for (const [role, cells] of Object.entries(matrix.expected ?? {})) {
      if (!roles.has(role)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expected', role], message: `"${role}" is not one of the roles` });
        continue;
      }
      for (const [probeId, expectation] of Object.entries(cells)) {
        const probe = probes.get(probeId);
        // A catalogue screen's probe (`screen-<id>`) exists only when the run starts: checked again there.
        if (!probe && matrix.screensFromCatalog && probeId.startsWith(CATALOG_PROBE_PREFIX)) continue;
        if (!probe) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expected', role, probeId], message: `"${probeId}" is not one of the probes` });
        } else if (probe.kind !== 'control' && !URL_OR_ACTION_EXPECTATIONS.has(expectation)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['expected', role, probeId],
            message: `a ${probe.kind} probe can only be expected "allowed" or "denied", not "${expectation}"`,
          });
        }
      }
    }
  });
export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;

/** A stored definition: the matrix plus its id and when it was saved. */
export const storedMatrixSchema = z
  .object({ id: safeName, updatedAt: z.string(), sha256: z.string().length(64), matrix: permissionMatrixSchema })
  .strict();
export type StoredMatrix = z.infer<typeof storedMatrixSchema>;

export const matrixRunBodySchema = z
  .object({
    buildId: buildIdSchema.optional(),
    retention: z.enum(['ephemeral', 'standard']).optional(),
  })
  .strict();
export type MatrixRunBody = z.infer<typeof matrixRunBodySchema>;

export const cellOutcomeSchema = z.enum(['pending', 'allowed', 'denied', 'error']);
export const controlStateSchema = z.enum(['hidden', 'enabled', 'disabled']);

export const matrixCellSchema = z
  .object({
    role: z.string(),
    probeId: z.string(),
    kind: z.enum(['url', 'control', 'action']),
    outcome: cellOutcomeSchema,
    /** Control probes on a page that was not denied. */
    state: controlStateSchema.optional(),
    /** `menu`: the expectation was derived from the probe's `offeredTo` (T6.2), nobody wrote it for this cell. */
    expectedBy: z.literal('menu').optional(),
    /** Which deniedWhen rule matched, e.g. `urlContains "login"`. */
    deniedBy: z.string().optional(),
    /** Where the page ended (url/control probes). */
    finalUrl: z.string().optional(),
    expected: expectationSchema.optional(),
    /** Present when there is an expectation and the cell has an answer. */
    matches: z.boolean().optional(),
    jobId: z.string().optional(),
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  .strict();
export type MatrixCell = z.infer<typeof matrixCellSchema>;

export const matrixChangeSchema = z
  .object({
    role: z.string(),
    probeId: z.string(),
    from: z.string(),
    to: z.string(),
    /** gainedAccess: the role can do or see MORE than in the previous run. */
    change: z.enum(['gainedAccess', 'lostAccess']),
    /** True when access was gained and no expectation covers the cell: nobody said this role should have it. */
    alert: z.boolean(),
  })
  .strict();
export type MatrixChange = z.infer<typeof matrixChangeSchema>;

export const matrixRunStateSchema = z
  .object({
    runId: z.string(),
    matrixId: z.string(),
    matrixSha256: z.string(),
    matrix: permissionMatrixSchema,
    title: z.string().optional(),
    targetProfile: z.string(),
    buildId: z.string().optional(),
    status: z.enum(['running', 'completed', 'cancelled', 'interrupted']),
    createdAt: z.string(),
    finishedAt: z.string().optional(),
    /** Sessions (browser runs) the matrix was split into. */
    sessions: z.number(),
    cells: z.array(matrixCellSchema),
    comparedTo: z.object({ runId: z.string(), createdAt: z.string(), buildId: z.string().optional() }).strict().optional(),
    changes: z.array(matrixChangeSchema),
    counts: z
      .object({
        pending: z.number(),
        allowed: z.number(),
        denied: z.number(),
        error: z.number(),
        mismatches: z.number(),
        alerts: z.number(),
        /** T6.2: role/screen pairs that opened a page the role's menu does not offer (included in `mismatches`). */
        unofferedAccess: z.number().optional(),
      })
      .strict(),
    /**
     * green (0): every cell answered, every expectation met, no unexpected gain of access.
     * red (1): an expectation was not met, or a role gained access no expectation covers.
     * infra-error (2): otherwise some cell could not be answered (login failed, page broke), or the run was cancelled.
     * Red wins over infra-error: a proven widening of access is never hidden behind another cell's error.
     */
    verdict: z.enum(['green', 'red', 'infra-error']).optional(),
    verdictReason: z.string().optional(),
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  })
  .strict();
export type MatrixRunState = z.infer<typeof matrixRunStateSchema>;
