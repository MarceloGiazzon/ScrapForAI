import { evaluateExpression, ExpressionError, parseExpression, variablesOf } from './expression.js';
import { type NumberLocale, NumberParseError, parseInvariantNumber, parseLocaleNumber } from './localeNumber.js';

/**
 * T5.5: the verdict of an `assertEquals` step. Pure (no browser, no configuration): the runner hands it what the page showed
 * (`extracted`), what the run was fed (`parameters`) and the step, and gets back the outcome with a message a person can act on.
 *
 * Variables of an expression are the run's parameters (plain numbers, because they were generated) and the values extracted from the page
 * (parsed with the step's `locale`). A name that is both is an error rather than a guess.
 */

export interface AssertEqualsInput {
  actual: { extracted: string };
  expected: { expr: string } | { value: string };
  tolerance?: { absolute?: number; relative?: number };
  locale: NumberLocale;
  parameters: Record<string, string>;
  extracted: Record<string, unknown>;
}

export interface AssertEqualsOutcome {
  passed: boolean;
  actual: number;
  expected: number;
  /** One line saying what was compared and, when it failed, by how much. */
  message: string;
}

/** Floating-point noise only: a real tolerance is asked for with `tolerance`. */
export const DEFAULT_ABSOLUTE_TOLERANCE = 1e-9;

export class AssertEqualsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertEqualsError';
  }
}

const show = (value: number): string => String(Number(value.toPrecision(15)));

function readExtracted(name: string, raw: unknown, locale: NumberLocale): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') throw new AssertEqualsError(`extracted "${name}" is not text or a number`);
  try {
    return parseLocaleNumber(raw, locale);
  } catch (error) {
    if (error instanceof NumberParseError) throw new AssertEqualsError(`extracted "${name}": ${error.message}`);
    throw error;
  }
}

export function checkAssertEquals(input: AssertEqualsInput): AssertEqualsOutcome {
  const { locale } = input;
  if (!(input.actual.extracted in input.extracted)) {
    throw new AssertEqualsError(`nothing was extracted as "${input.actual.extracted}" (extractText/extractAttribute/evaluate must run first)`);
  }
  const actual = readExtracted(input.actual.extracted, input.extracted[input.actual.extracted], locale);

  const used: Array<[string, number]> = [];
  let expected: number;
  let description: string;

  try {
    if ('expr' in input.expected) {
      const tree = parseExpression(input.expected.expr);
      const lookup = (name: string): number => {
        const isParameter = Object.hasOwn(input.parameters, name);
        const isExtracted = Object.hasOwn(input.extracted, name);
        if (isParameter && isExtracted) throw new AssertEqualsError(`"${name}" is both a parameter and an extracted value: rename one of them`);
        if (!isParameter && !isExtracted) {
          const known = [...Object.keys(input.parameters), ...Object.keys(input.extracted)].filter((candidate) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate));
          throw new AssertEqualsError(`the expression uses "${name}", which is neither a parameter nor an extracted value (available: ${known.join(', ') || 'none'})`);
        }
        let value: number;
        try {
          value = isParameter ? parseInvariantNumber(input.parameters[name]!) : readExtracted(name, input.extracted[name], locale);
        } catch (error) {
          if (error instanceof NumberParseError) throw new AssertEqualsError(`parameter "${name}": ${error.message}`);
          throw error;
        }
        used.push([name, value]);
        return value;
      };
      // Every name is resolved up front so the message names the first missing one even inside a branch that `if` would not take.
      for (const name of variablesOf(tree)) lookup(name);
      used.length = 0;
      expected = evaluateExpression(tree, lookup);
      description = input.expected.expr;
    } else {
      expected = parseLocaleNumber(input.expected.value, locale);
      description = input.expected.value;
    }
  } catch (error) {
    if (error instanceof ExpressionError) throw new AssertEqualsError(`expected value: ${error.message}`);
    if (error instanceof NumberParseError) throw new AssertEqualsError(`expected value: ${error.message}`);
    throw error;
  }

  const diff = Number(Math.abs(actual - expected).toPrecision(12)); // 34.65 - 34.64 is 0.00999999999999801 in binary
  const absolute = input.tolerance?.absolute ?? (input.tolerance?.relative === undefined ? DEFAULT_ABSOLUTE_TOLERANCE : 0);
  const relative = input.tolerance?.relative ?? 0;
  const allowed = Math.max(absolute, relative * Math.abs(expected));
  const passed = diff <= allowed;

  const inputs = [...new Map(used).entries()].map(([name, value]) => `${name}=${show(value)}`).join(', ');
  const message = passed
    ? `${input.actual.extracted} = ${show(actual)} matches ${description}`
    : `${input.actual.extracted} is ${show(actual)} but ${description} gives ${show(expected)} (difference ${show(diff)}, tolerance ${show(allowed)})${inputs ? `; with ${inputs}` : ''}`;
  return { passed, actual, expected, message };
}
