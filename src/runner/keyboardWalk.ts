/**
 * T7.6: the keyboard walk, with the browser injected so the rules can be tested without one (runExploration supplies the real driver).
 *
 * Tab is pressed again and again and the element that takes focus is written down: `{ key, role, name, focusVisible }`. Three findings:
 *  - **never focused**: a control a keyboard user is expected to reach (the candidates, see the `keyboard-candidates` script) that no Tab ever
 *    reached. Only decided when the walk ran to its natural end (the page wrapped or focus left the document); with a trap or a cut-off walk
 *    we cannot know what a longer walk would have reached, so nothing is claimed;
 *  - **focus trap**: the sequence came back to an element that is not where it started, so Tab goes round a loop and never gets out;
 *  - **invisible focus** (heuristic): the element looks the same with and without focus (outline, box-shadow and border, from computed styles).
 *    "Without focus" is read right after Tab moved away from it, so no extra blur/focus event is fired on the page. An indicator that is always
 *    on is not a focus indicator, so it counts as invisible; an indicator built from anything else (background, text colour) is not seen by this
 *    heuristic, which is why the finding says "no outline, shadow or border change".
 * No value of a field is ever read; a name comes from label, aria, placeholder, title or the caption of a button or link.
 */

export interface StyleSignature {
  outline: string;
  shadow: string;
  border: string;
}

export interface ActiveElement {
  none?: true;
  key?: string;
  tag?: string;
  role?: string;
  name?: string;
  signature?: StyleSignature;
}

export interface Candidate {
  key: string;
  role: string;
  name?: string;
  /** The control counts as reached when focus visited any of these (radios of one group). */
  anyOf: string[];
}

export interface WalkDriver {
  active(): Promise<ActiveElement>;
  /** Presses Tab once. */
  press(): Promise<void>;
  /** The style of the element at `key` now, or undefined when it is gone. */
  styleOf(key: string): Promise<StyleSignature | undefined>;
}

export interface FocusStop {
  key: string;
  role: string;
  name?: string;
  /** Undefined when it could not be told (the walk stopped on it, or the element was gone). */
  focusVisible?: boolean;
}

export type WalkEnd = 'wrap' | 'left-document' | 'trap' | 'max-tabs' | 'time-limit';

export interface KeyboardWalkResult {
  order: FocusStop[];
  tabs: number;
  completed: boolean;
  endedBy: WalkEnd;
  trap?: { startsAt: string; length: number };
  /** Undefined when the walk did not complete (or no candidates were supplied). */
  neverFocused?: Array<{ key: string; role: string; name?: string }>;
  /** Keys of the stops whose focus left no visible change. */
  invisibleFocus: string[];
  notes: string[];
}

export interface WalkOptions {
  maxTabs: number;
  /** The walk starts from this already-focused element (it is stop 0) instead of from the top of the page. */
  startFocused?: boolean;
  candidates?: Candidate[];
  /** Absolute time (ms since epoch) after which the walk stops. */
  deadline?: number;
  now?: () => number;
}

/** True when anything of the focus indicator differs between the two readings. */
export function focusIndicatorChanged(focused: StyleSignature, blurred: StyleSignature): boolean {
  return focused.outline !== blurred.outline || focused.shadow !== blurred.shadow || focused.border !== blurred.border;
}

export async function walkKeyboard(driver: WalkDriver, options: WalkOptions): Promise<KeyboardWalkResult> {
  const now = options.now ?? Date.now;
  const order: FocusStop[] = [];
  const signatures: Array<StyleSignature | undefined> = [];
  const firstIndex = new Map<string, number>();
  const notes: string[] = [];
  let tabs = 0;
  let endedBy: WalkEnd = 'max-tabs';
  let trap: KeyboardWalkResult['trap'];

  const record = (element: ActiveElement): void => {
    firstIndex.set(element.key!, order.length);
    order.push({ key: element.key!, role: element.role ?? 'unknown', ...(element.name ? { name: element.name } : {}) });
    signatures.push(element.signature);
  };

  /** Focus has just left `order[index]`: compare how it looks now with how it looked while it had focus. */
  const settleVisibility = async (index: number): Promise<void> => {
    const focused = signatures[index];
    if (!focused) return;
    const blurred = await driver.styleOf(order[index]!.key);
    if (blurred) order[index]!.focusVisible = focusIndicatorChanged(focused, blurred);
  };

  if (options.startFocused) {
    const start = await driver.active();
    if (start.key) record(start);
    else notes.push('The start element did not take focus; the walk begins from the top of the page.');
  }

  while (tabs < options.maxTabs) {
    if (options.deadline !== undefined && now() > options.deadline) {
      endedBy = 'time-limit';
      break;
    }

    await driver.press();
    tabs += 1;
    const element = await driver.active();
    const previous = order.length - 1;

    // If focus did not move (a single control, or one that swallows Tab) the element still has focus: there is no "without focus" reading to take.
    if (previous >= 0 && element.key !== order[previous]!.key) await settleVisibility(previous);

    if (element.none || !element.key) {
      // Focus is on the page itself (or the browser): the document has been walked from end to end.
      endedBy = 'left-document';
      break;
    }

    const seenAt = firstIndex.get(element.key);
    if (seenAt !== undefined) {
      if (seenAt === 0) {
        endedBy = 'wrap';
      } else {
        endedBy = 'trap';
        trap = { startsAt: order[seenAt]!.key, length: order.length - seenAt };
      }
      break;
    }

    record(element);
  }

  const completed = endedBy === 'wrap' || endedBy === 'left-document';

  let neverFocused: KeyboardWalkResult['neverFocused'];
  if (options.candidates) {
    if (completed) {
      const visited = new Set(order.map((stop) => stop.key));
      neverFocused = options.candidates
        .filter((candidate) => !candidate.anyOf.some((key) => visited.has(key)))
        .map((candidate) => ({ key: candidate.key, role: candidate.role, ...(candidate.name ? { name: candidate.name } : {}) }));
    } else if (endedBy === 'trap') {
      notes.push('Focus trap: the controls that were not reached are not listed, because they may only be unreachable behind the trap.');
    } else {
      notes.push(`The walk stopped at ${tabs} Tab(s) (${endedBy}) before the end of the page, so unreached controls are not listed. Raise maxTabs or narrow the scope.`);
    }
  }

  return {
    order,
    tabs,
    completed,
    endedBy,
    ...(trap ? { trap } : {}),
    ...(neverFocused ? { neverFocused } : {}),
    invisibleFocus: order.filter((stop) => stop.focusVisible === false).map((stop) => stop.key),
    notes,
  };
}
