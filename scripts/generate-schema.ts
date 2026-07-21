process.env.SCRAPFORAI_API_KEY ??= 'schema-generation-placeholder-key';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://placeholder.example.com';

const { mkdir, writeFile } = await import('node:fs/promises');
const { resolve } = await import('node:path');
const { buildRoutineRequestJsonSchema, buildRoutineResultJsonSchema } = await import('../src/schemas/jsonSchema.js');

const outDir = resolve(process.cwd(), 'schema');

const artifacts: Array<[string, Record<string, unknown>]> = [
  ['routine.request.json', buildRoutineRequestJsonSchema()],
  ['routine.result.json', buildRoutineResultJsonSchema()],
];

await mkdir(outDir, { recursive: true });

for (const [name, schema] of artifacts) {
  const path = resolve(outDir, name);
  await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
}
