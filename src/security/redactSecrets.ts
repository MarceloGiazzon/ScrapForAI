const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN = /(password|token|authorization|cookie|secret|apiKey|clientSecret)/i;

export function collectKnownSecretValues(...sources: Array<Record<string, unknown> | undefined>): string[] {
  const values = new Set<string>();

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const value of Object.values(source)) {
      if (typeof value === 'string' && value.length > 0) {
        values.add(value);
      }
    }
  }

  return [...values];
}

export function redactString(value: string, knownSecrets: string[] = []): string {
  let redacted = value;

  for (const secret of knownSecrets) {
    if (secret.length === 0) {
      continue;
    }

    if (redacted === secret) {
      return REDACTED;
    }

    redacted = redacted.split(secret).join(REDACTED);
  }

  return redacted;
}

export function redactSecrets<T>(value: T, knownSecrets: string[] = []): T {
  if (typeof value === 'string') {
    return redactString(value, knownSecrets) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, knownSecrets)) as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactSecrets(item, knownSecrets);
      }
    }

    return result as T;
  }

  return value;
}
