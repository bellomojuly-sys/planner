import { describe, expect, it } from 'vitest';
import { renderCaptureOutcome } from '../src/routes/capture';
import { spokenArea } from '../src/services/capture';

describe('voice capture response', () => {
  it('speaks the inferred area with an Italian label', () => {
    expect(spokenArea('mg')).toBe('MG');
    expect(spokenArea('university')).toBe('università');
    expect(spokenArea('errand')).toBe('commissioni');
  });

  it('confirms only an action that was actually applied', () => {
    expect(
      renderCaptureOutcome({
        summary: 'Aggiungo il task.',
        applied: ['Aggiunta "Chiamare Mario" (15 min)'],
        skipped: [],
      }),
    ).toBe('Aggiunta "Chiamare Mario" (15 min)');
  });

  it('does not repeat an optimistic model summary when the write failed', () => {
    expect(
      renderCaptureOutcome({
        summary: 'Aggiungo il task.',
        applied: [],
        skipped: ['Errore imprevisto. Riprova.'],
      }),
    ).toBe('Non ho salvato la richiesta: Errore imprevisto. Riprova.');
  });

  it('reports both sides of a partially applied utterance', () => {
    expect(
      renderCaptureOutcome({
        summary: 'Completo il report e aggiungo la chiamata.',
        applied: ['Completata "Report"'],
        skipped: ['Non ho trovato "Chiamata".'],
      }),
    ).toBe('Completata "Report". Non applicato: Non ho trovato "Chiamata".');
  });

  it('uses the interpretation summary when no action was requested', () => {
    expect(
      renderCaptureOutcome({
        summary: 'Ti mostro il piano di oggi.',
        applied: [],
        skipped: [],
      }),
    ).toBe('Ti mostro il piano di oggi.');
  });
});
