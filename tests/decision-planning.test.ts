import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/db/schema';
import {
  buildDecisionBriefing,
  buildPlanDecisions,
  executionClassFor,
  markMoved,
  planningClassFor,
} from '../src/scheduler/decisions';
import { schedule } from '../src/scheduler/engine';
import {
  applyBusyPersonalRules,
  applyTaskPersonalRules,
} from '../src/scheduler/personal-rules';
import type { SchedulableTask, UnplacedTask } from '../src/scheduler/types';
import { renderDecisionBriefing } from '../src/jobs/daily';

const NOW = Date.parse('2026-01-12T06:00:00Z');
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
  universityTravelMinutes: 15,
  universityPreparationMinutes: 60,
  universityShowerPreparationMinutes: 105,
  universityShowerDefault: false,
  restaurantTravelMinutes: 20,
  restaurantReturnMinutes: 20,
  gymSessionsPerWeek: 0,
  gymMaxSessionsPerWeek: 4,
  gymDurationMinutes: 75,
  gymPreferredDays: '1,3,5',
  gymAvoidDays: '',
  gymTravelMinutes: 25,
  gymPreparationMinutes: 20,
  gymReturnMinutes: 25,
  gymMinRecoveryHours: 36,
  briefingMinutes: 7 * 60,
  reviewMinutes: 20 * 60 + 30,
  reviewAfterShiftMinutes: 30,
  fixedEventKeywords: 'turno,lezione',
  planningHorizonDays: 14,
  autoRescheduleEnabled: true,
  pushEnabled: true,
  updatedAt: NOW,
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

function unplaced(
  taskId: string,
  reason: UnplacedTask['reason'] = 'no_free_time',
): UnplacedTask {
  return { taskId, title: taskId, reason };
}

describe('decide-first classification', () => {
  it('separates constraints, objectives and preferences deterministically', () => {
    expect(planningClassFor(task({ id: 'fixed', flexibility: 'fixed' }), NOW)).toBe(
      'constraint',
    );
    expect(planningClassFor(task({ id: 'urgent', priority: 1 }), NOW)).toBe(
      'objective',
    );
    expect(planningClassFor(task({ id: 'later', priority: 4, horizon: 2 }), NOW)).toBe(
      'preference',
    );
  });

  it('keeps physical work human and only recommends bounded AI work', () => {
    expect(executionClassFor(task({ id: 'airport', title: 'Accompagnare Mario in aeroporto' }))).toBe(
      'you_do',
    );
    expect(executionClassFor(task({ id: 'summary', title: 'Riassumere gli appunti' }))).toBe(
      'jarvis_does',
    );
    expect(executionClassFor(task({ id: 'analysis', title: 'Analisi competitor MG' }))).toBe(
      'hybrid',
    );
  });

  it('turns every overflow into an explicit decision', () => {
    const candidates = [
      task({ id: 'fixed', flexibility: 'fixed' }),
      task({ id: 'ai', title: 'Riassumere gli appunti' }),
      task({ id: 'human', title: 'Comprare il latte' }),
      task({ id: 'duplicate' }),
    ];
    const decisions = buildPlanDecisions({
      tasks: candidates,
      blocks: [],
      unplaced: [
        unplaced('fixed'),
        { ...unplaced('ai'), title: 'Riassumere gli appunti' },
        { ...unplaced('human'), title: 'Comprare il latte' },
        unplaced('duplicate', 'duplicate'),
      ],
      now: NOW,
    });

    expect(Object.fromEntries(decisions.map((d) => [d.taskId, d.outcome]))).toEqual({
      fixed: 'needs_decision',
      ai: 'delegation_candidate',
      human: 'postpone',
      duplicate: 'needs_decision',
    });
  });

  it('records a moved task distinctly from a kept task', () => {
    const decisions = buildPlanDecisions({
      tasks: [task({ id: 'moved' }), task({ id: 'kept' })],
      blocks: [
        {
          taskId: 'moved', title: 'moved', start: NOW, end: NOW + 60_000,
          kind: 'task', zone: 'morning', partIndex: 0, partCount: 1,
          zoneCompromised: false,
        },
        {
          taskId: 'kept', title: 'kept', start: NOW + 60_000, end: NOW + 120_000,
          kind: 'task', zone: 'morning', partIndex: 0, partCount: 1,
          zoneCompromised: false,
        },
      ],
      unplaced: [],
      now: NOW,
    });
    expect(markMoved(decisions, new Set(['moved'])).map((item) => item.outcome)).toEqual([
      'move',
      'keep',
    ]);
  });

  it('recommends shared MG analysis for delegation without executing or writing it', () => {
    const mg = task({ id: 'mg-analysis', title: 'Analisi competitor MG', area: 'mg' });
    const [decision] = buildPlanDecisions({
      tasks: [mg],
      blocks: [],
      unplaced: [{ ...unplaced(mg.id), title: mg.title }],
      now: NOW,
    });
    expect(decision).toMatchObject({
      executionClass: 'hybrid',
      outcome: 'delegation_candidate',
    });
  });
});

describe('Personal Rules and door-to-door reservations', () => {
  it('derives university preparation and travel from persisted settings', () => {
    const derived = applyTaskPersonalRules(
      task({ id: 'uni', area: 'university', travelMinutes: 0, preparationMinutes: 0 }),
      settings,
    );
    expect(derived.travelMinutes).toBe(15);
    expect(derived.preparationMinutes).toBe(60);
  });

  it('pads restaurant shifts asymmetrically from the stored rule', () => {
    expect(
      applyBusyPersonalRules(
        { start: 100, end: 200, title: 'Turno', isShift: true },
        settings,
      ),
    ).toMatchObject({ travelBeforeMinutes: 20, travelAfterMinutes: 20 });
  });

  it('publishes derived before/after buffers and anchors completion after return', () => {
    const airport = task({
      id: 'airport',
      title: 'Accompagnare Mario in aeroporto',
      area: 'personal',
      plannedMinutes: 30,
      travelMinutes: 20,
      preparationMinutes: 10,
      recoveryMinutes: 20,
      flexibility: 'fixed',
    });
    const result = schedule({
      now: NOW,
      horizonEnd: NOW + 86_400_000,
      timezone: 'Europe/Rome',
      settings,
      tasks: [airport],
      dependencies: new Map(),
      busy: [],
      pinnedBlocks: [],
    });
    const blocks = result.blocks.filter((block) => block.taskId === 'airport');
    expect(blocks.map((block) => block.kind)).toEqual(['buffer', 'task', 'buffer']);
    expect((blocks.at(-1)!.end - blocks[0]!.start) / 60_000).toBe(80);
    expect(result.taskEnd.get('airport')).toBe(blocks.at(-1)!.end);
    expect(result.decisions[0]).toMatchObject({
      planningClass: 'constraint',
      outcome: 'keep',
      reservedMinutes: 80,
    });
  });
});

describe('five-line decision briefing', () => {
  it('is structured, complete and accepted by the morning renderer', () => {
    const decisions = buildPlanDecisions({
      tasks: [task({ id: 'keep' }), task({ id: 'later' })],
      blocks: [
        {
          taskId: 'keep',
          title: 'keep',
          start: NOW,
          end: NOW + 60 * 60_000,
          kind: 'task',
          zone: 'morning',
          partIndex: 0,
          partCount: 1,
          zoneCompromised: false,
        },
      ],
      unplaced: [unplaced('later')],
      now: NOW,
    });
    const briefing = buildDecisionBriefing({ decisions, fixedCommitments: 2 });
    expect(briefing).toHaveLength(5);
    expect(briefing.join(' ')).toMatch(/Capacità.*Vincoli.*Piano.*Delega AI.*Decisioni per Giulia/);
    expect(renderDecisionBriefing({ briefing })).toBe(briefing.join('\n'));
    expect(renderDecisionBriefing({ briefing: [...briefing, 'extra'] })).toBeNull();
  });
});
