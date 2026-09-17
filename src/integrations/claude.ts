import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { PlannerError, toPlannerError } from '../lib/errors';
import { withRetry } from '../lib/retry';
import { AREAS, ENERGY } from '../db/schema';
import type { Env } from '../env';

/**
 * Turns a spoken Italian sentence into structured intents.
 *
 * Runs on Haiku 4.5 without thinking, the cheapest current model. These
 * utterances are short and the schema is tight, so extra reasoning depth buys
 * nothing. Haiku 4.5 rejects `effort`, so it is not sent.
 *
 * Structured outputs (rather than prose parsing) means a malformed response is
 * impossible: the API constrains generation to the schema.
 */

export const MODEL = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// Intent shapes
// ---------------------------------------------------------------------------

const IntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create_task'),
    title: z.string(),
    notes: z.string().optional(),
    area: z.enum(AREAS).optional(),
    energy: z.enum(ENERGY).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    estimatedMinutes: z.number().int().min(5).max(600).optional(),
    /** ISO date or a relative phrase already resolved by the model. */
    dueAt: z.string().optional(),
    dependsOnTitles: z.array(z.string()).optional(),
    urgent: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('complete_task'),
    taskQuery: z.string(),
    /** Real elapsed time, when Giulia says how long it took. */
    actualMinutes: z.number().int().min(1).max(1440).optional(),
  }),
  z.object({
    kind: z.literal('move_task'),
    taskQuery: z.string(),
    /** ISO instant or date the task should move to. */
    moveTo: z.string().optional(),
    /** "domani", "prossima settimana" → relative days. */
    shiftDays: z.number().int().min(-30).max(90).optional(),
  }),
  z.object({
    kind: z.literal('set_task_pin'),
    taskQuery: z.string(),
    /** True for “non spostare”, false when Giulia releases it again. */
    pinned: z.boolean(),
  }),
  z.object({
    kind: z.literal('add_dependency'),
    taskQuery: z.string(),
    dependsOnQuery: z.string(),
  }),
  z.object({
    kind: z.literal('add_shopping_item'),
    name: z.string(),
    quantity: z.number().min(0.1).max(1000).optional(),
    unit: z.string().optional(),
    category: z.string().optional(),
    store: z.string().optional(),
    urgent: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('complete_shopping_item'),
    itemQuery: z.string(),
  }),
  z.object({
    kind: z.literal('question'),
    question: z.string(),
  }),
  z.object({
    kind: z.literal('unclear'),
    reason: z.string(),
  }),
]);

export type Intent = z.infer<typeof IntentSchema>;

const ResponseSchema = z.object({
  intents: z.array(IntentSchema),
  /** One short Italian line confirming what was understood. */
  summary: z.string(),
});

export type Interpretation = z.infer<typeof ResponseSchema>;

/** Exported for contract tests without making a paid Anthropic request. */
export function validateInterpretation(value: unknown) {
  return ResponseSchema.safeParse(value);
}

/**
 * Hand-written rather than generated from the zod schema: structured outputs
 * rejects several JSON Schema keywords zod emits (string/number constraints),
 * and the constraints are re-checked by zod on the way out anyway.
 */
const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents', 'summary'],
  properties: {
    summary: {
      type: 'string',
      description:
        'Una frase breve in italiano che conferma cosa è stato capito.',
    },
    intents: {
      type: 'array',
      description: 'Le azioni richieste, in ordine.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'create_task',
              'complete_task',
              'move_task',
              'set_task_pin',
              'add_dependency',
              'add_shopping_item',
              'complete_shopping_item',
              'question',
              'unclear',
            ],
          },
          title: { type: 'string' },
          notes: { type: 'string' },
          area: { type: 'string', enum: [...AREAS] },
          energy: { type: 'string', enum: [...ENERGY] },
          priority: {
            type: 'integer',
            description: '1 = urgentissimo, 4 = quando capita.',
          },
          estimatedMinutes: { type: 'integer' },
          dueAt: {
            type: 'string',
            description: 'Data ISO 8601 (YYYY-MM-DD o completa).',
          },
          dependsOnTitles: { type: 'array', items: { type: 'string' } },
          urgent: { type: 'boolean' },
          taskQuery: {
            type: 'string',
            description:
              'Testo che identifica un’attività esistente, come lo ha detto Giulia.',
          },
          actualMinutes: { type: 'integer' },
          moveTo: { type: 'string' },
          shiftDays: { type: 'integer' },
          pinned: { type: 'boolean' },
          dependsOnQuery: { type: 'string' },
          name: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          category: { type: 'string' },
          store: { type: 'string' },
          itemQuery: { type: 'string' },
          question: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------

function buildSystemPrompt(context: InterpretContext): string {
  return `Sei l'assistente di pianificazione personale di Giulia. Interpreti frasi dettate a voce in italiano e le trasformi in azioni strutturate.

CONTESTO
- Oggi è ${context.todayIso} (${context.weekdayName}), fuso orario Europe/Rome.
- Aree disponibili: general (attività personali e varie), mg (lavoro MG Integration), university (università), heemia (progetto Heemia), career (carriera, ICT, formazione professionale, candidature), personal, health, errand (commissioni).
- Attività aperte più rilevanti, per riconoscere i riferimenti:
${context.openTasks.map((t) => `  - ${t.title}${t.area ? ` [${t.area}]` : ''}`).join('\n') || '  (nessuna)'}
- Articoli sulla lista della spesa:
${context.shoppingItems.map((i) => `  - ${i}`).join('\n') || '  (nessuno)'}

COME INTERPRETARE
- Una frase può contenere più azioni: restituiscile tutte, nell'ordine in cui sono state dette.
- "ho finito X", "fatto X", "X è a posto" → complete_task. Se dice quanto ci ha messo ("ci ho messo un'ora"), compila actualMinutes.
- "sposta X a domani", "X lo faccio giovedì" → move_task.
- "non spostare X", "X deve restare qui" → set_task_pin con pinned true.
- "puoi spostare di nuovo X", "sblocca X" → set_task_pin con pinned false.
- "prima di X devo fare Y", "X dipende da Y" → add_dependency.
- "compra X", "finito il latte", "serve X" → add_shopping_item.
- "preso il pane", "comprato X" → complete_shopping_item.
- Tutto il resto che descrive qualcosa da fare → create_task.
- Se la frase è una domanda sul piano ("cosa devo fare oggi?") → question.
- Se davvero non è chiaro cosa intende, usa unclear e spiega perché in italiano.

STIME
Per ogni create_task stima sempre area, energy, priority ed estimatedMinutes.
- energy alta: lavoro che richiede concentrazione profonda (scrivere, progettare, studiare, analizzare).
- energy media: riunioni, email, revisioni, amministrazione.
- energy bassa: commissioni, riordino, telefonate brevi, palestra.
- priority 1 solo se c'è una scadenza imminente o lo dice esplicitamente ("urgente", "subito").
- estimatedMinutes: sii realistica, arrotonda a multipli di 15. Non stimare mai meno di 10 minuti.

DATE
Risolvi sempre i riferimenti relativi in date ISO usando la data di oggi. "domani", "venerdì", "fine mese" diventano YYYY-MM-DD.

Non inventare attività che Giulia non ha nominato. Se cita un'attività esistente, riporta in taskQuery le sue parole, non una tua riformulazione.`;
}

export interface InterpretContext {
  todayIso: string;
  weekdayName: string;
  openTasks: Array<{ title: string; area?: string }>;
  shoppingItems: string[];
}

export async function interpretUtterance(
  env: Env,
  text: string,
  context: InterpretContext,
): Promise<Interpretation> {
  if (!text.trim()) {
    throw new PlannerError('bad_request', {
      userMessage: 'Non ho sentito nulla. Riprova.',
    });
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Retries are handled by withRetry so backoff and error mapping stay in
    // one place; letting the SDK also retry would multiply the delays.
    maxRetries: 0,
  });

  return withRetry(
    async () => {
      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          output_config: {
            format: { type: 'json_schema', schema: JSON_SCHEMA },
          },
          system: buildSystemPrompt(context),
          messages: [{ role: 'user', content: text }],
        });
      } catch (err) {
        throw mapAnthropicError(err);
      }

      if (response.stop_reason === 'refusal') {
        throw new PlannerError('upstream_rejected', {
          message: 'claude refused',
          userMessage:
            'Non sono riuscita a interpretare questa richiesta. Prova a riformularla.',
          retryable: false,
        });
      }

      if (response.stop_reason === 'max_tokens') {
        throw new PlannerError('upstream_rejected', {
          message: 'response truncated',
          userMessage: 'La richiesta era troppo lunga. Prova a dividerla.',
          retryable: false,
        });
      }

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new PlannerError('upstream_rejected', {
          message: 'no text block in response',
          retryable: true,
        });
      }

      const parsed = validateInterpretation(JSON.parse(textBlock.text));
      if (!parsed.success) {
        // Structured outputs makes this near-impossible, but a schema drift
        // should surface as a clear error rather than a silent bad write.
        throw new PlannerError('upstream_rejected', {
          message: `schema mismatch: ${parsed.error.message}`,
          userMessage: 'Risposta inattesa dal modello. Riprova.',
          retryable: true,
        });
      }

      return parsed.data;
    },
    { label: 'claude.interpret', attempts: 3 },
  );
}

function mapAnthropicError(err: unknown): PlannerError {
  if (err instanceof Anthropic.RateLimitError) {
    return new PlannerError('rate_limited', {
      message: err.message,
      retryable: true,
      retryAfterMs: 3_000,
    });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new PlannerError('config_missing', {
      message: err.message,
      userMessage: 'La chiave Claude non è valida. Controlla la configurazione.',
      retryable: false,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new PlannerError('upstream_unavailable', {
      message: err.message,
      retryable: true,
    });
  }
  if (err instanceof Anthropic.APIError) {
    return new PlannerError(
      err.status && err.status >= 500 ? 'upstream_unavailable' : 'upstream_rejected',
      { message: `${err.status}: ${err.message}`, retryable: (err.status ?? 0) >= 500 },
    );
  }
  return toPlannerError(err);
}

/**
 * Free-text daily briefing. Separate from intent parsing because the failure
 * mode is different: if this call fails, the plan is still valid and the UI
 * falls back to a plain rendering of the blocks.
 */
export async function composeBriefing(
  env: Env,
  prompt: string,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });

  return withRetry(
    async () => {
      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 1200,
          system:
            'Sei l’assistente di pianificazione di Giulia. Scrivi in italiano, in seconda persona, con tono diretto e caldo. Massimo 120 parole. Vai al punto: cosa conta oggi, cosa può slittare. Niente elenchi puntati se non servono davvero, niente preamboli.',
          messages: [{ role: 'user', content: prompt }],
        });
      } catch (err) {
        throw mapAnthropicError(err);
      }

      const textBlock = response.content.find((b) => b.type === 'text');
      return textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
    },
    { label: 'claude.briefing', attempts: 2 },
  );
}
