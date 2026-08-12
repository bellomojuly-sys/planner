/**
 * Every failure that can reach the UI carries an Italian message written for
 * Giulia, not a stack trace. `retryable` tells the outbox runner whether it is
 * worth trying again; `status` is the HTTP code the router should emit.
 */
export type ErrorCode =
  | 'unauthorized'
  | 'pin_locked'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_rejected'
  | 'config_missing'
  | 'internal';

const ITALIAN: Record<ErrorCode, string> = {
  unauthorized: 'Sessione scaduta. Inserisci di nuovo il PIN.',
  pin_locked: 'Troppi tentativi. Riprova tra qualche minuto.',
  bad_request: 'Richiesta non valida.',
  not_found: 'Non trovato.',
  conflict: 'Qualcosa è cambiato nel frattempo. Ricarica e riprova.',
  rate_limited: 'Troppe richieste al servizio esterno. Riprovo tra poco.',
  upstream_unavailable:
    'Il servizio esterno non risponde. I dati salvati sono al sicuro, riprovo automaticamente.',
  upstream_rejected: 'Il servizio esterno ha rifiutato la richiesta.',
  config_missing: 'Configurazione incompleta. Controlla le impostazioni.',
  internal: 'Errore imprevisto. Riprova.',
};

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  pin_locked: 429,
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_unavailable: 503,
  upstream_rejected: 502,
  config_missing: 500,
  internal: 500,
};

export class PlannerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Safe to show in the PWA. Never contains keys or upstream internals. */
  readonly userMessage: string;
  readonly retryable: boolean;
  /** Honours a `Retry-After` header when the upstream sent one. */
  readonly retryAfterMs?: number;
  readonly detail?: unknown;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      userMessage?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      detail?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'PlannerError';
    this.code = code;
    this.status = STATUS[code];
    this.userMessage = options.userMessage ?? ITALIAN[code];
    this.retryable =
      options.retryable ??
      (code === 'rate_limited' || code === 'upstream_unavailable');
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.userMessage,
      retryable: this.retryable,
    };
  }
}

export function toPlannerError(err: unknown): PlannerError {
  if (err instanceof PlannerError) return err;
  if (err instanceof Error) {
    // Workers surfaces connection resets as plain TypeErrors; those are worth
    // retrying, unlike a genuine programming error.
    const transient = /fetch failed|network|socket|timeout|aborted/i.test(
      err.message,
    );
    return new PlannerError(transient ? 'upstream_unavailable' : 'internal', {
      message: err.message,
      retryable: transient,
      cause: err,
    });
  }
  return new PlannerError('internal', { detail: err });
}
