import { and, desc, eq, gte, lt, lte, ne } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  scheduledBlocks,
  calendarEvents,
  tasks,
  shoppingItems,
  settings as settingsTable,
  scheduleRuns,
} from '../db/schema';
import { composeBriefing } from '../integrations/llm';
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

const ENGLISH_TITLE_FALLBACKS = new Map<string, string>([
  ['parlare con olga', 'Talk to Olga'],
  ['iscriversi / iscrizione assicurazione', 'Register for health insurance'],
  ['iscrizione assicurazione', 'Register for health insurance'],
  ['viaggio verso palestra', 'Travel to the gym'],
  ['ritorno dalla palestra', 'Return from the gym'],
  ['palestra', 'Gym'],
  ['doccia e cambio', 'Shower and change'],
  ['doccia corpo', 'Body shower'],
  ['doccia capelli', 'Hair wash and shower'],
  ['preparazione università', 'University preparation'],
  ['contenuti', 'Content creation'],
  ['analisi sito', 'Website analysis'],
  ['laovrare su betsy', 'Work on Betsy'],
  ['meeting idustry', 'Industry meeting'],
  ['riorganizzare', 'Reorganize'],
  ['spesa', 'Grocery shopping'],
  ['pranzo', 'Lunch'],
  ['compleanno', 'Birthday'],
]);

/**
 * Local, privacy-safe translations for recurring and planner-generated agenda
 * labels. Proper nouns and already-English course/project names stay intact.
 */
export function englishAgendaTitle(title: string): string {
  const cleanTitle = title.trim();
  const normalized = cleanTitle.toLocaleLowerCase('it-IT');
  const exact = ENGLISH_TITLE_FALLBACKS.get(normalized);
  if (exact) return exact;

  const route = cleanTitle
    .replace(/^viaggio casa\s*[→-]\s*università$/i, 'Travel from home to university')
    .replace(/^viaggio università\s*[→-]\s*casa$/i, 'Travel from university to home')
    .replace(/^viaggio università\s*[→-]\s*lavoro$/i, 'Travel from university to work')
    .replace(/^ritorno da(?:lla|l|)\s+(.+)$/i, 'Return from $1')
    .replace(/^viaggio verso\s+(.+)$/i, 'Travel to $1');
  if (route !== cleanTitle) return route;

  const patterns: Array<[RegExp, string]> = [
    [/^parlare con\s+(.+)$/i, 'Talk to $1'],
    [/^lavorare su\s+(.+)$/i, 'Work on $1'],
    [/^preparazione(?: per)?\s+(.+)$/i, 'Preparation for $1'],
    [/^preparare\s+(.+)$/i, 'Prepare $1'],
    [/^scegliere\s+(.+)$/i, 'Choose $1'],
    [/^mappare\s+(.+)$/i, 'Map $1'],
    [/^definire\s+(.+)$/i, 'Define $1'],
    [/^analizzare\s+(.+)$/i, 'Analyze $1'],
    [/^pubblicare\s+(.+)$/i, 'Publish $1'],
    [/^ricerca(?:re)?\s+(.+)$/i, 'Research $1'],
    [/^iscrizione\s+(.+)$/i, 'Registration for $1'],
  ];
  for (const [pattern, replacement] of patterns) {
    const translated = cleanTitle.replace(pattern, replacement);
    if (translated !== cleanTitle) return translated;
  }
  return cleanTitle;
}

const SMALL_ENGLISH_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

function englishNumber(value: number): string {
  if (value < 20) return SMALL_ENGLISH_NUMBERS[value] ?? String(value);
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  const remainder = value % 10;
  return remainder === 0
    ? (tens[Math.floor(value / 10)] ?? String(value))
    : `${tens[Math.floor(value / 10)]}-${SMALL_ENGLISH_NUMBERS[remainder]}`;
}

/**
 * Spell times as English words so a Shortcut with an Italian default voice
 * cannot reinterpret numeric clock notation in Italian.
 */
export function formatEnglishSpokenTime(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).formatToParts(timestamp);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    }).format(timestamp),
  );
  const period =
    localHour < 12
      ? 'in the morning'
      : localHour < 18
        ? 'in the afternoon'
        : 'in the evening';
  const minuteWords =
    minute === 0 ? '' : minute < 10 ? ` oh ${englishNumber(minute)}` : ` ${englishNumber(minute)}`;
  return `${englishNumber(hour)}${minuteWords} ${period}`;
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
  language: 'it' | 'en' = 'it',
): string {
  const isToday = agenda.dateKey === localDateKey(now, timezone);
  const english = language === 'en';
  const locale = english ? 'en-US' : 'it-IT';
  const dayAnchor = Date.parse(`${agenda.dateKey}T12:00:00Z`);
  const dayLabel = Number.isFinite(dayAnchor)
    ? formatDayLong(dayAnchor, timezone, locale)
    : agenda.dayLabel;
  const items = [
    ...agenda.fixed
      .filter((event) => event.kind === 'fixed' && (!isToday || event.end > now))
      .map((event) => ({
        title: english ? englishAgendaTitle(event.title) : event.title,
        start: event.start,
        end: event.end,
        allDay: event.allDay,
      })),
    ...agenda.blocks
      .filter(
        (block) =>
          block.kind !== 'break' &&
          block.kind !== 'buffer' &&
          (!isToday || block.end > now),
      )
      .map((block) => ({
        title: english ? englishAgendaTitle(block.title) : block.title,
        start: block.start,
        end: block.end,
        allDay: false,
      })),
  ].sort((a, b) => a.start - b.start);

  if (items.length === 0) {
    if (english) {
      return isToday
        ? 'You have nothing else scheduled today.'
        : `You have nothing scheduled for ${dayLabel}.`;
    }
    return isToday
      ? 'Per oggi non hai più nulla in programma.'
      : `Per ${agenda.dayLabel} non hai nulla in programma.`;
  }

  const spoken = items.map((item) => {
    if (item.allDay) {
      return `${english ? 'all day' : 'per tutto il giorno'}, ${item.title}`;
    }
    if (isToday && item.start <= now && item.end > now) {
      return `${english ? 'now' : 'adesso'}, ${item.title}`;
    }
    if (english) {
      return `${formatEnglishSpokenTime(item.start, timezone)}, ${item.title}`;
    }
    return `alle ${formatTime(item.start, timezone, locale)}, ${item.title}`;
  });

  if (english) {
    return `${isToday ? 'Today' : `Plan for ${dayLabel}`}: ${spoken.join('; ')}.`;
  }
  return `${isToday ? 'Oggi' : `Piano di ${agenda.dayLabel}`}: ${spoken.join('; ')}.`;
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
  const [latestRun] = await db
    .select({ summary: scheduleRuns.summary })
    .from(scheduleRuns)
    .where(eq(scheduleRuns.userId, userId))
    .orderBy(desc(scheduleRuns.startedAt))
    .limit(1);

  // The morning explanation is deterministic and traceable to the structured
  // decision result. The model may not invent what was kept or sacrificed.
  const text =
    renderDecisionBriefing(latestRun?.summary) ??
    `Piano di ${agenda.dayLabel}:\n${renderAgenda(agenda, timezone)}`;

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

export function renderDecisionBriefing(summary: unknown): string | null {
  if (!summary || typeof summary !== 'object') return null;
  const briefing = (summary as { briefing?: unknown }).briefing;
  if (
    !Array.isArray(briefing) ||
    briefing.length === 0 ||
    briefing.length > 5 ||
    !briefing.every((line) => typeof line === 'string' && line.trim().length > 0)
  ) {
    return null;
  }
  return briefing.join('\n');
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
