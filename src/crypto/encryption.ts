import { PlannerError } from '../lib/errors';

/**
 * AES-256-GCM envelope encryption for everything sensitive at rest: Notion and
 * Google credentials, push subscription keys, and the raw text of every voice
 * capture.
 *
 * The key lives only in the Worker's secret store. D1 holds ciphertext, so a
 * database dump on its own reveals nothing. `keyVersion` on each row leaves
 * room to rotate MASTER_KEY without a flag day.
 */

const ALGO = 'AES-GCM';
const IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeyMaterial: string | null = null;

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  // Isolate caching per key string so a rotated secret is not served stale
  // from a warm isolate.
  if (cachedKey && cachedKeyMaterial === masterKeyB64) return cachedKey;

  const raw = base64ToBytes(masterKeyB64);
  if (raw.length !== 32) {
    throw new PlannerError('config_missing', {
      message: `MASTER_KEY must decode to 32 bytes, got ${raw.length}`,
      userMessage:
        'Chiave di cifratura non valida. Rigenerala con "node scripts/gen-keys.mjs".',
    });
  }

  cachedKey = await crypto.subtle.importKey('raw', raw, ALGO, false, [
    'encrypt',
    'decrypt',
  ]);
  cachedKeyMaterial = masterKeyB64;
  return cachedKey;
}

export interface Sealed {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

export async function seal(
  plaintext: string,
  masterKeyB64: string,
): Promise<Sealed> {
  const key = await importKey(masterKeyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const buf = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  return {
    ciphertext: bytesToBase64(new Uint8Array(buf)),
    iv: bytesToBase64(iv),
    keyVersion: 1,
  };
}

export async function open(
  sealed: { ciphertext: string; iv: string },
  masterKeyB64: string,
): Promise<string> {
  const key = await importKey(masterKeyB64);
  try {
    const buf = await crypto.subtle.decrypt(
      { name: ALGO, iv: base64ToBytes(sealed.iv) },
      key,
      base64ToBytes(sealed.ciphertext),
    );
    return new TextDecoder().decode(buf);
  } catch (err) {
    // GCM authentication failure: wrong key, or the row was tampered with.
    throw new PlannerError('config_missing', {
      message: 'decryption failed',
      userMessage:
        'Impossibile decifrare i dati salvati. La chiave di cifratura è cambiata?',
      cause: err,
    });
  }
}

export async function sealJson<T>(
  value: T,
  masterKeyB64: string,
): Promise<Sealed> {
  return seal(JSON.stringify(value), masterKeyB64);
}

export async function openJson<T>(
  sealed: { ciphertext: string; iv: string },
  masterKeyB64: string,
): Promise<T> {
  return JSON.parse(await open(sealed, masterKeyB64)) as T;
}

// ---------------------------------------------------------------------------
// Encoding helpers, shared with the push and auth modules.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on large payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '=',
  );
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time comparison, for anything derived from a secret. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
