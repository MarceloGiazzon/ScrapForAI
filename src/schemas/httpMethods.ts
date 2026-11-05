/**
 * T5.7: the HTTP methods an `httpRequest` step may use, and the ones a target profile allows when it says nothing.
 * Safe methods only by default: a mutating call to an application is a decision of the target profile (`http.allowedMethods`), never of one routine.
 */
export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const DEFAULT_HTTP_METHODS: readonly HttpMethod[] = ['GET', 'HEAD'];

/** Largest request body a step carries, and the largest response body read back. */
export const HTTP_MAX_REQUEST_BODY_CHARS = 20_000;
export const HTTP_MAX_RESPONSE_BYTES = 1_000_000;

/** Headers whose value is a session or a credential: never copied into `extracted`, whatever a routine asks. */
export const HTTP_SENSITIVE_RESPONSE_HEADERS: readonly string[] = ['set-cookie', 'set-cookie2', 'cookie', 'authorization', 'proxy-authorization', 'www-authenticate'];
