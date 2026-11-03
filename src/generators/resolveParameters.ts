import { randomBytes } from 'node:crypto';

import {
  checkedGeneratorSchema,
  type GeneratorInput,
  type Parameter,
  type ParameterRecord,
  parameterName,
  sanitizeParameterName,
} from '../schemas/parameters.schema.js';
import { valueAt } from './generators.js';

/**
 * T5.3: from "this run declares parameters and its steps use them" to "these are the values, for this seed and sample".
 *
 * - `valueFromParameter` names a declared parameter. `valueFromGenerator` is sugar for an implicit parameter of its own
 *   (`gen_<stepId>`), so a one-off value needs no declaration; the step is rewritten to `valueFromParameter` before the run.
 * - Every declared parameter takes its `sample`-th value for the seed: edge values first, then random ones (see generators.ts).
 *   Several parameters move together (the same sample index for each); a cartesian combination is the business of T5.4.
 * - The seed is the caller's, or a fresh one that is RETURNED, so a failure can always be replayed with the same seed and sample.
 *
 * With no parameter and no generator anywhere the input comes back untouched and `record` is undefined: a run without them is
 * byte-for-byte what it was before.
 */

export class ParameterError extends Error {
  constructor(
    readonly type: 'UnknownParameter' | 'InvalidGenerator' | 'DuplicateParameter',
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

interface StepLike {
  id?: string;
  action: string;
  valueFromParameter?: string;
  valueFromGenerator?: GeneratorInput;
}

export interface ResolveInput<T extends StepLike> {
  steps: T[];
  teardown?: T[];
  parameters?: Parameter[];
  seed?: string;
  sample?: number;
}

export interface ResolveOutput<T extends StepLike> {
  steps: T[];
  teardown?: T[];
  /** Absent when the run uses no parameter at all. */
  record?: ParameterRecord;
}

const usesParameters = (step: StepLike): boolean => step.valueFromParameter !== undefined || step.valueFromGenerator !== undefined;

/** Names a step list refers to through `valueFromParameter`. */
export function referencedParameters(steps: StepLike[]): string[] {
  return [...new Set(steps.flatMap((step) => (step.valueFromParameter !== undefined ? [step.valueFromParameter] : [])))];
}

export function resolveParameters<T extends StepLike>(input: ResolveInput<T>): ResolveOutput<T> {
  const declared = input.parameters ?? [];
  const all = [...input.steps, ...(input.teardown ?? [])];
  if (declared.length === 0 && !all.some(usesParameters)) return { steps: input.steps, ...(input.teardown ? { teardown: input.teardown } : {}) };

  const parameters: Parameter[] = [];
  const names = new Set<string>();
  for (const parameter of declared) {
    if (names.has(parameter.name)) throw new ParameterError('DuplicateParameter', `parameter "${parameter.name}" is declared twice`);
    names.add(parameter.name);
    parameters.push(parameter);
  }

  // Inline generators become implicit parameters, named after their step so the record says where each value went.
  const rewrite = (steps: T[], phase: string): T[] =>
    steps.map((step, index) => {
      if (step.valueFromGenerator === undefined) return step;
      // A step id may carry dots (`login.user`, from an include): the parameter name gets underscores instead.
      const name = sanitizeParameterName(`gen_${step.id ?? `${phase}${index}`}`);
      if (!parameterName.safeParse(name).success) throw new ParameterError('InvalidGenerator', `cannot name a parameter after step "${step.id}"`);
      if (names.has(name)) throw new ParameterError('DuplicateParameter', `"${name}" is already a parameter: give the step a different id`);
      const parsed = checkedGeneratorSchema.safeParse(step.valueFromGenerator);
      if (!parsed.success) {
        throw new ParameterError('InvalidGenerator', `step "${step.id ?? `${phase}${index}`}": ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      }
      names.add(name);
      parameters.push({ name, generator: parsed.data, includeBoundaries: true });
      const { valueFromGenerator: _generator, ...rest } = step;
      return { ...rest, valueFromParameter: name } as T;
    });

  const steps = rewrite(input.steps, 's');
  const teardown = input.teardown ? rewrite(input.teardown, 't') : undefined;

  const unknown = referencedParameters([...steps, ...(teardown ?? [])]).filter((name) => !names.has(name));
  if (unknown.length > 0) {
    throw new ParameterError('UnknownParameter', `step(s) use parameter(s) that are not declared: ${unknown.join(', ')} (declared: ${[...names].join(', ') || 'none'})`);
  }

  const seed = input.seed ?? randomBytes(6).toString('hex');
  const sample = input.sample ?? 0;
  const values: Record<string, string> = {};
  const sources: ParameterRecord['sources'] = {};
  for (const parameter of parameters) {
    const generated = valueAt(parameter, sample, seed);
    values[parameter.name] = generated.value;
    sources[parameter.name] = { source: generated.source, index: generated.index };
  }

  const synthetic = parameters.filter((parameter) => 'generator' in parameter && parameter.generator.type === 'document').map((parameter) => parameter.name);
  return { steps, ...(teardown ? { teardown } : {}), record: { seed, sample, values, sources, ...(synthetic.length > 0 ? { synthetic } : {}) } };
}
