import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

/**
 * T1.5 evidence manifest: <jobDir>/manifest.json lists every file of a run with its sha256, so any
 * later change to a screenshot or to result.json is detectable. T2.6 builds signing and the
 * manifest chain on top of this format.
 *
 * What it proves: the files are byte-identical to what was recorded. It does not prove the test was
 * correct, and an attacker who can rewrite the directory can rewrite an unsigned manifest too.
 */

export const MANIFEST_FILE = 'manifest.json';

export const evidenceManifestSchema = z
  .object({
    version: z.literal(1),
    jobId: z.string(),
    createdAt: z.string(),
    retention: z.enum(['ephemeral', 'standard', 'pinned']),
    resultSha256: z.string().length(64),
    files: z.array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string().length(64) }).strict()),
    /** What this evidence is about (T2.6), read from result.json when the evidence is pinned. */
    context: z
      .object({
        scenarioName: z.string().optional(),
        targetUrl: z.string().optional(),
        buildId: z.string().optional(),
        routine: z.object({ id: z.string(), version: z.number(), sha256: z.string() }).strict().optional(),
        status: z.enum(['passed', 'failed']).optional(),
      })
      .strict()
      .optional(),
    /** Position in the chain of signed manifests of this installation (T2.6). */
    chain: z
      .object({
        sequence: z.number().int().positive(),
        /** sha256 of the previous manifest FILE in the chain; null for the first. Removing or editing one breaks the next. */
        previousManifestSha256: z.string().length(64).nullable(),
      })
      .strict()
      .optional(),
    signature: z.object({ alg: z.literal('Ed25519'), keyId: z.string().length(64), value: z.string() }).strict().optional(),
    pin: z
      .object({
        pinnedAt: z.string(),
        reason: z.string(),
        ref: z.string().optional(),
        keepTrace: z.boolean(),
        traceDiscarded: z.boolean(),
        /** 'run': the manifest predates the pin. 'pin': none existed, so the baseline is the pin itself. */
        integrityBaseline: z.enum(['run', 'pin']),
        /** sha256 of the manifest the run wrote, before the pin rewrote it. */
        originalManifestSha256: z.string().length(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;

export interface ManifestProblem {
  path: string;
  problem: 'modified' | 'missing' | 'unexpected';
}

export interface ManifestVerification {
  ok: boolean;
  checked: number;
  problems: ManifestProblem[];
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Text(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every file under `dir` as a posix-relative path, except the manifest itself. */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listFiles(full, base)));
    } else if (entry.isFile()) {
      const relative = path.relative(base, full).split(path.sep).join('/');
      if (relative !== MANIFEST_FILE) {
        found.push(relative);
      }
    }
  }

  return found.sort();
}

export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const relative of await listFiles(dir).catch(() => [] as string[])) {
    total += (await fs.stat(path.join(dir, relative)).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

export async function buildManifest(
  dir: string,
  jobId: string,
  retention: EvidenceManifest['retention'],
  pin?: EvidenceManifest['pin'],
): Promise<EvidenceManifest> {
  const files: EvidenceManifest['files'] = [];

  for (const relative of await listFiles(dir)) {
    const absolute = path.join(dir, relative);
    files.push({ path: relative, bytes: (await fs.stat(absolute)).size, sha256: await sha256File(absolute) });
  }

  const result = files.find((file) => file.path === 'result.json');

  return {
    version: 1,
    jobId,
    createdAt: new Date().toISOString(),
    retention,
    resultSha256: result?.sha256 ?? '0'.repeat(64),
    files,
    ...(pin ? { pin } : {}),
  };
}

export async function writeManifest(dir: string, manifest: EvidenceManifest): Promise<string> {
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(path.join(dir, MANIFEST_FILE), text, 'utf8');
  return sha256Text(text);
}

export async function readManifest(dir: string): Promise<{ manifest: EvidenceManifest; sha256: string } | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  return { manifest: evidenceManifestSchema.parse(JSON.parse(text)), sha256: sha256Text(text) };
}

/** Re-hashes every file and compares: modified, missing and unexpected (added) files are reported. */
export async function verifyManifest(dir: string, manifest: EvidenceManifest): Promise<ManifestVerification> {
  const problems: ManifestProblem[] = [];
  const recorded = new Set(manifest.files.map((file) => file.path));

  for (const file of manifest.files) {
    const absolute = path.resolve(dir, file.path);
    // A hand-edited manifest must not make verification read outside the job directory.
    const relative = path.relative(path.resolve(dir), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      problems.push({ path: file.path, problem: 'missing' });
      continue;
    }

    try {
      if ((await sha256File(absolute)) !== file.sha256) {
        problems.push({ path: file.path, problem: 'modified' });
      }
    } catch {
      problems.push({ path: file.path, problem: 'missing' });
    }
  }

  for (const relative of await listFiles(dir)) {
    if (!recorded.has(relative)) {
      problems.push({ path: relative, problem: 'unexpected' });
    }
  }

  return { ok: problems.length === 0, checked: manifest.files.length, problems };
}
