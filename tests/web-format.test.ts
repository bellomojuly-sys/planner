import { describe, expect, it } from 'vitest';
import {
  addDays,
  overlapsDay,
  sameDay,
  startOfDay,
} from '../web/src/lib/format';

describe('planner calendar day boundaries', () => {
  it('compares the local day without leaking input milliseconds', () => {
    const now = Date.parse('2026-08-12T14:55:42.987Z');
    const eveningBlock = Date.parse('2026-08-12T16:00:00.000Z');

    expect(startOfDay(now)).toBe(Date.parse('2026-08-11T22:00:00.000Z'));
    expect(sameDay(now, eveningBlock)).toBe(true);
  });

  it('advances by local calendar days across daylight saving time', () => {
    const saturdayMidnight = Date.parse('2026-03-27T23:00:00.000Z');
    const mondayMidnight = addDays(saturdayMidnight, 2);

    expect(mondayMidnight).toBe(Date.parse('2026-03-29T22:00:00.000Z'));
    expect(mondayMidnight - saturdayMidnight).toBe(47 * 60 * 60 * 1000);
  });

  it('shows a multi-day all-day event on every day it overlaps', () => {
    const tripStart = Date.parse('2026-08-13T22:00:00.000Z');
    const tripEnd = Date.parse('2026-08-30T22:00:00.000Z');
    const middleDay = Date.parse('2026-08-20T10:00:00.000Z');

    expect(overlapsDay(tripStart, tripEnd, middleDay)).toBe(true);
  });
});
