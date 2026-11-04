import type { FigureChangeSet, ManualFigure } from '../schemas/manual.schema.js';
import { compareFigures } from './figureHash.js';

/**
 * T9.2: what changed between the figures of the previous build and the ones just taken. Keyed by figure id (`<routineId>/<stepId>`), so adding a step
 * before another does not make every later figure look new. PURE.
 */
export function diffFigures(
  previous: { figures: readonly ManualFigure[]; buildId?: string; createdAt?: string } | undefined,
  current: readonly ManualFigure[],
): FigureChangeSet {
  const byId = (items: readonly ManualFigure[]): Map<string, ManualFigure> => new Map(items.map((figure) => [figure.id, figure]));
  const before = byId(previous?.figures ?? []);
  const after = byId(current);

  const added: string[] = [];
  const changed: FigureChangeSet['changed'] = [];
  const negligible: string[] = [];
  let unchanged = 0;

  for (const [id, figure] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    const old = before.get(id);
    if (!old) {
      added.push(id);
      continue;
    }
    const comparison = compareFigures(old, figure);
    if (comparison.verdict === 'unchanged') unchanged += 1;
    else if (comparison.verdict === 'negligible') negligible.push(id);
    else {
      changed.push({
        id,
        reason: comparison.reason ?? 'bytes',
        ...(comparison.changedCells === undefined ? {} : { changedCells: comparison.changedCells }),
        ...(comparison.totalCells === undefined ? {} : { totalCells: comparison.totalCells }),
        ...(comparison.percent === undefined ? {} : { percent: comparison.percent }),
      });
    }
  }

  const removed = [...before.keys()].filter((id) => !after.has(id)).sort((a, b) => a.localeCompare(b));
  return {
    // A previous manifest with no figures is as good as none: there is nothing to compare with.
    firstBuild: previous === undefined || previous.figures.length === 0,
    ...(previous?.buildId === undefined ? {} : { previousBuildId: previous.buildId }),
    ...(previous?.createdAt === undefined ? {} : { previousCreatedAt: previous.createdAt }),
    new: added,
    removed,
    changed,
    negligible,
    unchanged,
  };
}
