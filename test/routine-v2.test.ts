import assert from 'node:assert/strict';
import test from 'node:test';

process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-123456';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS ??= 'https://dev.example.com';
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:3000';

const { env } = await import('../src/config/env.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { buildEvaluateExpression, capAndRedactEvaluateResult } = await import('../src/runner/runExploration.js');
const { redactSecrets } = await import('../src/security/redactSecrets.js');

function withEvaluateAllowed<T>(allowed: boolean, fn: () => T): T {
  const previous = env.ALLOW_EVALUATE;
  env.ALLOW_EVALUATE = allowed;

  try {
    return fn();
  } finally {
    env.ALLOW_EVALUATE = previous;
  }
}

test('legacy exploration scenarios still parse', () => {
  const parsed = explorationRequestSchema.safeParse({
    targetUrl: 'https://dev.example.com/login',
    steps: [
      { action: 'goto', url: '$targetUrl' },
      { action: 'fill', selector: '#username', valueFromVariable: 'loginUser' },
      { action: 'extractText', selector: 'body', name: 'bodyText' },
    ],
    variables: {
      loginUser: 'test-user',
    },
  });

  assert.equal(parsed.success, true);
});

test('new routine v2 fields and actions parse when evaluate is allowed', () => {
  withEvaluateAllowed(true, () => {
    const parsed = explorationRequestSchema.safeParse({
      scenarioName: 'routine-v2',
      targetUrl: 'https://dev.example.com/app',
      caller: {
        correlationId: 'corr-001',
        source: 'unit-test',
        metadata: { taskId: 'task-123' },
      },
      steps: [
        {
          id: 'open',
          action: 'goto',
          url: '$targetUrl',
          waitFor: { loadState: 'domcontentloaded' },
        },
        {
          id: 'read',
          action: 'evaluate',
          name: 'state',
          frame: { index: 0 },
          delayMs: 0,
          waitFor: { selector: 'body', state: 'attached' },
          script: 'return { ready: true }',
        },
        {
          id: 'watch-ready',
          action: 'watch',
          name: 'timeline',
          script: 'return document.readyState',
          intervalMs: env.MIN_WATCH_INTERVAL_MS,
          durationMs: 100,
        },
        {
          action: 'waitForElapsed',
          sinceStepId: 'read',
          minElapsedMs: 0,
          timeoutMs: 0,
        },
      ],
    });

    assert.equal(parsed.success, true);
  });
});

test('evaluate and watch are rejected when disabled', () => {
  withEvaluateAllowed(false, () => {
    const parsed = explorationRequestSchema.safeParse({
      targetUrl: 'https://dev.example.com/app',
      steps: [
        { action: 'evaluate', name: 'state', script: 'return true' },
        { action: 'watch', name: 'timeline', script: 'return true', intervalMs: env.MIN_WATCH_INTERVAL_MS, durationMs: 100 },
      ],
    });

    assert.equal(parsed.success, false);
    const messages = parsed.error.issues.map((issue) => issue.message).join('\n');
    assert.match(messages, /disabled/);
    assert.equal(parsed.error.issues.filter((issue) => issue.message.includes('disabled')).length, 2);
  });
});

test('step ids are unique and waitForElapsed only references earlier ids', () => {
  withEvaluateAllowed(true, () => {
    const duplicate = explorationRequestSchema.safeParse({
      targetUrl: 'https://dev.example.com/app',
      steps: [
        { id: 'same', action: 'goto', url: '$targetUrl' },
        { id: 'same', action: 'click', selector: '#submit' },
      ],
    });

    assert.equal(duplicate.success, false);
    assert.match(duplicate.error.issues.map((issue) => issue.message).join('\n'), /duplicate step id/);

    const forwardReference = explorationRequestSchema.safeParse({
      targetUrl: 'https://dev.example.com/app',
      steps: [
        { action: 'waitForElapsed', sinceStepId: 'later', minElapsedMs: 10 },
        { id: 'later', action: 'goto', url: '$targetUrl' },
      ],
    });

    assert.equal(forwardReference.success, false);
    assert.match(forwardReference.error.issues.map((issue) => issue.message).join('\n'), /earlier step/);
  });
});

test('recursive redaction masks credentials and sensitive keys but preserves variable values', () => {
  const redacted = redactSecrets(
    {
      invoiceNo: 'INV-001',
      nested: {
        password: 'INV-001',
        visibleValue: 'INV-001',
      },
      array: ['credential-secret', 'INV-001', { apiKey: 'anything' }],
    },
    ['credential-secret'],
  );

  assert.deepEqual(redacted, {
    invoiceNo: 'INV-001',
    nested: {
      password: '[REDACTED]',
      visibleValue: 'INV-001',
    },
    array: ['[REDACTED]', 'INV-001', { apiKey: '[REDACTED]' }],
  });
});

test('evaluate scripts are wrapped as function bodies', () => {
  assert.equal(buildEvaluateExpression('return 42'), '(() => { return 42 })()');
});

test('evaluate results normalize JSON values, redact, and truncate oversized output', () => {
  const normalized = capAndRedactEvaluateResult({
    missing: undefined,
    invalidNumber: Number.NaN,
    credential: 'credential-secret',
    variableValue: 'INV-001',
    token: 'token-value',
  }, ['credential-secret']);

  assert.deepEqual(normalized, {
    missing: null,
    invalidNumber: null,
    credential: '[REDACTED]',
    variableValue: 'INV-001',
    token: '[REDACTED]',
  });

  const previousMax = env.MAX_EVALUATE_RESULT_CHARS;
  env.MAX_EVALUATE_RESULT_CHARS = 16;

  try {
    const truncated = capAndRedactEvaluateResult({ value: 'abcdefghijklmnopqrstuvwxyz' });
    assert.equal(typeof truncated, 'object');
    assert.equal(Array.isArray(truncated), false);
    assert.equal((truncated as { truncated?: boolean }).truncated, true);
    assert.equal((truncated as { preview?: string }).preview?.length, 16);
  } finally {
    env.MAX_EVALUATE_RESULT_CHARS = previousMax;
  }
});
