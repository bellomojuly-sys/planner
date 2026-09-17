import { and, eq, ne } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  calendarEvents,
  calendarSources,
  calendarSyncState,
  outbox,
  scheduledBlocks,
} from '../db/schema';
import {
  listCalendars,
  type GoogleCalendar,
} from '../integrations/google-calendar';
import { isLikelyIcsUrl, normalizeFeedUrl } from '../integrations/ics';
import { PlannerError } from '../lib/errors';
import type { Env } from '../env';

export type CalendarRole = 'busy' | 'context' | 'ignore' | 'planner';

export function canWriteCalendar(
  accessRole: GoogleCalendar['accessRole'] | string,
): boolean {
  return accessRole === 'writer' || accessRole === 'owner';
}

/**
 * Discovery starts conservatively: every timed calendar blocks planning, and
 * the writable primary calendar receives the blocks created by the planner.
 * Giulia can explicitly downgrade a calendar to context or ignore afterwards.
 */
export function suggestCalendarRole(
  calendar: GoogleCalendar,
  plannerAlreadyAssigned: boolean,
): CalendarRole {
  if (!plannerAlreadyAssigned && calendar.primary && canWriteCalendar(calendar.accessRole)) {
    return 'planner';
  }
  return 'busy';
}

/**
 * The feed URL is the credential: anyone holding it can read the calendar, so
 * the API returns only enough of it to recognise which feed a row is.
 */
export function redactFeedUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return 'feed';
  }
}

export function redactSource<T extends { feedUrl: string | null }>(source: T) {
  return { ...source, feedUrl: redactFeedUrl(source.feedUrl) };
}

/**
 * Subscribes to a calendar Planner reads by URL. Google cannot share these
 * with anyone (see `dl-how-planner-reads-subscribed-calendars`), so they are
 * registered here instead of discovered.
 */
export async function addIcsSource(
  db: DB,
  userId: string,
  input: { url: string; name: string; role: CalendarRole },
) {
  if (!isLikelyIcsUrl(input.url)) {
    throw new PlannerError('bad_request', {
      message: 'not an http(s) calendar url',
      userMessage: 'Indirizzo non valido. Incolla il link iCal (https:// o webcal://).',
    });
  }

  const url = normalizeFeedUrl(input.url);
  // Stable id derived from the URL: re-adding the same feed updates the row
  // instead of duplicating the calendar.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const calendarId = `ics:${[...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

  const [row] = await db
    .insert(calendarSources)
    .values({
      userId,
      calendarId,
      summary: input.name.trim() || 'Calendario esterno',
      kind: 'ics',
      feedUrl: url,
      role: input.role,
      accessRole: 'reader',
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [calendarSources.userId, calendarSources.calendarId],
      set: {
        summary: input.name.trim() || 'Calendario esterno',
        feedUrl: url,
        role: input.role,
        enabled: true,
        updatedAt: Date.now(),
      },
    })
    .returning();

  return row!;
}

export async function discoverCalendarSources(
  env: Env,
  db: DB,
  userId: string,
) {
  const remote = await listCalendars(env);
  const existing = await db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.userId, userId));

  const byCalendarId = new Map(existing.map((source) => [source.calendarId, source]));
  let plannerAssigned = existing.some(
    (source) => source.role === 'planner' && source.enabled,
  );

  for (const calendar of remote) {
    const source = byCalendarId.get(calendar.id);
    if (source) {
      await db
        .update(calendarSources)
        .set({
          summary: calendar.summary,
          color: calendar.color,
          accessRole: calendar.accessRole,
          primary: calendar.primary,
        })
        .where(eq(calendarSources.id, source.id));
      continue;
    }

    const role = suggestCalendarRole(calendar, plannerAssigned);
    if (role === 'planner') plannerAssigned = true;

    await db.insert(calendarSources).values({
      userId,
      calendarId: calendar.id,
      summary: calendar.summary,
      role,
      color: calendar.color,
      accessRole: calendar.accessRole,
      primary: calendar.primary,
    });
  }

  // A non-standard account may not mark any entry as primary. It still needs
  // one writable target, otherwise outbound jobs can never be delivered.
  if (!plannerAssigned) {
    const fallback = remote.find((calendar) => canWriteCalendar(calendar.accessRole));
    if (fallback) {
      await db
        .update(calendarSources)
        .set({ role: 'planner', enabled: true })
        .where(
          and(
            eq(calendarSources.userId, userId),
            eq(calendarSources.calendarId, fallback.id),
          ),
        );
    }
  }

  return loadCalendarSources(db, userId);
}

export async function loadCalendarSources(db: DB, userId: string) {
  const rows = await db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.userId, userId));

  return rows.sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary),
  );
}

export async function getPlannerCalendarId(db: DB, userId: string): Promise<string> {
  const [source] = await db
    .select({ calendarId: calendarSources.calendarId })
    .from(calendarSources)
    .where(
      and(
        eq(calendarSources.userId, userId),
        eq(calendarSources.role, 'planner'),
        eq(calendarSources.enabled, true),
      ),
    )
    .limit(1);

  // Backward-compatible until calendar discovery has run for an existing user.
  return source?.calendarId ?? 'primary';
}

export async function updateCalendarSource(
  db: DB,
  userId: string,
  sourceId: string,
  patch: { role?: CalendarRole; enabled?: boolean; color?: string },
) {
  const source = await db.query.calendarSources.findFirst({
    where: and(eq(calendarSources.id, sourceId), eq(calendarSources.userId, userId)),
  });
  if (!source) throw new PlannerError('not_found');

  const nextRole = patch.role ?? source.role;
  const nextEnabled = patch.enabled ?? source.enabled;

  if (nextRole === 'planner' && !canWriteCalendar(source.accessRole)) {
    throw new PlannerError('bad_request', {
      userMessage: 'Questo calendario è in sola lettura e non può ricevere il piano.',
    });
  }
  if (nextRole === 'planner' && !nextEnabled) {
    throw new PlannerError('bad_request', {
      userMessage: 'Il calendario del planner deve restare attivo.',
    });
  }
  if (source.role === 'planner' && nextRole !== 'planner') {
    throw new PlannerError('bad_request', {
      userMessage: 'Scegli prima un altro calendario come destinazione del planner.',
    });
  }
  if (source.role === 'planner' && !nextEnabled) {
    throw new PlannerError('bad_request', {
      userMessage: 'Scegli prima un altro calendario come destinazione del planner.',
    });
  }

  const switchingPlanner = nextRole === 'planner' && source.role !== 'planner';
  if (switchingPlanner) {
    const [previous] = await db
      .select()
      .from(calendarSources)
      .where(
        and(
          eq(calendarSources.userId, userId),
          eq(calendarSources.role, 'planner'),
          ne(calendarSources.id, source.id),
        ),
      )
      .limit(1);

    // Pending upserts still name the old destination. Supersede them before
    // queuing the replacement jobs, otherwise both calendars get a copy.
    await db
      .update(outbox)
      .set({ status: 'done' })
      .where(
        and(
          eq(outbox.userId, userId),
          eq(outbox.kind, 'google_upsert'),
          eq(outbox.status, 'pending'),
        ),
      );

    const blocks = await db
      .select()
      .from(scheduledBlocks)
      .where(eq(scheduledBlocks.userId, userId));

    for (const block of blocks) {
      if (block.googleEventId && previous) {
        await db.insert(outbox).values({
          userId,
          kind: 'google_delete',
          payload: {
            eventId: block.googleEventId,
            calendarId: previous.calendarId,
          },
        });
      }

      await db
        .update(scheduledBlocks)
        .set({ googleEventId: null, syncState: 'pending', syncError: null })
        .where(eq(scheduledBlocks.id, block.id));
      await db.insert(outbox).values({
        userId,
        kind: 'google_upsert',
        payload: { blockId: block.id, calendarId: source.calendarId },
      });
    }

    if (previous) {
      await db
        .update(calendarSources)
        .set({ role: 'busy' })
        .where(eq(calendarSources.id, previous.id));
      await resetCalendarSync(db, userId, previous.calendarId);
    }
  }

  await db
    .update(calendarSources)
    .set({ ...patch, ...(nextRole === 'planner' ? { enabled: true } : {}) })
    .where(eq(calendarSources.id, source.id));

  if (
    switchingPlanner ||
    (patch.role !== undefined && patch.role !== source.role) ||
    (patch.enabled !== undefined && patch.enabled !== source.enabled)
  ) {
    await resetCalendarSync(db, userId, source.calendarId);
  }

  return db.query.calendarSources.findFirst({
    where: and(eq(calendarSources.id, source.id), eq(calendarSources.userId, userId)),
  });
}

async function resetCalendarSync(
  db: DB,
  userId: string,
  calendarId: string,
): Promise<void> {
  await db
    .delete(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.calendarId, calendarId),
      ),
    );
  await db
    .delete(calendarSyncState)
    .where(
      and(
        eq(calendarSyncState.userId, userId),
        eq(calendarSyncState.calendarId, calendarId),
      ),
    );
}
