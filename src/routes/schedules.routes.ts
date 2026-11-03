import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { RoutineLibraryError } from '../library/routineLibrary.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { getScheduler } from '../scheduler/runtime.js';
import { getScheduleView, listScheduleViews, removeSchedule, saveScheduleDefinition } from '../scheduler/scheduleService.js';
import { requireBearer } from '../security/apiAuth.js';
import { safeName } from '../schemas/explorationRequest.schema.js';

/** /v1/schedules (T3.2). Writing a schedule makes the server start browsers on its own, so every write needs the bearer token. */
export const schedulesRouter = Router();

function known(res: Response, error: unknown): boolean {
  if (error instanceof RequestResolutionError || error instanceof RoutineLibraryError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid schedule', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return true;
  }
  return false;
}

const idOf = (value: unknown): string | undefined => {
  const parsed = safeName.safeParse(String(value));
  return parsed.success ? parsed.data : undefined;
};
const notFound = (res: Response): void => void res.status(404).json({ error: { type: 'ScheduleNotFound', message: 'Schedule not found' } });

schedulesRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ schedulerRunning: getScheduler() !== undefined, schedules: await listScheduleViews() });
  } catch (error) {
    next(error);
  }
});

schedulesRouter.get('/:id', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const found = id ? await getScheduleView(id) : undefined;
    if (!found) return notFound(res);
    res.json({ schedulerRunning: getScheduler() !== undefined, ...found });
  } catch (error) {
    next(error);
  }
});

schedulesRouter.put('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return notFound(res);
    const { view, created } = await saveScheduleDefinition(id, req.body);
    res.status(created ? 201 : 200).json(view);
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

schedulesRouter.delete('/:id', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id || !(await removeSchedule(id))) return notFound(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/** POST /v1/schedules/:id/run-now: start the target now, outside the clock. Honors overlap. Needs the scheduler to be running in this process. */
schedulesRouter.post('/:id/run-now', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id || !(await getScheduleView(id))) return notFound(res);
    const scheduler = getScheduler();
    if (!scheduler) {
      res.status(409).json({ error: { type: 'SchedulerDisabled', message: 'The scheduler is not running in this server (SCHEDULER_ENABLED=false)' } });
      return;
    }
    res.status(202).json(await scheduler.runNow(id));
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});
