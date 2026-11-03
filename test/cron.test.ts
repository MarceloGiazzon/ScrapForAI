import assert from 'node:assert/strict';
import test from 'node:test';

import { assertTimeZone, CronError, nextRun, occurrencesBetween, parseCron, upcoming } from '../src/scheduler/cron.js';

// T3.2 acceptance: the cron parser, with a table of cases. Pure, no clock: every instant is explicit.

const MVD = 'America/Montevideo'; // UTC-3 all year since 2015
const iso = (ms: number | undefined): string | undefined => (ms === undefined ? undefined : new Date(ms).toISOString());
const at = (text: string): number => Date.parse(text);

test('fields: lists, ranges, steps, names, macros, Sunday as 0 or 7', () => {
  const cases: Array<[string, Partial<ReturnType<typeof parseCron>>]> = [
    ['* * * * *', { minutes: Array.from({ length: 60 }, (_, i) => i), hours: Array.from({ length: 24 }, (_, i) => i), domStar: true, dowStar: true }],
    ['*/15 * * * *', { minutes: [0, 15, 30, 45] }],
    ['5/20 * * * *', { minutes: [5, 25, 45] }],
    ['10-30/10 * * * *', { minutes: [10, 20, 30] }],
    ['0,30 9-11 * * *', { minutes: [0, 30], hours: [9, 10, 11] }],
    ['0 0 1,15 * *', { daysOfMonth: [1, 15], domStar: false }],
    ['0 0 * jan,MAR *', { months: [1, 3] }],
    ['0 0 * * MON-FRI', { daysOfWeek: [1, 2, 3, 4, 5], dowStar: false }],
    ['0 0 * * 7', { daysOfWeek: [0] }],
    ['0 0 * * 0,7', { daysOfWeek: [0] }],
    ['0 0 * * 5-7', { daysOfWeek: [0, 5, 6] }],
    ['  0   12  *  *  *  ', { minutes: [0], hours: [12] }],
    ['@hourly', { minutes: [0], hours: Array.from({ length: 24 }, (_, i) => i) }],
    ['@daily', { minutes: [0], hours: [0] }],
    ['@weekly', { daysOfWeek: [0], dowStar: false }],
    ['@monthly', { daysOfMonth: [1] }],
    ['@yearly', { months: [1], daysOfMonth: [1] }],
  ];
  for (const [expression, expected] of cases) {
    const spec = parseCron(expression);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(spec[key as keyof typeof spec], value, `${expression} -> ${key}`);
  }
});

test('invalid expressions are refused with a reason, never guessed', () => {
  const bad = [
    '', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * 32 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '*/x * * * *',
    '5-1 * * * *', '1-2-3 * * * *', 'a * * * *', '? * * * *', '0 0 L * *', '0 0 * * MON#2', '0 0 1// * *', ',5 * * * *', '5, * * * *', '@reboot', '@every5m', '-1 * * * *', '* * * FOO *',
  ];
  for (const expression of bad) assert.throws(() => parseCron(expression), CronError, JSON.stringify(expression));
  assert.throws(() => parseCron('60 * * * *'), /minute: 60 is outside 0-59/);
  assert.throws(() => parseCron('* * * *'), /expected 5 fields/);
  assert.throws(() => assertTimeZone('Mars/Olympus'), /unknown time zone/);
  assert.doesNotThrow(() => assertTimeZone(MVD));
});

test('next occurrence, table of cases in America/Montevideo (UTC-3)', () => {
  // [cron, after (UTC), expected next (UTC)]
  const table: Array<[string, string, string | undefined]> = [
    ['* * * * *', '2026-11-03T12:00:00Z', '2026-11-03T12:01:00Z'],
    ['* * * * *', '2026-11-03T12:00:30Z', '2026-11-03T12:01:00Z'],
    ['*/15 * * * *', '2026-11-03T12:15:00Z', '2026-11-03T12:30:00Z'],
    ['30 2 * * *', '2026-11-03T12:00:00Z', '2026-11-04T05:30:00Z'], // 02:30 local = 05:30 UTC, tomorrow
    ['30 2 * * *', '2026-11-03T04:00:00Z', '2026-11-03T05:30:00Z'], // today still ahead
    ['0 9 * * 1-5', '2026-11-06T13:00:00Z', '2026-11-09T12:00:00Z'], // Fri 10:00 local -> Mon 09:00 local
    ['0 0 1 * *', '2026-11-03T12:00:00Z', '2026-12-01T03:00:00Z'],
    ['0 0 29 2 *', '2026-11-03T12:00:00Z', '2028-02-29T03:00:00Z'], // leap day, 2027 has none
    ['0 0 31 * *', '2026-11-03T12:00:00Z', '2026-12-31T03:00:00Z'], // November has 30 days
    ['0 0 31 2 *', '2026-11-03T12:00:00Z', undefined], // never
    ['0 12 25 12 *', '2026-12-25T15:00:00Z', '2027-12-25T15:00:00Z'], // exactly now is not "after"
    ['59 23 31 12 *', '2026-12-31T23:00:00Z', '2027-01-01T02:59:00Z'], // 23:59 local on the 31st
    ['@weekly', '2026-11-03T12:00:00Z', '2026-11-08T03:00:00Z'], // Sunday 00:00 local
  ];
  for (const [expression, after, expected] of table) {
    assert.equal(iso(nextRun(parseCron(expression), at(after), MVD)), expected === undefined ? undefined : new Date(expected).toISOString(), `${expression} after ${after}`);
  }
});

test('day-of-month and day-of-week: OR when both are restricted, AND otherwise (Vixie)', () => {
  // 1st of the month OR any Monday, 09:00 local
  const either = parseCron('0 9 1 * 1');
  const days = upcoming(either, at('2026-11-01T12:01:00Z'), MVD, 6).map((ms) => iso(ms)!.slice(0, 10));
  assert.deepEqual(days, ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-01']);

  // Only Mondays that are also in the first week: dom is a star, so the weekday alone decides
  const mondays = upcoming(parseCron('0 9 * * 1'), at('2026-11-01T00:00:00Z'), MVD, 2).map((ms) => iso(ms)!.slice(0, 10));
  assert.deepEqual(mondays, ['2026-11-02', '2026-11-09']);

  // A star with a step still counts as a star: "*/2" in day-of-month does not turn the OR rule on
  const stepStar = upcoming(parseCron('0 9 */2 * 1'), at('2026-11-01T00:00:00Z'), MVD, 3).map((ms) => iso(ms)!.slice(0, 10));
  assert.deepEqual(stepStar, ['2026-11-09', '2026-11-23', '2026-12-07'], 'odd days of the month AND Mondays');
});

test('time zones: the same cron fires at different instants; a fixed-offset zone and UTC', () => {
  const noon = parseCron('0 12 * * *');
  assert.equal(iso(nextRun(noon, at('2026-11-03T00:00:00Z'), 'UTC')), '2026-11-03T12:00:00.000Z');
  assert.equal(iso(nextRun(noon, at('2026-11-03T00:00:00Z'), MVD)), '2026-11-03T15:00:00.000Z');
  assert.equal(iso(nextRun(noon, at('2026-11-03T00:00:00Z'), 'Asia/Kolkata')), '2026-11-03T06:30:00.000Z'); // UTC+5:30
});

test('daylight saving (America/New_York): a time that does not exist is skipped that day, one that happens twice fires once', () => {
  const ny = 'America/New_York';
  // 2026-03-08: clocks jump from 02:00 to 03:00 EST->EDT. 02:30 does not exist that day.
  const springForward = parseCron('30 2 * * *');
  const days = upcoming(springForward, at('2026-03-07T00:00:00Z'), ny, 3).map((ms) => iso(ms));
  assert.deepEqual(days, ['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'], 'Mar 8 has no 02:30');

  // 2026-11-01: clocks go back from 02:00 to 01:00 EDT->EST. 01:30 happens twice (05:30Z and 06:30Z): fire the first time only.
  const fallBack = parseCron('30 1 * * *');
  const nov = upcoming(fallBack, at('2026-10-31T12:00:00Z'), ny, 3).map((ms) => iso(ms));
  assert.deepEqual(nov, ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z', '2026-11-03T06:30:00.000Z']);

  // Every hour across the change keeps firing, no duplicate and no gap in UTC.
  const hourly = occurrencesBetween(parseCron('0 * * * *'), at('2026-03-08T04:30:00Z'), at('2026-03-08T09:30:00Z'), ny).instants.map((ms) => iso(ms)!.slice(11, 16));
  assert.deepEqual(hourly, ['05:00', '06:00', '07:00', '08:00', '09:00']);
});

test('occurrencesBetween: (from, to], oldest first, limited', () => {
  const every = parseCron('*/10 * * * *');
  const found = occurrencesBetween(every, at('2026-11-03T12:00:00Z'), at('2026-11-03T12:30:00Z'), MVD);
  assert.deepEqual(found.instants.map((ms) => iso(ms)!.slice(11, 16)), ['12:10', '12:20', '12:30'], 'the start is excluded, the end is included');
  assert.equal(found.truncated, false);

  const many = occurrencesBetween(parseCron('* * * * *'), at('2026-11-03T00:00:00Z'), at('2026-11-10T00:00:00Z'), MVD, 50);
  assert.equal(many.instants.length, 50);
  assert.equal(many.truncated, true);

  assert.deepEqual(occurrencesBetween(every, at('2026-11-03T12:30:00Z'), at('2026-11-03T12:30:00Z'), MVD).instants, []);
});
