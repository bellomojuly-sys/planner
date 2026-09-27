import { describe, expect, it } from 'vitest';
import { gymCadence } from '../src/services/gym-cadence';

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
