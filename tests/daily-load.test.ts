import { describe, expect, it } from 'vitest';
import { schedule } from '../src/scheduler/engine';
import { localDateKey } from '../src/lib/time';
import type { SchedulableTask } from '../src/scheduler/types';
import type { Settings } from '../src/db/schema';

/**
 * The rules from `dl-how-planner-spreads-the-week`. Before them the greedy
 * pass put 15 blocks and 10h45 of work on one Sunday and a fifteen-hour
 * project in ten consecutive parts, with the rest of the week nearly empty.
 */

const TZ = 'Europe/Rome';
const MONDAY = Date.parse('2026-01-12T06:00:00Z');
const HOUR = 3_600_000;

const settings: Settings = {
  userId: 'u1',
  dayStartMinutes: 7 * 60,
  dayEndMinutes: 22 * 60 + 30,
  morningEndMinutes: 13 * 60,
  afternoonEndMinutes: 18 * 60,
  minBlockMinutes: 20,
  maxBlockMinutes: 90,
  breakMinutes: 10,
  bufferAroundEventsMinutes: 15,
  gymSessionsPerWeek: 0,
  gymDurationMinutes: 75,
  gymPreferredDays: '1,3,5',
  briefingMinutes: 7 * 60,
  reviewMinutes: 20 * 60 + 30,
  reviewAfterShiftMinutes: 30,
  fixedEventKeywords: 'turno,lezione',
  planningHorizonDays: 14,
  autoRescheduleEnabled: true,
  pushEnabled: true,
  updatedAt: Date.now(),
};

function task(overrides: Partial<SchedulableTask> & { id: string }): SchedulableTask {
  return {
    title: overrides.id,
    area: 'general',
    energy: 'medium',
    priority: 3,
    plannedMinutes: 60,
    dueAt: null,
    earliestStartAt: null,
    splittable: true,
    pinned: false,
    isGym: false,
    status: 'todo',
    projectKey: null,
    phaseOrder: null,
    ...overrides,
  };
}

function run(
  tasks: SchedulableTask[],
  busy: Array<{ start: number; end: number; isShift?: boolean }> = [],
  days = 7,
) {
  return schedule({
    now: MONDAY,
    horizonEnd: MONDAY + days * 86_400_000,
    timezone: TZ,
    settings,
    tasks,
    dependencies: new Map(),
    busy,
    pinnedBlocks: [],
  });
}

function minutesPerDay(blocks: Array<{ start: number; end: number; kind: string }>) {
  const out = new Map<string, number>();
  for (const b of blocks.filter((x) => x.kind === 'task')) {
    const day = localDateKey(b.start, TZ);
    out.set(day, (out.get(day) ?? 0) + (b.end - b.start) / 60_000);
  }
  return out;
}

describe('daily ceiling', () => {
  it('never books more than four hours of tasks on a free day', () => {
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task({ id: `t${i}`, area: i % 2 ? 'mg' : 'university', plannedMinutes: 60 }),
    );
    const result = run(tasks);
    for (const minutes of minutesPerDay(result.blocks).values()) {
      expect(minutes).toBeLessThanOrEqual(240);
    }
  });

  it('spreads work over the week instead of stacking the first day', () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({ id: `t${i}`, area: (['mg', 'university', 'heemia'] as const)[i % 3]!, plannedMinutes: 60 }),
    );
    const result = run(tasks);
    expect(minutesPerDay(result.blocks).size).toBeGreaterThanOrEqual(3);
  });

  it('halves the ceiling on a day with a shift', () => {
    // Monday 17:00–22:30 Rome is a shift.
    const shift = {
      start: Date.parse('2026-01-12T16:00:00Z'),
      end: Date.parse('2026-01-12T21:30:00Z'),
      isShift: true,
    };
    const tasks = Array.from({ length: 8 }, (_, i) =>
      task({ id: `t${i}`, area: i % 2 ? 'mg' : 'career', plannedMinutes: 60 }),
    );
    const result = run(tasks, [shift]);
    expect(minutesPerDay(result.blocks).get('2026-01-12') ?? 0).toBeLessThanOrEqual(120);
  });
});

describe('area balance', () => {
  it('lets no area take more than half of a day', () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `mg${i}`, area: 'mg', plannedMinutes: 60, priority: 1 }),
    );
    const result = run(tasks);
    for (const minutes of minutesPerDay(result.blocks).values()) {
      expect(minutes).toBeLessThanOrEqual(120);
    }
  });

  it('gives a lower-priority area room on the same day', () => {
    const tasks = [
      ...Array.from({ length: 6 }, (_, i) =>
        task({ id: `mg${i}`, area: 'mg', plannedMinutes: 60, priority: 1 }),
      ),
      task({ id: 'uni', area: 'university', plannedMinutes: 60, priority: 3 }),
    ];
    const result = run(tasks);
    const uni = result.blocks.find((b) => b.taskId === 'uni')!;
    expect(localDateKey(uni.start, TZ)).toBe('2026-01-12');
  });
});

describe('long projects', () => {
  it('places at most one part of a task per day', () => {
    const project = task({
      id: 'github',
      area: 'career',
      plannedMinutes: 900,
      dueAt: MONDAY + 120 * 86_400_000,
    });
    const result = run([project], [], 14);
    const days = result.blocks
      .filter((b) => b.taskId === 'github')
      .map((b) => localDateKey(b.start, TZ));
    expect(days.length).toBeGreaterThan(1);
    expect(new Set(days).size).toBe(days.length);
  });

  it('still places one oversized part on an otherwise empty day', () => {
    const big = task({ id: 'exam-prep', plannedMinutes: 150, splittable: false });
    const result = run([big]);
    expect(result.blocks.some((b) => b.taskId === 'exam-prep')).toBe(true);
    void HOUR;
  });
});

describe('duplicates', () => {
  it('plans the same title in the same area once and reports the copy', () => {
    const result = run([
      task({ id: 'a', title: 'analisi sito', area: 'mg' }),
      task({ id: 'b', title: 'Analisi  sito ', area: 'mg' }),
    ]);
    expect(result.blocks.filter((b) => b.kind === 'task')).toHaveLength(1);
    expect(result.unplaced).toEqual([
      expect.objectContaining({ reason: 'duplicate' }),
    ]);
    expect(result.warnings.join(' ')).toMatch(/duplicate/i);
  });

  it('keeps the same title in two different areas', () => {
    const result = run([
      task({ id: 'a', title: 'report', area: 'mg' }),
      task({ id: 'b', title: 'report', area: 'university' }),
    ]);
    expect(result.blocks.filter((b) => b.kind === 'task')).toHaveLength(2);
  });
});

describe('model estimates', () => {
  it('rounds to quarters of an hour and stays within a working day', async () => {
    const { roundEstimate } = await import('../src/services/estimate-missing');
    expect(roundEstimate(37)).toBe(30);
    expect(roundEstimate(5)).toBe(15);
    expect(roundEstimate(2000)).toBe(480);
  });
});
