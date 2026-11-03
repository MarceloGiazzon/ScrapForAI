/**
 * T3.2: a cron parser of our own (decision D5: no dependency). Pure: no configuration, no I/O.
 *
 *   minute hour day-of-month month day-of-week      e.g. "30 2 * * 1-5" = 02:30 on weekdays
 *
 * Each field is a comma list of `*`, `n`, `a-b`, each optionally followed by `/step` (`*` /5, `10-30/10`, `5/15` = from 5 to the end every 15).
 * Month and weekday accept English names (JAN-DEC, SUN-SAT); weekday 0 and 7 are both Sunday. Macros: @hourly @daily @midnight @weekly @monthly @yearly.
 * Like Vixie cron: when BOTH day-of-month and day-of-week are restricted (do not start with `*`), a day matches if EITHER does; otherwise both
 * must. Not supported (refused, never guessed): seconds, `?`, `L`, `W`, `#`, year.
 *
 * Time zones are IANA names, resolved with Intl. Around a daylight-saving change: a wall-clock time that does not exist (spring forward) is skipped
 * that day, and one that happens twice (fall back) fires once, the first time.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronError';
  }
}

export interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** 0-6, Sunday = 0. */
  daysOfWeek: number[];
  /** Field started with `*`: it does not restrict, and (with the other one restricted) the day rule is OR. */
  domStar: boolean;
  dowStar: boolean;
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function parseField(text: string, name: string, min: number, max: number, names?: string[], nameBase = 0): { values: number[]; star: boolean } {
  if (text === '') throw new CronError(`${name}: empty field`);
  const number = (token: string): number => {
    const upper = token.toUpperCase();
    const named = names?.indexOf(upper);
    if (named !== undefined && named >= 0) return named + nameBase;
    if (!/^\d{1,3}$/.test(token)) throw new CronError(`${name}: "${token}" is not a number${names ? ' or a name' : ''}`);
    return Number(token);
  };

  const values = new Set<number>();
  for (const item of text.split(',')) {
    const [range, stepText, ...extra] = item.split('/');
    if (extra.length > 0 || range === undefined || range === '') throw new CronError(`${name}: invalid item "${item}"`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${name}: step "${stepText}" must be a positive integer`);
      step = Number(stepText);
    }

    let from: number;
    let to: number;
    if (range === '*') {
      from = min;
      to = max;
    } else if (range.includes('-')) {
      const [a, b, ...more] = range.split('-');
      if (more.length > 0 || a === undefined || b === undefined || a === '' || b === '') throw new CronError(`${name}: invalid range "${range}"`);
      from = number(a);
      to = number(b);
    } else {
      from = number(range);
      to = stepText === undefined ? from : max; // "5/15" runs from 5 to the end
    }

    // Weekday 7 is Sunday: allowed as an upper bound or alone, folded to 0 below.
    if (from < min || to > max || from > to) throw new CronError(`${name}: ${range} is outside ${min}-${max}${from > to ? ' (a range must go up)' : ''}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values: [...values].sort((x, y) => x - y), star: text.startsWith('*') };
}

export function parseCron(expression: string): CronSpec {
  const text = expression.trim().replace(/\s+/g, ' ');
  const expanded = MACROS[text.toLowerCase()] ?? text;
  if (expanded.startsWith('@')) throw new CronError(`unknown macro "${text}" (known: ${Object.keys(MACROS).join(', ')})`);
  const fields = expanded.split(' ');
  if (fields.length !== 5) throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  if (/[?#]/.test(expanded)) throw new CronError('?, # (and L, W) are not supported: use plain lists, ranges and steps');

  const minute = parseField(fields[0]!, 'minute', 0, 59);
  const hour = parseField(fields[1]!, 'hour', 0, 23);
  const dom = parseField(fields[2]!, 'day-of-month', 1, 31);
  const month = parseField(fields[3]!, 'month', 1, 12, MONTH_NAMES, 1);
  const dow = parseField(fields[4]!, 'day-of-week', 0, 7, DAY_NAMES, 0);

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: [...new Set(dow.values.map((value) => value % 7))].sort((x, y) => x - y),
    domStar: dom.star,
    dowStar: dow.star,
  };
}

// ---- time zones -------------------------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let known = formatters.get(timeZone);
  if (!known) {
    try {
      known = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    } catch {
      throw new CronError(`unknown time zone "${timeZone}" (use an IANA name such as America/Montevideo)`);
    }
    formatters.set(timeZone, known);
  }
  return known;
}

export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallClock(instant: number, timeZone: string): WallClock {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return { year: out.year!, month: out.month!, day: out.day!, hour: out.hour! % 24, minute: out.minute! };
}

const asUtc = (clock: WallClock): number => Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);

/** Milliseconds the zone is ahead of UTC at `instant`. */
const offsetAt = (instant: number, timeZone: string): number => asUtc(wallClock(instant, timeZone)) - Math.floor(instant / 60_000) * 60_000;

/** The instant at which the zone's clock shows this wall-clock time: the earliest one, or undefined when the time does not exist. */
function instantOf(clock: WallClock, timeZone: string): number | undefined {
  const guess = asUtc(clock);
  const day = 86_400_000;
  const candidates = new Set([offsetAt(guess - day, timeZone), offsetAt(guess + day, timeZone)]);
  const valid = [...candidates]
    .map((offset) => guess - offset)
    .filter((instant) => {
      const shown = wallClock(instant, timeZone);
      return shown.year === clock.year && shown.month === clock.month && shown.day === clock.day && shown.hour === clock.hour && shown.minute === clock.minute;
    });
  return valid.length === 0 ? undefined : Math.min(...valid);
}

function dayMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.includes(month)) return false;
  const domOk = spec.daysOfMonth.includes(day);
  const dowOk = spec.daysOfWeek.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (!spec.domStar && !spec.dowStar) return domOk || dowOk;
  return domOk && dowOk;
}

const MAX_DAYS_AHEAD = 366 * 5;

/** The first occurrence strictly after `afterMs`, as an instant (epoch ms), or undefined when none exists within five years (e.g. 31 Feb). */
export function nextRun(spec: CronSpec, afterMs: number, timeZone: string): number | undefined {
  const start = wallClock(afterMs, timeZone);
  for (let offset = 0; offset <= MAX_DAYS_AHEAD; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!dayMatches(spec, year, month, day)) continue;

    for (const hour of spec.hours) {
      for (const minute of spec.minutes) {
        const instant = instantOf({ year, month, day, hour, minute }, timeZone);
        if (instant !== undefined && instant > afterMs) return instant;
      }
    }
  }
  return undefined;
}

/** Occurrences in (fromMs, toMs], oldest first, at most `limit` (the rest are not enumerated). */
export function occurrencesBetween(spec: CronSpec, fromMs: number, toMs: number, timeZone: string, limit = 1000): { instants: number[]; truncated: boolean } {
  const instants: number[] = [];
  let cursor = fromMs;
  for (;;) {
    const next = nextRun(spec, cursor, timeZone);
    if (next === undefined || next > toMs) return { instants, truncated: false };
    if (instants.length >= limit) return { instants, truncated: true };
    instants.push(next);
    cursor = next;
  }
}

/** The next `count` occurrences after `afterMs`. */
export function upcoming(spec: CronSpec, afterMs: number, timeZone: string, count: number): number[] {
  const out: number[] = [];
  let cursor = afterMs;
  while (out.length < count) {
    const next = nextRun(spec, cursor, timeZone);
    if (next === undefined) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
