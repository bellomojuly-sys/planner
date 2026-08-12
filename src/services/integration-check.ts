import Anthropic from '@anthropic-ai/sdk';
import { listCalendars } from '../integrations/google-calendar';
import { assertOk, fetchWithTimeout } from '../lib/retry';
import { toPlannerError } from '../lib/errors';
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
  service: 'claude' | 'notion' | 'google' | 'push';
  state: CheckState;
  /** Italian, safe to show. Never contains the credential itself. */
  detail: string;
}

export async function checkIntegrations(env: Env): Promise<IntegrationCheck[]> {
  // Run them together: three sequential network probes make the settings
  // screen feel broken even when everything is fine.
  return Promise.all([
    checkClaude(env),
    checkNotion(env),
    checkGoogle(env),
    checkPush(env),
  ]);
}

async function checkClaude(env: Env): Promise<IntegrationCheck> {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      service: 'claude',
      state: 'missing',
      detail: 'Chiave non impostata. Serve per interpretare le note vocali.',
    };
  }

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
    // Retrieving a model validates the key without spending any tokens.
    const model = await client.models.retrieve('claude-opus-5');
    return {
      service: 'claude',
      state: 'ok',
      detail: `Collegata — ${model.display_name}.`,
    };
  } catch (err) {
    return { service: 'claude', state: 'error', detail: explain(err) };
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
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Chiave non valida o revocata. Controlla su console.anthropic.com.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'Chiave valida ma senza permessi su questo modello.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Chiave valida, ma il limite di richieste è stato superato. Riprova fra poco.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Impossibile raggiungere il servizio. Problema di rete?';
  }
  if (err instanceof Anthropic.APIError) {
    return `Il servizio ha risposto ${err.status ?? '?'}. Credito esaurito o chiave del progetto sbagliato?`;
  }
  return toPlannerError(err).userMessage;
}
