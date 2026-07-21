import { Router } from 'express';

import { buildInspectDomRequestJsonSchema, buildRoutineRequestJsonSchema, buildRoutineResultJsonSchema } from '../schemas/jsonSchema.js';

export const schemaRouter = Router();

const routineRequestSchema = buildRoutineRequestJsonSchema();
const routineResultSchema = buildRoutineResultJsonSchema();
const inspectDomRequestSchema = buildInspectDomRequestJsonSchema();

schemaRouter.get('/', (_req, res) => {
  res.json({
    routineRequest: '/v1/schema/routine.request.json',
    routineResult: '/v1/schema/routine.result.json',
    inspectDomRequest: '/v1/schema/inspect-dom.request.json',
  });
});

schemaRouter.get('/routine.request.json', (_req, res) => {
  res.type('application/schema+json').json(routineRequestSchema);
});

schemaRouter.get('/routine.result.json', (_req, res) => {
  res.type('application/schema+json').json(routineResultSchema);
});

schemaRouter.get('/inspect-dom.request.json', (_req, res) => {
  res.type('application/schema+json').json(inspectDomRequestSchema);
});
