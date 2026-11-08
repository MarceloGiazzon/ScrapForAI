// First-use review (docs/INSTALL-AND-FIRST-USE-REVIEW.pt-BR.md, item 5): a target that is not running used to come back as
// `type: "Error"` with Playwright's raw text ("page.goto: net::ERR_CONNECTION_REFUSED at ... Call log: ..."), which reads like a
// ScrapForAI defect. This turns the failures that are NOT the application's fault into a type and a sentence that say what happened,
// where, and what to check. Pure: no I/O, no configuration, so it is safe to import from anywhere.
//
// Never echoes Playwright's call log, a stack, a path or a query string: the sentence is built from fixed text plus the ORIGIN
// (scheme, host, port) of the address that was being opened. A failure that is not recognised returns undefined and the caller keeps
// its own error exactly as before.

export type TargetFailureType = 'TargetUnreachable' | 'TargetTlsError' | 'TargetNavigationTimeout' | 'BrowserLaunchFailed';

export interface TargetFailure {
  type: TargetFailureType;
  message: string;
}

export interface TargetFailureContext {
  /** The address being opened. Only its origin ends up in the message. */
  url?: string;
  /** True when the error came from opening a page (`goto`, `reload`, inspect-dom): only then are `net::ERR_*` and navigation timeouts the target's. */
  navigation: boolean;
}

/** Chromium error codes that mean "the target did not answer", with what to tell the person. */
const UNREACHABLE_REASONS: Record<string, string> = {
  ERR_CONNECTION_REFUSED: 'nothing is listening there (connection refused)',
  ERR_CONNECTION_RESET: 'the connection was reset before an answer came',
  ERR_CONNECTION_CLOSED: 'the connection was closed before an answer came',
  ERR_EMPTY_RESPONSE: 'the server closed the connection without answering',
  ERR_CONNECTION_TIMED_OUT: 'nothing answered before the connection timed out',
  ERR_TIMED_OUT: 'nothing answered before the connection timed out',
  ERR_ADDRESS_UNREACHABLE: 'that address cannot be reached from this machine',
  ERR_NETWORK_CHANGED: 'the network changed while the page was loading',
  ERR_INTERNET_DISCONNECTED: 'this machine has no network connection',
  ERR_NAME_NOT_RESOLVED: 'the host name could not be resolved (DNS)',
  ERR_NAME_RESOLUTION_FAILED: 'the host name could not be resolved (DNS)',
};

const TLS_CODE = /^ERR_(CERT_|SSL_|BAD_SSL_)/;
const NET_ERROR = /net::(ERR_[A-Z0-9_]+)/;
// Playwright: "browserType.launch: Executable doesn't exist at ..." / "Chromium distribution 'chrome' is not found at ..."
const BROWSER_MISSING = /Executable doesn't exist|distribution '[^']+' is not found|Looks like Playwright (Test or Playwright )?was just installed/i;
// Linux: "Host system is missing dependencies to run browsers" / "error while loading shared libraries: libnss3.so"
const BROWSER_LIBRARIES = /Host system is missing dependencies|error while loading shared libraries/i;

/** The origin of an address, or undefined when it is not a URL. Credentials, path and query never survive `URL.origin`. */
function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

export function classifyTargetFailure(error: unknown, context: TargetFailureContext): TargetFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const text = error.message;

  if (BROWSER_MISSING.test(text)) {
    return {
      type: 'BrowserLaunchFailed',
      message:
        'The browser could not start: the Chromium that Playwright needs is not installed on this machine. ' +
        'Run "npx playwright install chromium" (on Linux, "npx playwright install --with-deps chromium" also installs system libraries and asks for sudo), then try again. ' +
        '"npm run doctor" checks the installation.',
    };
  }
  if (BROWSER_LIBRARIES.test(text)) {
    return {
      type: 'BrowserLaunchFailed',
      message:
        'The browser could not start: this machine is missing system libraries that Chromium needs. ' +
        'On Linux run "sudo npx playwright install-deps chromium" (it installs operating-system packages, so it asks for sudo), then try again. ' +
        '"npm run doctor" checks the installation.',
    };
  }

  if (!context.navigation) return undefined;
  const where = originOf(context.url);
  const at = where ? ` at ${where}` : '';

  const netCode = NET_ERROR.exec(text)?.[1];
  if (netCode) {
    if (TLS_CODE.test(netCode)) {
      return {
        type: 'TargetTlsError',
        message:
          `The target${at} answered with a certificate or TLS error (${netCode}). ScrapForAI does not ignore certificate errors: ` +
          'give the application a certificate this machine trusts, or allowlist its plain http:// address if it is a local development server.',
      };
    }
    const reason = UNREACHABLE_REASONS[netCode];
    if (reason) {
      return {
        type: 'TargetUnreachable',
        message:
          `The target is unreachable${at}: ${reason} (${netCode}). This is not a ScrapForAI failure. ` +
          'Check that the application under test is running and answering on that host and port, then try again.',
      };
    }
    return undefined;
  }

  if (error.name === 'TimeoutError' && /page\.(goto|reload)|frame\.goto/.test(text)) {
    const limit = /Timeout (\d+)ms exceeded/.exec(text)?.[1];
    return {
      type: 'TargetNavigationTimeout',
      message:
        `The target${at} did not finish loading${limit ? ` within ${limit} ms` : ' in time'}. ` +
        'It may be starting up, stuck, or slower than the step timeout: check that it responds in a normal browser, or raise the step/inspection timeout.',
    };
  }

  return undefined;
}
