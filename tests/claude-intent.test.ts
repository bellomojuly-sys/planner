import { describe, expect, it } from 'vitest';
import { validateInterpretation } from '../src/integrations/claude';

describe('Claude intent contract', () => {
  it.each([
    ['non spostare questo task', true],
    ['puoi spostare di nuovo questo task', false],
  ])('accepts the permanent-task intent for “%s”', (_phrase, pinned) => {
    const parsed = validateInterpretation({
      summary: 'Aggiorno il vincolo.',
      intents: [
        {
          kind: 'set_task_pin',
          taskQuery: 'questo task',
          pinned,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a permanent-task intent without an explicit boolean', () => {
    const parsed = validateInterpretation({
      summary: 'Aggiorno il vincolo.',
      intents: [{ kind: 'set_task_pin', taskQuery: 'questo task' }],
    });

    expect(parsed.success).toBe(false);
  });
});
