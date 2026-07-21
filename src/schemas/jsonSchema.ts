import { z } from 'zod';

import { domInspectionRequestSchema } from './domInspectionRequest.schema.js';
import { explorationRequestSchema } from './explorationRequest.schema.js';
import { explorationResultSchema } from './explorationResult.schema.js';

export function buildRoutineRequestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(explorationRequestSchema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }) as Record<string, unknown>;
}

export function buildRoutineResultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(explorationResultSchema, {
    target: 'draft-2020-12',
    io: 'output',
    reused: 'ref',
  }) as Record<string, unknown>;
}

export function buildInspectDomRequestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(domInspectionRequestSchema, {
    target: 'draft-2020-12',
    io: 'input',
    reused: 'ref',
  }) as Record<string, unknown>;
}
