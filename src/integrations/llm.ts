import { z } from 'zod';
import { PlannerError } from '../lib/errors';
import { assertOk, fetchWithTimeout, withRetry } from '../lib/retry';
import { AREAS, ENERGY } from '../db/schema';
import type { Env } from '../env';

/**
 * Turns a spoken Italian or English sentence into structured intents, and writes the
 * daily briefing. Backed by DeepSeek through its OpenAI-format HTTP API.
 *
 * Thinking is disabled: these utterances are short and the schema is tight,
 * so reasoning adds cost and latency without changing the answer.
 *
 * DeepSeek's JSON mode guarantees valid JSON but not the shape, so the schema
 * is described in the prompt and every response is re-checked with zod.
 */

export const MODEL = 'deepseek-flash';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

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
    location: z.string().max(200).optional(),
    travelMinutes: z.number().int().min(0).max(240).optional(),
    preparationMinutes: z.number().int().min(0).max(240).optional(),
    recoveryMinutes: z.number().int().min(0).max(240).optional(),
    flexibility: z.enum(['fixed', 'low', 'medium', 'high']).optional(),
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
    /** Requested agenda day, resolved from "oggi", "domani" or a weekday. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    kind: z.literal('unclear'),
    reason: z.string(),
  }),
]);

export type Intent = z.infer<typeof IntentSchema>;

const ResponseSchema = z.object({
  intents: z.array(IntentSchema),
  /** Language detected from Giulia's utterance. */
  language: z.enum(['it', 'en']).default('it'),
  /** One short line, in the detected language, confirming what was understood. */
  summary: z.string(),
});

export type Interpretation = z.infer<typeof ResponseSchema>;

/** Exported for contract tests without making a paid model request. */
export function validateInterpretation(value: unknown) {
  return ResponseSchema.safeParse(value);
}

const ENGLISH_MARKERS = new Set([
  'the', 'an', 'my', 'is', 'are', 'what', 'do', 'have', 'to', 'for',
  'with', 'and', 'this', 'that', 'finished', 'done', 'move', 'buy', 'today',
  'tomorrow', 'plan', 'task', 'need', 'add', 'completed', 'from', 'on', 'at', 'of',
]);
const ITALIAN_MARKERS = new Set([
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'ho', 'devo', 'cosa', 'che', 'di', 'per',
  'con', 'e', 'questa', 'questo', 'finito', 'fatto', 'sposta', 'compra', 'oggi',
  'domani', 'piano', 'attività', 'mi', 'del', 'della', 'alla', 'al', 'completato',
]);

/**
 * Deterministic fallback when the model returns no usable language. Counts
 * function words, because content words (MG, Heemia, report) are shared.
 * A mixed sentence answers in the language of most of its grammar; a tie
 * stays Italian, the default everywhere else in the app.
 */
export function detectUtteranceLanguage(text: string): 'it' | 'en' {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let en = 0;
  let it = 0;
  for (const raw of words) {
    const word = raw.replace(/^[a-z]+'/, '');
    if (ENGLISH_MARKERS.has(word)) en++;
    if (ITALIAN_MARKERS.has(word)) it++;
  }
  return en > it ? 'en' : 'it';
}

/**
 * Models sometimes answer "mixed", "en-US" or "english". Those used to fail
 * the schema three times in a row and surface as "not understood" — the
 * reported English failure. Anything else is resolved from the text itself.
 */
export function normalizeInterpretationLanguage(json: unknown, text: string): unknown {
  if (!json || typeof json !== 'object') return json;
  const raw = (json as { language?: unknown }).language;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const language =
    value === 'it' || value.startsWith('it-') || value.startsWith('ital')
      ? 'it'
      : value === 'en' || value.startsWith('en-') || value.startsWith('engl') || value.startsWith('ingl')
        ? 'en'
        : detectUtteranceLanguage(text);
  return { ...(json as object), language };
}

/**
 * Hand-written rather than generated from the zod schema, so the prompt stays
 * short and readable. The constraints are re-checked by zod on the way out.
 */
const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents', 'language', 'summary'],
  properties: {
    language: {
      type: 'string',
      enum: ['it', 'en'],
      description: 'Lingua della richiesta: it per italiano, en per inglese.',
    },
    summary: {
      type: 'string',
      description:
        'Una frase breve nella lingua della richiesta che conferma cosa è stato capito.',
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
          location: { type: 'string' },
          travelMinutes: { type: 'integer' },
          preparationMinutes: { type: 'integer' },
          recoveryMinutes: { type: 'integer' },
          flexibility: {
            type: 'string',
            enum: ['fixed', 'low', 'medium', 'high'],
          },
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
          date: {
            type: 'string',
            description:
              'Per una domanda sul piano, data richiesta in formato YYYY-MM-DD. Se non è specificata, usa oggi.',
          },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------

/** Exported so tests can pin the language rules without a model call. */
export function buildSystemPrompt(context: InterpretContext): string {
  return `Sei l'assistente di pianificazione personale di Giulia. Interpreti frasi dettate a voce in italiano o inglese e le trasformi in azioni strutturate.

LINGUA
- Giulia parla italiano, inglese o un misto dei due nella stessa frase. Tutti e tre i casi sono normali e devono produrre le stesse azioni.
- Compila language solo con "it" o "en", mai altri valori. Per una frase mista usa la lingua della maggior parte della frase (verbi, articoli, domanda).
- Scrivi summary e reason nella lingua scelta per language.
- Il titolo di una NUOVA attività conserva le parole usate da Giulia, nella lingua in cui le ha dette.

CONTESTO
- Oggi è ${context.todayIso} (${context.weekdayName}), fuso orario Europe/Rome.
- Aree disponibili: general (attività personali e varie), mg (lavoro MG Integration), university (università), heemia (progetto Heemia), career (carriera, ICT, formazione professionale, candidature), personal, health, errand (commissioni).
- Attività aperte più rilevanti, per riconoscere i riferimenti:
${context.openTasks.map((t) => `  - ${t.title}${t.area ? ` [${t.area}]` : ''}`).join('\n') || '  (nessuna)'}
- Articoli sulla lista della spesa:
${context.shoppingItems.map((i) => `  - ${i}`).join('\n') || '  (nessuno)'}

COME INTERPRETARE
- Una frase può contenere più azioni: restituiscile tutte, nell'ordine in cui sono state dette.
- "ho finito X", "fatto X", "X è a posto", "I finished X", "X is done" → complete_task. Se dice quanto ci ha messo, compila actualMinutes.
- "ho completato quest'azione", "ho finito questa attività", "I completed this task" → complete_task. Conserva il riferimento generico in taskQuery: il sistema lo risolve in modo deterministico dall'unica attività in corso. Non scegliere un titolo dall'elenco.
- "sposta X a domani", "X lo faccio giovedì", "move X to tomorrow" → move_task.
- "non spostare X", "X deve restare qui" → set_task_pin con pinned true.
- "puoi spostare di nuovo X", "sblocca X" → set_task_pin con pinned false.
- "prima di X devo fare Y", "X dipende da Y" → add_dependency.
- "compra X", "finito il latte", "serve X", "buy X", "add X to my shopping list" → add_shopping_item.
- "preso il pane", "comprato X" → complete_shopping_item.
- Tutto il resto che descrive qualcosa da fare → create_task.
- Se la frase è una domanda sul piano ("cosa devo fare oggi?", "cosa devo fare lunedì?", "what do I have to do today?", "what is my plan for Monday?") → question. Compila sempre date con il giorno richiesto in formato YYYY-MM-DD; se non viene detto un giorno, usa oggi.
- Se davvero non è chiaro cosa intende, usa unclear e spiega perché nella lingua della richiesta.

STIME
Per ogni create_task stima sempre area, energy, priority, estimatedMinutes e flexibility. Quando il testo lo permette estrai anche location, travelMinutes, preparationMinutes e recoveryMinutes.
- energy alta: lavoro che richiede concentrazione profonda (scrivere, progettare, studiare, analizzare).
- energy media: riunioni, email, revisioni, amministrazione.
- energy bassa: commissioni, riordino, telefonate brevi, palestra.
- priority 1 solo se c'è una scadenza imminente o lo dice esplicitamente ("urgente", "subito").
- estimatedMinutes: sii realistica, arrotonda a multipli di 15. Non stimare mai meno di 10 minuti.
- flexibility fixed solo per un orario esterno già imposto; low per attività difficili da spostare; medium/high per lavoro flessibile.
- travelMinutes è il viaggio di andata. preparationMinutes include preparazione necessaria prima; recoveryMinutes include doccia, cambio o decompressione dopo.

DATE
Risolvi sempre i riferimenti relativi in date ISO usando la data di oggi. "domani", "venerdì", "fine mese", "tomorrow", "Friday", "end of the month" diventano YYYY-MM-DD.

RIFERIMENTI ALLE ATTIVITÀ ESISTENTI
Non inventare attività che Giulia non ha nominato. Quando cita un'attività che è nell'elenco delle attività aperte, in taskQuery (e in dependsOnQuery) copia il titolo ESATTO dall'elenco, carattere per carattere, qualunque lingua abbia usato: il sistema confronta le parole e non traduce. Esempi: "I finished the health insurance registration" con l'attività "Registrarsi all'assicurazione sanitaria" → taskQuery "Registrarsi all'assicurazione sanitaria"; "ho finito il report for MG" con "Report MG" → taskQuery "Report MG". Solo se nessuna attività dell'elenco corrisponde, riporta le parole di Giulia.

FORMATO DI RISPOSTA
Rispondi solo con un oggetto json valido che rispetta questo JSON Schema. Per ogni intent includi "kind" e solo i campi che lo riguardano.
${JSON.stringify(JSON_SCHEMA)}

Esempio per "ho finito la fattura e compra il latte":
{"language":"it","summary":"Segno la fattura come fatta e aggiungo il latte alla spesa.","intents":[{"kind":"complete_task","taskQuery":"la fattura"},{"kind":"add_shopping_item","name":"latte","category":"alimentari"}]}

Esempio per "move the report MG to tomorrow" con l'attività "Report MG" (domani = una data ISO):
{"language":"en","summary":"I’ll move Report MG to tomorrow.","intents":[{"kind":"move_task","taskQuery":"Report MG","moveTo":"YYYY-MM-DD"}]}

Esempio per la frase mista "ho finito il report for MG, cosa devo fare today?":
{"language":"it","summary":"Segno Report MG come fatto e ti dico il piano di oggi.","intents":[{"kind":"complete_task","taskQuery":"Report MG"},{"kind":"question","question":"Cosa devo fare oggi?","date":"${context.todayIso}"}]}

Esempio per "what is my plan for today?":
{"language":"en","summary":"I’ll show you today’s plan.","intents":[{"kind":"question","question":"What is my plan for today?","date":"${context.todayIso}"}]}`;
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

  return withRetry(
    async () => {
      const content = await chat(env, 'deepseek.interpret', {
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(context) },
          { role: 'user', content: text },
        ],
      });

      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        throw new PlannerError('upstream_rejected', {
          message: 'response is not valid json',
          retryable: true,
        });
      }

      const parsed = validateInterpretation(normalizeInterpretationLanguage(json, text));
      if (!parsed.success) {
        throw new PlannerError('upstream_rejected', {
          message: `schema mismatch: ${parsed.error.message.slice(0, 300)}`,
          retryable: true,
        });
      }

      return parsed.data;
    },
    { label: 'deepseek.interpret', attempts: 3 },
  );
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletion {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
}

/**
 * One chat completion with thinking off. Returns the message text, and turns
 * the ways DeepSeek can fail without an HTTP error into PlannerErrors.
 */
export async function chat(
  env: Env,
  label: string,
  body: {
    max_tokens: number;
    messages: ChatMessage[];
    response_format?: { type: 'json_object' };
  },
): Promise<string> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new PlannerError('config_missing', {
      message: 'DEEPSEEK_API_KEY not set',
      userMessage: 'La chiave DeepSeek non è impostata.',
      retryable: false,
    });
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${DEEPSEEK_BASE_URL}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          thinking: { type: 'disabled' },
          ...body,
        }),
      },
      30_000,
    );
  } catch (err) {
    if (err instanceof PlannerError) throw err;
    throw new PlannerError('upstream_unavailable', {
      message: `${label}: ${String(err)}`,
      retryable: true,
    });
  }
  await assertOk(res, label);

  const completion = (await res.json()) as ChatCompletion;
  const choice = completion.choices?.[0];

  if (choice?.finish_reason === 'length') {
    throw new PlannerError('upstream_rejected', {
      message: `${label}: response truncated`,
      userMessage: 'La richiesta era troppo lunga. Prova a dividerla.',
      retryable: false,
    });
  }
  if (choice?.finish_reason === 'content_filter') {
    throw new PlannerError('upstream_rejected', {
      message: `${label}: content filtered`,
      userMessage:
        'Non sono riuscita a interpretare questa richiesta. Prova a riformularla.',
      retryable: false,
    });
  }

  const content = choice?.message?.content?.trim() ?? '';
  if (!content) {
    // DeepSeek documents that JSON mode occasionally returns empty content.
    throw new PlannerError('upstream_rejected', {
      message: `${label}: empty content`,
      retryable: true,
    });
  }
  return content;
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
  return withRetry(
    () =>
      chat(env, 'deepseek.briefing', {
        max_tokens: 1200,
        messages: [
          {
            role: 'system',
            content:
              'Sei l’assistente di pianificazione di Giulia. Scrivi in italiano, in seconda persona, con tono diretto e caldo. Massimo 120 parole. Vai al punto: cosa conta oggi, cosa può slittare. Niente elenchi puntati se non servono davvero, niente preamboli.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    { label: 'deepseek.briefing', attempts: 2 },
  );
}
