import { and, eq, ne, desc, gt, lte, notInArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  tasks,
  taskSources,
  taskDependencies,
  shoppingItems,
  scheduledBlocks,
  captures,
  outbox,
  settings as settingsTable,
  type Task,
} from '../db/schema';
import {
  interpretUtterance,
  validateInterpretation,
  type Intent,
  type Interpretation,
} from '../integrations/llm';
import { applyLearning } from '../scheduler/estimate';
import { inferArea } from './area-classifier';
import { gymCadence } from './gym-cadence';
import { replan, type RescheduleTrigger } from './planner';
import {
  completeTaskLocally,
  inferActualMinutes,
} from './completion';
import { seal } from '../crypto/encryption';
import { DAY_MS, formatDayLong, localDateKey } from '../lib/time';
import { PlannerError, toPlannerError } from '../lib/errors';
import type { Env } from '../env';

export interface CaptureResult {
  captureId: string;
  language: CaptureLanguage;
  summary: string;
  applied: string[];
  skipped: string[];
  answer?: string;
  /** ISO local date requested by an agenda question. */
  answerDate?: string;
  replanned: boolean;
}

export type CaptureLanguage = Interpretation['language'];

/**
 * The voice pipeline: interpret → apply → reschedule.
 *
 * Every utterance is stored (encrypted) alongside the model's parsed intents
 * before anything is written, so a bad interpretation can be inspected and
 * reversed rather than silently corrupting the plan.
 */
export async function handleCapture(
  env: Env,
  db: DB,
  userId: string,
  input: {
    text: string;
    source?: 'action_button' | 'web' | 'shortcut' | 'api';
    clientRequestId?: string;
  },
): Promise<CaptureResult> {
  const timezone = 'Europe/Rome';

  // The Shortcut retries over flaky cellular; the same request id must not
  // create the task twice.
  if (input.clientRequestId) {
    const prior = await db.query.captures.findFirst({
      where: and(
        eq(captures.userId, userId),
        eq(captures.clientRequestId, input.clientRequestId),
      ),
    });
    if (prior) {
      const priorInterpretation = validateInterpretation(prior.interpretation);
      return {
        captureId: prior.id,
        language: priorInterpretation.success
          ? priorInterpretation.data.language
          : 'it',
        summary: prior.appliedSummary ?? 'Già registrato.',
        applied: [],
        skipped: [],
        replanned: false,
      };
    }
  }

  const sealed = await seal(input.text, env.MASTER_KEY);
  const [capture] = await db
    .insert(captures)
    .values({
      userId,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      source: input.source ?? 'action_button',
      clientRequestId: input.clientRequestId,
      status: 'pending',
    })
    .returning({ id: captures.id });

  const captureId = capture!.id;

  try {
    const context = await buildContext(db, userId, timezone);
    const interpretation = await interpretUtterance(env, input.text, context);

    await db
      .update(captures)
      .set({ status: 'interpreted', interpretation })
      .where(eq(captures.id, captureId));

    const applied: string[] = [];
    const skipped: string[] = [];
    let answer: string | undefined;
    let answerDate: string | undefined;
    let trigger: RescheduleTrigger | null = null;

    for (const intent of interpretation.intents) {
      try {
        const outcome = await applyIntent(
          env,
          db,
          userId,
          intent,
          timezone,
          interpretation.language,
        );
        if (outcome.message) applied.push(outcome.message);
        if (outcome.answer) answer = outcome.answer;
        if (outcome.answerDate) answerDate = outcome.answerDate;
        if (outcome.trigger) {
          // An urgent addition outranks a routine one when several intents
          // arrive in the same breath.
          trigger =
            outcome.trigger === 'urgent_task' ? 'urgent_task' : (trigger ?? outcome.trigger);
        }
      } catch (err) {
        skipped.push(toPlannerError(err).userMessage);
      }
    }

    let replanned = false;
    if (trigger) {
      const diff = await replan(env, db, userId, trigger);
      replanned = diff.applied;
    }

    const summary = interpretation.summary;
    await db
      .update(captures)
      .set({
        status: skipped.length > 0 && applied.length === 0 ? 'needs_review' : 'applied',
        appliedSummary: [summary, ...applied].join(' · ').slice(0, 1000),
      })
      .where(eq(captures.id, captureId));

    return {
      captureId,
      language: interpretation.language,
      summary,
      applied,
      skipped,
      answer,
      answerDate,
      replanned,
    };
  } catch (err) {
    const pe = toPlannerError(err);
    await db
      .update(captures)
      .set({ status: 'failed', error: pe.message.slice(0, 500) })
      .where(eq(captures.id, captureId));
    throw pe;
  }
}

// ---------------------------------------------------------------------------

async function buildContext(db: DB, userId: string, timezone: string) {
  const openTasks = await db
    .select({ title: tasks.title, area: tasks.area })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        notInArray(tasks.status, ['done', 'cancelled']),
      ),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(60);

  const items = await db
    .select({ name: shoppingItems.name })
    .from(shoppingItems)
    .where(and(eq(shoppingItems.userId, userId), eq(shoppingItems.status, 'open')))
    .limit(40);

  const now = Date.now();
  return {
    todayIso: localDateKey(now, timezone),
    weekdayName: formatDayLong(now, timezone),
    openTasks: openTasks.map((t) => ({ title: t.title, area: t.area })),
    shoppingItems: items.map((i) => i.name),
  };
}

interface IntentOutcome {
  message?: string;
  answer?: string;
  answerDate?: string;
  trigger?: RescheduleTrigger;
}

async function applyIntent(
  env: Env,
  db: DB,
  userId: string,
  intent: Intent,
  timezone: string,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  switch (intent.kind) {
    case 'create_task':
      return createTask(env, db, userId, intent, language);
    case 'complete_task':
      return completeTask(env, db, userId, intent, language);
    case 'move_task':
      return moveTask(db, userId, intent, timezone, language);
    case 'set_task_pin':
      return setTaskPin(db, userId, intent, language);
    case 'add_dependency':
      return addDependency(db, userId, intent, language);
    case 'add_shopping_item':
      return addShoppingItem(db, userId, intent, language);
    case 'complete_shopping_item':
      return completeShoppingItem(db, userId, intent, language);
    case 'set_gym_cadence':
      return setGymCadence(db, userId, intent, language);
    case 'question':
      return { answer: intent.question, answerDate: intent.date };
    case 'unclear':
      throw new PlannerError('bad_request', {
        userMessage:
          language === 'en'
            ? `I did not understand: ${intent.reason}`
            : `Non ho capito: ${intent.reason}`,
      });
  }
}

async function setGymCadence(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'set_gym_cadence' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const plan = gymCadence(intent.sessionsPerWeek);
  await db
    .update(settingsTable)
    .set({
      gymSessionsPerWeek: plan.sessionsPerWeek,
      gymMaxSessionsPerWeek: plan.maxSessionsPerWeek,
      gymPreferredDays: plan.preferredDays,
      gymMinRecoveryHours: plan.minRecoveryHours,
    })
    .where(eq(settingsTable.userId, userId));

  const n = plan.sessionsPerWeek;
  const message =
    n === 0
      ? language === 'en'
        ? 'Gym removed from the plan.'
        : 'Palestra tolta dal piano.'
      : n === 7
        ? language === 'en'
          ? 'Gym set to every day.'
          : 'Palestra impostata tutti i giorni.'
        : language === 'en'
          ? `Gym set to ${n} times a week.`
          : `Palestra impostata ${n} volte a settimana.`;

  return { message, trigger: 'manual' };
}

async function createTask(
  env: Env,
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'create_task' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  // When the model does not commit to an area (or falls back to the generic
  // one), route by the title so a dictated "post Heemia" still lands in Heemia.
  const area =
    intent.area && intent.area !== 'general'
      ? intent.area
      : inferArea(intent.title) ?? intent.area ?? 'general';
  const energy = intent.energy ?? 'medium';
  const estimated = intent.estimatedMinutes ?? 30;

  const learned = await applyLearning(db, userId, {
    area,
    energy,
    title: intent.title,
    estimatedMinutes: estimated,
  });

  const dueAt = intent.dueAt ? parseIsoLoose(intent.dueAt) : null;

  const [created] = await db
    .insert(tasks)
    .values({
      userId,
      title: intent.title,
      notes: intent.notes ?? null,
      area,
      energy,
      priority: intent.urgent ? 1 : (intent.priority ?? 3),
      estimatedMinutes: estimated,
      plannedMinutes: learned.plannedMinutes,
      estimateSource: 'claude',
      estimateConfidence: learned.confidence,
      dueAt,
      location: intent.location ?? null,
      travelMinutes: intent.travelMinutes ?? 0,
      preparationMinutes: intent.preparationMinutes ?? 0,
      recoveryMinutes: intent.recoveryMinutes ?? 0,
      flexibility: intent.flexibility ?? 'high',
      status: 'todo',
      isGym: /palestra|allenamento|gym|corsa|nuoto/i.test(intent.title),
      dirty: true,
    })
    .returning({ id: tasks.id, title: tasks.title });

  // Named prerequisites are matched against existing tasks; an unmatched name
  // is dropped rather than inventing a task Giulia never mentioned.
  for (const depTitle of intent.dependsOnTitles ?? []) {
    const match = await findTask(db, userId, depTitle);
    if (match) {
      await db
        .insert(taskDependencies)
        .values({
          userId,
          taskId: created!.id,
          dependsOnId: match.id,
          createdBy: 'claude',
        })
        .onConflictDoNothing();
    }
  }

  // Mirror into the matching Notion database so Notion stays the source of
  // record — queued, because a Notion outage must not lose the capture.
  const source = await pickSourceForArea(db, userId, area);
  if (source) {
    await db.insert(outbox).values({
      userId,
      kind: 'notion_upsert',
      payload: { taskId: created!.id, sourceId: source.id },
    });
  }

  return {
    message:
      language === 'en'
        ? `Added "${created!.title}", area ${spokenArea(area, language)} (${learned.plannedMinutes} min)`
        : `Aggiunta "${created!.title}", area ${spokenArea(area, language)} (${learned.plannedMinutes} min)`,
    trigger: intent.urgent || (intent.priority ?? 3) === 1 ? 'urgent_task' : 'capture',
  };
}

/** Human labels used in the short spoken confirmation returned to the Shortcut. */
export function spokenArea(
  area: string,
  language: CaptureLanguage = 'it',
): string {
  const italian: Record<string, string> = {
    general: 'generale',
    mg: 'MG',
    university: 'università',
    heemia: 'Heemia',
    career: 'carriera',
    personal: 'personale',
    health: 'salute',
    errand: 'commissioni',
  };
  const english: Record<string, string> = {
    general: 'general',
    mg: 'MG',
    university: 'university',
    heemia: 'Heemia',
    career: 'career',
    personal: 'personal',
    health: 'health',
    errand: 'errands',
  };
  return (language === 'en' ? english : italian)[area] ?? area;
}

/**
 * Chooses which Notion database a new task belongs in.
 *
 * A source registered for one area is not the only home for that area: the
 * shared Tasks database carries an `Area` select and can hold University,
 * Heemia and the rest. So prefer an exact area match, then any database that
 * has an Area property (it can represent this area), and only then give up.
 * Without the middle step a voice-captured University task would never reach
 * Notion at all.
 */
async function pickSourceForArea(db: DB, userId: string, area: string) {
  const sources = await db
    .select()
    .from(taskSources)
    .where(and(eq(taskSources.userId, userId), eq(taskSources.enabled, true)));

  return (
    sources.find((s) => s.area === area) ??
    sources.find((s) => s.propertyMap.area && s.propertyMap.areaValues?.[area as never]) ??
    sources.find((s) => s.propertyMap.area) ??
    null
  );
}

async function completeTask(
  env: Env,
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'complete_task' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const contextual = isContextualCompletionReference(intent.taskQuery);
  const task = contextual
    ? await findActiveTask(db, userId, Date.now())
    : await findTask(db, userId, intent.taskQuery);
  if (!task) {
    const userMessage = contextual
      ? language === 'en'
        ? 'There is not exactly one task in progress right now. Say its name so I do not complete the wrong one.'
        : 'Non c’è un’unica attività in corso in questo momento. Dimmi il nome, così non completo quella sbagliata.'
      : language === 'en'
        ? `I could not find a task matching "${intent.taskQuery}".`
        : `Non ho trovato un'attività che assomigli a "${intent.taskQuery}".`;

    throw new PlannerError('not_found', {
      userMessage,
    });
  }

  // When Giulia does not say how long it took, infer it from the block that
  // was actually scheduled — still real data, just less precise.
  const actual =
    intent.actualMinutes ?? (await inferActualMinutes(db, userId, task.id));

  await completeTaskLocally(db, userId, task, actual);

  return {
    message:
      language === 'en'
        ? actual
          ? `Completed "${task.title}" (${actual} actual min)`
          : `Completed "${task.title}"`
        : actual
          ? `Completata "${task.title}" (${actual} min reali)`
          : `Completata "${task.title}"`,
    trigger: 'dependency_cascade',
  };
}

/**
 * Generic references are resolved from the live plan, never guessed from the
 * most recently edited task. The list is deliberately narrow because a wrong
 * completion is more damaging than asking Giulia to name the task.
 */
export function isContextualCompletionReference(query: string): boolean {
  const normalized = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return new Set([
    'questa azione',
    'quest azione',
    'questa attivita',
    'quest attivita',
    'questa attivita in corso',
    'azione corrente',
    'l azione corrente',
    'attivita corrente',
    'l attivita corrente',
    'questo task',
    'questa task',
    'il task corrente',
    'quello che sto facendo',
    'cio che sto facendo',
    'this action',
    'this task',
    'this activity',
    'the current action',
    'the current task',
    'what i am doing',
    'what im doing',
  ]).has(normalized);
}

export function selectSingleActiveTaskId(
  blocks: Array<{
    taskId: string | null;
    kind: string;
    startAt: number;
    endAt: number;
  }>,
  now: number,
): string | null {
  const activeTaskIds = new Set(
    blocks
      .filter(
        (block) =>
          block.kind === 'task' &&
          block.taskId &&
          block.startAt <= now &&
          block.endAt > now,
      )
      .map((block) => block.taskId as string),
  );

  return activeTaskIds.size === 1 ? [...activeTaskIds][0]! : null;
}

async function findActiveTask(
  db: DB,
  userId: string,
  now: number,
): Promise<Task | null> {
  const activeBlocks = await db
    .select({
      taskId: scheduledBlocks.taskId,
      kind: scheduledBlocks.kind,
      startAt: scheduledBlocks.startAt,
      endAt: scheduledBlocks.endAt,
    })
    .from(scheduledBlocks)
    .where(
      and(
        eq(scheduledBlocks.userId, userId),
        eq(scheduledBlocks.kind, 'task'),
        lte(scheduledBlocks.startAt, now),
        gt(scheduledBlocks.endAt, now),
      ),
    );

  const taskId = selectSingleActiveTaskId(activeBlocks, now);
  if (!taskId) return null;

  const [task] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.id, taskId),
        ne(tasks.status, 'done'),
        ne(tasks.status, 'cancelled'),
      ),
    )
    .limit(1);

  return task ?? null;
}

async function moveTask(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'move_task' }>,
  timezone: string,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const task = await findTask(db, userId, intent.taskQuery);
  if (!task) {
    throw new PlannerError('not_found', {
      userMessage:
        language === 'en'
          ? `I could not find "${intent.taskQuery}".`
          : `Non ho trovato "${intent.taskQuery}".`,
    });
  }

  let earliest: number | null = null;
  if (intent.moveTo) earliest = parseIsoLoose(intent.moveTo);
  else if (intent.shiftDays) earliest = Date.now() + intent.shiftDays * DAY_MS;

  if (!earliest) {
    throw new PlannerError('bad_request', {
      userMessage:
        language === 'en'
          ? `I could not understand when to move "${task.title}".`
          : `Non ho capito a quando spostare "${task.title}".`,
    });
  }

  // Unpin: the scheduler should find the best slot on or after the new date,
  // not the exact instant the model guessed.
  await db
    .update(tasks)
    .set({ earliestStartAt: earliest, pinned: false })
    .where(eq(tasks.id, task.id));

  await db.delete(scheduledBlocks).where(eq(scheduledBlocks.taskId, task.id));

  return {
    message:
      language === 'en'
        ? `Moved "${task.title}" to ${formatDayLong(earliest, timezone, 'en-GB')}`
        : `Spostata "${task.title}" a ${formatDayLong(earliest, timezone)}`,
    trigger: 'task_moved',
  };
}

async function setTaskPin(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'set_task_pin' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const task = await findTask(db, userId, intent.taskQuery);
  if (!task) {
    throw new PlannerError('not_found', {
      userMessage:
        language === 'en'
          ? `I could not find "${intent.taskQuery}".`
          : `Non ho trovato "${intent.taskQuery}".`,
    });
  }

  const blocks = await db
    .select({ id: scheduledBlocks.id })
    .from(scheduledBlocks)
    .where(
      and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, task.id)),
    );
  if (intent.pinned && blocks.length === 0) {
    throw new PlannerError('bad_request', {
      userMessage:
        language === 'en'
          ? `"${task.title}" is not in the plan yet: choose a time first.`
          : `"${task.title}" non è ancora nel piano: prima scegli un orario.`,
    });
  }

  await db
    .update(tasks)
    .set({ pinned: intent.pinned })
    .where(and(eq(tasks.id, task.id), eq(tasks.userId, userId)));
  await db
    .update(scheduledBlocks)
    .set({ pinned: intent.pinned })
    .where(
      and(eq(scheduledBlocks.userId, userId), eq(scheduledBlocks.taskId, task.id)),
    );

  return {
    message:
      language === 'en'
        ? intent.pinned
          ? `"${task.title}" will not be moved automatically`
          : `"${task.title}" can be planned again`
        : intent.pinned
          ? `"${task.title}" non verrà spostata automaticamente`
          : `"${task.title}" può essere ripianificata di nuovo`,
  };
}

async function addDependency(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'add_dependency' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const [task, dependsOn] = await Promise.all([
    findTask(db, userId, intent.taskQuery),
    findTask(db, userId, intent.dependsOnQuery),
  ]);

  if (!task || !dependsOn) {
    throw new PlannerError('not_found', {
      userMessage:
        language === 'en'
          ? 'I could not find both tasks to create the dependency.'
          : 'Non ho trovato entrambe le attività per creare la dipendenza.',
    });
  }
  if (task.id === dependsOn.id) {
    throw new PlannerError('bad_request', {
      userMessage:
        language === 'en'
          ? 'A task cannot depend on itself.'
          : "Un'attività non può dipendere da sé stessa.",
    });
  }

  await db
    .insert(taskDependencies)
    .values({ userId, taskId: task.id, dependsOnId: dependsOn.id, createdBy: 'claude' })
    .onConflictDoNothing();

  return {
    message:
      language === 'en'
        ? `"${task.title}" now depends on "${dependsOn.title}"`
        : `"${task.title}" ora dipende da "${dependsOn.title}"`,
    trigger: 'dependency_cascade',
  };
}

async function addShoppingItem(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'add_shopping_item' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const existing = await db.query.shoppingItems.findFirst({
    where: and(
      eq(shoppingItems.userId, userId),
      eq(shoppingItems.status, 'open'),
      eq(shoppingItems.name, intent.name),
    ),
  });

  if (existing) {
    // Saying it twice means more of it, not a duplicate line.
    await db
      .update(shoppingItems)
      .set({ quantity: existing.quantity + (intent.quantity ?? 1) })
      .where(eq(shoppingItems.id, existing.id));
    return {
      message:
        language === 'en'
          ? `Updated the quantity of ${intent.name}`
          : `Aggiornata quantità di ${intent.name}`,
    };
  }

  await db.insert(shoppingItems).values({
    userId,
    name: intent.name,
    quantity: intent.quantity ?? 1,
    unit: intent.unit ?? 'pz',
    category: intent.category ?? guessCategory(intent.name),
    store: intent.store ?? null,
    urgent: intent.urgent ?? false,
  });

  return {
    message:
      language === 'en' ? `Added to the list: ${intent.name}` : `In lista: ${intent.name}`,
  };
}

async function completeShoppingItem(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'complete_shopping_item' }>,
  language: CaptureLanguage,
): Promise<IntentOutcome> {
  const open = await db
    .select()
    .from(shoppingItems)
    .where(and(eq(shoppingItems.userId, userId), eq(shoppingItems.status, 'open')));

  const match = bestMatch(open, intent.itemQuery, (i) => i.name);
  if (!match) {
    throw new PlannerError('not_found', {
      userMessage:
        language === 'en'
          ? `"${intent.itemQuery}" is not on the list.`
          : `"${intent.itemQuery}" non è nella lista.`,
    });
  }

  await db
    .update(shoppingItems)
    .set({ status: 'bought', completedAt: Date.now() })
    .where(eq(shoppingItems.id, match.id));

  return {
    message: language === 'en' ? `Bought: ${match.name}` : `Preso: ${match.name}`,
  };
}

// ---------------------------------------------------------------------------
// Fuzzy matching — speech rarely reproduces a task title exactly
// ---------------------------------------------------------------------------

async function findTask(
  db: DB,
  userId: string,
  query: string,
): Promise<Task | null> {
  const candidates = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), ne(tasks.status, 'cancelled')))
    .orderBy(desc(tasks.updatedAt))
    .limit(200);

  // Open tasks first: "ho finito la fattura" almost always means the open one.
  const open = candidates.filter((t) => t.status !== 'done');
  return bestMatch(open, query, (t) => t.title) ?? bestMatch(candidates, query, (t) => t.title);
}

/**
 * Function words carry no identity. Without this list "the MG report" scored
 * "the" as a missing word and English queries fell under the match threshold
 * far more often than Italian ones, whose articles are mostly two letters.
 */
const MATCH_STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'my', 'your', 'our', 'into',
  'about', 'task', 'finished', 'done', 'completed', 'complete',
  // Italian
  'del', 'della', 'dello', 'dei', 'degli', 'delle', 'alla', 'allo', 'alle', 'agli',
  'dal', 'dalla', 'nel', 'nella', 'con', 'per', 'una', 'uno', 'gli', 'questa',
  'questo', 'attivita', 'finito', 'fatto', 'completato',
]);

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    // Two-letter acronyms such as "MG" identify a task; articles do not.
    .filter((w) => {
      if (MATCH_STOPWORDS.has(w)) return false;
      return w.length > 2 || (w.length === 2 && !TWO_LETTER_STOPWORDS.has(w));
    });
}

const TWO_LETTER_STOPWORDS = new Set([
  'il', 'lo', 'la', 'le', 'un', 'di', 'da', 'in', 'su', 'ho', 'ha', 'mi', 'ti', 'si',
  'ci', 'al', 'ai', 'of', 'to', 'on', 'at', 'is', 'it', 'an', 'my', 'me', 'do', 'or',
  'as', 'by', 'up', 'we', 'so', 'if', 'no', 'ed', 'po',
]);

/** Exported for the bilingual voice tests: the same task for IT, EN and mixed queries. */
export function matchTaskTitle<T extends { title: string }>(items: T[], query: string): T | null {
  return bestMatch(items, query, (item) => item.title);
}

/**
 * Token-overlap scoring with a substring bonus. Deliberately simple: the
 * candidate set is small, and a predictable rule is easier to reason about
 * than an edit-distance threshold when a wrong match silently completes the
 * wrong task.
 */
function bestMatch<T>(
  items: T[],
  query: string,
  getText: (item: T) => string,
): T | null {
  const queryTokens = normalize(query);
  if (queryTokens.length === 0) return null;

  let best: { item: T; score: number } | null = null;

  for (const item of items) {
    const text = getText(item);
    const tokens = normalize(text);
    if (tokens.length === 0) continue;

    const overlap = queryTokens.filter((q) =>
      tokens.some((t) => t === q || t.startsWith(q) || q.startsWith(t)),
    ).length;

    let score = overlap / queryTokens.length;
    if (text.toLowerCase().includes(query.toLowerCase())) score += 0.5;

    if (score > (best?.score ?? 0)) best = { item, score };
  }

  // Below half the query's tokens matching, a "match" is more likely to be
  // wrong than right — better to ask than to act on the wrong task.
  return best && best.score >= 0.5 ? best.item : null;
}

function parseIsoLoose(value: string): number | null {
  const ts = Date.parse(value.length === 10 ? `${value}T09:00:00` : value);
  return Number.isNaN(ts) ? null : ts;
}

function guessCategory(name: string): string {
  const s = name.toLowerCase();
  if (/latte|formagg|yogurt|burro|uova/.test(s)) return 'latticini';
  if (/pane|pasta|riso|farina|biscott/.test(s)) return 'dispensa';
  if (/mela|banana|insalata|pomodor|verdur|frutta/.test(s)) return 'ortofrutta';
  if (/carne|pollo|pesce|prosciutt/.test(s)) return 'macelleria';
  if (/detersiv|sapone|carta|spazzol|shampoo/.test(s)) return 'casa';
  if (/vino|birra|acqua|succo/.test(s)) return 'bevande';
  return 'altro';
}
