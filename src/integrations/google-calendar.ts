import { assertOk, fetchWithTimeout, withRetry } from '../lib/retry';
import { PlannerError } from '../lib/errors';
import type { Env } from '../env';

/**
 * Google Calendar over raw REST. The `googleapis` package is far too heavy for
 * a Worker, and the four endpoints we need are stable.
 *
 * Auth is a long-lived refresh token exchanged for short-lived access tokens.
 * Nothing Google-related ever reaches the browser.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Access tokens live an hour; caching them in KV avoids a token exchange on
 * every cron tick and keeps us well inside Google's quota.
 */
async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.CACHE.get<CachedToken>('google:access_token', 'json');
  // 60s safety margin so a token cannot expire mid-request.
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new PlannerError('config_missing', {
      message: 'google oauth secrets missing',
      userMessage:
        'Google Calendar non è collegato. Esegui "node scripts/google-auth.mjs" per ottenere il refresh token.',
    });
  }

  const token = await withRetry(
    async () => {
      const res = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
          refresh_token: env.GOOGLE_REFRESH_TOKEN!,
          grant_type: 'refresh_token',
        }),
      });
      await assertOk(res, 'google.token');
      return (await res.json()) as { access_token: string; expires_in: number };
    },
    { label: 'google.token', attempts: 3 },
  );

  await env.CACHE.put(
    'google:access_token',
    JSON.stringify({
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    }),
    { expirationTtl: Math.max(60, token.expires_in - 120) },
  );

  return token.access_token;
}

async function calFetch<T>(
  env: Env,
  path: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  return withRetry(
    async () => {
      const accessToken = await getAccessToken(env);
      const res = await fetchWithTimeout(
        `${CAL_API}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
          },
        },
        20_000,
      );

      // A 410 means the sync token expired; the caller must re-sync in full.
      if (res.status === 410) {
        throw new PlannerError('conflict', {
          message: 'sync token expired',
          userMessage: 'Sincronizzazione calendario riavviata.',
          retryable: false,
          detail: { syncTokenExpired: true },
        });
      }

      await assertOk(res, label);
      return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    },
    { label, attempts: 4 },
  );
}

export function isSyncTokenExpired(err: unknown): boolean {
  return (
    err instanceof PlannerError &&
    (err.detail as { syncTokenExpired?: boolean } | undefined)?.syncTokenExpired ===
      true
  );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface GoogleEvent {
  externalId: string;
  title: string;
  location: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  cancelled: boolean;
  etag: string | null;
  /** Set by us on blocks we created, so we never treat our own output as busy. */
  isPlannerBlock: boolean;
  plannerBlockId: string | null;
}

export async function listCalendars(
  env: Env,
): Promise<Array<{ id: string; summary: string; primary: boolean }>> {
  const res = await calFetch<any>(
    env,
    '/users/me/calendarList',
    { method: 'GET' },
    'google.listCalendars',
  );
  return (res.items ?? []).map((c: any) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary === true,
  }));
}

export interface SyncResult {
  events: GoogleEvent[];
  nextSyncToken: string | null;
}

/**
 * Incremental where possible: with a sync token Google returns only what
 * changed, which is what makes "reschedule when a shift moves" cheap enough to
 * check every five minutes.
 */
export async function syncEvents(
  env: Env,
  calendarId: string,
  options: { syncToken?: string | null; timeMin?: number; timeMax?: number },
): Promise<SyncResult> {
  const events: GoogleEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      maxResults: '250',
      showDeleted: 'true',
    });

    if (options.syncToken) {
      params.set('syncToken', options.syncToken);
    } else {
      // A full sync must bound the window, or a decade of history comes back.
      if (options.timeMin) params.set('timeMin', new Date(options.timeMin).toISOString());
      if (options.timeMax) params.set('timeMax', new Date(options.timeMax).toISOString());
      params.set('orderBy', 'startTime');
    }
    if (pageToken) params.set('pageToken', pageToken);

    const res = await calFetch<any>(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { method: 'GET' },
      'google.syncEvents',
    );

    for (const item of res.items ?? []) {
      const mapped = mapEvent(item);
      if (mapped) events.push(mapped);
    }

    pageToken = res.nextPageToken;
    if (res.nextSyncToken) nextSyncToken = res.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken };
}

function mapEvent(item: any): GoogleEvent | null {
  const cancelled = item.status === 'cancelled';

  // Cancelled events arrive with almost no fields; keep the id so the caller
  // can delete the local row.
  if (cancelled) {
    return {
      externalId: item.id,
      title: item.summary ?? '',
      location: null,
      startAt: 0,
      endAt: 0,
      allDay: false,
      cancelled: true,
      etag: item.etag ?? null,
      isPlannerBlock: false,
      plannerBlockId: null,
    };
  }

  const allDay = Boolean(item.start?.date);
  const startAt = allDay
    ? Date.parse(`${item.start.date}T00:00:00Z`)
    : Date.parse(item.start?.dateTime ?? '');
  const endAt = allDay
    ? Date.parse(`${item.end.date}T00:00:00Z`)
    : Date.parse(item.end?.dateTime ?? '');

  if (Number.isNaN(startAt) || Number.isNaN(endAt)) return null;

  const plannerBlockId = item.extendedProperties?.private?.plannerBlockId ?? null;

  return {
    externalId: item.id,
    title: item.summary ?? '(senza titolo)',
    location: item.location ?? null,
    startAt,
    endAt,
    allDay,
    cancelled: false,
    etag: item.etag ?? null,
    isPlannerBlock: Boolean(plannerBlockId),
    plannerBlockId,
  };
}

// ---------------------------------------------------------------------------
// Writing planner blocks
// ---------------------------------------------------------------------------

export interface PlannerBlockEvent {
  blockId: string;
  title: string;
  startAt: number;
  endAt: number;
  description?: string;
  colorId?: string;
}

/**
 * Every block we write is tagged with `plannerBlockId` in private extended
 * properties. That tag is how the next sync recognises our own events and
 * excludes them from the busy mask — without it, the scheduler would treat
 * yesterday's plan as immovable commitments.
 */
export async function upsertPlannerEvent(
  env: Env,
  calendarId: string,
  block: PlannerBlockEvent,
  existingEventId: string | null,
  timezone: string,
): Promise<string> {
  const body = {
    summary: block.title,
    description: block.description ?? 'Pianificato automaticamente da Planner.',
    start: { dateTime: new Date(block.startAt).toISOString(), timeZone: timezone },
    end: { dateTime: new Date(block.endAt).toISOString(), timeZone: timezone },
    colorId: block.colorId ?? '7',
    extendedProperties: { private: { plannerBlockId: block.blockId } },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
  };

  if (existingEventId) {
    try {
      const updated = await calFetch<any>(
        env,
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existingEventId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
        'google.updateEvent',
      );
      return updated.id;
    } catch (err) {
      // Deleted in Google but still referenced locally: fall through and
      // recreate rather than failing the whole sync.
      if (!(err instanceof PlannerError) || err.code !== 'not_found') throw err;
    }
  }

  const created = await calFetch<any>(
    env,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', body: JSON.stringify(body) },
    'google.createEvent',
  );
  return created.id;
}

export async function deletePlannerEvent(
  env: Env,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await calFetch<void>(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE' },
      'google.deleteEvent',
    );
  } catch (err) {
    // Already gone is the desired end state.
    if (err instanceof PlannerError && err.code === 'not_found') return;
    throw err;
  }
}
