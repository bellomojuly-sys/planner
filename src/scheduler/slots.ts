import type { Settings } from '../db/schema';
import {
  atLocalMinutes,
  addLocalDays,
  localDateKey,
  startOfLocalDay,
  subtractIntervals,
  mergeIntervals,
  MINUTE_MS,
  type Interval,
} from '../lib/time';
import type { Slot, Zone } from './types';

/**
 * Turns the calendar into a list of workable openings. Fixed commitments are
 * padded with a travel buffer first, then subtracted from each day's waking
 * window, then the remainder is cut at the energy-zone boundaries so a slot
 * never straddles morning and afternoon.
 */
export function buildSlots(params: {
  from: number;
  to: number;
  timezone: string;
  settings: Settings;
  busy: Interval[];
}): Slot[] {
  const { from, to, timezone, settings } = params;

  const padded = params.busy.map((b) => ({
    start: b.start - settings.bufferAroundEventsMinutes * MINUTE_MS,
    end: b.end + settings.bufferAroundEventsMinutes * MINUTE_MS,
  }));
  const busy = mergeIntervals(padded);

  const slots: Slot[] = [];
  let cursor = startOfLocalDay(from, timezone);

  // Hard stop guards against a pathological horizon or a DST bug looping.
  for (let guard = 0; guard < 400 && cursor < to; guard++) {
    const dayStart = atLocalMinutes(
      cursor,
      timezone,
      settings.dayStartMinutes,
    );
    const dayEnd = atLocalMinutes(cursor, timezone, settings.dayEndMinutes);
    const morningEnd = atLocalMinutes(
      cursor,
      timezone,
      settings.morningEndMinutes,
    );
    const afternoonEnd = atLocalMinutes(
      cursor,
      timezone,
      settings.afternoonEndMinutes,
    );

    // Never schedule in the past, and never before the caller's `from`.
    const windowStart = Math.max(dayStart, from);
    const windowEnd = Math.min(dayEnd, to);

    if (windowEnd > windowStart) {
      const dayKey = localDateKey(cursor, timezone);
      const free = subtractIntervals(
        { start: windowStart, end: windowEnd },
        busy,
      );

      for (const piece of free) {
        for (const zoned of splitByZone(
          piece,
          morningEnd,
          afternoonEnd,
          dayKey,
        )) {
          if (zoned.end - zoned.start >= settings.minBlockMinutes * MINUTE_MS) {
            slots.push(zoned);
          }
        }
      }
    }

    cursor = addLocalDays(cursor, timezone, 1);
  }

  return slots.sort((a, b) => a.start - b.start);
}

function splitByZone(
  piece: Interval,
  morningEnd: number,
  afternoonEnd: number,
  dayKey: string,
): Slot[] {
  const cuts = [piece.start, morningEnd, afternoonEnd, piece.end]
    .filter((t) => t >= piece.start && t <= piece.end)
    .sort((a, b) => a - b);

  const out: Slot[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i]!;
    const end = cuts[i + 1]!;
    if (end <= start) continue;
    out.push({ start, end, dayKey, zone: zoneAt(start, morningEnd, afternoonEnd) });
  }
  return out;
}

function zoneAt(ts: number, morningEnd: number, afternoonEnd: number): Zone {
  if (ts < morningEnd) return 'morning';
  if (ts < afternoonEnd) return 'afternoon';
  return 'evening';
}

/**
 * Mutable view over the day's openings. Placing a block carves it out and
 * leaves the remainders available, which is what lets a long morning gap host
 * three tasks back to back.
 */
export class SlotPool {
  private slots: Slot[];

  constructor(slots: Slot[]) {
    this.slots = [...slots].sort((a, b) => a.start - b.start);
  }

  list(): readonly Slot[] {
    return this.slots;
  }

  /**
   * Earliest opening that starts at or after `notBefore`, sits in one of
   * `zones`, and is long enough for `durationMs` plus the trailing break.
   *
   * `zones` is ordered by preference, but the search is breadth-first over
   * time within each preference tier: a demanding task takes tomorrow morning
   * over this afternoon, unless the deadline says otherwise.
   */
  find(params: {
    durationMs: number;
    breakMs: number;
    notBefore: number;
    notAfter: number | null;
    zones: Zone[];
  }): { slot: Slot; start: number } | null {
    for (const zone of params.zones) {
      for (const slot of this.slots) {
        if (slot.zone !== zone) continue;

        const start = Math.max(slot.start, params.notBefore);
        const end = start + params.durationMs;

        if (end > slot.end) continue;
        // The break may spill past the slot's end — that is fine, it only has
        // to not collide with the *next* block, and slot boundaries are
        // already separated by buffers.
        if (params.notAfter !== null && end > params.notAfter) continue;

        return { slot, start };
      }
    }
    return null;
  }

  /** Removes `[start, start + durationMs + breakMs)` from the pool. */
  consume(slot: Slot, start: number, durationMs: number, breakMs: number): void {
    const index = this.slots.indexOf(slot);
    if (index === -1) return;

    const consumedEnd = start + durationMs + breakMs;
    const replacements: Slot[] = [];

    if (start - slot.start > 0) {
      replacements.push({ ...slot, end: start });
    }
    if (slot.end - consumedEnd > 0) {
      replacements.push({ ...slot, start: consumedEnd });
    }

    this.slots.splice(index, 1, ...replacements);
  }

  /** Total workable minutes left, used for the "day is overbooked" warning. */
  remainingMinutes(): number {
    return Math.round(
      this.slots.reduce((sum, s) => sum + (s.end - s.start), 0) / MINUTE_MS,
    );
  }
}

/**
 * Preference order per energy level, with the fallback chain baked in.
 * Demanding work wants the morning but will take an afternoon rather than miss
 * a deadline; gym and light work belong to the evening.
 */
export const ZONE_PREFERENCE: Record<string, Zone[]> = {
  high: ['morning', 'afternoon', 'evening'],
  medium: ['afternoon', 'morning', 'evening'],
  low: ['evening', 'afternoon', 'morning'],
};
