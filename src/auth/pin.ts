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
 * A short PIN cannot safely be protected by an unkeyed database hash alone.
 * New hashes therefore use HMAC-SHA256 with MASTER_KEY as a server-side pepper
 * plus a per-user salt. A D1 dump is not enough to test PIN guesses offline,
 * while the escalating lockout below stops online guessing.
 *
 * `pinIterations > 0` remains readable for legacy PBKDF2 rows. New HMAC rows
 * use `pinIterations = 0`; unlike 210k-round PBKDF2, HMAC also stays inside the
 * CPU allowance of a Cloudflare Workers Free request.
 */

const HMAC_VERSION = 0;
const MAX_ATTEMPTS = 5;
const LOCKOUT_BASE_MS = 60_000;

let cachedPepper: CryptoKey | null = null;
let cachedPepperMaterial: string | null = null;

export function assertPinFormat(pin: string): void {
  if (!/^\d{4,10}$/.test(pin)) {
    throw new PlannerError('bad_request', {
      userMessage: 'Il PIN deve essere composto da 4 a 10 cifre.',
    });
  }
}

async function deriveLegacyPbkdf2(
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

async function importPepper(pepperB64: string): Promise<CryptoKey> {
  if (cachedPepper && cachedPepperMaterial === pepperB64) return cachedPepper;

  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = base64ToBytes(pepperB64);
  } catch {
    throw new PlannerError('config_missing', {
      message: 'PIN pepper is not valid base64',
      userMessage: 'Chiave di sicurezza del PIN non valida.',
    });
  }
  if (raw.length !== 32) {
    throw new PlannerError('config_missing', {
      message: `PIN pepper must decode to 32 bytes, got ${raw.length}`,
      userMessage: 'Chiave di sicurezza del PIN non valida.',
    });
  }

  cachedPepper = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedPepperMaterial = pepperB64;
  return cachedPepper;
}

export async function derivePinHash(
  pin: string,
  saltB64: string,
  pepperB64: string,
): Promise<string> {
  const key = await importPepper(pepperB64);
  const payload = new TextEncoder().encode(`planner-pin-v1\0${saltB64}\0${pin}`);
  const signature = await crypto.subtle.sign('HMAC', key, payload);
  return bytesToBase64(new Uint8Array(signature));
}

export async function createPinCredentials(
  pin: string,
  pepperB64: string,
): Promise<{ pinHash: string; pinSalt: string; pinIterations: number }> {
  assertPinFormat(pin);
  const pinSalt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  return {
    pinHash: await derivePinHash(pin, pinSalt, pepperB64),
    pinSalt,
    pinIterations: HMAC_VERSION,
  };
}

export async function setPin(
  db: DB,
  userId: string,
  pin: string,
  pepperB64: string,
): Promise<void> {
  const credentials = await createPinCredentials(pin, pepperB64);

  await db
    .update(users)
    .set({
      ...credentials,
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
  pepperB64: string,
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

  const candidate =
    user.pinIterations === HMAC_VERSION
      ? await derivePinHash(pin, user.pinSalt, pepperB64)
      : await deriveLegacyPbkdf2(pin, user.pinSalt, user.pinIterations);
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
