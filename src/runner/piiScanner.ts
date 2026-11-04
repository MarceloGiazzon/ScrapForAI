import type { BrowserContext, Frame, Page, Response } from 'playwright';

import type { PiiReport } from '../schemas/pii.schema.js';
import type { PiiPolicy } from '../schemas/piiPolicy.schema.js';
import { someStep } from '../schemas/stepTree.js';
import { isSecretName, isSessionCookieName, PII_SURFACES, type PiiSurface, scanText, scanUrl } from '../security/piiDetectors.js';
import { countFindings, FindingCollector } from '../security/piiFindings.js';
import { applyPiiPolicy } from '../security/piiPolicy.js';
import { isAllowedResourceUrl } from '../security/validateTargetUrl.js';
import { runTrustedScript } from './trusted/runTrusted.js';

/**
 * T7.8: the PII hunt of one run. It listens to the page while the steps run (URLs of every request, console, page errors, bodies of requests that
 * carried no credentials) and, on `scan()`, reads what only a look at the end can see (storage, cookies, hidden inputs).
 *
 * It only READS: it never routes, delays or changes a request, so a run that hunts behaves like one that does not. Everything it sees is scanned in
 * memory and dropped; what survives is a finding (masked sample, keyed fingerprint, a location without the value), never the text itself.
 */

/** A response body larger than this is not read. Public pages and JSON of an API are far below it; a download is not what this looks for. */
export const MAX_BODY_BYTES = 256 * 1024;
const SETTLE_TIMEOUT_MS = 3000;
const MAX_PENDING_BODIES = 200;

/** A run hunts when it asks for `options.piiScan` or has a `scanForPii` step. Any other run attaches nothing. */
export function usesPiiScan(request: { options: { piiScan?: boolean | undefined }; steps: readonly { action: string }[]; teardown?: readonly { action: string }[] }): boolean {
  return request.options.piiScan === true || someStep([...request.steps, ...(request.teardown ?? [])], (step) => step.action === 'scanForPii');
}

export interface PiiScannerOptions {
  /** Vault values and the run's secrets: found anywhere, reported as `known-secret`. */
  knownSecrets: readonly string[];
  /** Secret of the installation that keys the fingerprints (src/security/piiSalt.ts). */
  key: Buffer | string;
  maxFindings?: number;
  /** T7.9: the target profile's severity rules and suppressions. Applied when the report is built, so a finding is always collected. */
  policy?: PiiPolicy;
  /** For tests: the date suppressions are judged against. */
  now?: () => Date;
}

export class PiiScanner {
  private readonly collector: FindingCollector;
  private readonly pending = new Set<Promise<void>>();
  private readonly notes = new Set<string>();
  private readonly scanned = { urls: 0, console: 0, responseBodies: 0, responseBodiesSkipped: 0, storageEntries: 0, jarEntries: 0, hiddenInputs: 0 };
  private attached = false;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private readonly options: PiiScannerOptions,
  ) {
    this.collector = new FindingCollector({ key: options.key, ...(options.maxFindings === undefined ? {} : { maxFindings: options.maxFindings }) });
  }

  private get known(): readonly string[] {
    return this.options.knownSecrets;
  }

  /** Starts listening. Idempotent. */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    const { page } = this;

    page.on('request', (request) => this.scanUrlSurface(request.url(), request.method()));
    page.on('framenavigated', (frame) => {
      // A request never carries the fragment; the address bar does (`#access_token=...`).
      if (frame === page.mainFrame()) this.scanUrlSurface(frame.url(), 'navigation');
    });
    page.on('console', (message) => {
      this.scanned.console += 1;
      this.scanPlain(message.text(), 'console', `console.${message.type()}`);
    });
    page.on('pageerror', (error) => {
      this.scanned.console += 1;
      this.scanPlain(`${error.message}\n${error.stack ?? ''}`, 'console', 'page error');
    });
    page.on('response', (response) => {
      if (this.pending.size >= MAX_PENDING_BODIES) {
        this.scanned.responseBodiesSkipped += 1;
        return;
      }
      const job = this.scanBody(response).catch(() => {
        this.scanned.responseBodiesSkipped += 1;
      });
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
    });
  }

  private scanUrlSurface(url: string, how: string): void {
    if (!/^https?:/i.test(url)) return;
    this.scanned.urls += 1;
    const result = scanUrl(url, { knownSecrets: this.known });
    for (const hit of result.hits) this.collector.add(hit.detector, 'url', `${how} ${result.display} [${hit.where}]`, hit.raw);
  }

  /** Text that has no structure to name (a log line, a body): the finding says the surface and a label, never the text. */
  private scanPlain(text: string, surface: PiiSurface, location: string): void {
    for (const match of scanText(text, { knownSecrets: this.known })) this.collector.add(match.detector, surface, location, match.raw);
  }

  /**
   * Body of a response to a request that carried NO credentials (no Authorization, no Cookie): what the application hands to anyone. JSON and HTML only,
   * small ones only. A body that needed a login is the logged-in user's own page; flagging that would only be noise.
   */
  private async scanBody(response: Response): Promise<void> {
    const status = response.status();
    if (status < 200 || status >= 300 || status === 204) return;
    const type = response.headers()['content-type'] ?? '';
    if (!/json|html/i.test(type)) return;
    if (!isAllowedResourceUrl(response.url())) return;

    const request = response.request();
    const sent = await request.allHeaders();
    if (sent['authorization'] !== undefined || sent['cookie'] !== undefined) return;

    const declared = Number(response.headers()['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      this.scanned.responseBodiesSkipped += 1;
      return;
    }
    const body = await response.body();
    if (body.length > MAX_BODY_BYTES) {
      this.scanned.responseBodiesSkipped += 1;
      return;
    }
    this.scanned.responseBodies += 1;
    const where = scanUrl(response.url(), { knownSecrets: this.known });
    const location = `${request.method()} ${where.display} (response, no credentials sent)`;
    this.scanPlain(body.toString('utf8'), 'response-body', location);
  }

  /** Waits (bounded) for the response bodies still being read, so a finding is not lost to timing. */
  async settle(): Promise<void> {
    if (this.pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    });
    await Promise.race([Promise.allSettled([...this.pending]).then(() => undefined), timeout]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Looks at the surfaces that need a look now: storage and hidden inputs of `frame`, and the cookies of the context. The ones the page has been
   * producing all along (URLs, console, bodies) were already collected; this also waits for the bodies in flight.
   */
  async scan(frame: Frame, surfaces: readonly PiiSurface[] = PII_SURFACES): Promise<void> {
    await this.settle();
    const wants = new Set(surfaces);

    if (wants.has('storage') || wants.has('hidden-input')) {
      try {
        // knownSecrets is NOT passed to the runner: it would mask exactly the values this scan looks for. The answer stays in memory and is dropped.
        const answer = (await runTrustedScript(frame, 'pii-surfaces', { storage: wants.has('storage'), hidden: wants.has('hidden-input') }, { knownSecrets: [] })) as unknown as {
          storage: Array<{ area: string; key: string; value: string }>;
          hidden: Array<{ name: string; value: string }>;
          truncated: boolean;
        };
        for (const entry of answer.storage) {
          this.scanned.storageEntries += 1;
          const location = `${entry.area}["${entry.key}"]`;
          const found = scanText(entry.value, { knownSecrets: this.known });
          for (const match of found) this.collector.add(match.detector, 'storage', location, match.raw);
          if (found.length === 0 && isSecretName(entry.key, entry.value)) this.collector.add('secret-named', 'storage', location, entry.value);
        }
        for (const input of answer.hidden) {
          this.scanned.hiddenInputs += 1;
          const location = `hidden input "${input.name}"`;
          const found = scanText(input.value, { knownSecrets: this.known });
          for (const match of found) this.collector.add(match.detector, 'hidden-input', location, match.raw);
          if (found.length === 0 && isSecretName(input.name, input.value)) this.collector.add('secret-named', 'hidden-input', location, input.value);
        }
        if (answer.truncated) this.notes.add('storage or hidden inputs: only the first 200 entries were read');
      } catch (error) {
        this.notes.add(`storage / hidden inputs could not be read (${error instanceof Error ? error.name : 'error'})`);
      }
    }

    if (wants.has('cookie')) {
      try {
        for (const cookie of await this.context.cookies()) {
          this.scanned.jarEntries += 1;
          // HttpOnly: the page's scripts cannot read it, which is the point of the flag. Only what a script (or an XSS) could take is a finding.
          if (cookie.httpOnly) continue;
          const location = `cookie "${cookie.name.slice(0, 80)}" (${cookie.domain})`;
          let value = cookie.value;
          try {
            value = decodeURIComponent(value);
          } catch {
            // keep it as it is
          }
          const found = scanText(value, { knownSecrets: this.known });
          for (const match of found) this.collector.add(match.detector, 'cookie', location, match.raw);
          const isSecret = found.some((match) => ['jwt', 'bearer', 'api-key', 'known-secret'].includes(match.detector));
          if (!isSecret && isSessionCookieName(cookie.name, value)) this.collector.add('cookie-no-httponly', 'cookie', location, value);
        }
      } catch (error) {
        this.notes.add(`cookies could not be read (${error instanceof Error ? error.name : 'error'})`);
      }
    }
  }

  /** The findings so far, optionally only those of some surfaces. */
  report(surfaces: readonly PiiSurface[] = PII_SURFACES): PiiReport {
    const wanted = new Set(surfaces);
    const applied = applyPiiPolicy(
      this.collector.findings().filter((finding) => wanted.has(finding.surface)),
      this.options.policy,
      this.options.now?.(),
    );
    const notes = [...this.notes, ...applied.expired.map((x) => `suppression "${x.id}" expired on ${x.until}: what it covered counts again`)];
    return {
      kind: 'pii-scan',
      findings: applied.findings,
      counts: countFindings(applied.findings),
      scanned: { ...this.scanned },
      truncated: this.collector.truncated,
      notes,
      ...(applied.suppressed.length > 0 ? { suppressed: applied.suppressed } : {}),
    };
  }
}
