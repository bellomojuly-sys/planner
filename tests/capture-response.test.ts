import { describe, expect, it } from 'vitest';
import {
  agendaAnchor,
  renderActionButtonCommitment,
  renderCaptureOutcome,
} from '../src/routes/capture';
import { spokenArea } from '../src/services/capture';

describe('voice capture response', () => {
  it('uses the day requested by the agenda question', () => {
    expect(agendaAnchor('2026-09-21')).toBe(
      Date.parse('2026-09-21T12:00:00Z'),
    );
  });

  it('speaks the inferred area with an Italian label', () => {
    expect(spokenArea('mg')).toBe('MG');
    expect(spokenArea('university')).toBe('università');
    expect(spokenArea('errand')).toBe('commissioni');
  });

  it('speaks the inferred area with an English label', () => {
    expect(spokenArea('university', 'en')).toBe('university');
    expect(spokenArea('errand', 'en')).toBe('errands');
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

  it('reports successful and failed English actions in English', () => {
    expect(
      renderCaptureOutcome({
        language: 'en',
        summary: 'I will add the task.',
        applied: ['Added "Call Mario"'],
        skipped: ['I could not find "Report".'],
      }),
    ).toBe('Added "Call Mario". Not applied: I could not find "Report".');

    expect(
      renderCaptureOutcome({
        language: 'en',
        summary: 'I will add the task.',
        applied: [],
        skipped: ['Unexpected error. Try again.'],
      }),
    ).toBe('I did not save the request: Unexpected error. Try again.');
  });

  it('returns one spoken question and an opaque session id to the Action Button', () => {
    const rendered = renderActionButtonCommitment({
      summary: 'Completo i dettagli.',
      clarifyingQuestion: 'Dove devi andare?',
      blockingVerificationRequired: true,
      proposals: [
        {
          title: 'Barbecue',
          notes: '',
          area: 'personal',
          energy: 'low',
          priority: 2,
          estimatedMinutes: 300,
          dueDate: '2026-09-29',
          fixedStartAt: '2026-09-29T18:00:00+02:00',
          location: null,
          travelMinutes: 0,
          preparationMinutes: 0,
          recoveryMinutes: 0,
          flexibility: 'fixed',
          dependsOn: [],
          evidence: '',
        },
      ],
      trace: { request: { requestId: '06cd59bd-3662-4cd4-8a05-cf6d2a421ffe' } },
    });

    expect(rendered).toEqual({
      state: 'needs_input',
      sessionId: '06cd59bd-3662-4cd4-8a05-cf6d2a421ffe',
      spoken: 'Dove devi andare?',
    });
  });

  it('reads the door-to-door preview before the Action Button can confirm', () => {
    const rendered = renderActionButtonCommitment({
      summary: 'Barbecue pronto.',
      clarifyingQuestion: null,
      blockingVerificationRequired: false,
      proposals: [
        {
          title: 'Barbecue',
          notes: '',
          area: 'personal',
          energy: 'low',
          priority: 2,
          estimatedMinutes: 300,
          dueDate: '2026-09-29',
          fixedStartAt: '2026-09-29T18:00:00+02:00',
          location: 'Downtown',
          travelMinutes: 20,
          preparationMinutes: 40,
          recoveryMinutes: 0,
          flexibility: 'fixed',
          dependsOn: [],
          evidence: '',
        },
      ],
      trace: { request: { requestId: '06cd59bd-3662-4cd4-8a05-cf6d2a421ffe' } },
    });

    expect(rendered.state).toBe('ready');
    expect(rendered.spoken).toContain('dalle 18:00 alle 23:00');
    expect(rendered.spoken).toContain('preparazione dalle 17:00');
    expect(rendered.spoken).toContain('partenza alle 17:40');
    expect(rendered.spoken).toContain('Vuoi inserirlo e pianificarlo?');
  });
});
