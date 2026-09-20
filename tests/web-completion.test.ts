import { describe, expect, it } from 'vitest';
import {
  withoutTaskBlocks,
  withTaskStatus,
} from '../web/src/lib/optimistic';

describe('optimistic task completion', () => {
  it('hides every split block of the completed task immediately', () => {
    const blocks = [
      { id: 'a1', taskId: 'a' },
      { id: 'a2', taskId: 'a' },
      { id: 'b1', taskId: 'b' },
      { id: 'fixed', taskId: null },
    ];

    expect(withoutTaskBlocks(blocks, 'a')).toEqual([
      { id: 'b1', taskId: 'b' },
      { id: 'fixed', taskId: null },
    ]);
  });

  it('updates only the selected task checkbox', () => {
    const tasks = [
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'todo' },
    ];

    expect(withTaskStatus(tasks, 'a', 'done')).toEqual([
      { id: 'a', status: 'done' },
      { id: 'b', status: 'todo' },
    ]);
  });
});
