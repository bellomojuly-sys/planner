import { describe, expect, it } from 'vitest';
import { schedule } from '../src/scheduler/engine';
import { withoutSuppressedBuffers } from '../src/scheduler/personal-rules';
import {
  blockEditability,
  bufferSuppressionKey,
  eventEditability,
  gymSessionParts,
  gymSuppressionKey,
} from '../src/services/manual-edits';
import { localDateKey } from '../src/lib/time';
import type { PlacedBlock } from '../src/scheduler/types';
import type { Settings } from '../src/db/schema';
import { baseSettings } from './support/settings';

const TZ = 'Europe/Rome';
/** Monday 12 January 2026, 07:00 in Rome. */
const MONDAY = Date.parse('2026-01-12T06:00:00Z');
const DAY = 86_400_000;

function plan(options: {
  settings?: Partial<Settings>;
  suppressedKeys?: Set<string>;
  pinnedBlocks?: PlacedBlock[];
}) {
  return schedule({
    now: MONDAY,
    horizonEnd: MONDAY + 7 * DAY,
    timezone: TZ,
    settings: { ...baseSettings, ...options.settings },
    tasks: [],
    dependencies: new Map(),
    busy: [],
    pinnedBlocks: options.pinnedBlocks ?? [],
    suppressedKeys: options.suppressedKeys,
  });
}

describe('which events can be edited', () => {
  it('allows Google calendars the account can write to', () => {
    expect(eventEditability({ kind: 'google', accessRole: 'owner' }).editable).toBe(true);
    expect(eventEditability({ kind: 'google', accessRole: 'writer' }).editable).toBe(true);
  });

  it('refuses ICS feeds and read-only shares, with a reason', () => {
    const ics = eventEditability({ kind: 'ics', accessRole: 'reader' });
    const reader = eventEditability({ kind: 'google', accessRole: 'reader' });
    expect(ics.editable).toBe(false);
    expect(ics.reason).toMatch(/ICS/);
    expect(reader.editable).toBe(false);
    expect(reader.reason).toMatch(/sola lettura/);
    expect(eventEditability(undefined).editable).toBe(false);
  });

  it('lets derived travel be deleted but not edited, and never a break', () => {
    expect(blockEditability({ kind: 'task' })).toMatchObject({ editable: true, deletable: true });
    expect(blockEditability({ kind: 'gym' })).toMatchObject({ editable: true, deletable: true });
    expect(blockEditability({ kind: 'buffer' })).toMatchObject({ editable: false, deletable: true });
    expect(blockEditability({ kind: 'break' })).toMatchObject({ editable: false, deletable: false });
  });
});

describe('deleted gym sessions stay deleted', () => {
  const threePerWeek = { gymSessionsPerWeek: 3, gymPreferredDays: '1,3,5' };

  it('does not recreate the session on the deleted day or compensate elsewhere', () => {
    const before = plan({ settings: threePerWeek }).blocks.filter((b) => b.kind === 'gym');
    expect(before).toHaveLength(3);
    const deletedDay = localDateKey(before[0]!.start, TZ);

    const after = plan({
      settings: threePerWeek,
      suppressedKeys: new Set([gymSuppressionKey(deletedDay)]),
    }).blocks;

    const gym = after.filter((b) => b.kind === 'gym');
    expect(gym).toHaveLength(2);
    expect(gym.map((b) => localDateKey(b.start, TZ))).not.toContain(deletedDay);
    // Its travel and shower are gone too, not orphaned.
    expect(
      after.filter((b) => !b.taskId && localDateKey(b.start, TZ) === deletedDay),
    ).toHaveLength(0);
  });

  it('removes only the travel component that was deleted', () => {
    const before = plan({ settings: { gymSessionsPerWeek: 1, gymPreferredDays: '1' } }).blocks;
    const outward = before.find((b) => b.title === 'Viaggio verso palestra')!;
    const day = localDateKey(outward.start, TZ);

    const after = plan({
      settings: { gymSessionsPerWeek: 1, gymPreferredDays: '1' },
      suppressedKeys: new Set([bufferSuppressionKey(day, 'Viaggio verso palestra')]),
    }).blocks;

    expect(after.some((b) => b.kind === 'gym')).toBe(true);
    expect(after.some((b) => b.title === 'Viaggio verso palestra')).toBe(false);
    expect(after.some((b) => b.title === 'Ritorno dalla palestra')).toBe(true);
  });
});

describe('edited gym sessions are not overwritten or duplicated', () => {
  it('counts a pinned session toward the week instead of adding another', () => {
    const wednesdayEvening = MONDAY + 2 * DAY + 12 * 60 * 60_000; // Wed 19:00
    const pinned: PlacedBlock = {
      taskId: null,
      title: 'Palestra con Sara',
      start: wednesdayEvening,
      end: wednesdayEvening + 90 * 60_000,
      kind: 'gym',
      zone: 'evening',
      partIndex: 1,
      partCount: 1,
      zoneCompromised: false,
    };

    const result = plan({
      settings: { gymSessionsPerWeek: 2, gymPreferredDays: '1,3,5' },
      pinnedBlocks: [pinned],
    });
    const gym = result.blocks.filter((b) => b.kind === 'gym');

    expect(gym).toHaveLength(2);
    expect(gym).toContainEqual(expect.objectContaining({ title: 'Palestra con Sara' }));
    expect(
      gym.filter((b) => localDateKey(b.start, TZ) === localDateKey(wednesdayEvening, TZ)),
    ).toHaveLength(1);
  });

  it('moves the travel and shower parts with the edited workout', () => {
    const at = (h: number) => MONDAY + h * 60 * 60_000;
    const blocks: Parameters<typeof gymSessionParts>[1] = [
      { id: 'out', taskId: null, title: 'Viaggio verso palestra', kind: 'buffer', startAt: at(11) },
      { id: 'gym', taskId: null, title: 'Palestra', kind: 'gym', startAt: at(11.5) },
      { id: 'back', taskId: null, title: 'Ritorno dalla palestra', kind: 'buffer', startAt: at(13) },
      { id: 'uni', taskId: null, title: 'Viaggio casa → università', kind: 'buffer', startAt: at(2) },
      { id: 'next', taskId: null, title: 'Palestra', kind: 'gym', startAt: at(35) },
    ];

    expect(gymSessionParts({ id: 'gym', startAt: at(11.5) }, blocks, TZ).sort()).toEqual(
      ['back', 'gym', 'out'],
    );
  });
});

describe('deleted commitment travel', () => {
  it('frees exactly the deleted journey', () => {
    const start = MONDAY + 3 * 60 * 60_000; // 10:00
    const lesson = {
      start,
      end: start + 2 * 60 * 60_000,
      title: 'Applied GenAI',
      travelBeforeMinutes: 20,
      travelAfterMinutes: 20,
      travelBeforeLabel: 'Viaggio casa → università',
      travelAfterLabel: 'Viaggio università → casa',
    };
    const day = localDateKey(start, TZ);

    const [result] = withoutSuppressedBuffers(
      [lesson],
      new Set([bufferSuppressionKey(day, 'Viaggio casa → università')]),
      TZ,
    );

    expect(result!.travelBeforeMinutes).toBe(0);
    expect(result!.travelAfterMinutes).toBe(20);
  });
});
