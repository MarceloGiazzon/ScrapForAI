import { z } from 'zod';

/**
 * T5.3 (Appendix A.6): parameters and value generators. Pure schema, no configuration import: the generators run anywhere and this
 * file is imported by the request schema, so it must not import it back (hence its own `parameterName`).
 */
export const parameterName = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

/** Turns any text (a step id like `login.user`, an include path) into a legal parameter name. */
export const sanitizeParameterName = (text: string): string => text.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are ISO yyyy-MM-dd')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'not a real calendar date');

/** Output format of a date: yyyy, yy, MM, dd and separators. Letters and digits other than the tokens are refused (ambiguous). */
export const DATE_FORMAT = /^(?:yyyy|yy|MM|dd|[^A-Za-z0-9])+$/;

const safeInt = z.number().int().min(Number.MIN_SAFE_INTEGER + 2).max(Number.MAX_SAFE_INTEGER - 2);

export const generatorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('int'), min: safeInt, max: safeInt }).strict(),
  z.object({ type: z.literal('decimal'), min: z.number().finite(), max: z.number().finite(), scale: z.number().int().min(0).max(8) }).strict(),
  z
    .object({
      type: z.literal('date'),
      from: isoDate,
      to: isoDate,
      format: z.string().min(1).max(40).regex(DATE_FORMAT, 'format: yyyy, yy, MM, dd and separators only').default('dd/MM/yyyy'),
    })
    .strict(),
  z
    .object({
      type: z.literal('string'),
      minLength: z.number().int().min(0).max(5000),
      maxLength: z.number().int().min(0).max(5000),
      charset: z.enum(['alpha', 'alnum', 'unicode', 'hostile']).default('alnum'),
    })
    .strict(),
  z.object({ type: z.literal('oneOf'), values: z.array(z.string().max(5000)).min(1).max(200) }).strict(),
  // Synthetic identity documents with correct (or deliberately wrong) check digits. `formatted` adds the usual separators
  // (cpf 000.000.000-00, cnpj 00.000.000/0000-00, ci-uy 0.000.000-0; rut-uy has none).
  z
    .object({
      type: z.literal('document'),
      kind: z.enum(['ci-uy', 'rut-uy', 'cpf', 'cnpj']),
      valid: z.boolean().default(true),
      formatted: z.boolean().default(false),
    })
    .strict(),
]);

/** A generator as written (defaults not yet applied) and as parsed. */
export type GeneratorInput = z.input<typeof generatorSchema>;
export type Generator = z.output<typeof generatorSchema>;

/** Cross-field rules a plain object schema cannot express. Returns the problems, empty when fine. */
export function generatorProblems(generator: Generator): string[] {
  switch (generator.type) {
    case 'int':
    case 'decimal':
      return generator.min > generator.max ? ['min is greater than max'] : [];
    case 'date':
      return generator.from > generator.to ? ['from is after to'] : [];
    case 'string':
      return generator.minLength > generator.maxLength ? ['minLength is greater than maxLength'] : [];
    default:
      return [];
  }
}

const withGeneratorChecks = <T extends z.ZodType<Generator>>(schema: T) =>
  schema.superRefine((generator, ctx) => {
    for (const message of generatorProblems(generator)) ctx.addIssue({ code: 'custom', message });
  });

export const checkedGeneratorSchema = withGeneratorChecks(generatorSchema);

export const parameterSchema = z.union([
  z
    .object({
      name: parameterName,
      generator: checkedGeneratorSchema,
      // Edge values first (min, min-1, max, max+1, zero, ...) and only then random ones. Default true.
      includeBoundaries: z.boolean().default(true),
    })
    .strict(),
  z.object({ name: parameterName, cases: z.array(z.string().max(5000)).min(1).max(500) }).strict(),
]);

export type Parameter = z.output<typeof parameterSchema>;

export const parametersSchema = z
  .array(parameterSchema)
  .max(50)
  .superRefine((parameters, ctx) => {
    const seen = new Set<string>();
    parameters.forEach((parameter, index) => {
      if (seen.has(parameter.name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `parameter "${parameter.name}" is declared twice` });
      seen.add(parameter.name);
    });
  });

export const seedSchema = z.string().min(1).max(100);
export const sampleIndexSchema = z.number().int().min(0).max(1_000_000);

/** What a run records about its parameters (T5.3): not secrets, so they are shown as they are. */
export const parameterRecordSchema = z
  .object({
    seed: z.string(),
    sample: z.number().int(),
    values: z.record(z.string(), z.string()),
    /** Where each value came from: an edge value, a random one or a listed case; `index` is its position in that stream. */
    sources: z.record(z.string(), z.object({ source: z.enum(['boundary', 'random', 'case']), index: z.number().int() }).strict()),
    /**
     * Parameters whose values are SYNTHETIC identity documents. A generated CPF/CI/RUT/CNPJ is made up, but with correct check digits it
     * can coincide with a real person's or company's: dev/QA environments only, and reports say so.
     */
    synthetic: z.array(z.string()).optional(),
  })
  .strict();
export type ParameterRecord = z.infer<typeof parameterRecordSchema>;
