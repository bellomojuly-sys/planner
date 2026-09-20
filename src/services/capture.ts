import { and, eq, ne, desc } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  tasks,
  taskSources,
  taskDependencies,
  shoppingItems,
  scheduledBlocks,
  captures,
  outbox,
  type Task,
} from '../db/schema';
import { interpretUtterance, type Intent } from '../integrations/llm';
import { applyLearning } from '../scheduler/estimate';
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
  summary: string;
  applied: string[];
  skipped: string[];
  answer?: string;
  /** ISO local date requested by an agenda question. */
  answerDate?: string;
  replanned: boolean;
}

/**
 * The voice pipeline: interpret → apply → reschedule.
 *
 * Every utterance is stored (encrypted) alongside Claude's parsed intents
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
      return {
        captureId: prior.id,
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
        const outcome = await applyIntent(env, db, userId, intent, timezone);
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

    return { captureId, summary, applied, skipped, answer, answerDate, replanned };
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
    .where(and(eq(tasks.userId, userId), ne(tasks.status, 'done')))
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
): Promise<IntentOutcome> {
  switch (intent.kind) {
    case 'create_task':
      return createTask(env, db, userId, intent);
    case 'complete_task':
      return completeTask(env, db, userId, intent);
    case 'move_task':
      return moveTask(db, userId, intent, timezone);
    case 'set_task_pin':
      return setTaskPin(db, userId, intent);
    case 'add_dependency':
      return addDependency(db, userId, intent);
    case 'add_shopping_item':
      return addShoppingItem(db, userId, intent);
    case 'complete_shopping_item':
      return completeShoppingItem(db, userId, intent);
    case 'question':
      return { answer: intent.question, answerDate: intent.date };
    case 'unclear':
      throw new PlannerError('bad_request', {
        userMessage: `Non ho capito: ${intent.reason}`,
      });
  }
}

async function createTask(
  env: Env,
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'create_task' }>,
): Promise<IntentOutcome> {
  const area = intent.area ?? 'general';
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
    message: `Aggiunta "${created!.title}", area ${spokenArea(area)} (${learned.plannedMinutes} min)`,
    trigger: intent.urgent || (intent.priority ?? 3) === 1 ? 'urgent_task' : 'capture',
  };
}

/** Human labels used in the short spoken confirmation returned to the Shortcut. */
export function spokenArea(area: string): string {
  const labels: Record<string, string> = {
    general: 'generale',
    mg: 'MG',
    university: 'università',
    heemia: 'Heemia',
    career: 'carriera',
    personal: 'personale',
    health: 'salute',
    errand: 'commissioni',
  };
  return labels[area] ?? area;
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
): Promise<IntentOutcome> {
  const task = await findTask(db, userId, intent.taskQuery);
  if (!task) {
    throw new PlannerError('not_found', {
      userMessage: `Non ho trovato un'attività che assomigli a "${intent.taskQuery}".`,
    });
  }

  // When Giulia does not say how long it took, infer it from the block that
  // was actually scheduled — still real data, just less precise.
  const actual =
    intent.actualMinutes ?? (await inferActualMinutes(db, userId, task.id));

  await completeTaskLocally(db, userId, task, actual);

  return {
    message: actual
      ? `Completata "${task.title}" (${actual} min reali)`
      : `Completata "${task.title}"`,
    trigger: 'dependency_cascade',
  };
}

async function moveTask(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'move_task' }>,
  timezone: string,
): Promise<IntentOutcome> {
  const task = await findTask(db, userId, intent.taskQuery);
  if (!task) {
    throw new PlannerError('not_found', {
      userMessage: `Non ho trovato "${intent.taskQuery}".`,
    });
  }

  let earliest: number | null = null;
  if (intent.moveTo) earliest = parseIsoLoose(intent.moveTo);
  else if (intent.shiftDays) earliest = Date.now() + intent.shiftDays * DAY_MS;

  if (!earliest) {
    throw new PlannerError('bad_request', {
      userMessage: `Non ho capito a quando spostare "${task.title}".`,
    });
  }

  // Unpin: the scheduler should find the best slot on or after the new date,
  // not the exact instant Claude guessed.
  await db
    .update(tasks)
    .set({ earliestStartAt: earliest, pinned: false })
    .where(eq(tasks.id, task.id));

  await db.delete(scheduledBlocks).where(eq(scheduledBlocks.taskId, task.id));

  return {
    message: `Spostata "${task.title}" a ${formatDayLong(earliest, timezone)}`,
    trigger: 'task_moved',
  };
}

async function setTaskPin(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'set_task_pin' }>,
): Promise<IntentOutcome> {
  const task = await findTask(db, userId, intent.taskQuery);
  if (!task) {
    throw new PlannerError('not_found', {
      userMessage: `Non ho trovato "${intent.taskQuery}".`,
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
      userMessage: `"${task.title}" non è ancora nel piano: prima scegli un orario.`,
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
    message: intent.pinned
      ? `"${task.title}" non verrà spostata automaticamente`
      : `"${task.title}" può essere ripianificata di nuovo`,
  };
}

async function addDependency(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'add_dependency' }>,
): Promise<IntentOutcome> {
  const [task, dependsOn] = await Promise.all([
    findTask(db, userId, intent.taskQuery),
    findTask(db, userId, intent.dependsOnQuery),
  ]);

  if (!task || !dependsOn) {
    throw new PlannerError('not_found', {
      userMessage: 'Non ho trovato entrambe le attività per creare la dipendenza.',
    });
  }
  if (task.id === dependsOn.id) {
    throw new PlannerError('bad_request', {
      userMessage: "Un'attività non può dipendere da sé stessa.",
    });
  }

  await db
    .insert(taskDependencies)
    .values({ userId, taskId: task.id, dependsOnId: dependsOn.id, createdBy: 'claude' })
    .onConflictDoNothing();

  return {
    message: `"${task.title}" ora dipende da "${dependsOn.title}"`,
    trigger: 'dependency_cascade',
  };
}

async function addShoppingItem(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'add_shopping_item' }>,
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
    return { message: `Aggiornata quantità di ${intent.name}` };
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

  return { message: `In lista: ${intent.name}` };
}

async function completeShoppingItem(
  db: DB,
  userId: string,
  intent: Extract<Intent, { kind: 'complete_shopping_item' }>,
): Promise<IntentOutcome> {
  const open = await db
    .select()
    .from(shoppingItems)
    .where(and(eq(shoppingItems.userId, userId), eq(shoppingItems.status, 'open')));

  const match = bestMatch(open, intent.itemQuery, (i) => i.name);
  if (!match) {
    throw new PlannerError('not_found', {
      userMessage: `"${intent.itemQuery}" non è nella lista.`,
    });
  }

  await db
    .update(shoppingItems)
    .set({ status: 'bought', completedAt: Date.now() })
    .where(eq(shoppingItems.id, match.id));

  return { message: `Preso: ${match.name}` };
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

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
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
