/**
 * Turns a requested weekly gym frequency into a coherent settings bundle: which
 * weekdays to prefer, the weekly cap, and a recovery gap short enough to make
 * the frequency feasible. Back-to-back days are only ~24h apart, so a high
 * frequency also has to lower `minRecoveryHours` or the scheduler would refuse
 * the extra sessions. Weekday numbers follow the app's convention (0 = Sunday
 * … 6 = Saturday), matching the `1,3,5` default (Mon/Wed/Fri).
 */
export interface GymCadence {
  sessionsPerWeek: number;
  maxSessionsPerWeek: number;
  preferredDays: string;
  minRecoveryHours: number;
}

const DAYS_BY_COUNT: Record<number, string> = {
  0: '',
  1: '3',
  2: '2,4',
  3: '1,3,5',
  4: '1,2,4,5',
  5: '1,2,3,4,5',
  6: '1,2,3,4,5,6',
  7: '0,1,2,3,4,5,6',
};

export function gymCadence(sessionsPerWeek: number): GymCadence {
  const n = Math.max(0, Math.min(7, Math.round(sessionsPerWeek)));
  // Three-or-fewer sessions fit every-other-day, so the 36h default holds; more
  // than that needs consecutive days, which requires under 24h of recovery.
  const minRecoveryHours = n >= 6 ? 18 : n >= 4 ? 20 : 36;
  return {
    sessionsPerWeek: n,
    maxSessionsPerWeek: n,
    preferredDays: DAYS_BY_COUNT[n]!,
    minRecoveryHours,
  };
}
