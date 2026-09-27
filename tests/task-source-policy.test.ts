import { describe, expect, it } from 'vitest';
import { isTaskSourceEnabled } from '../src/services/task-source-policy';

describe('task source policy', () => {
  const enabled = new Set(['university']);

  it('always keeps tasks created locally in Dani', () => {
    expect(isTaskSourceEnabled(null, enabled)).toBe(true);
  });

  it('keeps tasks from an enabled external source', () => {
    expect(isTaskSourceEnabled('university', enabled)).toBe(true);
  });

  it('hides tasks from a disabled external source without deleting them', () => {
    expect(isTaskSourceEnabled('legacy-notion', enabled)).toBe(false);
  });
});
