import { TZDate } from '@date-fns/tz';

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
  const local = new TZDate(ts, TZ);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
}

export function addDays(ts: number, days: number): number {
  const local = new TZDate(startOfDay(ts), TZ);
  local.setDate(local.getDate() + days);
  return local.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function overlapsDay(start: number, end: number, day: number): boolean {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  return start < to && end > from;
}

export const AREA_LABELS: Record<string, string> = {
  general: 'Generale',
  mg: 'MG Integration',
  university: 'Università',
  heemia: 'Heemia',
  career: 'Carriera / ICT',
  personal: 'Personale',
  health: 'Salute',
  errand: 'Commissioni',
};

export const ENERGY_LABELS: Record<string, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Bassa',
};

/** "HH:MM" in Rome time, for `<input type="time">`. */
export function timeInputValue(ts: number): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TZ,
  }).format(ts);
}

/** "YYYY-MM-DD" in Rome time, for `<input type="date">`. */
export function dateInputValue(ts: number): string {
  const local = new TZDate(ts, TZ);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${month}-${day}`;
}

/** The instant for a Rome-local date and "HH:MM", DST-safe. */
export function fromDateAndTime(date: string, hhmm: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const local = new TZDate(year!, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0, 0, TZ);
  return local.getTime();
}
