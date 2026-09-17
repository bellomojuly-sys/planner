#!/usr/bin/env node
/**
 * "Cosa manca per finire?" — risposta ricavata dallo stato reale, non dalla
 * memoria di nessuno.
 *
 * Esiste perché fra una sessione e l'altra passano settimane: quando torni,
 * un comando solo deve dirti a che punto sei e qual è la prossima mossa.
 *
 * Non stampa mai il valore di un secret: solo se c'è o no.
 *
 *   npm run status
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const workerName = /^name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? 'planner';
const routeHost = `https://${workerName}.giulia-planner.workers.dev`;

const GROUPS = [
  {
    name: 'Voce (Claude)',
    secrets: ['ANTHROPIC_API_KEY'],
    how: [
      'Crea una chiave su https://console.anthropic.com → API keys, poi:',
      '  npx wrangler secret put ANTHROPIC_API_KEY',
    ],
  },
  {
    name: 'Attività (Notion)',
    secrets: ['NOTION_TOKEN'],
    how: [
      'Crea un\'integrazione su https://notion.so/my-integrations, poi:',
      '  npx wrangler secret put NOTION_TOKEN',
      'Infine in Notion: apri Tasks → ··· → Connections → aggiungi l\'integrazione.',
      'Ripeti su "Task MG Integration". Senza questo il token è valido ma non vede niente.',
    ],
  },
  {
    name: 'Turni e lezioni (Google Calendar)',
    secrets: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    how: [
      'In Google Cloud Console: abilita Calendar API, crea un ID client OAuth',
      '(Applicazione web) con redirect http://127.0.0.1:8976/callback. Poi:',
      '  GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/google-auth.mjs',
      'Lo script apre il browser una volta e stampa i tre comandi già pronti.',
    ],
  },
  {
    name: 'Notifiche (push)',
    secrets: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    how: ['  node scripts/gen-keys.mjs   (e imposta i secret che stampa)'],
  },
  {
    name: 'Cifratura',
    secrets: ['MASTER_KEY'],
    how: ['  node scripts/gen-keys.mjs   ⚠ cambiarla rende illeggibili i dati già salvati'],
  },
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

console.log(`\n  PLANNER — stato\n  worker: ${workerName}\n`);

// --- 1. Secret ------------------------------------------------------------
let present = new Set();
let secretsReadable = true;
try {
  const out = sh('npx', ['wrangler', 'secret', 'list']);
  const start = out.indexOf('[');
  if (start >= 0) present = new Set(JSON.parse(out.slice(start)).map((s) => s.name));
} catch {
  secretsReadable = false;
}

const missing = [];
if (!secretsReadable) {
  console.log('  Non riesco a leggere i secret. Sei loggata? → npx wrangler login\n');
} else {
  console.log('  CREDENZIALI');
  for (const g of GROUPS) {
    const absent = g.secrets.filter((s) => !present.has(s));
    console.log(`    ${absent.length === 0 ? '✓' : '·'}  ${g.name}${absent.length ? '  — da fare' : ''}`);
    if (absent.length) missing.push(g);
  }
  console.log();
}

// --- 2. App online --------------------------------------------------------
console.log('  APP ONLINE');
try {
  const health = await fetch(`${routeHost}/api/health`, { signal: AbortSignal.timeout(12000) });
  const status = await (await fetch(`${routeHost}/api/auth/status`, { signal: AbortSignal.timeout(12000) })).json();
  console.log(`    ${health.ok ? '✓' : '·'}  raggiungibile — ${routeHost}`);
  console.log(`    ${status.pinSet ? '✓' : '·'}  PIN ${status.pinSet ? 'impostato' : 'da impostare (apri l\'app)'}`);
} catch {
  console.log('    ·  non raggiungibile');
}
console.log();

// --- 3. Codice ------------------------------------------------------------
console.log('  CODICE');
try {
  const dirty = sh('git', ['status', '--porcelain']).trim();
  console.log(dirty ? `    ·  ${dirty.split('\n').length} file non committati` : '    ✓  tutto committato');
} catch {
  /* non è un repo git */
}
console.log();

// --- 4. Prossima mossa ----------------------------------------------------
if (!secretsReadable) {
  console.log(`  STATO CREDENZIALI SCONOSCIUTO

    Accedi con:  npx wrangler login
    Poi rilancia:  npm run status
`);
} else if (missing.length === 0) {
  console.log(`  Tutto configurato. Verifica dall'app:
    Impostazioni → Verifica connessioni
  Poi assegna i ruoli ai calendari (busy per turni e lezioni) e collega i
  database Notion.\n`);
} else {
  const next = missing[0];
  console.log(`  PROSSIMA MOSSA — ${next.name}\n`);
  for (const line of next.how) console.log(`    ${line}`);
  console.log(`\n  Poi rilancia:  npm run status`);
  if (missing.length > 1) {
    console.log(`  Restano dopo questo: ${missing.slice(1).map((g) => g.name).join(', ')}`);
  }
  console.log();
}
