import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-123456';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS ??= 'https://dev.example.com';
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:3000';

const { getLiveAllowedOrigins } = await import('../src/config/env.js');

// Regression: getLiveAllowedOrigins previously resolved `liveValue ?? process.env[key]`.
// Because the checked-in .env almost always defines the key, `liveValue` was always set and
// the process.env branch was dead code -- so an origin injected by a launcher via the
// environment (e.g. NPDev's scrapforai-harness.ps1, which sets ALLOWED_TARGET_ORIGINS in
// process.env for the child server) was silently dropped, and every routine targeting that
// origin failed validateTargetUrl at its first navigation. It must now UNION both sources.
test('getLiveAllowedOrigins honors a launcher-injected process.env origin not present in .env', () => {
  const injected = 'http://127.0.0.1:65123';
  const previous = process.env.ALLOWED_TARGET_ORIGINS ?? '';
  process.env.ALLOWED_TARGET_ORIGINS = previous.length > 0 ? `${previous},${injected}` : injected;

  try {
    const origins = getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS');
    assert.ok(
      origins.includes(injected),
      `expected launcher-injected ${injected} to be allowlisted, got ${JSON.stringify(origins)}`,
    );
  } finally {
    process.env.ALLOWED_TARGET_ORIGINS = previous;
  }
});

test('getLiveAllowedOrigins de-duplicates an origin supplied by both process.env and .env', () => {
  const dup = 'https://dup.example.com';
  const previous = process.env.ALLOWED_TARGET_ORIGINS ?? '';
  process.env.ALLOWED_TARGET_ORIGINS = `${dup},${dup}`;

  try {
    const origins = getLiveAllowedOrigins('ALLOWED_TARGET_ORIGINS');
    assert.equal(origins.filter((origin) => origin === dup).length, 1);
  } finally {
    process.env.ALLOWED_TARGET_ORIGINS = previous;
  }
});
