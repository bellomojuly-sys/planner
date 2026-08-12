import { and, eq, gte, lt, lte, ne } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  scheduledBlocks,
  calendarEvents,
  tasks,
  shoppingItems,
  settings as settingsTable,
} from '../db/schema';
import { composeBriefing } from '../integrations/claude';
import { estimateAccuracy } from '../scheduler/estimate';
import { sendToUser } from '../services/outbox';
import {
  addLocalDays,
  atLocalMinutes,
  formatDayLong,
  formatRange,
  formatTime,
  localDateKey,
  startOfLocalDay,
  DAY_MS,
} from '../lib/time';
import type { Env } from '../env';

export interface DayAgenda {
  dateKey: string;
  dayLabel: string;
  fixed: Array<{
    title: string;
    start: number;
    end: number;
    allDay: boolean;
    kind: 'fixed' | 'soft';
    isShift: boolean;
  }>;
  blocks: Array<{
    title: string;
    start: number;
    end: number;
    kind: string;
    taskId: string | null;
  }>;
  overdue: Array<{ title: string; dueAt: number | null }>;
  shoppingOpen: number;
}

export async function loadAgenda(
  db: DB,
  userId: string,
  timezone: string,
  dayAnchor: number,
): Promise<DayAgenda> {
  const dayStart = startOfLocalDay(dayAnchor, timezone);
  const dayEnd = addLocalDays(dayStart, timezone, 1);

  const [blocks, events, overdue, shopping] = await Promise.all([
    db
      .select()
      .from(scheduledBlocks)
      .where(
        and(
          eq(scheduledBlocks.userId, userId),
          gte(scheduledBlocks.startAt, dayStart),
          lt(scheduledBlocks.startAt, dayEnd),
        ),
      ),
    db
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.userId, userId),
          gte(calendarEvents.endAt, dayStart),
          lt(calendarEvents.startAt, dayEnd),
        ),
      ),
    db
      .select({ title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, userId),
          ne(tasks.status, 'done'),
          ne(tasks.status, 'cancelled'),
          lt(tasks.dueAt, dayStart),
        ),
      ),
    db
      .select({ id: shoppingItems.id })
      .from(shoppingItems)
      .where(
        and(eq(shoppingItems.userId, userId), eq(shoppingItems.status, 'open')),
      ),
  ]);

  return {
    dateKey: localDateKey(dayStart, timezone),
    dayLabel: formatDayLong(dayStart, timezone),
    fixed: events
      .filter((e) => !e.cancelled && e.kind !== 'planner')
      .map((e) => ({
        title: e.title,
        start: e.startAt,
        end: e.endAt,
        allDay: e.allDay,
        kind: e.kind === 'fixed' ? ('fixed' as const) : ('soft' as const),
        isShift: e.isShift,
      }))
      .sort((a, b) => a.start - b.start),
    blocks: blocks
      .map((b) => ({
        title: b.title,
        start: b.startAt,
        end: b.endAt,
        kind: b.kind,
        taskId: b.taskId,
      }))
      .sort((a, b) => a.start - b.start),
    overdue: overdue.slice(0, 10),
    shoppingOpen: shopping.length,
  };
}

function renderAgenda(agenda: DayAgenda, timezone: string): string {
  const lines: string[] = [];

  for (const event of agenda.fixed) {
    lines.push(
      `${event.allDay ? 'Tutto il giorno' : formatRange(event.start, event.end, timezone)} — ${event.title}${event.isShift ? ' (turno)' : ''} [${event.kind === 'fixed' ? 'fisso' : 'contesto'}]`,
    );
  }
  for (const block of agenda.blocks) {
    lines.push(
      `${formatRange(block.start, block.end, timezone)} — ${block.title}${block.kind === 'gym' ? ' [palestra]' : ''}`,
    );
  }

  lines.sort();
  return lines.join('\n') || '(niente in programma)';
}

/**
 * A deterministic, intentionally terse answer for the Siri shortcut.
 * It includes only commitments that still matter today: fixed calendar events
 * and actionable planner blocks. Context events, breaks, buffers, overdue
 * lists and tomorrow are deliberately omitted.
 */
export function renderVoiceAgenda(
  agenda: DayAgenda,
  timezone: string,
  now = Date.now(),
): string {
  const items = [
    ...agenda.fixed
      .filter((event) => event.kind === 'fixed' && event.end > now)
      .map((event) => ({
        title: event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
      })),
    ...agenda.blocks
      .filter(
        (block) =>
          block.kind !== 'break' && block.kind !== 'buffer' && block.end > now,
      )
      .map((block) => ({
        title: block.title,
        start: block.start,
        end: block.end,
        allDay: false,
      })),
  ].sort((a, b) => a.start - b.start);

  if (items.length === 0) return 'Per oggi non hai più nulla in programma.';

  const spoken = items.map((item) => {
    if (item.allDay) return `per tutto il giorno, ${item.title}`;
    if (item.start <= now && item.end > now) return `adesso, ${item.title}`;
    return `alle ${formatTime(item.start, timezone)}, ${item.title}`;
  });

  return `Oggi: ${spoken.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// 07:00 — morning briefing
// ---------------------------------------------------------------------------

export async function runMorningBriefing(
  env: Env,
  db: DB,
  userId: string,
  timezone: string,
): Promise<string> {
  const agenda = await loadAgenda(db, userId, timezone, Date.now());

  const prompt = `Prepara il briefing del mattino per ${agenda.dayLabel}.

PROGRAMMA DI OGGI
${renderAgenda(agenda, timezone)}

${agenda.overdue.length > 0 ? `IN RITARDO\n${agenda.overdue.map((t) => `- ${t.title}`).join('\n')}\n` : ''}${agenda.shoppingOpen > 0 ? `Lista della spesa: ${agenda.shoppingOpen} articoli aperti.\n` : ''}
Scrivi il briefing: cosa conta davvero oggi, dove sono i momenti stretti, cosa può slittare senza danni. Non ripetere l'elenco orario, Giulia ce l'ha già davanti.`;

  // If Claude is unreachable the plan is still correct, so fall back to the
  // plain agenda rather than skipping the briefing entirely.
  let text: string;
  try {
    text = await composeBriefing(env, prompt);
  } catch (err) {
    console.error('[briefing] compose failed, using plain agenda', err);
    text = renderAgenda(agenda, timezone);
  }

  const firstBlock = agenda.blocks[0];
  await sendToUser(env, db, userId, {
    title: `Buongiorno — ${agenda.dayLabel}`,
    body: firstBlock
      ? `${text.slice(0, 140)}\n\nSi parte alle ${formatTime(firstBlock.start, timezone)}.`
      : text.slice(0, 180),
    url: '/',
    tag: `briefing-${agenda.dateKey}`,
  });

  return text;
}

// ---------------------------------------------------------------------------
// 20:30 (or 30 min after the shift) — evening review
// ---------------------------------------------------------------------------

export async function runEveningReview(
  env: Env,
  db: DB,
  userId: string,
  timezone: string,
): Promise<string> {
  const today = await loadAgenda(db, userId, timezone, Date.now());
  const tomorrow = await loadAgenda(
    db,
    userId,
    timezone,
    addLocalDays(Date.now(), timezone, 1),
  );

  const dayStart = startOfLocalDay(Date.now(), timezone);
  const completedToday = await db
    .select({ title: tasks.title, actualMinutes: tasks.actualMinutes })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, 'done'),
        gte(tasks.completedAt, dayStart),
      ),
    );

  const accuracy = await estimateAccuracy(db, userId);

  const prompt = `Prepara la revisione della sera e l'anteprima di domani.

FATTO OGGI (${completedToday.length})
${completedToday.map((t) => `- ${t.title}${t.actualMinutes ? ` (${t.actualMinutes} min)` : ''}`).join('\n') || '- niente registrato'}

NON COMPLETATO OGGI
${today.blocks.map((b) => `- ${b.title}`).join('\n') || '- niente'}

DOMANI — ${tomorrow.dayLabel}
${renderAgenda(tomorrow, timezone)}

${accuracy.samples >= 5 ? `Accuratezza delle stime: le attività richiedono in media ${accuracy.meanRatio.toFixed(2)}× il tempo previsto.` : ''}

Scrivi una revisione breve: com'è andata, cosa resta, e la cosa principale a cui pensare domani. Se le stime sono sistematicamente sbagliate, dillo in una frase.`;

  let text: string;
  try {
    text = await composeBriefing(env, prompt);
  } catch (err) {
    console.error('[review] compose failed, using plain agenda', err);
    text = `Fatto oggi: ${completedToday.length}. Domani:\n${renderAgenda(tomorrow, timezone)}`;
  }

  await sendToUser(env, db, userId, {
    title: 'Riepilogo della giornata',
    body: text.slice(0, 180),
    url: '/?view=tomorrow',
    tag: `review-${today.dateKey}`,
  });

  return text;
}

// ---------------------------------------------------------------------------
// Deciding when the review is due
// ---------------------------------------------------------------------------

/**
 * The review normally fires at 20:30, but a restaurant shift that runs past it
 * would mean reviewing a day that is not over yet. When a shift ends later, the
 * review slides to shift-end plus a buffer.
 */
export async function resolveReviewTime(
  db: DB,
  userId: string,
  timezone: string,
  now: number,
): Promise<number> {
  const prefs = await db.query.settings.findFirst({
    where: eq(settingsTable.userId, userId),
  });

  const base = atLocalMinutes(now, timezone, prefs?.reviewMinutes ?? 20 * 60 + 30);
  const dayStart = startOfLocalDay(now, timezone);
  const dayEnd = dayStart + DAY_MS;

  const shifts = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        eq(calendarEvents.isShift, true),
        eq(calendarEvents.kind, 'fixed'),
        gte(calendarEvents.endAt, dayStart),
        lte(calendarEvents.endAt, dayEnd),
      ),
    );

  const latestShiftEnd = shifts.reduce((max, s) => Math.max(max, s.endAt), 0);
  if (latestShiftEnd === 0) return base;

  const afterShift =
    latestShiftEnd + (prefs?.reviewAfterShiftMinutes ?? 30) * 60_000;

  return Math.max(base, afterShift);
}
