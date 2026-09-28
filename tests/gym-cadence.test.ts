import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MORNING_GYM_MINUTES,
  gymCadence,
  gymStartMinutesFromText,
} from '../src/services/gym-cadence';

describe('gymCadence', () => {
  it('keeps the 36h recovery for an every-other-day cadence', () => {
    expect(gymCadence(3)).toEqual({
      sessionsPerWeek: 3,
      maxSessionsPerWeek: 3,
      preferredDays: '1,3,5',
      minRecoveryHours: 36,
    });
  });

  it('spreads five sessions across the working week and shortens recovery', () => {
    const plan = gymCadence(5);
    expect(plan.sessionsPerWeek).toBe(5);
    expect(plan.maxSessionsPerWeek).toBe(5);
    expect(plan.preferredDays).toBe('1,2,3,4,5');
    expect(plan.minRecoveryHours).toBeLessThan(24);
  });

  it('allows every day, including the weekend, when asked for seven', () => {
    const plan = gymCadence(7);
    expect(plan.preferredDays).toBe('0,1,2,3,4,5,6');
    expect(plan.minRecoveryHours).toBeLessThan(24);
  });

  it('turns gym off at zero', () => {
    expect(gymCadence(0)).toEqual({
      sessionsPerWeek: 0,
      maxSessionsPerWeek: 0,
      preferredDays: '',
      minRecoveryHours: 36,
    });
  });

  it('clamps out-of-range requests into 0..7', () => {
    expect(gymCadence(99).sessionsPerWeek).toBe(7);
    expect(gymCadence(-3).sessionsPerWeek).toBe(0);
  });
});

describe('gymStartMinutesFromText', () => {
  it('pins "alla mattina" to the 07:00 default', () => {
    expect(gymStartMinutesFromText('palestra 5 volte a settimana alla mattina')).toBe(
      DEFAULT_MORNING_GYM_MINUTES,
    );
    expect(gymStartMinutesFromText('vai in palestra tutti i giorni la mattina')).toBe(420);
  });

  it('reads an explicit clock time, numeric or worded', () => {
    expect(gymStartMinutesFromText('palestra tutti i giorni alle 7')).toBe(7 * 60);
    expect(gymStartMinutesFromText('palestra alle 6:30 ogni giorno')).toBe(6 * 60 + 30);
    expect(gymStartMinutesFromText('metti la palestra alle sette del mattino')).toBe(7 * 60);
    expect(gymStartMinutesFromText('gym every day at 8')).toBe(8 * 60);
  });

  it('restores the flexible evening for "la sera"', () => {
    expect(gymStartMinutesFromText('palestra 3 volte a settimana la sera')).toBe(0);
    expect(gymStartMinutesFromText('gym in the evening')).toBe(0);
  });

  it('never mistakes the weekly frequency for a time', () => {
    expect(gymStartMinutesFromText('palestra 5 volte a settimana')).toBeNull();
    expect(gymStartMinutesFromText('palestra 3 volte a settimana')).toBeNull();
    expect(gymStartMinutesFromText('vai in palestra tutti i giorni')).toBeNull();
  });
});
