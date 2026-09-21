import { describe, expect, it } from 'vitest';
import {
  englishAgendaTitle,
  formatEnglishSpokenTime,
  renderVoiceAgenda,
  type DayAgenda,
} from '../src/jobs/daily';
import {
  buildSystemPrompt,
  detectUtteranceLanguage,
  normalizeInterpretationLanguage,
  validateInterpretation,
} from '../src/integrations/llm';
import {
  isContextualCompletionReference,
  matchTaskTitle,
} from '../src/services/capture';

const TZ = 'Europe/Rome';
const NOW = Date.parse('2026-08-12T10:00:00Z'); // 12:00 in Rome

function agenda(overrides: Partial<DayAgenda> = {}): DayAgenda {
  return {
    dateKey: '2026-08-12',
    dayLabel: 'mercoledì 12 agosto',
    fixed: [],
    blocks: [],
    overdue: [],
    shoppingOpen: 0,
    ...overrides,
  };
}

describe('Siri daily agenda', () => {
  it('speaks only remaining actionable items in chronological order', () => {
    const result = renderVoiceAgenda(
      agenda({
        fixed: [
          {
            title: 'Turno al ristorante',
            start: Date.parse('2026-08-12T16:00:00Z'),
            end: Date.parse('2026-08-12T20:00:00Z'),
            allDay: false,
            kind: 'fixed',
            isShift: true,
          },
          {
            title: 'Promemoria viaggio',
            start: Date.parse('2026-08-12T00:00:00Z'),
            end: Date.parse('2026-08-13T00:00:00Z'),
            allDay: true,
            kind: 'soft',
            isShift: false,
          },
        ],
        blocks: [
          {
            title: 'Blocco già finito',
            start: Date.parse('2026-08-12T07:00:00Z'),
            end: Date.parse('2026-08-12T08:00:00Z'),
            kind: 'task',
            taskId: 'done',
          },
          {
            title: 'Preparare esame',
            start: Date.parse('2026-08-12T12:00:00Z'),
            end: Date.parse('2026-08-12T13:00:00Z'),
            kind: 'task',
            taskId: 'study',
          },
          {
            title: 'Pausa',
            start: Date.parse('2026-08-12T13:00:00Z'),
            end: Date.parse('2026-08-12T13:10:00Z'),
            kind: 'break',
            taskId: null,
          },
        ],
      }),
      TZ,
      NOW,
    );

    expect(result).toBe(
      'Oggi: alle 14:00, Preparare esame; alle 18:00, Turno al ristorante.',
    );
  });

  it('uses “adesso” for an item already in progress', () => {
    const result = renderVoiceAgenda(
      agenda({
        blocks: [
          {
            title: 'Scrivere il report',
            start: NOW - 10 * 60_000,
            end: NOW + 20 * 60_000,
            kind: 'task',
            taskId: 'report',
          },
        ],
      }),
      TZ,
      NOW,
    );

    expect(result).toBe('Oggi: adesso, Scrivere il report.');
  });

  it('stops after today when nothing remains', () => {
    expect(renderVoiceAgenda(agenda(), TZ, NOW)).toBe(
      'Per oggi non hai più nulla in programma.',
    );
  });

  it('speaks the complete requested future day instead of today', () => {
    const result = renderVoiceAgenda(
      agenda({
        dateKey: '2026-08-13',
        dayLabel: 'giovedì 13 agosto',
        blocks: [
          {
            title: 'Preparare il progetto',
            start: Date.parse('2026-08-13T07:00:00Z'),
            end: Date.parse('2026-08-13T08:00:00Z'),
            kind: 'task',
            taskId: 'project',
          },
        ],
      }),
      TZ,
      NOW,
    );

    expect(result).toBe(
      'Piano di giovedì 13 agosto: alle 09:00, Preparare il progetto.',
    );
  });

  it('speaks the requested future day in English', () => {
    const result = renderVoiceAgenda(
      agenda({
        dateKey: '2026-08-13',
        dayLabel: 'giovedì 13 agosto',
        blocks: [
          {
            title: 'Prepare the project',
            start: Date.parse('2026-08-13T07:00:00Z'),
            end: Date.parse('2026-08-13T08:00:00Z'),
            kind: 'task',
            taskId: 'project',
          },
        ],
      }),
      TZ,
      NOW,
      'en',
    );

    expect(result).toBe(
      'Plan for Thursday, August 13: nine in the morning, Prepare the project.',
    );
  });

  it('translates recurring Italian labels and uses English AM/PM times', () => {
    const result = renderVoiceAgenda(
      agenda({
        blocks: [
          {
            title: 'Iscriversi / iscrizione assicurazione',
            start: Date.parse('2026-08-12T19:30:00Z'),
            end: Date.parse('2026-08-12T20:00:00Z'),
            kind: 'task',
            taskId: 'insurance',
          },
        ],
      }),
      TZ,
      NOW,
      'en',
    );

    expect(result).toBe(
      'Today: nine thirty in the evening, Register for health insurance.',
    );
  });

  it('spells English times so iPhone does not read digits with Italian rules', () => {
    expect(formatEnglishSpokenTime(Date.parse('2026-08-12T04:05:00Z'), TZ)).toBe(
      'six oh five in the morning',
    );
    expect(formatEnglishSpokenTime(Date.parse('2026-08-12T11:15:00Z'), TZ)).toBe(
      'one fifteen in the afternoon',
    );
  });

  it('translates generated travel labels without changing proper names', () => {
    expect(englishAgendaTitle('Viaggio casa → università')).toBe(
      'Travel from home to university',
    );
    expect(englishAgendaTitle('Parlare con Olga')).toBe('Talk to Olga');
    expect(englishAgendaTitle('laovrare su betsy ')).toBe('Work on Betsy');
    expect(englishAgendaTitle('meeting idustry ')).toBe('Industry meeting');
    expect(englishAgendaTitle('analisi sito')).toBe('Website analysis');
    expect(englishAgendaTitle('Applied GenAI')).toBe('Applied GenAI');
  });

  it('uses an English empty-day response', () => {
    expect(renderVoiceAgenda(agenda(), TZ, NOW, 'en')).toBe(
      'You have nothing else scheduled today.',
    );
  });
});

describe('bilingual voice input: Italian, English and mixed give the same result', () => {
  const openTasks = [
    { id: 'mg', title: 'Report MG' },
    { id: 'health', title: "Registrarsi all'assicurazione sanitaria" },
    { id: 'exam', title: 'Preparare esame Applied GenAI' },
    { id: 'heemia', title: 'Sito Heemia: pagina prodotti' },
  ];

  it('resolves the same task from Italian, English and mixed wording', () => {
    for (const query of ['il report MG', 'the report for MG', 'il report for MG', 'the MG report']) {
      expect(matchTaskTitle(openTasks, query)?.id, query).toBe('mg');
    }
    for (const query of ["l'esame di Applied GenAI", 'the Applied GenAI exam prep', 'prep esame Applied GenAI']) {
      expect(matchTaskTitle(openTasks, query)?.id, query).toBe('exam');
    }
  });

  it('matches the exact Italian title the model copies for an English sentence', () => {
    // "I finished the health insurance registration" shares no word with the
    // Italian title; the prompt makes the model copy the title from the list.
    expect(matchTaskTitle(openTasks, 'health insurance registration')).toBeNull();
    expect(matchTaskTitle(openTasks, "Registrarsi all'assicurazione sanitaria")?.id).toBe('health');
  });

  it('pins the cross-language rules in the interpretation prompt', () => {
    const prompt = buildSystemPrompt({
      todayIso: '2026-09-21',
      weekdayName: 'lunedì 21 settembre',
      openTasks: openTasks.map(({ title }) => ({ title })),
      shoppingItems: [],
    });
    expect(prompt).toContain('copia il titolo ESATTO');
    expect(prompt).toContain('qualunque lingua abbia usato');
    expect(prompt).toContain('un misto dei due');
    expect(prompt).toContain('mai altri valori');
  });

  it('understands “this action” in all three forms', () => {
    for (const phrase of ["quest'azione", 'this task', 'questa task', 'this activity']) {
      expect(isContextualCompletionReference(phrase), phrase).toBe(true);
    }
    expect(isContextualCompletionReference('Report MG')).toBe(false);
  });

  it('answers a mixed sentence in the language of most of its grammar', () => {
    expect(detectUtteranceLanguage('ho finito il report e cosa devo fare oggi?')).toBe('it');
    expect(detectUtteranceLanguage('I finished the report, what do I have to do today?')).toBe('en');
    expect(detectUtteranceLanguage('ho finito il report for MG, cosa devo fare today?')).toBe('it');
    expect(detectUtteranceLanguage("I finished il report MG, what's my plan for today?")).toBe('en');
  });

  it('accepts the language labels models actually return instead of failing', () => {
    const intents = [
      { kind: 'complete_task', taskQuery: 'Report MG' },
      { kind: 'question', question: 'What do I have to do today?', date: '2026-09-21' },
    ];
    const cases: Array<[string, string, 'it' | 'en']> = [
      ['it', 'ho finito il report MG, cosa devo fare oggi?', 'it'],
      ['en-US', 'I finished the MG report, what do I have to do today?', 'en'],
      ['English', 'I finished the MG report, what do I have to do today?', 'en'],
      ['mixed', 'ho finito il report for MG, cosa devo fare today?', 'it'],
    ];

    for (const [label, utterance, expected] of cases) {
      const parsed = validateInterpretation(
        normalizeInterpretationLanguage({ language: label, summary: 'ok', intents }, utterance),
      );
      expect(parsed.success, label).toBe(true);
      expect(parsed.success && parsed.data.language).toBe(expected);
      expect(parsed.success && parsed.data.intents).toEqual(intents);
    }
  });
});
