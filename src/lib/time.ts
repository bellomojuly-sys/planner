import { TZDate } from '@date-fns/tz';
import { addDays, startOfDay } from 'date-fns';

/**
 * All scheduling happens in Europe/Rome wall-clock terms ("demanding work
 * before 13:00") while storage is epoch-ms UTC. These helpers are the only
 * place the two representations meet, so DST transitions are handled once.
 *
 * On the spring-forward day 02:00–03:00 does not exist and on autumn-back it
 * happens twice; TZDate resolves both consistently, which is why the scheduler
 * never does naive `+24h` arithmetic to advance a day.
 */

export const DAY_MS = 86_400_000;
export const MINUTE_MS = 60_000;

export function zoned(ts: number, tz: string): TZDate {
  return new TZDate(ts, tz);
}

/** Local minutes since midnight for an instant. */
export function localMinutes(ts: number, tz: string): number {
  const d = zoned(ts, tz);
  return d.getHours() * 60 + d.getMinutes();
}

/** 0 = Sunday … 6 = Saturday, in local time. */
export function localWeekday(ts: number, tz: string): number {
  return zoned(ts, tz).getDay();
}

/** `2026-08-12` for the local calendar day containing `ts`. */
export function localDateKey(ts: number, tz: string): string {
  const d = zoned(ts, tz);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Epoch ms of local midnight for the day containing `ts`. */
export function startOfLocalDay(ts: number, tz: string): number {
  return startOfDay(zoned(ts, tz)).getTime();
}

/**
 * Epoch ms for `minutes` past local midnight on the day containing `ts`.
 * Clamped through TZDate so a 25-hour day does not shift the target hour.
 */
export function atLocalMinutes(ts: number, tz: string, minutes: number): number {
  const base = zoned(startOfLocalDay(ts, tz), tz);
  const target = new TZDate(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
    tz,
  );
  return target.getTime();
}

/** Advance by whole local days, DST-safe. */
export function addLocalDays(ts: number, tz: string, days: number): number {
  return addDays(zoned(ts, tz), days).getTime();
}

export function formatTime(ts: number, tz: string, locale = 'it-IT'): string {
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: tz,
  }).format(ts);
}

export function formatDayLong(
  ts: number,
  tz: string,
  locale = 'it-IT',
): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  }).format(ts);
}

export function formatRange(
  start: number,
  end: number,
  tz: string,
  locale = 'it-IT',
): string {
  return `${formatTime(start, tz, locale)}–${formatTime(end, tz, locale)}`;
}

/** Minutes, rounded, for display and duration maths. */
export function minutesBetween(a: number, b: number): number {
  return Math.round((b - a) / MINUTE_MS);
}

export interface Interval {
  start: number;
  end: number;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Merges overlapping/adjacent intervals. Used to collapse fixed events plus
 * their buffers into a single "busy" mask before free slots are computed.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** `window` minus every busy interval, preserving order. */
export function subtractIntervals(
  window: Interval,
  busy: Interval[],
): Interval[] {
  const merged = mergeIntervals(busy);
  const free: Interval[] = [];
  let cursor = window.start;

  for (const b of merged) {
    if (b.end <= cursor) continue;
    if (b.start >= window.end) break;
    if (b.start > cursor) {
      free.push({ start: cursor, end: Math.min(b.start, window.end) });
    }
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });

  return free.filter((f) => f.end > f.start);
}
