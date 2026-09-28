import { describe, expect, it } from 'vitest';
import { validateInterpretation } from '../src/integrations/llm';

describe('Voice intent contract', () => {
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

  it('keeps the requested day on an agenda question', () => {
    const parsed = validateInterpretation({
      summary: 'Ti mostro il piano di lunedì.',
      intents: [
        {
          kind: 'question',
          question: 'Cosa devo fare lunedì?',
          date: '2026-09-21',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.intents[0]).toMatchObject({ date: '2026-09-21' });
    }
  });

  it('rejects an agenda question that lost its requested day', () => {
    const parsed = validateInterpretation({
      summary: 'Ti mostro il piano.',
      intents: [{ kind: 'question', question: 'Cosa devo fare lunedì?' }],
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts an English agenda question and preserves its language', () => {
    const parsed = validateInterpretation({
      language: 'en',
      summary: "I’ll show you Monday’s plan.",
      intents: [
        {
          kind: 'question',
          question: 'What do I have to do on Monday?',
          date: '2026-09-21',
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.language).toBe('en');
      expect(parsed.data.intents[0]).toMatchObject({ date: '2026-09-21' });
    }
  });

  it('preserves an exact commitment start instead of reducing it to a due date', () => {
    const parsed = validateInterpretation({
      language: 'it',
      summary: 'Registro il barbecue come impegno fisso.',
      intents: [
        {
          kind: 'create_task',
          title: 'Barbecue',
          fixedStartAt: '2026-09-28T18:00:00+02:00',
          dueAt: '2026-09-28',
          flexibility: 'fixed',
          area: 'personal',
          estimatedMinutes: 180,
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.intents[0]).toMatchObject({
        fixedStartAt: '2026-09-28T18:00:00+02:00',
        flexibility: 'fixed',
      });
    }
  });

  it('rejects an exact commitment start without a timezone offset', () => {
    const parsed = validateInterpretation({
      language: 'it',
      summary: 'Registro il barbecue.',
      intents: [
        {
          kind: 'create_task',
          title: 'Barbecue',
          fixedStartAt: '2026-09-28T18:00:00',
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});
