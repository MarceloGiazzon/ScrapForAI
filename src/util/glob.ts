/**
 * Minimal glob matching for file paths (no dependency): `*` = any characters except "/", `**` = any
 * characters including "/" (and `**` + "/" also matches zero directories), `?` = one character except "/".
 * Paths are compared with "/" separators and without a leading "./", whatever the platform wrote them with.
 */

export function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/');
}

export function globToRegExp(glob: string): RegExp {
  const pattern = normalizePath(glob);
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        const slashFollows = pattern[i + 2] === '/';
        source += slashFollows ? '(?:.*/)?' : '.*';
        i += slashFollows ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${source}$`);
}

export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(file));
}
