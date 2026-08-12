const LOCALE = 'it-IT';
const TZ = 'Europe/Rome';

export const time = (ts: number) =>
  new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TZ,
  }).format(ts);

export const dayShort = (ts: number) =>
  new Intl.DateTimeFormat(LOCALE, {
    weekday: 'short',
    day: 'numeric',
    timeZone: TZ,
  }).format(ts);

export const dayLong = (ts: number) =>
  new Intl.DateTimeFormat(LOCALE, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  }).format(ts);

export const range = (start: number, end: number) => `${time(start)}–${time(end)}`;

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
}

/** Local minutes since midnight — the y-axis of the day grid. */
export function minutesOfDay(ts: number): number {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).formatToParts(ts);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

export function startOfDay(ts: number): number {
  // Subtracting the local offset rather than using setHours keeps this correct
  // across the DST boundary, where a day is not 24 hours long.
  return ts - minutesOfDay(ts) * 60_000 - (new Date(ts).getSeconds() * 1000);
}

export function addDays(ts: number, days: number): number {
  return startOfDay(ts) + days * 86_400_000;
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export const AREA_LABELS: Record<string, string> = {
  general: 'Generale',
  mg: 'MG Integration',
  university: 'Università',
  heemia: 'Heemia',
  personal: 'Personale',
  health: 'Salute',
  errand: 'Commissioni',
};

export const ENERGY_LABELS: Record<string, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Bassa',
};
