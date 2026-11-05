import { valueAt } from '../generators/generators.js';
import type { Parameter } from '../schemas/parameters.schema.js';
import type { ShrinkParameter } from './shrink.js';

/**
 * T5.6: what shrinking may do with each parameter, from how it is generated. The "baseline" is a neutral value to reset a parameter to
 * ("this parameter is not what breaks it"): zero (or the nearest value inside the range) for numbers, a short plain text for strings, the
 * first listed value for a choice, the first date of the range, a VALID document.
 */
export function describeParameter(parameter: Parameter): ShrinkParameter {
  const { name } = parameter;
  if ('cases' in parameter) return { name, shape: { kind: 'opaque', baseline: parameter.cases[0]! } };
  // A table row is one case with its own expected result: shrinkService stops before this (there is nothing to shrink).
  if ('fromTable' in parameter) return { name, shape: { kind: 'opaque', baseline: '' } };

  const generator = parameter.generator;
  switch (generator.type) {
    case 'int': {
      const baseline = Math.min(Math.max(0, generator.min), generator.max);
      return { name, shape: { kind: 'int', baseline: String(baseline) } };
    }
    case 'decimal': {
      const baseline = Math.min(Math.max(0, generator.min), generator.max);
      return { name, shape: { kind: 'decimal', scale: generator.scale, baseline: baseline.toFixed(generator.scale) } };
    }
    case 'string':
      return { name, shape: { kind: 'string', baseline: 'a'.repeat(Math.max(generator.minLength, Math.min(1, generator.maxLength))) } };
    case 'oneOf':
      return { name, shape: { kind: 'opaque', baseline: generator.values[0]! } };
    case 'date':
      return { name, shape: { kind: 'opaque', baseline: valueAt({ name, generator, includeBoundaries: true }, 0, 'baseline').value } };
    case 'document':
      return { name, shape: { kind: 'opaque', baseline: valueAt({ name, generator: { ...generator, valid: true }, includeBoundaries: false }, 0, 'baseline').value } };
  }
}

export const describeParameters = (parameters: Parameter[]): ShrinkParameter[] => parameters.map(describeParameter);
