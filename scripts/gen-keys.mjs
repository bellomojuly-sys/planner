#!/usr/bin/env node
/**
 * Generates the two key sets the Worker needs:
 *   MASTER_KEY  — AES-256 key that encrypts credentials, push keys, and the
 *                 raw text of every voice capture at rest.
 *   VAPID_*     — P-256 keypair identifying this server to push services.
 *
 * Run once. Keep the output out of git — it goes into `wrangler secret put`.
 */

import { webcrypto as crypto } from 'node:crypto';

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64url');

const masterKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

const vapid = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', vapid.publicKey)));
const jwk = await crypto.subtle.exportKey('jwk', vapid.privateKey);

console.log(`
Chiavi generate. Impostale come secret del Worker:

  echo "${masterKey}" | npx wrangler secret put MASTER_KEY
  echo "${publicKey}" | npx wrangler secret put VAPID_PUBLIC_KEY
  echo "${jwk.d}" | npx wrangler secret put VAPID_PRIVATE_KEY
  echo "mailto:tu@esempio.it" | npx wrangler secret put VAPID_SUBJECT

Per lo sviluppo locale, mettile in .dev.vars (già in .gitignore):

MASTER_KEY=${masterKey}
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${jwk.d}
VAPID_SUBJECT=mailto:tu@esempio.it

⚠️  Se cambi MASTER_KEY, i dati già cifrati non saranno più leggibili.
`);
