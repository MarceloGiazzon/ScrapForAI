/**
 * T1.2 origin binding. A credential set is bound to one or more origins; a `fill` that would type
 * one of its values into a page of any OTHER origin is refused, even if that origin is allowlisted.
 * This stops a routine authored by an AI from carrying a password to a different allowlisted app.
 */

export class CredentialOriginMismatchError extends Error {
  constructor(credentialSetId: string, fieldName: string, actualOrigin: string) {
    // Names the set/field and the page origin only, never a value.
    super(`Credential "${fieldName}" of set "${credentialSetId}" is not bound to origin ${actualOrigin}`);
    this.name = 'CredentialOriginMismatch';
  }
}

export interface CredentialBinding {
  setId: string;
  boundOrigins: string[];
  /** Field names whose values came from the vault (and are therefore bound). */
  fields: string[];
}

function originOf(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl);
    // Opaque origins (about:blank, data:, file:) serialize to "null" and never match a binding.
    return parsed.origin;
  } catch {
    return 'null';
  }
}

/** Throws CredentialOriginMismatchError unless the page the value is typed into is a bound origin. */
export function assertCredentialOrigin(binding: CredentialBinding | undefined, fieldName: string, pageUrl: string): void {
  if (!binding || !binding.fields.includes(fieldName)) {
    return;
  }

  const origin = originOf(pageUrl);
  if (!binding.boundOrigins.includes(origin)) {
    throw new CredentialOriginMismatchError(binding.setId, fieldName, origin);
  }
}
