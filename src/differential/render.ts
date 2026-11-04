import type { DifferentialState } from './differentialService.js';

/**
 * Markdown for a differential run (T6.3): the verdict, then ONLY the routines that differ or could not run, with one line per difference.
 * Pure. Text from the application (console messages, extracted values) is shown as inline code with backticks neutralized, so a page cannot
 * inject markup into the report.
 */

const code = (text: string): string => `\`${text.replace(/`/g, "'").replace(/[\r\n]+/g, ' ')}\``;

export function renderDifferentialMarkdown(state: DifferentialState): string {
  const { left, right } = state.labels;
  const lines: string[] = [];
  lines.push(`# Differential run ${state.differentialId}`, '');
  lines.push(`- **${left}** (baseline) × **${right}** (candidate)`);
  lines.push(`- Verdict: **${state.verdict ?? state.status}**${state.reason ? ` — ${state.reason}` : ''}`);
  lines.push(`- Routines: ${state.counts.total} (${state.counts.same} same, ${state.counts.different} different, ${state.counts.infraError} could not run, ${state.counts.notRun} not run)`);
  for (const warning of state.warnings ?? []) lines.push(`- Warning: ${code(warning)}`);
  lines.push('');

  const interesting = state.pairs.filter((pair) => pair.outcome !== 'same');
  if (interesting.length === 0) {
    lines.push('Every routine behaved the same on both sides.');
  }
  for (const pair of interesting) {
    lines.push(`## ${pair.routineId}@v${pair.version}: ${pair.outcome ?? pair.state}`, '');
    if (pair.error) lines.push(`Could not compare: ${code(pair.error)}`, '');
    for (const [label, side] of [[left, pair.left], [right, pair.right]] as const) {
      if (side?.jobId) lines.push(`- ${label}: run ${side.jobId} ${side.status}${side.buildId ? `, build ${code(side.buildId)}` : ''}`);
    }
    if (pair.comparison) {
      lines.push('');
      for (const line of pair.lines ?? []) lines.push(`- ${code(line)}`);
      const timing = pair.timeLines ?? [];
      if (timing.length > 0) {
        lines.push('', 'Time (information, does not change the verdict):');
        for (const line of timing) lines.push(`- ${code(line)}`);
      }
      for (const note of pair.comparison.notes) lines.push(`- _${note}_`);
    }
    lines.push('');
  }
  lines.push('_Evidence of each run is kept under its run id; ephemeral evidence expires._');
  return `${lines.join('\n')}\n`;
}
