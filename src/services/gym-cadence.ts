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

/** Default morning workout start when Giulia says "la mattina" without a time. */
export const DEFAULT_MORNING_GYM_MINUTES = 7 * 60;

const ITALIAN_HOUR_WORDS: Record<string, number> = {
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
};

/**
 * Reads an optional time-of-day preference for the gym out of a spoken command,
 * as minutes from local midnight. This feeds `gymStartMinutes`, where a positive
 * value pins the workout to that morning time and 0 restores the flexible evening
 * placement.
 *
 * - An explicit clock ("alle 7", "alle 6:30", "alle sette", "at 7") → that time.
 * - "la mattina" / "in the morning" with no time → the 07:00 default.
 * - "la sera" / "il pomeriggio" / "in the evening" → 0 (flexible evening).
 * - Nothing about when → `null`, so the stored preference is left untouched.
 *
 * A frequency like "5 volte a settimana" is not a time: the clock patterns all
 * require a preposition ("alle", "ore", "at") before the number, so the "5" is
 * never mistaken for 05:00.
 */
export function gymStartMinutesFromText(text: string): number | null {
  const t = text.toLowerCase();

  const numeric = t.match(
    /\b(?:alle(?:\s+ore)?|ore|verso\s+le|per\s+le|at)\s+(\d{1,2})(?:[:.](\d{2}))?/,
  );
  if (numeric) {
    const hour = Number(numeric[1]);
    const minute = Number(numeric[2] ?? 0);
    if (hour >= 0 && hour <= 23 && minute < 60) return hour * 60 + minute;
  }

  const words = Object.keys(ITALIAN_HOUR_WORDS).join('|');
  const worded = t.match(new RegExp(`\\b(?:alle|ore)\\s+(${words})\\b`));
  if (worded) return ITALIAN_HOUR_WORDS[worded[1]!]! * 60;

  if (/\b(mattina|mattino|mattutina|morning)\b/.test(t)) {
    return DEFAULT_MORNING_GYM_MINUTES;
  }
  if (/\b(sera|serale|serali|pomeriggio|evening|afternoon)\b/.test(t)) {
    return 0;
  }
  return null;
}
