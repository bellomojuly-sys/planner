import { describe, expect, it } from 'vitest';
import { renderVoiceAgenda, type DayAgenda } from '../src/jobs/daily';

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
});
