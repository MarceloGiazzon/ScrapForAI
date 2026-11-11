import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { getRoutine, listRoutines, listVersions, RoutineLibraryError } from '../library/routineLibrary.js';
import { lintRoutineContent, runLibraryRoutine, saveRoutine, setRoutineStatus } from '../library/routineService.js';
import { acquireInteractiveSlot } from '../runner/jobSlots.js';
import { RequestResolutionError } from '../runner/resolveRequest.js';
import { routineLintBodySchema, routineRunBodySchema, routineSaveBodySchema, routineStatusChangeSchema } from '../schemas/libraryRoutine.schema.js';
import { redactSecrets } from '../security/redactSecrets.js';
import { TargetUrlNotAllowedError } from '../security/validateTargetUrl.js';
import { VaultError } from '../vault/credentials/credentialVault.js';
import { initiatorOf } from '../team/initiator.js';

/** /v1/routines: the versioned routine library (T1.3). */
export const routinesRouter = Router();

function zodDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** Sends the response for the errors this router raises on purpose; returns false for the rest. */
function sendKnownError(res: Response, error: unknown): boolean {
  if (error instanceof RoutineLibraryError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return true;
  }

  if (error instanceof RequestResolutionError || error instanceof VaultError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }

  if (error instanceof TargetUrlNotAllowedError) {
    res.status(400).json({ error: { type: error.name, message: error.message } });
    return true;
  }

  if (error instanceof ZodError) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid request', details: zodDetails(error) } });
    return true;
  }

  return false;
}

/** `?version=N`: a positive integer, or undefined when absent. Anything else is a 400. */
function parseVersion(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : 'invalid';
}

routinesRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ routines: await listRoutines() });
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(error);
    }
  }
});

routinesRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const version = parseVersion(req.query.version);
    if (version === 'invalid') {
      res.status(400).json({ error: { type: 'ValidationError', message: 'version must be a positive integer', details: [] } });
      return;
    }

    const routine = await getRoutine(id, version);
    if (!routine) {
      res.status(404).json({ error: { type: 'RoutineNotFound', message: version === undefined ? `Routine "${id}" does not exist` : `Routine "${id}" has no version ${version}` } });
      return;
    }

    res.json({ routine, versions: await listVersions(id) });
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(error);
    }
  }
});

// T8.4: the authoring conventions, without saving anything.
routinesRouter.post('/lint', async (req, res, next) => {
  try {
    const parsed = routineLintBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid lint request', details: zodDetails(parsed.error) } });
      return;
    }
    res.json(await lintRoutineContent(parsed.data));
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(error);
    }
  }
});

routinesRouter.put('/:id', async (req, res, next) => {
  try {
    const parsed = routineSaveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid routine', details: zodDetails(parsed.error) } });
      return;
    }

    const { routine, created, lint } = await saveRoutine(String(req.params.id), parsed.data);
    res.status(created ? 201 : 200).json({ created, routine, lint });
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(error);
    }
  }
});

/**
 * Quarantine, release, activate, retire or park a routine: the same content under another status, as the next version. A runner may do it,
 * exactly as a runner could already do it by saving the routine again (PUT), so this adds no power; it adds the reason, the person in the audit
 * log and a path that does not re-judge the content (see setRoutineStatus).
 */
routinesRouter.post('/:id/status', async (req, res, next) => {
  try {
    const parsed = routineStatusChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid status change', details: zodDetails(parsed.error) } });
      return;
    }

    const id = String(req.params.id);
    const change = await setRoutineStatus(id, parsed.data.status, { reason: parsed.data.reason, changedBy: req.principal?.userId });
    res.locals.auditDetail = {
      routine: id,
      from: change.previousStatus,
      to: change.routine.status,
      version: change.routine.version,
      changed: change.changed,
      reason: parsed.data.reason,
    };
    res.json({
      changed: change.changed,
      previousStatus: change.previousStatus,
      previousVersion: change.previousVersion,
      routine: { id: change.routine.id, version: change.routine.version, status: change.routine.status, title: change.routine.title, sha256: change.routine.sha256 },
      ...(change.includedBy ? { includedBy: change.includedBy } : {}),
    });
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(error);
    }
  }
});

routinesRouter.post('/:id/run', async (req, res, next) => {
  const version = parseVersion(req.query.version);
  if (version === 'invalid') {
    res.status(400).json({ error: { type: 'ValidationError', message: 'version must be a positive integer', details: [] } });
    return;
  }

  const parsed = routineRunBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid run request', details: zodDetails(parsed.error) } });
    return;
  }

  // The lock key is the credential set this run will actually use (override, else the routine's own).
  const stored = await getRoutine(String(req.params.id), version).catch(() => undefined);
  const slot = await acquireInteractiveSlot({
    credentialSet: parsed.data.credentialSet ?? stored?.credentialSet,
    targetProfile: parsed.data.targetProfile ?? stored?.targetProfile,
  });
  if (!slot.ok) {
    res.status(slot.status).json({ error: { type: slot.type, message: slot.message } });
    return;
  }

  try {
    const result = await runLibraryRoutine(String(req.params.id), version, parsed.data, { initiator: initiatorOf(req.principal) });
    res.status(result.status === 'passed' ? 200 : 500).json(result);
  } catch (error) {
    if (!sendKnownError(res, error)) {
      next(redactSecrets(error));
    }
  } finally {
    slot.release();
  }
});
