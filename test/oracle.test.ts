import assert from 'node:assert/strict';
import test from 'node:test';

import { AssertEqualsError, checkAssertEquals } from '../src/oracle/assertEquals.js';
import { evaluateExpression, ExpressionError, parseExpression, renameVariables, roundHalfAway, variablesOf } from '../src/oracle/expression.js';
import { NumberParseError, parseInvariantNumber, parseLocaleNumber } from '../src/oracle/localeNumber.js';

// T5.5: the formula oracle. Pure code, no browser: grammar, precedence, rounding, locales, safety, and the verdict of assertEquals.

const calc = (source: string, vars: Record<string, number> = {}): number =>
  evaluateExpression(parseExpression(source), (name) => {
    if (!(name in vars)) throw new Error(`unbound ${name}`);
    return vars[name]!;
  });

test('arithmetic and precedence', () => {
  assert.equal(calc('1 + 2 * 3'), 7);
  assert.equal(calc('(1 + 2) * 3'), 9);
  assert.equal(calc('10 / 4'), 2.5);
  assert.equal(calc('10 - 4 - 3'), 3, 'left associative');
  assert.equal(calc('2 ^ 3 ^ 2'), 512, '^ is right associative');
  assert.equal(calc('-2 ^ 2'), -4, '^ binds tighter than unary minus');
  assert.equal(calc('2 ^ -1'), 0.5);
  assert.equal(calc('--3'), 3);
  assert.equal(calc('.5 + 0.25'), 0.75);
  assert.equal(calc('0.1 + 0.2'), 0.3, 'floating-point noise is cleaned');
  assert.equal(calc('1.1 * 3'), 3.3);
});

test('comparison, logic and if: only the branch taken is evaluated', () => {
  assert.equal(calc('3 > 2'), 1);
  assert.equal(calc('3 <= 2'), 0);
  assert.equal(calc('1 == 1 && 2 != 3'), 1);
  assert.equal(calc('0 || 0'), 0);
  assert.equal(calc('!0'), 1);
  assert.equal(calc('if(qty > 10, 5, 0)', { qty: 11 }), 5);
  assert.equal(calc('if(qty == 0, 0, 100 / qty)', { qty: 0 }), 0, 'no division by zero in the branch not taken');
  assert.equal(calc('1 + 1 == 2'), 1);
});

test('functions', () => {
  assert.equal(calc('floor(2.9)'), 2);
  assert.equal(calc('floor(-2.1)'), -3);
  assert.equal(calc('ceil(2.1)'), 3);
  assert.equal(calc('abs(-4.5)'), 4.5);
  assert.equal(calc('min(3, 1, 2)'), 1);
  assert.equal(calc('max(3, 1, 2)'), 3);
  assert.equal(calc('round(2.5)'), 3);
  assert.equal(calc('round(-2.5)'), -3, 'half away from zero');
  assert.equal(calc('round(1.005, 2)'), 1.01, 'decimal rounding, not binary');
  assert.equal(calc('round(2.675, 2)'), 2.68);
  assert.equal(calc('round(10.5 * 3 * 1.1, 2)'), 34.65);
  assert.equal(roundHalfAway(1234567.891, 1), 1234567.9);
  assert.equal(roundHalfAway(1e-7, 2), 0);
});

test('the formula of the roadmap: round(price * qty * (1 + tax), 2)', () => {
  const total = calc('round(price * qty * (1 + tax), 2)', { price: 19.99, qty: 3, tax: 0.22 });
  assert.equal(total, 73.16);
});

test('variables are found, in order of first use', () => {
  assert.deepEqual(variablesOf(parseExpression('round(a * b, 2) + a + if(c > 1, d, a)')), ['a', 'b', 'c', 'd']);
  assert.deepEqual(variablesOf(parseExpression('1 + 2')), []);
});

test('errors: division by zero, non-finite results, unknown names are refused, never turned into a number', () => {
  assert.throws(() => calc('1 / 0'), (e) => e instanceof ExpressionError && e.type === 'ExpressionEval' && /division by zero/.test(e.message));
  assert.throws(() => calc('10 ^ 400'), /not a finite number/);
  assert.throws(() => calc('x + 1'), /unbound x/);
  assert.throws(() => calc('round(1, 99)'), /digits/);
});

test('syntax errors say where', () => {
  for (const bad of ['', '1 +', '(1', '1 2', 'round()', 'round(1, 2, 3)', 'if(1, 2)', 'foo(1)', '1 $ 2', '1..2', 'a b', ')']) {
    assert.throws(() => parseExpression(bad), (e) => e instanceof ExpressionError && e.type === 'ExpressionSyntax', `"${bad}"`);
  }
  assert.throws(() => parseExpression('1 + $'), /position 4/);
  assert.throws(() => parseExpression('x'.repeat(501)), /longer than 500/);
  assert.throws(() => parseExpression(`${'('.repeat(200)}1${')'.repeat(200)}`), /nested too deeply/);
});

test('there is no eval: code-shaped input is a syntax error, and identifiers only read what the caller gives', () => {
  for (const attack of ['process.exit(1)', 'constructor', '__proto__', 'require("fs")', '(function(){})()', 'a.b', 'this', '`x`', "'a'", 'x = 1', '1; 2', '[1]', '{}']) {
    let outcome: string;
    try {
      calc(attack, {});
      outcome = 'evaluated';
    } catch (error) {
      outcome = error instanceof ExpressionError ? error.type : 'other';
    }
    assert.notEqual(outcome, 'evaluated', attack);
  }
  // `constructor` and `__proto__` are just names; the lookup decides, and the oracle's lookup refuses what is not an own key.
  assert.throws(() =>
    checkAssertEquals({ actual: { extracted: 'total' }, expected: { expr: 'constructor' }, locale: 'en', parameters: {}, extracted: { total: '1' } }),
    /neither a parameter nor an extracted value/,
  );
  assert.throws(() =>
    checkAssertEquals({ actual: { extracted: 'total' }, expected: { expr: '__proto__ + 1' }, locale: 'en', parameters: {}, extracted: { total: '1' } }),
    AssertEqualsError,
  );
});

test('renaming variables touches names only, never functions or numbers', () => {
  const names = new Map([['qty', 'a_qty'], ['round', 'x']]);
  assert.equal(renameVariables('round(price * qty, 2) + qty', names), 'round(price * a_qty, 2) + a_qty');
  assert.equal(renameVariables('1 + 2', names), '1 + 2');
});

test('numbers as a page prints them, per locale', () => {
  const cases: Array<[string, 'en' | 'pt' | 'es', number]> = [
    ['1,234.56', 'en', 1234.56], ['1.234,56', 'pt', 1234.56], ['1.234,56', 'es', 1234.56],
    ['1.234', 'pt', 1234], ['1,234', 'en', 1234], ['1.234', 'en', 1.234], ['1,5', 'pt', 1.5],
    ['1,234,567.8', 'en', 1234567.8], ['1.234.567,8', 'pt', 1234567.8],
    ['R$ 1.234,56', 'pt', 1234.56], ['$1,234.56', 'en', 1234.56], ['U$S 12,50', 'es', 12.5], ['12,50 EUR', 'es', 12.5], ['15%', 'en', 15],
    ['-12,5', 'pt', -12.5], ['(1.234,56)', 'pt', -1234.56], ['−12.5', 'en', -12.5], ['R$ -3,00', 'pt', -3], ['+7', 'en', 7],
    ['1 234,56', 'pt', 1234.56], ['1 234 567,8', 'pt', 1234567.8], ['0', 'en', 0], ['.5', 'en', 0.5], [',5', 'pt', 0.5], ['  42  ', 'en', 42],
  ];
  for (const [text, locale, expected] of cases) assert.equal(parseLocaleNumber(text, locale), expected, `${text} (${locale})`);
});

test('text that is not a number is an error in that locale, never a silent 0', () => {
  for (const [text, locale] of [['', 'en'], ['abc', 'en'], ['12abc', 'en'], ['1.234,56', 'en'], ['1,234.56', 'pt'], ['1,2,3', 'en'], ['1.23.4', 'pt'], ['12.', 'en'], ['--1', 'en'], ['1 2', 'en'], ['NaN', 'en'], ['Infinity', 'en'], ['1e5', 'en'], ['1,23', 'en'], ['x1', 'en']] as const) {
    assert.throws(() => parseLocaleNumber(text, locale), NumberParseError, `${text} (${locale})`);
  }
  assert.equal(parseInvariantNumber('-12.5'), -12.5);
  assert.throws(() => parseInvariantNumber('1.234,5'), NumberParseError);
});

const base = { actual: { extracted: 'total' }, locale: 'en' as const, parameters: { price: '10.50', qty: '3' }, extracted: { total: '34.65', tax: '10%' } as Record<string, unknown> };

test('assertEquals: a formula over parameters and extracted values', () => {
  const ok = checkAssertEquals({ ...base, expected: { expr: 'round(price * qty * 1.1, 2)' } });
  assert.deepEqual([ok.passed, ok.actual, ok.expected], [true, 34.65, 34.65]);

  const wrong = checkAssertEquals({ ...base, extracted: { total: '34.64' }, expected: { expr: 'round(price * qty * 1.1, 2)' } });
  assert.equal(wrong.passed, false);
  assert.match(wrong.message, /total is 34.64 but .* gives 34.65 \(difference 0.01, tolerance 1e-9\); with price=10.5, qty=3/);
});

test('assertEquals: extracted values are parsed with the step locale, parameters are always plain', () => {
  const pt = checkAssertEquals({
    ...base, locale: 'pt', extracted: { total: 'R$ 1.234,50' }, parameters: { price: '1234.5' }, expected: { expr: 'price' },
  });
  assert.equal(pt.passed, true);

  const ptValue = checkAssertEquals({ ...base, locale: 'pt', extracted: { total: '1.234,50' }, expected: { value: '1.234,5' } });
  assert.equal(ptValue.passed, true);

  assert.throws(() => checkAssertEquals({ ...base, parameters: { price: '1.234,5' }, expected: { expr: 'price' } }), /parameter "price": .*not a plain number/);
});

test('assertEquals: tolerance is absolute, relative, or floating-point noise only', () => {
  const near = { ...base, extracted: { total: '100.4' }, expected: { value: '100' } };
  assert.equal(checkAssertEquals(near).passed, false);
  assert.equal(checkAssertEquals({ ...near, tolerance: { absolute: 0.5 } }).passed, true);
  assert.equal(checkAssertEquals({ ...near, tolerance: { relative: 0.01 } }).passed, true);
  assert.equal(checkAssertEquals({ ...near, tolerance: { relative: 0.001 } }).passed, false);
  assert.equal(checkAssertEquals({ ...base, extracted: { total: '0.30000000000000004' }, expected: { expr: '0.1 + 0.2' } }).passed, true);
});

test('assertEquals: a problem with the inputs is an error that names it, not a failed comparison', () => {
  const run = (patch: Record<string, unknown>) => () => checkAssertEquals({ ...base, expected: { expr: 'price' }, ...patch } as never);
  assert.throws(run({ actual: { extracted: 'missing' } }), /nothing was extracted as "missing"/);
  assert.throws(run({ extracted: { total: 'abc' } }), /extracted "total": "abc" is not a number/);
  assert.throws(run({ extracted: { total: { nested: 1 } } }), /not text or a number/);
  assert.throws(run({ expected: { expr: 'price * nope' } }), /uses "nope".*available: price, qty, total, tax/);
  assert.throws(run({ expected: { expr: '1 / 0' } }), /expected value: division by zero/);
  assert.throws(run({ expected: { expr: 'total' }, parameters: { total: '1' } }), /both a parameter and an extracted value/);
  assert.throws(run({ expected: { expr: 'if(0, nope, 1)' } }), /uses "nope"/, 'a name inside a branch not taken is still checked');
  assert.throws(run({ expected: { value: 'twelve' } }), /expected value: "twelve" is not a number/);
});

test('assertEquals: a number extracted by evaluate() (JSON number) is accepted', () => {
  assert.equal(checkAssertEquals({ ...base, extracted: { total: 12.5 }, expected: { value: '12.5' } }).passed, true);
});
