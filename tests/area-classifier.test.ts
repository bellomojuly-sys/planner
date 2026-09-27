import { describe, expect, it } from 'vitest';
import { inferArea } from '../src/services/area-classifier';

describe('inferArea', () => {
  it('routes Heemia work to the heemia area', () => {
    expect(inferArea('creazione piano editoriale Heemia')).toBe('heemia');
    expect(inferArea('post heemia settimana')).toBe('heemia');
  });

  it('routes MG / DMG work to the mg area', () => {
    expect(inferArea('preparare proposal per il cliente MG')).toBe('mg');
    expect(inferArea('onboarding DMG')).toBe('mg');
  });

  it('routes university work to the university area', () => {
    expect(inferArea('studiare per esame')).toBe('university');
    expect(inferArea('aggiornare il portfolio Berzi')).toBe('university');
    expect(inferArea('scadenza Fontys')).toBe('university');
  });

  it('routes career, health and errands', () => {
    expect(inferArea('aggiornare il CV su LinkedIn')).toBe('career');
    expect(inferArea('prenotare visita dal medico')).toBe('health');
    expect(inferArea('fare la spesa')).toBe('errand');
  });

  it('routes personal admin and bureaucracy', () => {
    expect(inferArea('rinnovo assicurazione auto')).toBe('personal');
  });

  it('returns null when nothing matches, leaving the default untouched', () => {
    expect(inferArea('chiamare Marco')).toBeNull();
    expect(inferArea('pensare')).toBeNull();
  });

  it('matches whole words only, so a marker inside another word does not fire', () => {
    // "posta" (errand) must not fire on "imposta"; "casa" is not a marker.
    expect(inferArea('imposta la sveglia')).toBeNull();
  });

  it('is accent and case insensitive', () => {
    expect(inferArea('LEZIONE di Università')).toBe('university');
  });
});
