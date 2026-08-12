import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { users } from '../db/schema';
import { PlannerError } from '../lib/errors';
import {
  bytesToBase64,
  base64ToBytes,
  timingSafeEqual,
} from '../crypto/encryption';

/**
 * A 6-digit PIN has only a million combinations, so the hash alone is not the
 * defence — the lockout is. PBKDF2 makes each guess expensive; the escalating
 * lockout after 5 failures makes an online attack impractical.
 */

const DEFAULT_ITERATIONS = 210_000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_BASE_MS = 60_000;

export function assertPinFormat(pin: string): void {
  if (!/^\d{4,10}$/.test(pin)) {
    throw new PlannerError('bad_request', {
      userMessage: 'Il PIN deve essere composto da 4 a 10 cifre.',
    });
  }
}

async function derive(
  pin: string,
  saltB64: string,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltB64),
      iterations,
      hash: 'SHA-256',
    },
    key,
    256,
  );
  return bytesToBase64(new Uint8Array(bits));
}

export async function setPin(
  db: DB,
  userId: string,
  pin: string,
): Promise<void> {
  assertPinFormat(pin);
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(pin, salt, DEFAULT_ITERATIONS);

  await db
    .update(users)
    .set({
      pinHash: hash,
      pinSalt: salt,
      pinIterations: DEFAULT_ITERATIONS,
      failedPinAttempts: 0,
      lockedUntil: null,
    })
    .where(eq(users.id, userId));
}

export interface PinVerification {
  ok: boolean;
  attemptsLeft: number;
}

export async function verifyPin(
  db: DB,
  userId: string,
  pin: string,
): Promise<PinVerification> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new PlannerError('unauthorized');

  if (!user.pinHash || !user.pinSalt) {
    throw new PlannerError('config_missing', {
      userMessage: 'Nessun PIN impostato. Completa la configurazione iniziale.',
    });
  }

  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    throw new PlannerError('pin_locked', {
      retryAfterMs: user.lockedUntil - now,
      userMessage: `Troppi tentativi. Riprova tra ${Math.ceil(
        (user.lockedUntil - now) / 1000,
      )} secondi.`,
    });
  }

  const candidate = await derive(pin, user.pinSalt, user.pinIterations);
  const ok = timingSafeEqual(candidate, user.pinHash);

  if (ok) {
    await db
      .update(users)
      .set({ failedPinAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId));
    return { ok: true, attemptsLeft: MAX_ATTEMPTS };
  }

  const failed = user.failedPinAttempts + 1;
  // Doubles each time past the threshold: 1min, 2min, 4min, capped at 1 hour.
  const lockedUntil =
    failed >= MAX_ATTEMPTS
      ? now +
        Math.min(
          LOCKOUT_BASE_MS * 2 ** (failed - MAX_ATTEMPTS),
          60 * 60 * 1000,
        )
      : null;

  await db
    .update(users)
    .set({ failedPinAttempts: failed, lockedUntil })
    .where(eq(users.id, userId));

  if (lockedUntil) {
    throw new PlannerError('pin_locked', {
      retryAfterMs: lockedUntil - now,
    });
  }

  return { ok: false, attemptsLeft: Math.max(0, MAX_ATTEMPTS - failed) };
}
