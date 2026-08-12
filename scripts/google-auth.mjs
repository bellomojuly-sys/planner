#!/usr/bin/env node
/**
 * One-time Google OAuth flow to obtain a refresh token.
 *
 * Runs a throwaway local server on 127.0.0.1 to catch the redirect, so no
 * copy-pasting of codes and no third-party service ever sees the token. The
 * refresh token it prints is the only Google credential the Worker stores.
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(`
Servono le credenziali OAuth. In Google Cloud Console:
  1. API e servizi → Abilita "Google Calendar API"
  2. Credenziali → Crea credenziali → ID client OAuth → Applicazione web
  3. URI di reindirizzamento autorizzati: ${REDIRECT_URI}

Poi:
  GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs
`);
  process.exit(1);
}

// CSRF guard: the callback must echo back the state we generated.
const state = randomBytes(16).toString('hex');

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES.join(' '));
// `offline` + `consent` together are what actually returns a refresh token;
// without `consent` Google omits it on repeat authorisations.
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');
authUrl.searchParams.set('state', state);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  if (url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('State non valido. Riprova.');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Autorizzazione negata: ${url.searchParams.get('error')}`);
    server.close();
    return;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const token = await tokenResponse.json();

  if (!token.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Google non ha restituito un refresh token. Revoca l’accesso e riprova.');
    console.error('Risposta:', token);
    server.close();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>Fatto</h1><p>Puoi chiudere questa scheda e tornare al terminale.</p>');

  console.log(`
Refresh token ottenuto. Impostalo come secret:

  echo "${CLIENT_ID}" | npx wrangler secret put GOOGLE_CLIENT_ID
  echo "${CLIENT_SECRET}" | npx wrangler secret put GOOGLE_CLIENT_SECRET
  echo "${token.refresh_token}" | npx wrangler secret put GOOGLE_REFRESH_TOKEN

Per lo sviluppo locale, in .dev.vars:

GOOGLE_CLIENT_ID=${CLIENT_ID}
GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}
GOOGLE_REFRESH_TOKEN=${token.refresh_token}
`);

  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nApri questo indirizzo nel browser:\n\n${authUrl}\n`);
});
