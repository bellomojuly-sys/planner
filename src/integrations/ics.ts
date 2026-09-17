import { TZDate } from '@date-fns/tz';
import { assertOk, fetchWithTimeout } from '../lib/retry';
import { PlannerError } from '../lib/errors';
import type { GoogleEvent } from './google-calendar';

/**
 * Calendars Planner subscribes to directly, by URL.
 *
 * Google refuses to share a subscribed calendar with anyone — not even a
 * service account — so shifts (eitje) and university deadlines (Canvas) can
 * only be read from the feed itself. Reasoning in
 * `dl-how-planner-reads-subscribed-calendars`.
 *
 * The parser covers the subset those feeds actually use: no recurring events
 * (both publish each occurrence), so no RRULE expansion. A feed that does use
 * RRULE has its repeating events reported, not silently dropped.
 */

/** The feed URL is a bearer credential: holding it is reading the calendar. */
export function isLikelyIcsUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim().replace(/^webcal:/i, 'https:'));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/^webcal:/i, 'https:');
}

/**
 * Undoes RFC 5545 line folding: a continuation line starts with a space or a
 * tab and belongs to the line before it. Splitting on newlines alone cuts long
 * URLs and summaries in half.
 */
export function unfoldLines(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** `DTSTART;TZID=Europe/Amsterdam:20260804T170000` → name, params, value. */
export function parseProperty(line: string): IcsProperty | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name = '', ...rawParams] = head.split(';');

  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    // Feeds in the wild repeat a parameter (`;VALUE=DATE;VALUE=DATE`); the
    // last one wins, as it would in any reasonable reader.
    params[param.slice(0, eq).toUpperCase()] = param
      .slice(eq + 1)
      .replace(/^"(.*)"$/, '$1');
  }

  return { name: name.toUpperCase(), params, value };
}

/** A colon inside a quoted parameter value does not end the property name. */
function indexOfUnquoted(line: string, char: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === char && !quoted) return i;
  }
  return -1;
}

export function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

export interface IcsDate {
  at: number;
  allDay: boolean;
}

/**
 * Resolves the three shapes these feeds use: a UTC instant (`...Z`), a local
 * time with a named zone (`TZID=Europe/Amsterdam`), and a bare date
 * (`VALUE=DATE`), which is an all-day marker.
 *
 * A wall-clock time is resolved in its own zone, not in the Worker's UTC:
 * 17:00 in Amsterdam is 15:00Z in summer and 16:00Z in winter, and getting
 * this wrong shifts every shift by an hour half the year.
 */
export function parseIcsDate(prop: IcsProperty, fallbackZone: string): IcsDate | null {
  const raw = prop.value.trim();

  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (!match) return null;
    const [, y, m, d] = match;
    const zone = prop.params.TZID || fallbackZone;
    return {
      at: new TZDate(Number(y), Number(m) - 1, Number(d), 0, 0, 0, zone).getTime(),
      allDay: true,
    };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!match) return null;
  const [, y, m, d, hh, mm, ss, utc] = match;

  if (utc) {
    return {
      at: Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
      allDay: false,
    };
  }

  const zone = prop.params.TZID || fallbackZone;
  return {
    at: new TZDate(
      Number(y),
      Number(m) - 1,
      Number(d),
      Number(hh),
      Number(mm),
      Number(ss),
      zone,
    ).getTime(),
    allDay: false,
  };
}

export interface IcsParseResult {
  events: GoogleEvent[];
  /** Repeating events, which this parser does not expand. */
  skippedRecurring: number;
  /** Events dropped because they carry no usable start. */
  skippedUnparsable: number;
}

const DAY_MS = 86_400_000;

/**
 * Parses a whole feed. `defaultZone` is the planning timezone, used only for
 * values that name no zone of their own.
 */
export function parseIcs(text: string, defaultZone = 'Europe/Rome'): IcsParseResult {
  const lines = unfoldLines(text);
  const result: IcsParseResult = {
    events: [],
    skippedRecurring: 0,
    skippedUnparsable: 0,
  };

  let inEvent = false;
  // VTIMEZONE blocks carry their own DTSTART and RRULE; reading them as event
  // data invents events that do not exist.
  let depth = 0;
  let current: IcsProperty[] = [];

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && depth === 0) {
        inEvent = true;
        current = [];
      } else if (inEvent) {
        depth++;
      }
      continue;
    }

    if (prop.name === 'END') {
      if (prop.value.toUpperCase() === 'VEVENT' && depth === 0) {
        const event = buildEvent(current, defaultZone, result);
        if (event) result.events.push(event);
        inEvent = false;
        current = [];
      } else if (inEvent && depth > 0) {
        depth--;
      }
      continue;
    }

    if (inEvent && depth === 0) current.push(prop);
  }

  return result;
}

function buildEvent(
  props: IcsProperty[],
  defaultZone: string,
  result: IcsParseResult,
): GoogleEvent | null {
  const find = (name: string) => props.find((p) => p.name === name);

  if (find('RRULE')) {
    result.skippedRecurring++;
    return null;
  }

  const dtstart = find('DTSTART');
  if (!dtstart) {
    result.skippedUnparsable++;
    return null;
  }

  const start = parseIcsDate(dtstart, defaultZone);
  if (!start) {
    result.skippedUnparsable++;
    return null;
  }

  const dtend = find('DTEND');
  const end = dtend ? parseIcsDate(dtend, defaultZone) : null;
  const status = find('STATUS')?.value.toUpperCase();

  // A Canvas deadline arrives either as an all-day date or as an instant with
  // DTEND equal to DTSTART. Both mean "due at", not "busy until": they are
  // given a nominal length here and classified as soft by the caller.
  const endAt = end && end.at > start.at ? end.at : start.at + (start.allDay ? DAY_MS : 0);

  return {
    externalId: find('UID')?.value.trim() || `${dtstart.value}-${find('SUMMARY')?.value ?? ''}`,
    title: unescapeText(find('SUMMARY')?.value ?? '(senza titolo)'),
    location: find('LOCATION') ? unescapeText(find('LOCATION')!.value) : null,
    startAt: start.at,
    endAt,
    allDay: start.allDay,
    // Zero-length events cannot occupy the day, whatever the calendar's role.
    transparent: endAt <= start.at,
    cancelled: status === 'CANCELLED',
    etag: find('LAST-MODIFIED')?.value ?? find('DTSTAMP')?.value ?? null,
    isPlannerBlock: false,
    plannerBlockId: null,
  };
}

/**
 * Fetches and parses one feed. Errors keep the shape every other integration
 * uses, so the stale-data gate treats a dead feed like a dead Google sync.
 */
export async function fetchIcsEvents(
  url: string,
  defaultZone = 'Europe/Rome',
): Promise<IcsParseResult> {
  const res = await fetchWithTimeout(
    normalizeFeedUrl(url),
    {
      headers: {
        Accept: 'text/calendar, text/plain;q=0.8',
        // Canvas answers a Worker's header-less request with 401; a plain
        // client identification is enough for it to serve the feed.
        'User-Agent': 'Planner/1.0 (personal calendar client)',
      },
    },
    20_000,
  );
  await assertOk(res, 'ics.fetch');

  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new PlannerError('upstream_rejected', {
      message: 'ics.fetch: response is not a calendar',
      userMessage:
        'Questo indirizzo non restituisce un calendario. Controlla di aver copiato il link iCal.',
      retryable: false,
    });
  }

  return parseIcs(text, defaultZone);
}
