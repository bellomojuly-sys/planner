import { PlannerError, toPlannerError } from './errors';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Label used in logs so a failure is traceable to a call site. */
  label: string;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full-jitter exponential backoff. Full jitter (rather than fixed or
 * equal-jitter) matters here because the cron tick fans out several Notion and
 * Google calls at once — without it they would retry in lockstep and hammer a
 * recovering upstream.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 20_000;

  let last: PlannerError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new PlannerError('upstream_unavailable', {
        message: `${opts.label}: aborted`,
      });
    }
    try {
      return await fn(attempt);
    } catch (err) {
      const pe = toPlannerError(err);
      last = pe;

      if (!pe.retryable || attempt === attempts) {
        console.error(
          `[retry] ${opts.label} failed on attempt ${attempt}/${attempts}: ${pe.code} ${pe.message}`,
        );
        throw pe;
      }

      const exponential = Math.min(max, base * 2 ** (attempt - 1));
      const delay = pe.retryAfterMs ?? Math.random() * exponential;
      console.warn(
        `[retry] ${opts.label} attempt ${attempt} → ${pe.code}, retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  throw last ?? new PlannerError('internal', { message: opts.label });
}

/**
 * Translates an HTTP response into the error taxonomy. Everything that talks
 * to Notion, Google or Anthropic funnels through here so retry semantics are
 * decided in exactly one place.
 */
export async function assertOk(res: Response, label: string): Promise<Response> {
  if (res.ok) return res;

  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfterMs = retryAfterHeader
    ? Number.isNaN(Number(retryAfterHeader))
      ? // The header may be an HTTP-date instead of seconds.
        Math.max(0, Date.parse(retryAfterHeader) - Date.now())
      : Number(retryAfterHeader) * 1000
    : undefined;

  // Bodies from failed upstream calls can contain echoed request data, so this
  // is truncated and kept server-side only — never put on a PlannerError's
  // userMessage.
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch {
    /* body already consumed or empty */
  }

  if (res.status === 429) {
    throw new PlannerError('rate_limited', {
      message: `${label}: 429 ${body}`,
      retryable: true,
      retryAfterMs: retryAfterMs ?? 2_000,
    });
  }
  if (res.status >= 500) {
    throw new PlannerError('upstream_unavailable', {
      message: `${label}: ${res.status} ${body}`,
      retryable: true,
      retryAfterMs,
    });
  }
  if (res.status === 401 || res.status === 403) {
    throw new PlannerError('config_missing', {
      message: `${label}: ${res.status} ${body}`,
      userMessage:
        'Le credenziali per un servizio esterno non sono più valide. Riconnetti l’integrazione dalle impostazioni.',
      retryable: false,
    });
  }
  if (res.status === 404) {
    throw new PlannerError('not_found', {
      message: `${label}: 404 ${body}`,
      retryable: false,
    });
  }

  throw new PlannerError('upstream_rejected', {
    message: `${label}: ${res.status} ${body}`,
    retryable: false,
  });
}

/** `fetch` with a hard timeout, since Workers has no default one. */
export async function fetchWithTimeout(
  input: RequestInfo,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new PlannerError('upstream_unavailable', {
        message: `timeout after ${timeoutMs}ms`,
        retryable: true,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
