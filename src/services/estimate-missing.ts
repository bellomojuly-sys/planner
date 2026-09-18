import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client';
import { ENERGY, tasks } from '../db/schema';
import { chat } from '../integrations/llm';
import type { Env } from '../env';

/**
 * Gives a duration and an energy level to tasks Notion left without one.
 *
 * All 35 `Task MG Integration` rows arrived with `Energia` and `Durata
 * stimata` empty, so every one of them was planned as thirty minutes of
 * medium work — a plan with no mornings for hard work and no realistic
 * length. Giulia asked for the model to read what each task is and estimate
 * it (see `dl-how-planner-spreads-the-week`).
 *
 * Only rows still on the default estimate are sent, once each: the result is
 * stored with `estimateSource = 'claude'` (the column's name for "estimated
 * by the model"), and a value typed into Notion later always wins, because
 * the sync prefers Notion's figure over the stored one.
 */

const MAX_PER_RUN = 40;

const EstimatesSchema = z.object({
  estimates: z.array(
    z.object({
      id: z.string(),
      minutes: z.number(),
      energy: z.enum(ENERGY),
    }),
  ),
});

export function roundEstimate(minutes: number): number {
  // Quarters of an hour, between a short admin task and a full working day:
  // a model's "37 minutes" implies a precision it does not have.
  return Math.min(480, Math.max(15, Math.round(minutes / 15) * 15));
}

export async function estimateMissing(
  env: Env,
  db: DB,
  userId: string,
): Promise<number> {
  if (!env.DEEPSEEK_API_KEY) return 0;

  const pending = await db
    .select({ id: tasks.id, title: tasks.title, area: tasks.area, notes: tasks.notes })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.estimateSource, 'learned'),
        inArray(tasks.status, ['inbox', 'todo', 'scheduled', 'in_progress']),
      ),
    )
    .limit(MAX_PER_RUN);

  if (pending.length === 0) return 0;

  const content = await chat(env, 'deepseek.estimate', {
    max_tokens: 4096,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Stimi quanto tempo richiede ogni attività di Giulia e quanta concentrazione serve.

Per ogni attività rispondi con:
- minutes: durata realistica di UNA sessione di lavoro completa, in minuti. Un'attività breve (una mail, una telefonata) è 15; un documento o un'analisi 60–120; un progetto grande resta comunque sotto 480.
- energy: "high" per lavoro che richiede concentrazione profonda (scrivere, progettare, analizzare, programmare); "medium" per revisioni, riunioni, organizzazione; "low" per commissioni, amministrazione, attività ripetitive.

Leggi il titolo per capire di cosa si tratta. Non inventare attività.
Rispondi solo con un oggetto json:
{"estimates":[{"id":"...","minutes":60,"energy":"high"}]}`,
      },
      {
        role: 'user',
        content: JSON.stringify(
          pending.map((t) => ({
            id: t.id,
            title: t.title,
            area: t.area,
            notes: t.notes?.slice(0, 200) ?? undefined,
          })),
        ),
      },
    ],
  });

  const parsed = EstimatesSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    console.warn('[estimate] model answer did not match the schema');
    return 0;
  }

  const known = new Set(pending.map((t) => t.id));
  let updated = 0;
  for (const estimate of parsed.data.estimates) {
    // Ignore ids the model made up.
    if (!known.has(estimate.id)) continue;
    const minutes = roundEstimate(estimate.minutes);
    await db
      .update(tasks)
      .set({
        estimatedMinutes: minutes,
        plannedMinutes: minutes,
        energy: estimate.energy,
        estimateSource: 'claude',
        estimateConfidence: 0.4,
      })
      .where(and(eq(tasks.id, estimate.id), eq(tasks.userId, userId)));
    updated++;
  }
  return updated;
}
