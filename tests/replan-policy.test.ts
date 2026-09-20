import { describe, expect, it } from 'vitest';
import {
  confirmationReasons,
  CONFIRMATION_WINDOW_MS,
} from '../src/services/replan-policy';
import type { ScheduleResult } from '../src/scheduler/types';

const NOW = Date.parse('2026-09-14T08:00:00Z');
const TZ = 'Europe/Rome';

function result(start: number, unplaced: ScheduleResult['unplaced'] = []): ScheduleResult {
  return {
    blocks: [
      {
        taskId: 'task-1',
        title: 'Task',
        start,
        end: start + 30 * 60_000,
        kind: 'task',
        zone: 'morning',
        partIndex: 0,
        partCount: 1,
        zoneCompromised: false,
      },
    ],
    unplaced,
    decisions: [],
    briefing: [],
    fixedCommitments: 0,
    taskEnd: new Map(),
    warnings: [],
  };
}

describe('replan confirmation policy', () => {
  it.each([
    [59, true],
    [60, true],
    [61, false],
  ])('treats a new block starting in %i minutes as confirmation=%s', (minutes, expected) => {
    const reasons = confirmationReasons(
      [],
      result(NOW + minutes * 60_000),
      NOW,
      TZ,
    );

    expect(reasons.includes('near_term_change')).toBe(expected);
  });

  it('does not ask when a near-term block remains unchanged', () => {
    const start = NOW + CONFIRMATION_WINDOW_MS;
    const reasons = confirmationReasons(
      [
        {
          taskId: 'task-1',
          partIndex: 0,
          kind: 'task',
          startAt: start,
          endAt: start + 30 * 60_000,
        },
      ],
      result(start),
      NOW,
      TZ,
    );

    expect(reasons).toEqual([]);
  });

  it('requires confirmation for a permanent-task conflict', () => {
    const proposed = result(NOW + 2 * CONFIRMATION_WINDOW_MS, [
      {
        taskId: 'permanent',
        title: 'Task permanente',
        reason: 'pinned_conflict',
      },
    ]);

    expect(confirmationReasons([], proposed, NOW, TZ)).toContain(
      'permanent_task_conflict',
    );
  });
});
