import { base64ToBytes, bytesToBase64Url } from '../crypto/encryption';
import { PlannerError } from '../lib/errors';
import { assertOk, fetchWithTimeout, withRetry } from '../lib/retry';

/**
 * Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) implemented directly on Web
 * Crypto.
 *
 * Hand-rolled rather than pulled from npm because the Node-oriented push
 * libraries assume `crypto`/`Buffer` and do not run on Workers. Everything
 * here is standard-library primitives, so there is no dependency to rot.
 *
 * This is what delivers the 07:00 briefing to an installed PWA on iOS without
 * a native app.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// ---------------------------------------------------------------------------
// Payload encryption
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function encryptPayload(
  subscription: PushSubscriptionKeys,
  plaintext: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const clientPublic = base64ToBytes(subscription.p256dh);
  const authSecret = base64ToBytes(subscription.auth);

  // Ephemeral sender keypair — a fresh one per message, as the spec requires.
  const senderKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const senderPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', senderKeys.publicKey),
  );

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: clientKey },
      senderKeys.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3: the key-derivation info binds both public keys, so a
  // captured message cannot be replayed against a different subscription.
  const keyInfo = concat(
    encoder.encode('WebPush: info\0'),
    clientPublic,
    senderPublic,
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: aes128gcm\0'),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode('Content-Encoding: nonce\0'),
    12,
  );

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, [
    'encrypt',
  ]);

  // 0x02 is the final-record delimiter; without it the browser rejects the
  // message as truncated.
  const padded = concat(encoder.encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded),
  );

  // Header: salt(16) | record size(4, BE) | key id length(1) | key id(65)
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = senderPublic.length;

  return concat(header, senderPublic, ciphertext);
}

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

async function importVapidKey(
  publicKeyB64: string,
  privateKeyB64: string,
): Promise<CryptoKey> {
  const pub = base64ToBytes(publicKeyB64);
  const priv = base64ToBytes(privateKeyB64);

  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new PlannerError('config_missing', {
      message: 'VAPID public key must be a 65-byte uncompressed P-256 point',
      userMessage:
        'Chiavi push non valide. Rigenerale con "node scripts/gen-keys.mjs".',
    });
  }

  // Web Crypto cannot import a bare P-256 scalar, so the private key is
  // reassembled as a JWK using the coordinates from the public point.
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: bytesToBase64Url(priv),
      x: bytesToBase64Url(pub.subarray(1, 33)),
      y: bytesToBase64Url(pub.subarray(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

async function buildVapidHeader(
  endpoint: string,
  vapid: VapidConfig,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    // 12 hours: comfortably inside the 24-hour maximum push services accept.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  };

  const signingInput = `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.${bytesToBase64Url(
    encoder.encode(JSON.stringify(payload)),
  )}`;

  const key = await importVapidKey(vapid.publicKey, vapid.privateKey);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      encoder.encode(signingInput),
    ),
  );

  // Web Crypto already emits the raw r‖s form ES256 requires — no DER unwrap.
  return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${vapid.publicKey}`;
}

// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  /** True when the subscription is dead and the row should be deleted. */
  expired: boolean;
  error?: string;
}

export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: PushPayload,
  vapid: VapidConfig,
): Promise<SendResult> {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const authorization = await buildVapidHeader(subscription.endpoint, vapid);

  try {
    await withRetry(
      async () => {
        const res = await fetchWithTimeout(
          subscription.endpoint,
          {
            method: 'POST',
            headers: {
              Authorization: authorization,
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: '86400',
              Urgency: 'normal',
            },
            body,
          },
          10_000,
        );

        // 404/410 mean the user uninstalled the PWA or revoked permission.
        if (res.status === 404 || res.status === 410) {
          throw new PlannerError('not_found', {
            message: 'subscription gone',
            retryable: false,
          });
        }

        await assertOk(res, 'webpush.send');
        return res;
      },
      { label: 'webpush.send', attempts: 3 },
    );

    return { ok: true, expired: false };
  } catch (err) {
    if (err instanceof PlannerError && err.code === 'not_found') {
      return { ok: false, expired: true };
    }
    return {
      ok: false,
      expired: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
