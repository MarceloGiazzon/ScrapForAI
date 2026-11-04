/**
 * T7.2 `assertNoTextMatches`: what a user must never read on a screen. The patterns are OURS, not the caller's: a caller-supplied regular
 * expression run over a page the caller does not control is a way to stall the server. Every pattern below is anchored on a literal
 * word or on a delimiter its repeated part cannot contain, so matching is linear in the text. The text is capped before matching.
 */

export type LeakKind = 'stackTrace' | 'exception' | 'sqlError' | 'serverPath';

/** The page text is cut here before matching, so cost is bounded whatever the page holds. */
export const MAX_SCANNED_CHARS = 200_000;

const PATTERNS: Record<LeakKind, RegExp[]> = {
  stackTrace: [
    // Java: "at com.acme.Service.save(Service.java:42)"
    /\bat [\w$.]+\([\w$]+\.java:\d+\)/,
    // .NET: "at Acme.Service.Save() in C:\src\Service.cs:line 42"
    /\bat [\w$.<>]+\([^)\n]{0,200}\) in [^\n]{1,300}:line \d+/,
    // JavaScript: "at save (http://host/app.js:10:5)" or "at async save (/srv/app.js:10:5)"
    /\bat (?:async )?[\w$.<>]+ \((?:https?:\/\/|file:\/\/|\/|[A-Za-z]:\\)[^)\n]{1,300}:\d+:\d+\)/,
    // Python and PHP
    /Traceback \(most recent call last\)/,
    /Stack trace:\s{0,5}#0 /,
    // GeneXus / generic servers that print the raw trace header
    /Server Error in '[^'\n]{1,100}' Application/,
  ],
  exception: [
    /\b(?:java|javax|jakarta|org|com|net)\.[a-z0-9_.]{0,100}\.[A-Z]\w{0,80}(?:Exception|Error)\b/,
    /\bSystem\.[A-Za-z.]{0,80}Exception\b/,
    /\b(?:NullPointerException|NullReferenceException|ClassCastException|IndexOutOfBoundsException|InvalidOperationException|ArgumentNullException)\b/,
    /\bUnhandled [Ee]xception\b/,
    /\bUncaught (?:TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  ],
  sqlError: [
    /\bORA-\d{5}\b/,
    /\bSQLSTATE\b/,
    /You have an error in your SQL syntax/i,
    /\bsyntax error at or near\b/i,
    /Unclosed quotation mark/i,
    /\b(?:PSQLException|SQLServerException|SQLSyntaxErrorException|SqlException)\b/,
    /\bjava\.sql\.SQL\w{0,40}Exception\b/,
  ],
  serverPath: [
    // C:\inetpub\wwwroot\app\Service.cs  (the repeated part cannot contain the backslash that ends it)
    /\b[A-Za-z]:\\(?:[\w .$-]{1,80}\\){2,}[\w .$-]{1,80}\.\w{1,6}\b/,
    // /var/www/app/Service.php, /usr/local/tomcat/webapps/app/WEB-INF/x.class
    /(?<![\w:/.])\/(?:var|usr|home|opt|srv|etc|app|tmp)\/(?:[\w.$-]{1,80}\/){1,}[\w.$-]{1,80}\.\w{1,6}\b/,
  ],
};

export const ALL_LEAK_KINDS: readonly LeakKind[] = ['stackTrace', 'exception', 'sqlError', 'serverPath'];

export interface LeakFinding {
  /** `contains` for the caller's literal fragments. */
  kind: LeakKind | 'contains';
  count: number;
  /** The first match, clipped. The caller redacts it before it leaves. */
  example: string;
}

const EXAMPLE_CHARS = 100;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXAMPLE_CHARS ? `${flat.slice(0, EXAMPLE_CHARS)}...` : flat;
}

/**
 * Looks for leaks in `text`. Returns one finding per kind that matched (count = how many matches of that kind, over all its patterns),
 * plus one `contains` finding for the caller's fragments. Empty array = clean.
 */
export function findLeaks(text: string, options: { kinds?: readonly LeakKind[]; contains?: readonly string[] } = {}): LeakFinding[] {
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const findings: LeakFinding[] = [];

  for (const kind of options.kinds ?? ALL_LEAK_KINDS) {
    let count = 0;
    let example: string | undefined;
    for (const pattern of PATTERNS[kind]) {
      const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      for (const match of scanned.matchAll(global)) {
        count += 1;
        example ??= match[0];
        if (count >= 1000) break;
      }
    }
    if (count > 0) findings.push({ kind, count, example: clip(example ?? '') });
  }

  const fragments = options.contains ?? [];
  let containsCount = 0;
  let containsExample: string | undefined;
  for (const fragment of fragments) {
    let from = 0;
    for (;;) {
      const at = scanned.indexOf(fragment, from);
      if (at < 0) break;
      containsCount += 1;
      containsExample ??= fragment;
      from = at + fragment.length;
      if (containsCount >= 1000) break;
    }
  }
  if (containsCount > 0) findings.push({ kind: 'contains', count: containsCount, example: clip(containsExample ?? '') });

  return findings;
}
