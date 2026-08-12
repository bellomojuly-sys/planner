import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client';
import {
  durationSamples,
  estimateModel,
  tasks as tasksTable,
  type Area,
  type Energy,
  type Task,
} from '../db/schema';

/**
 * Closes the loop between "Claude thinks this takes 30 minutes" and how long
 * it actually takes Giulia.
 *
 * Every completed task contributes a ratio (actual / estimated) to one or more
 * buckets. A bucket's `biasFactor` is an exponential moving average of those
 * ratios, and it multiplies future estimates in that bucket. If admin work for
 * MG consistently runs 1.6× long, the planner starts booking 48 minutes for a
 * 30-minute guess — without Giulia ever adjusting a setting.
 */

/** Ratios outside this range are outliers (interrupted work, mistyped entry). */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;
/** Never distort an estimate by more than this, however lopsided the history. */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 2.5;
/** Below this, the bucket is too thin to trust on its own. */
const CONFIDENT_SAMPLES = 5;

export function bucketKeysFor(input: {
  area: Area;
  energy: Energy;
  title: string;
}): string[] {
  const keys = [`area:${input.area}`, `area:${input.area}|energy:${input.energy}`];

  // A single strong keyword captures recurring work ("fattura", "email",
  // "revisione") that behaves the same regardless of area.
  const keyword = dominantKeyword(input.title);
  if (keyword) keys.push(`kw:${keyword}`);

  return keys;
}

const STOPWORDS = new Set([
  'il','lo','la','i','gli','le','un','uno','una','di','a','da','in','con','su','per','tra','fra',
  'e','o','ma','che','del','della','dei','delle','al','allo','alla','ai','agli','alle','dal','dalla',
  'nel','nella','sul','sulla','fase','the','of','and','to','for',
]);

function dominantKeyword(title: string): string | null {
  const words = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  // The first substantive word is a stable-enough handle; ranking by frequency
  // would need a corpus we do not have on day one.
  return words[0] ?? null;
}

export interface LearnedAdjustment {
  plannedMinutes: number;
  factor: number;
  confidence: number;
  /** Which buckets contributed, for the "perché?" explanation in the UI. */
  basis: string[];
}

/**
 * Blends the buckets that have data, weighted by sample count. A brand-new
 * bucket contributes nothing, so an unseen kind of task keeps Claude's raw
 * estimate rather than inheriting a stranger's bias.
 */
export async function applyLearning(
  db: DB,
  userId: string,
  input: { area: Area; energy: Energy; title: string; estimatedMinutes: number },
): Promise<LearnedAdjustment> {
  const keys = bucketKeysFor(input);

  const rows = await db
    .select()
    .from(estimateModel)
    .where(
      and(eq(estimateModel.userId, userId), inArray(estimateModel.bucketKey, keys)),
    );

  if (rows.length === 0) {
    return {
      plannedMinutes: input.estimatedMinutes,
      factor: 1,
      confidence: 0.3,
      basis: [],
    };
  }

  let weightSum = 0;
  let weighted = 0;
  const basis: string[] = [];

  for (const row of rows) {
    if (row.sampleCount === 0) continue;
    // More specific buckets carry more weight per sample: a keyword match says
    // more than "this is an MG task".
    const specificity = row.bucketKey.startsWith('kw:')
      ? 3
      : row.bucketKey.includes('|')
        ? 2
        : 1;
    const weight = Math.min(row.sampleCount, 20) * specificity;
    weighted += row.biasFactor * weight;
    weightSum += weight;
    basis.push(row.bucketKey);
  }

  if (weightSum === 0) {
    return {
      plannedMinutes: input.estimatedMinutes,
      factor: 1,
      confidence: 0.3,
      basis: [],
    };
  }

  const factor = clamp(weighted / weightSum, MIN_FACTOR, MAX_FACTOR);
  const totalSamples = rows.reduce((s, r) => s + r.sampleCount, 0);

  return {
    // Round to 5 minutes: a plan reading "37 min" implies a precision the
    // model does not have.
    plannedMinutes: Math.max(5, Math.round((input.estimatedMinutes * factor) / 5) * 5),
    factor,
    confidence: Math.min(0.95, 0.3 + totalSamples / (CONFIDENT_SAMPLES * 4)),
    basis,
  };
}

/**
 * Records ground truth on completion and folds it into the model. Called from
 * the completion path, never from a sync — a task marked done in Notion has no
 * measured duration, so it teaches us nothing.
 */
export async function recordCompletion(
  db: DB,
  userId: string,
  task: Task,
  actualMinutes: number,
): Promise<void> {
  if (!Number.isFinite(actualMinutes) || actualMinutes <= 0) return;

  const estimated = Math.max(1, task.estimatedMinutes);
  const ratio = clamp(actualMinutes / estimated, MIN_RATIO, MAX_RATIO);

  await db.insert(durationSamples).values({
    userId,
    taskId: task.id,
    area: task.area,
    energy: task.energy,
    titleSample: task.title.slice(0, 120),
    estimatedMinutes: estimated,
    actualMinutes,
  });

  await db
    .update(tasksTable)
    .set({ actualMinutes })
    .where(and(eq(tasksTable.id, task.id), eq(tasksTable.userId, userId)));

  const keys = bucketKeysFor({
    area: task.area,
    energy: task.energy,
    title: task.title,
  });

  for (const key of keys) {
    const existing = await db.query.estimateModel.findFirst({
      where: and(
        eq(estimateModel.userId, userId),
        eq(estimateModel.bucketKey, key),
      ),
    });

    if (!existing) {
      await db.insert(estimateModel).values({
        userId,
        bucketKey: key,
        biasFactor: clamp(ratio, MIN_FACTOR, MAX_FACTOR),
        sampleCount: 1,
        meanAbsErrorMinutes: Math.abs(actualMinutes - estimated),
      });
      continue;
    }

    // Learning rate decays with sample count: the first few observations move
    // the estimate quickly, later ones only nudge it. Floored at 0.1 so the
    // model keeps tracking genuine changes in how Giulia works.
    const alpha = Math.max(0.1, 1 / (existing.sampleCount + 1));
    const nextFactor = clamp(
      existing.biasFactor + alpha * (ratio - existing.biasFactor),
      MIN_FACTOR,
      MAX_FACTOR,
    );
    const absError = Math.abs(actualMinutes - estimated);

    await db
      .update(estimateModel)
      .set({
        biasFactor: nextFactor,
        sampleCount: existing.sampleCount + 1,
        meanAbsErrorMinutes:
          existing.meanAbsErrorMinutes +
          (absError - existing.meanAbsErrorMinutes) / (existing.sampleCount + 1),
      })
      .where(eq(estimateModel.id, existing.id));
  }
}

/** Accuracy summary for the evening review. */
export async function estimateAccuracy(
  db: DB,
  userId: string,
): Promise<{ samples: number; meanRatio: number; withinTolerance: number }> {
  const rows = await db
    .select()
    .from(durationSamples)
    .where(eq(durationSamples.userId, userId));

  if (rows.length === 0) return { samples: 0, meanRatio: 1, withinTolerance: 0 };

  const ratios = rows.map((r) =>
    clamp(r.actualMinutes / Math.max(1, r.estimatedMinutes), MIN_RATIO, MAX_RATIO),
  );
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const within = ratios.filter((r) => r >= 0.75 && r <= 1.25).length;

  return {
    samples: rows.length,
    meanRatio: mean,
    withinTolerance: within / rows.length,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
