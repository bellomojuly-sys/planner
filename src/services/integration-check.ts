import { DEEPSEEK_BASE_URL, MODEL as LLM_MODEL } from '../integrations/llm';
import { cleanSecret, listCalendars } from '../integrations/google-calendar';
import { assertOk, fetchWithTimeout } from '../lib/retry';
import { PlannerError, toPlannerError } from '../lib/errors';
import type { Env } from '../env';

/**
 * Actually talks to each third party, rather than checking that a secret is
 * present.
 *
 * Connecting three services means three chances to paste the wrong string, and
 * a key that merely *exists* looks identical to one that works until the first
 * voice note fails at 07:00. Each probe below is chosen to be free and
 * read-only: no tokens are generated, no calendar is written, nothing is
 * created.
 */

export type CheckState = 'ok' | 'missing' | 'error';

export interface IntegrationCheck {
  service: 'voice' | 'notion' | 'google' | 'push';
  state: CheckState;
  /** Italian, safe to show. Never contains the credential itself. */
  detail: string;
}

export async function checkIntegrations(
  env: Env,
  options: { notionRequired?: boolean } = {},
): Promise<IntegrationCheck[]> {
  // Run them together: three sequential network probes make the settings
  // screen feel broken even when everything is fine.
  return Promise.all([
    checkVoice(env),
    options.notionRequired === false
      ? Promise.resolve<IntegrationCheck>({
          service: 'notion',
          state: 'ok',
          detail: 'Opzionale — nessun database attività Notion è attivo.',
        })
      : checkNotion(env),
    checkGoogle(env),
    checkPush(env),
  ]);
}

async function checkVoice(env: Env): Promise<IntegrationCheck> {
  if (!env.DEEPSEEK_API_KEY) {
    return {
      service: 'voice',
      state: 'missing',
      detail: 'Chiave DeepSeek non impostata. Serve per interpretare le note vocali.',
    };
  }

  try {
    // Listing models validates the key without spending any tokens.
    const res = await fetchWithTimeout(
      `${DEEPSEEK_BASE_URL}/models`,
      { headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` } },
      10_000,
    );
    await assertOk(res, 'deepseek.check');
    const models = ((await res.json()) as { data?: Array<{ id: string }> }).data ?? [];
    const available = models.some((m) => m.id === LLM_MODEL);
    return {
      service: 'voice',
      state: available ? 'ok' : 'error',
      detail: available
        ? `Collegata — DeepSeek ${LLM_MODEL}.`
        : `Chiave valida, ma il modello ${LLM_MODEL} non è nell’elenco di DeepSeek.`,
    };
  } catch (err) {
    return { service: 'voice', state: 'error', detail: explain(err) };
  }
}

async function checkNotion(env: Env): Promise<IntegrationCheck> {
  if (!env.NOTION_TOKEN) {
    return {
      service: 'notion',
      state: 'missing',
      detail: 'Token non impostato. Serve per leggere le attività.',
    };
  }

  try {
    const res = await fetchWithTimeout(
      'https://api.notion.com/v1/users/me',
      {
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
        },
      },
      10_000,
    );
    await assertOk(res, 'notion.check');
    const me = (await res.json()) as { name?: string; bot?: { owner?: unknown } };

    // A valid token still reaches nothing until the integration is connected
    // to the databases from Notion's own share menu — the most common reason
    // for an empty first sync.
    const dbRes = await fetchWithTimeout(
      'https://api.notion.com/v1/search',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filter: { value: 'database', property: 'object' },
          page_size: 10,
        }),
      },
      10_000,
    );
    await assertOk(dbRes, 'notion.check.search');
    const found = ((await dbRes.json()) as { results?: unknown[] }).results ?? [];

    return {
      service: 'notion',
      state: found.length > 0 ? 'ok' : 'error',
      detail:
        found.length > 0
          ? `Collegata come "${me.name ?? 'integrazione'}" — ${found.length} database raggiungibili.`
          : 'Token valido, ma nessun database condiviso con l’integrazione. In Notion apri Tasks → ··· → Connections e aggiungila.',
    };
  } catch (err) {
    return { service: 'notion', state: 'error', detail: explain(err) };
  }
}

async function checkGoogle(env: Env): Promise<IntegrationCheck> {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return {
      service: 'google',
      state: 'missing',
      detail: 'Credenziali non impostate. Servono per turni e lezioni.',
    };
  }

  if (!cleanSecret(env.GOOGLE_CLIENT_ID).endsWith('.apps.googleusercontent.com')) {
    return {
      service: 'google',
      state: 'error',
      detail:
        'Il Client ID salvato non è un Client ID Google (deve finire con .apps.googleusercontent.com). Salvalo di nuovo.',
    };
  }

  try {
    // Exercises the whole chain: refresh token → access token → API call.
    const calendars = await listCalendars(env);
    return {
      service: 'google',
      state: 'ok',
      detail: `Collegato — ${calendars.length} calendari visibili.`,
    };
  } catch (err) {
    return { service: 'google', state: 'error', detail: explain(err) };
  }
}

async function checkPush(env: Env): Promise<IntegrationCheck> {
  const configured =
    Boolean(env.VAPID_PUBLIC_KEY) &&
    Boolean(env.VAPID_PRIVATE_KEY) &&
    Boolean(env.VAPID_SUBJECT);

  return {
    service: 'push',
    state: configured ? 'ok' : 'missing',
    // There is nothing to probe: a push only proves itself against a real
    // subscription, which the browser creates.
    detail: configured
      ? 'Chiavi presenti. Attiva le notifiche dal pulsante qui sotto.'
      : 'Chiavi VAPID non impostate.',
  };
}

/**
 * The whole point of this screen is telling a wrong key apart from an
 * unreachable service, so a generic "unexpected error" would defeat it. The
 * SDK's typed errors carry that distinction; `toPlannerError` does not know
 * about them, so they are matched first.
 */
function explain(err: unknown): string {
  if (err instanceof PlannerError) {
    if (err.message.includes('invalid_client')) {
      return 'Google non riconosce il Client ID o il Client secret. Devono essere dello stesso client OAuth.';
    }
    if (err.message.includes('invalid_grant')) {
      return 'Il refresh token Google non vale per questo client o è stato revocato. Rifai scripts/google-auth.mjs.';
    }
    if (err.code === 'config_missing') {
      return 'Credenziali rifiutate dal servizio. Controlla la chiave di questa integrazione.';
    }
    if (err.code === 'rate_limited') {
      return 'Chiave valida, ma il limite di richieste è stato superato. Riprova fra poco.';
    }
    if (err.message.includes(': 402')) {
      return 'Chiave valida, ma il credito è esaurito.';
    }
  }
  return toPlannerError(err).userMessage;
}
