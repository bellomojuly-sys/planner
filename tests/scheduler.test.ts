import { describe, it, expect } from 'vitest';
import { schedule, urgencyScore } from '../src/scheduler/engine';
import { buildSlots, SlotPool } from '../src/scheduler/slots';
import {
  applyBusyPersonalRules,
  applyCalendarPersonalRules,
  applyTaskPersonalRules,
} from '../src/scheduler/personal-rules';
import {
  topologicalOrder,
  collectDescendants,
  inferPhaseEdges,
  parsePhase,
  type DepMap,
} from '../src/scheduler/dependencies';
import {
  subtractIntervals,
  mergeIntervals,
  localMinutes,
  localWeekday,
  localDateKey,
} from '../src/lib/time';
import type { ScheduleInput, SchedulableTask } from '../src/scheduler/types';
import type { Settings } from '../src/db/schema';

const TZ = 'Europe/Rome';

/** A Monday in winter, 06:00 UTC = 07:00 Rome. */
const MONDAY = Date.parse('2026-01-12T06:00:00Z');

const settings: Settings = {
  userId: 'u1',
  dayStartMinutes: 7 * 60,
  dayEndMinutes: 22 * 60 + 30,
  sleepStartMinutes: 60,
  sleepTargetMinutes: 8 * 60,
  wakeBufferMinutes: 30,
  morningEndMinutes: 13 * 60,
  afternoonEndMinutes: 18 * 60,
  minBlockMinutes: 20,
  maxBlockMinutes: 90,
  breakMinutes: 10,
  bufferAroundEventsMinutes: 15,
  universityTravelMinutes: 20,
  universityToWorkTravelMinutes: 25,
  universityPreparationMinutes: 60,
  universityShowerPreparationMinutes: 105,
  universityShowerDefault: false,
  restaurantTravelMinutes: 20,
  restaurantReturnMinutes: 20,
  travelMode: 'bike',
  homeAddress: null,
  defaultTravelMinutes: 20,
  travelBufferMinutes: 5,
  placeTravelMinutes: '',
  gymSessionsPerWeek: 0,
  gymMaxSessionsPerWeek: 4,
  gymDurationMinutes: 75,
  gymPreferredDays: '1,3,5',
  gymAvoidDays: '',
  gymTravelMinutes: 25,
  gymPreparationMinutes: 20,
  gymReturnMinutes: 25,
  gymMinRecoveryHours: 36,
  gymStartMinutes: 0,
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
  options: {
    deps?: DepMap;
    busy?: ScheduleInput['busy'];
    contexts?: ScheduleInput['contexts'];
    settingsOverride?: Partial<Settings>;
    days?: number;
  } = {},
) {
  return schedule({
    now: MONDAY,
    horizonEnd: MONDAY + (options.days ?? 7) * 86_400_000,
    timezone: TZ,
    settings: { ...settings, ...options.settingsOverride },
    tasks,
    dependencies: options.deps ?? new Map(),
    busy: options.busy ?? [],
    contexts: options.contexts,
    pinnedBlocks: [],
  });
}

describe('interval maths', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(
      mergeIntervals([
        { start: 0, end: 10 },
        { start: 5, end: 20 },
        { start: 30, end: 40 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('subtracts busy time from a window, keeping the gaps', () => {
    expect(
      subtractIntervals({ start: 0, end: 100 }, [
        { start: 20, end: 30 },
        { start: 60, end: 70 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 60 },
      { start: 70, end: 100 },
    ]);
  });

  it('returns nothing when the window is fully covered', () => {
    expect(subtractIntervals({ start: 10, end: 20 }, [{ start: 0, end: 50 }])).toEqual([]);
  });
});

describe('slot generation', () => {
  it('does not create productive time before sleep target and wake buffer', () => {
    const slots = buildSlots({
      from: MONDAY,
      to: MONDAY + 86_400_000,
      timezone: TZ,
      settings,
      busy: [],
    });

    expect(localMinutes(slots[0]!.start, TZ)).toBe(9 * 60 + 30);
  });

  it('never creates automatic task time before 09:00 even with an early sleep profile', () => {
    const slots = buildSlots({
      from: MONDAY,
      to: MONDAY + 86_400_000,
      timezone: TZ,
      settings: {
        ...settings,
        dayStartMinutes: 6 * 60,
        sleepStartMinutes: 20 * 60,
        sleepTargetMinutes: 4 * 60,
        wakeBufferMinutes: 0,
      },
      busy: [],
    });

    expect(localMinutes(slots[0]!.start, TZ)).toBe(9 * 60);
  });

  it('never produces a slot spanning two energy zones', () => {
    const slots = buildSlots({
      from: MONDAY,
      to: MONDAY + 86_400_000,
      timezone: TZ,
      settings,
      busy: [],
    });

    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const startMin = localMinutes(slot.start, TZ);
      // The end is exclusive, so a slot ending exactly at the boundary is fine.
      const endMin = localMinutes(slot.end - 1, TZ);

      if (slot.zone === 'morning') expect(endMin).toBeLessThan(13 * 60);
      if (slot.zone === 'afternoon') {
        expect(startMin).toBeGreaterThanOrEqual(13 * 60);
        expect(endMin).toBeLessThan(18 * 60);
      }
      if (slot.zone === 'evening') expect(startMin).toBeGreaterThanOrEqual(18 * 60);
    }
  });

  it('pads fixed events with the travel buffer', () => {
    const shiftStart = MONDAY + 3 * 3_600_000; // 10:00 Rome
    const shiftEnd = shiftStart + 3_600_000;

    const slots = buildSlots({
      from: MONDAY,
      to: MONDAY + 86_400_000,
      timezone: TZ,
      settings,
      busy: [{ start: shiftStart, end: shiftEnd }],
    });

    const bufferMs = settings.bufferAroundEventsMinutes * 60_000;
    for (const slot of slots) {
      expect(slot.start >= shiftEnd + bufferMs || slot.end <= shiftStart - bufferMs).toBe(
        true,
      );
    }
  });

  it('consumes a slot and leaves both remainders available', () => {
    const pool = new SlotPool([
      { start: 0, end: 100, zone: 'morning', dayKey: '2026-01-12' },
    ]);
    const slot = pool.list()[0]!;
    pool.consume(slot, 30, 20, 0);

    expect(pool.list()).toEqual([
      { start: 0, end: 30, zone: 'morning', dayKey: '2026-01-12' },
      { start: 50, end: 100, zone: 'morning', dayKey: '2026-01-12' },
    ]);
  });
});

describe('confirmed personal reality rules', () => {
  it('reserves preparation and both journeys for the first Den Bosch workshop', () => {
    const event = applyBusyPersonalRules(
      {
        start: Date.parse('2026-01-14T09:00:00Z'),
        end: Date.parse('2026-01-14T11:00:00Z'),
        title: 'Workshop Den Bosch',
        location: null,
      },
      settings,
    );

    expect(event.preparationBeforeMinutes).toBe(40);
    expect(event.travelBeforeMinutes).toBe(90);
    expect(event.travelAfterMinutes).toBe(90);
  });

  it('shows Den Bosch preparation and journeys as separate calendar blocks', () => {
    const workshop = applyBusyPersonalRules(
      {
        start: Date.parse('2026-01-14T08:00:00Z'), // 09:00 Rome
        end: Date.parse('2026-01-14T11:00:00Z'),
        title: 'Workshop Den Bosch',
      },
      settings,
    );
    const result = run([], { busy: [workshop] });
    const buffers = result.blocks.filter((block) => block.kind === 'buffer');

    expect(buffers.map((block) => block.title)).toEqual([
      'Preparazione — Workshop Den Bosch',
      'Viaggio casa → Den Bosch',
      'Viaggio Den Bosch → casa',
    ]);
    expect(buffers.map((block) => (block.end - block.start) / 60_000)).toEqual([
      40, 90, 90,
    ]);
    expect(localMinutes(buffers[0]!.start, TZ)).toBe(6 * 60 + 50);
  });

  it('reserves one hour preparation and twenty minutes each way for university context', () => {
    const contextStart = MONDAY + 2 * 3_600_000; // 09:00 Rome
    const contextEnd = MONDAY + 5 * 3_600_000; // 12:00 Rome
    const reality = applyCalendarPersonalRules(
      [],
      [
        {
          start: contextStart,
          end: contextEnd,
          title: 'Zelf Work Fontys',
          allowedAreas: ['university'],
        },
      ],
      settings,
      TZ,
    );
    const result = run(
      [task({ id: 'dani', title: 'Dani improvement', area: 'university' })],
      { contexts: reality.contexts },
    );
    const contextBuffers = result.blocks.filter(
      (block) => block.taskId === null && block.kind === 'buffer',
    );

    expect(reality.contexts[0]).toMatchObject({
      preparationBeforeMinutes: 60,
      travelBeforeMinutes: 20,
      travelAfterMinutes: 20,
    });
    expect(contextBuffers.map((block) => block.title)).toEqual([
      'Preparazione università',
      'Viaggio casa → università',
      'Viaggio università → casa',
    ]);
    expect(contextBuffers.map((block) => (block.end - block.start) / 60_000)).toEqual([
      60, 20, 20,
    ]);
  });

  it('uses a single 25 minute journey when going directly from university to work', () => {
    const contextEnd = MONDAY + 9 * 3_600_000; // 16:00 Rome
    const shiftStart = contextEnd + 60 * 60_000;
    const reality = applyCalendarPersonalRules(
      [
        {
          start: shiftStart,
          end: shiftStart + 5 * 3_600_000,
          title: 'Werken bij Arizona',
          isShift: true,
        },
      ],
      [
        {
          start: MONDAY + 6 * 3_600_000,
          end: contextEnd,
          title: 'Applied GenAI Fontys',
          allowedAreas: ['university'],
        },
      ],
      settings,
      TZ,
    );

    expect(reality.contexts[0]).toMatchObject({
      travelAfterMinutes: 25,
      travelAfterLabel: 'Viaggio università → lavoro',
    });
    expect(reality.busy[0]).toMatchObject({ travelBeforeMinutes: 0 });

    const result = run([], {
      busy: reality.busy,
      contexts: reality.contexts,
    });
    const journeyTitles = result.blocks
      .filter((block) => block.kind === 'buffer')
      .map((block) => block.title);

    expect(journeyTitles).toContain('Viaggio università → lavoro');
    expect(journeyTitles).not.toContain('Viaggio verso — Werken bij Arizona');
  });

  it('keeps undated adult-life bureaucracy on Sunday', () => {
    const duo = applyTaskPersonalRules(
      task({ id: 'duo', title: 'Iscrizione DUO', plannedMinutes: 60 }),
      settings,
    );
    const result = run([duo]);
    const block = result.blocks.find((candidate) => candidate.taskId === duo.id)!;

    expect(localDateKey(block.start, TZ)).toBe('2026-01-18');
  });

  it('uses university context for university work but not unrelated work', () => {
    const contextStart = MONDAY + 2 * 3_600_000; // 09:00 Rome
    const contextEnd = MONDAY + 5 * 3_600_000; // 12:00 Rome
    const result = run(
      [
        task({ id: 'uni', title: 'Dani improvement', area: 'university', energy: 'high' }),
        task({ id: 'work', title: 'Heemia task', area: 'heemia', energy: 'high' }),
      ],
      {
        days: 1,
        settingsOverride: { dayEndMinutes: 12 * 60 },
        contexts: [
          { start: contextStart, end: contextEnd, allowedAreas: ['university'] },
        ],
      },
    );

    const university = result.blocks.find((block) => block.taskId === 'uni');
    expect(university?.start).toBeGreaterThanOrEqual(contextStart);
    expect(university?.end).toBeLessThanOrEqual(contextEnd);
    expect(result.blocks.some((block) => block.taskId === 'work')).toBe(false);
  });

  it('ranks Heemia above generic flexible work and LinkedIn last', () => {
    const heemia = task({ id: 'heemia', title: 'Heemia operativo', area: 'heemia' });
    const generic = task({ id: 'generic', title: 'Riordinare appunti' });
    const linkedin = task({ id: 'linkedin', title: 'Aggiornare LinkedIn' });

    expect(urgencyScore(heemia, MONDAY, 0)).toBeGreaterThan(
      urgencyScore(generic, MONDAY, 0),
    );
    expect(urgencyScore(linkedin, MONDAY, 0)).toBeLessThan(
      urgencyScore(generic, MONDAY, 0),
    );
  });
});

describe('energy-based placement', () => {
  it('puts demanding work in the morning and light work in the evening', () => {
    const result = run([
      task({ id: 'deep', energy: 'high', plannedMinutes: 60 }),
      task({ id: 'light', energy: 'low', plannedMinutes: 30 }),
    ]);

    const deep = result.blocks.find((b) => b.taskId === 'deep')!;
    const light = result.blocks.find((b) => b.taskId === 'light')!;

    expect(deep.zone).toBe('morning');
    expect(light.zone).toBe('evening');
    expect(localMinutes(deep.start, TZ)).toBeLessThan(13 * 60);
    expect(localMinutes(light.start, TZ)).toBeGreaterThanOrEqual(18 * 60);
  });

  it('prefers a later morning over the same afternoon for demanding work', () => {
    // Monday morning is fully booked, so the task should land on Tuesday
    // morning rather than Monday afternoon.
    const morningBusy = {
      start: MONDAY,
      end: MONDAY + 6 * 3_600_000, // through 13:00 Rome
    };

    const result = run([task({ id: 'deep', energy: 'high', plannedMinutes: 60 })], {
      busy: [morningBusy],
    });

    const deep = result.blocks.find((b) => b.taskId === 'deep')!;
    expect(deep.zone).toBe('morning');
    expect(deep.start).toBeGreaterThan(MONDAY + 20 * 3_600_000);
  });

  it('falls back to another zone rather than missing a deadline', () => {
    const dueTonight = MONDAY + 14 * 3_600_000; // 21:00 Rome
    const result = run(
      [
        task({
          id: 'urgent-deep',
          energy: 'high',
          plannedMinutes: 60,
          dueAt: dueTonight,
        }),
      ],
      // Every morning slot today is gone; the deadline is tonight.
      { busy: [{ start: MONDAY, end: MONDAY + 6 * 3_600_000 }] },
    );

    const block = result.blocks.find((b) => b.taskId === 'urgent-deep')!;
    expect(block).toBeDefined();
    expect(block.end).toBeLessThanOrEqual(dueTonight);
    expect(block.zoneCompromised).toBe(true);
  });
});

describe('dependencies', () => {
  it('orders prerequisites before dependents', () => {
    const deps: DepMap = new Map([
      ['b', [{ dependsOnId: 'a', lagMinutes: 0 }]],
      ['c', [{ dependsOnId: 'b', lagMinutes: 0 }]],
    ]);

    const { order } = topologicalOrder(
      [task({ id: 'c' }), task({ id: 'a' }), task({ id: 'b' })],
      deps,
      () => 0,
    );

    expect(order.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('schedules a phase chain in order, never overlapping', () => {
    const deps: DepMap = new Map([
      ['p16', [{ dependsOnId: 'p15', lagMinutes: 0 }]],
      ['p17', [{ dependsOnId: 'p16', lagMinutes: 0 }]],
      ['p18', [{ dependsOnId: 'p17', lagMinutes: 0 }]],
    ]);

    const result = run(
      [
        task({ id: 'p18', title: 'Fase 18', plannedMinutes: 60 }),
        task({ id: 'p15', title: 'Fase 15', plannedMinutes: 60 }),
        task({ id: 'p17', title: 'Fase 17', plannedMinutes: 60 }),
        task({ id: 'p16', title: 'Fase 16', plannedMinutes: 60 }),
      ],
      { deps },
    );

    const at = (id: string) => result.blocks.find((b) => b.taskId === id)!;

    expect(at('p15').end).toBeLessThanOrEqual(at('p16').start);
    expect(at('p16').end).toBeLessThanOrEqual(at('p17').start);
    expect(at('p17').end).toBeLessThanOrEqual(at('p18').start);
  });

  it('pushes the whole chain when the first phase is delayed', () => {
    const deps: DepMap = new Map([
      ['p16', [{ dependsOnId: 'p15', lagMinutes: 0 }]],
      ['p17', [{ dependsOnId: 'p16', lagMinutes: 0 }]],
    ]);

    const baseline = run(
      [task({ id: 'p15' }), task({ id: 'p16' }), task({ id: 'p17' })],
      { deps },
    );

    // This is what moveBlock() does: it sets earliestStartAt on the task.
    const delayed = run(
      [
        task({ id: 'p15', earliestStartAt: MONDAY + 3 * 86_400_000 }),
        task({ id: 'p16' }),
        task({ id: 'p17' }),
      ],
      { deps },
    );

    const before = baseline.blocks.find((b) => b.taskId === 'p17')!;
    const after = delayed.blocks.find((b) => b.taskId === 'p17')!;

    expect(after.start).toBeGreaterThan(before.start);
    expect(after.start).toBeGreaterThanOrEqual(MONDAY + 3 * 86_400_000);
  });

  it('honours the lag between a prerequisite and its dependent', () => {
    const deps: DepMap = new Map([
      ['b', [{ dependsOnId: 'a', lagMinutes: 120 }]],
    ]);

    const result = run([task({ id: 'a' }), task({ id: 'b' })], { deps });
    const a = result.blocks.find((b) => b.taskId === 'a')!;
    const b = result.blocks.find((x) => x.taskId === 'b')!;

    expect(b.start - a.end).toBeGreaterThanOrEqual(120 * 60_000);
  });

  it('reports a cycle instead of scheduling nothing at all', () => {
    const deps: DepMap = new Map([
      ['x', [{ dependsOnId: 'y', lagMinutes: 0 }]],
      ['y', [{ dependsOnId: 'x', lagMinutes: 0 }]],
    ]);

    const result = run([task({ id: 'x' }), task({ id: 'y' }), task({ id: 'ok' })], {
      deps,
    });

    expect(result.unplaced.map((u) => u.taskId).sort()).toEqual(['x', 'y']);
    expect(result.blocks.some((b) => b.taskId === 'ok')).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/circolari/i);
  });

  it('collects every transitive dependent', () => {
    const deps: DepMap = new Map([
      ['b', [{ dependsOnId: 'a', lagMinutes: 0 }]],
      ['c', [{ dependsOnId: 'b', lagMinutes: 0 }]],
      ['d', [{ dependsOnId: 'c', lagMinutes: 0 }]],
    ]);

    expect([...collectDescendants(['a'], deps)].sort()).toEqual(['b', 'c', 'd']);
  });
});

describe('phase inference', () => {
  it('parses phase markers in several forms', () => {
    expect(parsePhase('Fase 15 — MG Integration')?.order).toBe(15);
    expect(parsePhase('MG: phase 3 rollout')?.order).toBe(3);
    expect(parsePhase('Comprare il latte')).toBeNull();
  });

  it('groups consecutive phases of the same project into a chain', () => {
    const edges = inferPhaseEdges(
      [
        { id: 'a', title: 'MG Fase 15', status: 'todo' },
        { id: 'b', title: 'MG Fase 16', status: 'todo' },
        { id: 'c', title: 'MG Fase 17', status: 'todo' },
        { id: 'd', title: 'Heemia Fase 1', status: 'todo' },
      ],
      new Map(),
    );

    expect(edges).toEqual([
      { taskId: 'b', dependsOnId: 'a' },
      { taskId: 'c', dependsOnId: 'b' },
    ]);
  });

  it('does not duplicate an edge that already exists', () => {
    const existing: DepMap = new Map([['b', [{ dependsOnId: 'a', lagMinutes: 0 }]]]);
    const edges = inferPhaseEdges(
      [
        { id: 'a', title: 'Fase 1', status: 'todo' },
        { id: 'b', title: 'Fase 2', status: 'todo' },
      ],
      existing,
    );
    expect(edges).toEqual([]);
  });
});

describe('splitting and capacity', () => {
  it('reserves travel, preparation and recovery around a task', () => {
    const result = run([
      task({
        id: 'appointment-work',
        energy: 'high',
        plannedMinutes: 60,
        travelMinutes: 20,
        preparationMinutes: 10,
        recoveryMinutes: 30,
      }),
      task({ id: 'next', energy: 'high', plannedMinutes: 60 }),
    ]);
    const first = result.blocks.find(
      (b) => b.taskId === 'appointment-work' && b.kind === 'task',
    )!;
    const next = result.blocks.find(
      (b) => b.taskId === 'next' && b.kind === 'task',
    )!;

    expect(localMinutes(first.start, TZ)).toBeGreaterThanOrEqual(10 * 60);
    expect(next.start - first.end).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('splits work longer than the maximum block, in order', () => {
    const result = run([task({ id: 'long', plannedMinutes: 240, energy: 'medium' })]);
    const parts = result.blocks.filter((b) => b.taskId === 'long');

    expect(parts.length).toBe(3); // 240 / 90 → 3 parts
    expect(parts.every((p) => p.end - p.start <= 90 * 60_000)).toBe(true);

    const sorted = [...parts].sort((a, b) => a.partIndex - b.partIndex);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    }
  });

  it('keeps an unsplittable task in one block', () => {
    const result = run([
      task({ id: 'exam', plannedMinutes: 180, splittable: false, energy: 'high' }),
    ]);
    const parts = result.blocks.filter((b) => b.taskId === 'exam');

    expect(parts.length).toBe(1);
    expect(parts[0]!.end - parts[0]!.start).toBe(180 * 60_000);
  });

  it('reports what it could not fit rather than silently dropping it', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      task({ id: `t${i}`, plannedMinutes: 90, energy: 'high' }),
    );

    const result = run(many, { days: 1 });

    expect(result.unplaced.length).toBeGreaterThan(0);
    expect(result.blocks.length + result.unplaced.length).toBe(many.length);
    expect(result.warnings.join(' ')).toMatch(/spazio/i);
  });

  it('never overlaps two blocks', () => {
    const result = run(
      Array.from({ length: 12 }, (_, i) =>
        task({
          id: `t${i}`,
          plannedMinutes: 45,
          energy: (['high', 'medium', 'low'] as const)[i % 3],
        }),
      ),
    );

    const sorted = [...result.blocks].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
    }
  });

  it('leaves fixed commitments untouched', () => {
    const shift = { start: MONDAY + 5 * 3_600_000, end: MONDAY + 11 * 3_600_000 };
    const result = run(
      Array.from({ length: 6 }, (_, i) => task({ id: `t${i}`, plannedMinutes: 60 })),
      { busy: [shift] },
    );

    for (const block of result.blocks) {
      expect(block.start < shift.end && shift.start < block.end).toBe(false);
    }
  });
});

describe('priority and urgency', () => {
  it('schedules the overdue task before the relaxed one', () => {
    const result = run([
      task({ id: 'someday', priority: 4, energy: 'medium' }),
      task({ id: 'overdue', priority: 1, dueAt: MONDAY - 86_400_000, energy: 'medium' }),
    ]);

    const overdue = result.blocks.find((b) => b.taskId === 'overdue')!;
    const someday = result.blocks.find((b) => b.taskId === 'someday')!;
    expect(overdue.start).toBeLessThan(someday.start);
  });

  it('starts a task that unblocks others before an equal-priority leaf', () => {
    const deps: DepMap = new Map([
      ['leaf1', [{ dependsOnId: 'blocker', lagMinutes: 0 }]],
      ['leaf2', [{ dependsOnId: 'blocker', lagMinutes: 0 }]],
      ['leaf3', [{ dependsOnId: 'blocker', lagMinutes: 0 }]],
    ]);

    const result = run(
      [
        task({ id: 'standalone', energy: 'medium' }),
        task({ id: 'blocker', energy: 'medium' }),
        task({ id: 'leaf1' }),
        task({ id: 'leaf2' }),
        task({ id: 'leaf3' }),
      ],
      { deps },
    );

    const blocker = result.blocks.find((b) => b.taskId === 'blocker')!;
    const standalone = result.blocks.find((b) => b.taskId === 'standalone')!;
    expect(blocker.start).toBeLessThan(standalone.start);
  });
});

describe('gym', () => {
  it('books the weekly sessions on the preferred evenings', () => {
    const result = run([], {
      settingsOverride: { gymSessionsPerWeek: 3, gymPreferredDays: '1,3,5' },
    });

    const gym = result.blocks.filter((b) => b.kind === 'gym');
    expect(gym.length).toBe(3);

    for (const session of gym) {
      expect(localMinutes(session.start, TZ)).toBeGreaterThanOrEqual(18 * 60);
      expect(session.end - session.start).toBe(75 * 60_000);
    }

    const firstDay = localDateKey(gym[0]!.start, TZ);
    const doorToDoor = result.blocks.filter(
      (block) => localDateKey(block.start, TZ) === firstDay && block.taskId === null,
    );
    expect(doorToDoor.map((block) => block.title)).toEqual([
      'Viaggio verso palestra',
      'Palestra',
      'Ritorno dalla palestra',
      'Doccia / cambio',
    ]);
    expect(
      (doorToDoor.at(-1)!.end - doorToDoor[0]!.start) / 60_000,
    ).toBe(145);
  });

  it('pins the workout to a fixed morning time, before the automatic day', () => {
    const result = run([], {
      settingsOverride: {
        gymSessionsPerWeek: 1,
        gymMaxSessionsPerWeek: 1,
        gymPreferredDays: '1',
        gymStartMinutes: 7 * 60,
      },
    });

    const workout = result.blocks.find((b) => b.kind === 'gym')!;
    expect(localMinutes(workout.start, TZ)).toBe(7 * 60);
    expect(localMinutes(workout.end, TZ)).toBe(7 * 60 + 75);

    const day = localDateKey(workout.start, TZ);
    const sequence = result.blocks
      .filter((b) => localDateKey(b.start, TZ) === day && b.taskId === null)
      .sort((a, b) => a.start - b.start);
    expect(sequence.map((b) => b.title)).toEqual([
      'Viaggio verso palestra',
      'Palestra',
      'Ritorno dalla palestra',
      'Doccia / cambio',
    ]);
    // Travel runs before the workout: she leaves 25 minutes earlier.
    expect(localMinutes(sequence[0]!.start, TZ)).toBe(7 * 60 - 25);
  });

  it('chains a morning session into a following commitment, dropping home prep', () => {
    // University at 09:00 Rome on Tuesday, with the usual home approach metadata.
    const uniStart = MONDAY + 26 * 3_600_000;
    const university = {
      start: uniStart,
      end: uniStart + 4 * 3_600_000,
      title: 'Applied GenAI',
      area: 'university' as const,
      preparationBeforeMinutes: 60,
      travelBeforeMinutes: 20,
      travelAfterMinutes: 20,
      preparationLabel: 'Preparazione università',
      travelBeforeLabel: 'Viaggio casa → università',
      travelAfterLabel: 'Viaggio università → casa',
    };
    const result = run([], {
      settingsOverride: {
        gymSessionsPerWeek: 1,
        gymMaxSessionsPerWeek: 1,
        gymPreferredDays: '2',
        gymStartMinutes: 7 * 60,
      },
      busy: [university],
    });

    const titles = result.blocks.map((b) => b.title);
    // Workout is at 07:00, then she showers at the gym and goes straight on.
    const workout = result.blocks.find((b) => b.kind === 'gym')!;
    expect(localMinutes(workout.start, TZ)).toBe(7 * 60);
    expect(titles).toContain('Viaggio palestra → università');
    // No return home, and the venue's home approach is dropped.
    expect(titles).not.toContain('Ritorno dalla palestra');
    expect(titles).not.toContain('Preparazione università');
    expect(titles).not.toContain('Viaggio casa → università');
    // The trip back home after university is kept.
    expect(titles).toContain('Viaggio università → casa');
  });

  it('skips a morning session when a fixed event blocks the slot', () => {
    // A whole-morning commitment on Wednesday overlaps the fixed 07:00 window,
    // so no gym is placed that day (it falls to another morning instead).
    const wednesday = MONDAY + 2 * 86_400_000;
    const blocker = { start: wednesday - 60 * 60_000, end: wednesday + 3 * 60 * 60_000 };
    const result = run([], {
      settingsOverride: {
        gymSessionsPerWeek: 1,
        gymMaxSessionsPerWeek: 1,
        gymPreferredDays: '3',
        gymStartMinutes: 7 * 60,
      },
      busy: [blocker],
    });
    const wednesdayGym = result.blocks.find(
      (b) => b.kind === 'gym' && localDateKey(b.start, TZ) === localDateKey(wednesday, TZ),
    );
    expect(wednesdayGym).toBeUndefined();
    // The session still happens, just on a clear morning.
    expect(result.blocks.some((b) => b.kind === 'gym')).toBe(true);
  });

  it('wraps Monday gym around Zumba and showers after returning home', () => {
    const zumbaStart = MONDAY + (13 * 60 + 15) * 60_000; // 20:15 Rome
    const zumbaEnd = zumbaStart + 45 * 60_000;
    const result = run([], {
      settingsOverride: { gymSessionsPerWeek: 1, gymPreferredDays: '1,3,5' },
      busy: [{ start: zumbaStart, end: zumbaEnd, title: 'Zumba' }],
    });
    const monday = result.blocks
      .filter((block) => localDateKey(block.start, TZ) === '2026-01-12')
      .filter((block) => block.taskId === null);

    expect(monday.map((block) => block.title)).toEqual([
      'Viaggio verso palestra',
      'Palestra',
      'Ritorno dalla palestra',
      'Doccia / cambio',
    ]);
    expect(monday.find((block) => block.title === 'Palestra')!.end).toBeLessThan(
      zumbaStart,
    );
    expect(
      monday.find((block) => block.title === 'Ritorno dalla palestra')!.start,
    ).toBeGreaterThan(zumbaEnd);
  });

  it('falls back from preferred days but never uses avoided days', () => {
    const mondayEvening = {
      start: Date.parse('2026-01-12T17:00:00Z'),
      end: Date.parse('2026-01-12T22:00:00Z'),
    };
    const result = run([], {
      settingsOverride: {
        gymSessionsPerWeek: 1,
        gymMaxSessionsPerWeek: 1,
        gymPreferredDays: '1',
        gymAvoidDays: '2',
      },
      busy: [mondayEvening],
    });
    const gym = result.blocks.find((block) => block.kind === 'gym')!;
    expect(localWeekday(gym.start, TZ)).not.toBe(2);
  });

  it('does not schedule gym when the weekly target is zero', () => {
    const result = run([task({ id: 'a' })], {
      settingsOverride: { gymSessionsPerWeek: 0 },
    });
    expect(result.blocks.some((b) => b.kind === 'gym')).toBe(false);
  });

  it('counts completed workouts toward the current weekly target', () => {
    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 7 * 86_400_000,
      timezone: TZ,
      settings: {
        ...settings,
        gymSessionsPerWeek: 3,
        gymMaxSessionsPerWeek: 4,
      },
      tasks: [],
      dependencies: new Map(),
      busy: [],
      pinnedBlocks: [],
      completedGymAt: [MONDAY - 24 * 3_600_000],
    });
    expect(result.blocks.filter((block) => block.kind === 'gym')).toHaveLength(2);
  });
});

describe('pinned work', () => {
  it('re-emits a manually placed block unchanged and plans around it', () => {
    const pinnedStart = MONDAY + 4 * 3_600_000;
    const pinned = {
      taskId: 'fixed-task',
      title: 'Spostata a mano',
      start: pinnedStart,
      end: pinnedStart + 3_600_000,
      kind: 'task' as const,
      zone: 'morning' as const,
      partIndex: 0,
      partCount: 1,
      zoneCompromised: false,
    };

    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 3 * 86_400_000,
      timezone: TZ,
      settings,
      tasks: [task({ id: 'other', plannedMinutes: 60, energy: 'high' })],
      dependencies: new Map(),
      busy: [],
      pinnedBlocks: [pinned],
    });

    const kept = result.blocks.find((b) => b.taskId === 'fixed-task')!;
    expect(kept.start).toBe(pinned.start);
    expect(kept.end).toBe(pinned.end);

    const other = result.blocks.find((b) => b.taskId === 'other')!;
    expect(other.start < pinned.end && pinned.start < other.end).toBe(false);
  });

  it('does not publish a permanent task over a fixed commitment', () => {
    const pinnedStart = MONDAY + 4 * 3_600_000;
    const pinned = {
      taskId: 'permanent',
      title: 'Non spostare questo task',
      start: pinnedStart,
      end: pinnedStart + 3_600_000,
      kind: 'task' as const,
      zone: 'morning' as const,
      partIndex: 0,
      partCount: 1,
      zoneCompromised: false,
    };

    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 3 * 86_400_000,
      timezone: TZ,
      settings,
      tasks: [task({ id: 'permanent', pinned: true })],
      dependencies: new Map(),
      busy: [{ start: pinnedStart + 15 * 60_000, end: pinned.end + 60_000 }],
      pinnedBlocks: [pinned],
    });

    expect(result.blocks.some((block) => block.taskId === 'permanent')).toBe(false);
    expect(result.unplaced).toContainEqual(
      expect.objectContaining({ taskId: 'permanent', reason: 'pinned_conflict' }),
    );
    expect(result.warnings.join(' ')).toMatch(/permanente/i);
  });

  it('removes every part of a permanent split task when one part conflicts', () => {
    const firstStart = MONDAY + 2 * 3_600_000;
    const secondStart = MONDAY + 5 * 3_600_000;
    const pinned = [firstStart, secondStart].map((start, partIndex) => ({
      taskId: 'split-permanent',
      title: 'Task permanente diviso',
      start,
      end: start + 45 * 60_000,
      kind: 'task' as const,
      zone: 'morning' as const,
      partIndex,
      partCount: 2,
      zoneCompromised: false,
    }));

    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 3 * 86_400_000,
      timezone: TZ,
      settings,
      tasks: [task({ id: 'split-permanent', pinned: true })],
      dependencies: new Map(),
      busy: [{ start: firstStart, end: firstStart + 30 * 60_000 }],
      pinnedBlocks: pinned,
    });

    expect(result.blocks.some((block) => block.taskId === 'split-permanent')).toBe(false);
    expect(result.unplaced.filter((item) => item.taskId === 'split-permanent')).toHaveLength(1);
  });

  it('keeps reporting a permanent task after its conflicting block is removed', () => {
    const result = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 3 * 86_400_000,
      timezone: TZ,
      settings,
      tasks: [task({ id: 'still-permanent', pinned: true })],
      dependencies: new Map(),
      busy: [],
      pinnedBlocks: [],
    });

    expect(result.blocks.some((block) => block.taskId === 'still-permanent')).toBe(false);
    expect(result.unplaced).toContainEqual(
      expect.objectContaining({
        taskId: 'still-permanent',
        reason: 'pinned_conflict',
      }),
    );
  });
});

describe('rescheduling when a fixed commitment moves', () => {
  // Wednesday 07:00 Rome, the first day of the shift week.
  const WEDNESDAY = MONDAY + 2 * 86_400_000;
  const WEDNESDAY_MIDNIGHT = WEDNESDAY - 7 * 3_600_000;

  const eveningShift = {
    start: WEDNESDAY + 11 * 3_600_000, // 18:00
    end: WEDNESDAY + 15 * 3_600_000 + 1_800_000, // 22:30
  };
  // The same shift pulled to the morning, which is what eitje actually does.
  const morningShift = { start: WEDNESDAY, end: WEDNESDAY + 6 * 3_600_000 };

  /** A realistic week: a phase chain, deep university work, errands. */
  const week = (): SchedulableTask[] => [
    task({ id: 'p15', title: 'MG Fase 15', energy: 'high', plannedMinutes: 90, priority: 2 }),
    task({ id: 'p16', title: 'MG Fase 16', energy: 'high', plannedMinutes: 90, priority: 2 }),
    task({ id: 'p17', title: 'MG Fase 17', energy: 'medium', plannedMinutes: 60, priority: 2 }),
    task({ id: 'study', title: 'Fontys deliverable', energy: 'high', plannedMinutes: 120, priority: 1 }),
    task({ id: 'heemia', title: 'Heemia content', energy: 'medium', plannedMinutes: 60, priority: 3 }),
    task({ id: 'admin', title: 'Amministrazione', energy: 'low', plannedMinutes: 45, priority: 4 }),
  ];

  const chain: DepMap = new Map([
    ['p16', [{ dependsOnId: 'p15', lagMinutes: 0 }]],
    ['p17', [{ dependsOnId: 'p16', lagMinutes: 0 }]],
  ]);

  const before = () => run(week(), { deps: chain, busy: [eveningShift] });
  const after = () => run(week(), { deps: chain, busy: [morningShift] });

  it('replans without dropping any task', () => {
    const baseline = before();
    const moved = after();

    expect(baseline.unplaced).toEqual([]);
    expect(moved.unplaced).toEqual([]);
    expect(moved.blocks.map((b) => b.taskId).filter(Boolean).sort()).toEqual(
      baseline.blocks.map((b) => b.taskId).filter(Boolean).sort(),
    );
  });

  it('never books over the commitment in its new position', () => {
    for (const block of after().blocks) {
      expect(block.start < morningShift.end && morningShift.start < block.end).toBe(false);
    }
  });

  it('leaves the days before the change untouched', () => {
    const untouched = (r: ReturnType<typeof run>) =>
      r.blocks
        .filter((b) => b.start < WEDNESDAY_MIDNIGHT)
        .map((b) => `${b.taskId}:${b.partIndex}@${b.start}`);

    expect(untouched(after())).toEqual(untouched(before()));
  });

  it('keeps the phase chain in order after the move', () => {
    const moved = after();
    const at = (id: string) => moved.blocks.filter((b) => b.taskId === id);
    const last = (id: string) => Math.max(...at(id).map((b) => b.end));
    const first = (id: string) => Math.min(...at(id).map((b) => b.start));

    expect(last('p15')).toBeLessThanOrEqual(first('p16'));
    expect(last('p16')).toBeLessThanOrEqual(first('p17'));
  });

  it('still protects the morning for demanding work after the move', () => {
    const moved = after();
    const study = moved.blocks.filter((b) => b.taskId === 'study');

    expect(study.length).toBeGreaterThan(0);
    for (const part of study) expect(part.zone).toBe('morning');
  });

  it('keeps a manually pinned block in place when the shift moves', () => {
    const pinnedStart = MONDAY + 7 * 3_600_000; // Monday 14:00 Rome
    const pinned = {
      taskId: 'call',
      title: 'Call cliente, spostata a mano',
      start: pinnedStart,
      end: pinnedStart + 3_600_000,
      kind: 'task' as const,
      zone: 'afternoon' as const,
      partIndex: 0,
      partCount: 1,
      zoneCompromised: false,
    };

    const replanned = schedule({
      now: MONDAY,
      horizonEnd: MONDAY + 7 * 86_400_000,
      timezone: TZ,
      settings,
      tasks: week(),
      dependencies: chain,
      busy: [morningShift],
      pinnedBlocks: [pinned],
    });

    const kept = replanned.blocks.find((b) => b.taskId === 'call')!;
    expect(kept.start).toBe(pinned.start);
    expect(kept.end).toBe(pinned.end);
  });
});
