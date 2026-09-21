import { assertOk, fetchWithTimeout, withRetry } from '../lib/retry';
import { PlannerError } from '../lib/errors';
import type { Env } from '../env';

/**
 * Google Calendar over raw REST. The `googleapis` package is far too heavy for
 * a Worker, and the four endpoints we need are stable.
 *
 * Auth is either a service-account key (preferred: it never expires, and the
 * calendars are shared with the account's address) or the older OAuth refresh
 * token. Both end in a short-lived access token, cached in KV.
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
/**
 * Secrets pasted by hand or piped through `echo` can carry a trailing newline,
 * spaces or the quotes around them, and Google then reports a perfectly good
 * client as "not found".
 */
export function cleanSecret(value: string | undefined): string {
  return (value ?? '').trim().replace(/^(["'])(.*)\1$/s, '$2').trim();
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/** Parses the downloaded key file, or explains what is wrong with it. */
export function parseServiceAccount(raw: string | undefined): ServiceAccountKey | null {
  const text = cleanSecret(raw);
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlannerError('config_missing', {
      message: 'service account key is not valid json',
      userMessage:
        'La chiave del service account non è un file JSON valido. Ricaricala come è stata scaricata da Google.',
      retryable: false,
    });
  }

  const key = parsed as Partial<ServiceAccountKey>;
  if (!key.client_email || !key.private_key) {
    throw new PlannerError('config_missing', {
      message: 'service account key missing client_email or private_key',
      userMessage:
        'Alla chiave del service account mancano client_email o private_key.',
      retryable: false,
    });
  }
  // A key pasted through a shell or an env file arrives with literal \n.
  return {
    client_email: key.client_email,
    private_key: key.private_key.replace(/\\n/g, '\n'),
  };
}

function base64url(bytes: ArrayBuffer | string): string {
  const raw =
    typeof bytes === 'string'
      ? bytes
      : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Claims for the JWT a service account exchanges for an access token. */
export function serviceAccountClaims(
  clientEmail: string,
  nowMs: number,
): Record<string, string | number> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: clientEmail,
    scope: GOOGLE_SCOPES.join(' '),
    aud: TOKEN_URL,
    iat,
    // Google rejects anything longer than an hour.
    exp: iat + 3600,
  };
}

/** PEM (`-----BEGIN PRIVATE KEY-----`) to the DER bytes WebCrypto imports. */
export function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

async function signedJwt(key: ServiceAccountKey): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const payload = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify(serviceAccountClaims(key.client_email, Date.now())),
  )}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(payload),
  );

  return `${payload}.${base64url(signature)}`;
}

async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.CACHE.get<CachedToken>('google:access_token', 'json');
  // 60s safety margin so a token cannot expire mid-request.
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const serviceAccount = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (serviceAccount) return exchangeJwt(env, serviceAccount);

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
          client_id: cleanSecret(env.GOOGLE_CLIENT_ID),
          client_secret: cleanSecret(env.GOOGLE_CLIENT_SECRET),
          refresh_token: cleanSecret(env.GOOGLE_REFRESH_TOKEN),
          grant_type: 'refresh_token',
        }),
      });
      await assertOk(res, 'google.token');
      return (await res.json()) as { access_token: string; expires_in: number };
    },
    { label: 'google.token', attempts: 3 },
  );

  await cacheAccessToken(env, token);

  return token.access_token;
}

/**
 * Service-account flow: a JWT we sign ourselves becomes an access token. No
 * consent screen and nothing to renew — Google grants exactly the calendars
 * shared with the account's address.
 */
async function exchangeJwt(env: Env, key: ServiceAccountKey): Promise<string> {
  const assertion = await signedJwt(key);

  const token = await withRetry(
    async () => {
      const res = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
      await assertOk(res, 'google.token');
      return (await res.json()) as { access_token: string; expires_in: number };
    },
    { label: 'google.token', attempts: 3 },
  );

  await cacheAccessToken(env, token);
  return token.access_token;
}

async function cacheAccessToken(
  env: Env,
  token: { access_token: string; expires_in: number },
): Promise<void> {
  await env.CACHE.put(
    'google:access_token',
    JSON.stringify({
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    }),
    { expirationTtl: Math.max(60, token.expires_in - 120) },
  );
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
  /** Google `transparency=transparent`: visible, but explicitly not busy. */
  transparent: boolean;
  cancelled: boolean;
  etag: string | null;
  /** Set by us on blocks we created, so we never treat our own output as busy. */
  isPlannerBlock: boolean;
  plannerBlockId: string | null;
}

export interface GoogleCalendar {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
  color: string;
}

/**
 * Adds a calendar to the authenticated account's list.
 *
 * Sharing a calendar with a service account grants access but does not put it
 * in that account's list, so discovery alone returns nothing. Registering the
 * id once is what makes it visible — see
 * `dl-how-planner-authenticates-to-google`, open question 1.
 */
export async function subscribeToCalendar(
  env: Env,
  calendarId: string,
): Promise<GoogleCalendar> {
  let entry: any;
  try {
    entry = await calFetch<any>(
      env,
      '/users/me/calendarList',
      { method: 'POST', body: JSON.stringify({ id: calendarId }) },
      'google.subscribeToCalendar',
    );
  } catch (err) {
    // Google answers 403/404 both for "not shared with this account" and for
    // a mistyped id. Either way the credentials are fine, so the message must
    // not say they expired.
    if (
      err instanceof PlannerError &&
      (err.code === 'config_missing' || err.code === 'not_found')
    ) {
      const account = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON)?.client_email;
      throw new PlannerError('bad_request', {
        message: `calendar ${calendarId} not reachable: ${err.message}`,
        userMessage: account
          ? `Planner non vede questo calendario. Controlla l'ID e condividilo con ${account}.`
          : "Planner non vede questo calendario. Controlla l'ID e la condivisione.",
        retryable: false,
      });
    }
    throw err;
  }

  return {
    id: entry.id ?? calendarId,
    summary: entry.summary ?? calendarId,
    primary: entry.primary === true,
    accessRole: entry.accessRole ?? 'reader',
    color: entry.backgroundColor ?? '#9aa3b8',
  };
}

export async function listCalendars(env: Env): Promise<GoogleCalendar[]> {
  const calendars: GoogleCalendar[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ maxResults: '250', showHidden: 'true' });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await calFetch<any>(
      env,
      `/users/me/calendarList?${params}`,
      { method: 'GET' },
      'google.listCalendars',
    );

    for (const calendar of res.items ?? []) {
      calendars.push({
        id: calendar.id,
        summary: calendar.summary ?? '(senza nome)',
        primary: calendar.primary === true,
        accessRole: calendar.accessRole ?? 'reader',
        color: calendar.backgroundColor ?? '#9aa3b8',
      });
    }

    pageToken = res.nextPageToken;
  } while (pageToken);

  return calendars;
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
      transparent: false,
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
    transparent: item.transparency === 'transparent',
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
    // Re-confirms an event with this id that was deleted earlier.
    status: 'confirmed',
  };

  // The event id is derived from the block id, so writing the same block
  // twice can only ever update one event. Before this, two drains running at
  // once each created their own event and left orphans in the calendar.
  const stableId = plannerEventId(block.blockId);

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

  try {
    const created = await calFetch<any>(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      { method: 'POST', body: JSON.stringify({ ...body, id: stableId }) },
      'google.createEvent',
    );
    return created.id;
  } catch (err) {
    // 409: this block's event already exists — written by a concurrent drain,
    // or deleted and now being restored. Update it instead of duplicating.
    if (!(err instanceof PlannerError) || !err.message.includes(': 409')) throw err;
    const updated = await calFetch<any>(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events/${stableId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      'google.updateEvent',
    );
    return updated.id;
  }
}

/**
 * Google accepts client-chosen event ids made of base32hex characters
 * (0-9, a-v), 5 to 1024 long. A block id is a UUID, whose hex digits are a
 * subset of that alphabet once the dashes are dropped.
 */
export function plannerEventId(blockId: string): string {
  return `pl${blockId.toLowerCase().replace(/[^0-9a-v]/g, '')}`;
}

/**
 * Every event Planner wrote in a calendar, within a window, with the block it
 * claims to represent. Events without the tag — anything Giulia created by
 * hand — are never returned, so they can never be cleaned up by mistake.
 */
export async function listPlannerEvents(
  env: Env,
  calendarId: string,
  timeMin: number,
  timeMax: number,
): Promise<Array<{ eventId: string; plannerBlockId: string }>> {
  const out: Array<{ eventId: string; plannerBlockId: string }> = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: 'true',
      maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await calFetch<any>(
      env,
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { method: 'GET' },
      'google.listPlannerEvents',
    );

    for (const item of res.items ?? []) {
      const plannerBlockId = item.extendedProperties?.private?.plannerBlockId;
      if (plannerBlockId && item.status !== 'cancelled') {
        out.push({ eventId: item.id, plannerBlockId });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);

  return out;
}

// ---------------------------------------------------------------------------
// Editing events Giulia owns
// ---------------------------------------------------------------------------

export interface CalendarEventPatch {
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
}

/**
 * Edits an event that is not ours (a lesson, a shift, anything created by
 * hand). Only the three fields the planner UI exposes are sent, so location,
 * attendees and reminders set in Google survive the edit.
 */
export async function updateCalendarEvent(
  env: Env,
  calendarId: string,
  eventId: string,
  patch: CalendarEventPatch,
  timezone: string,
): Promise<{ etag: string | null }> {
  const body = patch.allDay
    ? {
        summary: patch.title,
        start: { date: new Date(patch.startAt).toISOString().slice(0, 10) },
        end: { date: new Date(patch.endAt).toISOString().slice(0, 10) },
      }
    : {
        summary: patch.title,
        start: { dateTime: new Date(patch.startAt).toISOString(), timeZone: timezone },
        end: { dateTime: new Date(patch.endAt).toISOString(), timeZone: timezone },
      };

  const updated = await calFetch<any>(
    env,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    'google.updateEvent',
  );
  return { etag: updated?.etag ?? null };
}

/** Deletes any event; an event that is already gone counts as success. */
export async function deleteCalendarEvent(
  env: Env,
  calendarId: string,
  eventId: string,
): Promise<void> {
  return deletePlannerEvent(env, calendarId, eventId);
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
