import { describe, expect, it } from 'vitest';
import {
  isContextualCompletionReference,
  selectSingleActiveTaskId,
} from '../src/services/capture';

const NOW = Date.parse('2026-09-21T10:00:00Z');

describe('contextual voice completion', () => {
  it('recognises narrow Italian and English references', () => {
    expect(isContextualCompletionReference("quest'azione")).toBe(true);
    expect(isContextualCompletionReference('questa attività')).toBe(true);
    expect(isContextualCompletionReference('quello che sto facendo')).toBe(true);
    expect(isContextualCompletionReference('this task')).toBe(true);
    expect(isContextualCompletionReference('report MG')).toBe(false);
  });

  it('selects the single task block active now', () => {
    expect(
      selectSingleActiveTaskId(
        [
          { taskId: 'past', kind: 'task', startAt: NOW - 120_000, endAt: NOW },
          { taskId: 'current', kind: 'task', startAt: NOW - 60_000, endAt: NOW + 60_000 },
          { taskId: 'current', kind: 'buffer', startAt: NOW - 60_000, endAt: NOW + 60_000 },
          { taskId: 'future', kind: 'task', startAt: NOW + 60_000, endAt: NOW + 120_000 },
        ],
        NOW,
      ),
    ).toBe('current');
  });

  it('refuses to guess when no task or several tasks are active', () => {
    expect(selectSingleActiveTaskId([], NOW)).toBeNull();
    expect(
      selectSingleActiveTaskId(
        [
          { taskId: 'a', kind: 'task', startAt: NOW - 60_000, endAt: NOW + 60_000 },
          { taskId: 'b', kind: 'task', startAt: NOW - 60_000, endAt: NOW + 60_000 },
        ],
        NOW,
      ),
    ).toBeNull();
  });
});
