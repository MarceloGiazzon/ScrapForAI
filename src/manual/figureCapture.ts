import type { Frame, Page } from 'playwright';

import type { EvidenceCollector } from '../runner/collectEvidence.js';
import { runTrustedScript } from '../runner/trusted/runTrusted.js';
import type { DocStep } from '../schemas/docStep.schema.js';

/**
 * T9.2: takes the figure of one documentation step. The element to highlight is found with the runner's own locator (any selector the runner
 * understands), its bounding boxes are sent to the trusted script `doc-highlight` as NUMBERS, the page is photographed and the border is taken off
 * again whatever happens, so a failed screenshot cannot leave a mark on the page for the next step.
 *
 * A `highlight` that matches no visible element is an ERROR, not a figure without a highlight: the caption says "press this button", and a
 * manual build that quietly draws nothing would publish a lie after the application changed.
 */

/** More matches than this are not drawn (a selector that matches a whole table is a mistake, not a figure). */
export const MAX_HIGHLIGHTED_ELEMENTS = 10;

export class DocFigureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocFigureError';
  }
}

export interface DocFigureInput {
  page: Page;
  /** The frame the step targets: where `doc.highlight` is looked up. The border itself is always drawn in the main frame (boxes are relative to it). */
  frame: Frame;
  evidence: EvidenceCollector;
  stepId: string;
  doc: DocStep;
  knownSecrets: string[];
  /** How long to wait for the highlighted element to be visible. */
  timeoutMs: number;
}

/** The screenshot name of a step's figure; the file is `doc-<id>.png` (the artifact store makes the name safe). */
export const figureNameOf = (stepId: string): string => `doc-${stepId}`;

export async function captureDocFigure(input: DocFigureInput): Promise<{ figure: string }> {
  const { page, frame, evidence, stepId, doc, knownSecrets, timeoutMs } = input;

  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  if (doc.highlight !== undefined) {
    const matches = frame.locator(doc.highlight);
    try {
      await matches.first().waitFor({ state: 'visible', timeout: timeoutMs });
      await matches.first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
    } catch {
      throw new DocFigureError(`doc.highlight "${doc.highlight.slice(0, 120)}" matched no visible element, so the figure of step "${stepId}" would not show what its caption says`);
    }
    const count = Math.min(await matches.count(), MAX_HIGHLIGHTED_ELEMENTS);
    for (let index = 0; index < count; index += 1) {
      const box = await matches.nth(index).boundingBox();
      if (box && box.width > 0 && box.height > 0) rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
    }
    if (rects.length === 0) {
      throw new DocFigureError(`doc.highlight "${doc.highlight.slice(0, 120)}" has no visible area, so the figure of step "${stepId}" would not show what its caption says`);
    }
  }

  const main = page.mainFrame();
  try {
    if (rects.length > 0) await runTrustedScript(main, 'doc-highlight', { action: 'draw', rects }, { knownSecrets });
    const shot = await evidence.captureScreenshot(figureNameOf(stepId), { fullPage: doc.fullPage === true, stable: true });
    return { figure: shot.name };
  } finally {
    if (rects.length > 0) await runTrustedScript(main, 'doc-highlight', { action: 'clear' }, { knownSecrets }).catch(() => undefined);
  }
}
