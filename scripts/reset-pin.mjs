#!/usr/bin/env node
/**
 * Azzera il PIN dimenticato.
 *
 * Il PIN non è recuperabile per costruzione: è un HMAC-SHA256 con MASTER_KEY
 * come pepper, e quel secret vive solo dentro il Worker. Nemmeno `wrangler` lo
 * rivela. L'unica cosa possibile è cancellare l'hash e sceglierne uno nuovo.
 *
 * Non serve toccare MASTER_KEY — anzi, non va toccato: cambiarlo renderebbe
 * illeggibili credenziali, chiavi delle notifiche e note vocali già salvate.
 *
 * Cosa fa:
 *   1. svuota pin_hash / pin_salt e sblocca eventuali tentativi falliti;
 *   2. cancella le sessioni attive, così un dispositivo ancora loggato non
 *      resta dentro dopo un reset che non hai fatto tu.
 * Tutto il resto — attività, blocchi, spesa, stime imparate — resta intatto.
 *
 * Dopo averlo eseguito, apri l'app: mostrerà "Nuovo PIN" al posto della
 * tastiera. Il PIN nuovo lo digiti lì, non qui: così non finisce in nessun
 * log, cronologia della shell o trascrizione.
 *
 * Uso:
 *   node scripts/reset-pin.mjs            # produzione (--remote)
 *   node scripts/reset-pin.mjs --local    # database locale di sviluppo
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const local = process.argv.includes('--local');
const target = local ? '--local' : '--remote';

// Il nome del database sta in wrangler.toml: leggerlo evita che lo script
// scada quando il progetto viene rinominato.
let dbName;
try {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  dbName = /database_name\s*=\s*"([^"]+)"/.exec(toml)?.[1];
} catch {
  /* gestito sotto */
}

if (!dbName) {
  console.error('Non trovo database_name in wrangler.toml.');
  process.exit(1);
}

function d1(sql) {
  return execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', dbName, target, '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function rows(output) {
  // wrangler stampa qualche riga di intestazione prima del JSON.
  const start = output.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(output.slice(start))[0]?.results ?? [];
}

console.log(`\nDatabase: ${dbName} (${local ? 'locale' : 'PRODUZIONE'})\n`);

let account;
try {
  account = rows(d1('SELECT id, email, display_name, pin_hash IS NOT NULL AS has_pin FROM users'));
} catch (err) {
  console.error('Lettura fallita:', err.stderr?.toString() ?? err.message);
  process.exit(1);
}

if (account.length === 0) {
  console.error('Nessun account in questo database: non c’è niente da azzerare.');
  process.exit(1);
}
if (account.length > 1) {
  console.error('Più di un account presente. Fermati: questo script ne assume uno solo.');
  process.exit(1);
}

const user = account[0];
console.log(`  Account:  ${user.display_name} <${user.email}>`);
console.log(`  PIN:      ${user.has_pin ? 'impostato' : 'già azzerato'}\n`);

const rl = createInterface({ input: stdin, output: stdout });
const answer = await rl.question(
  local ? 'Azzero il PIN locale? [s/N] ' : 'Azzero il PIN di PRODUZIONE? [s/N] ',
);
rl.close();

if (!/^s(i|ì)?$/i.test(answer.trim())) {
  console.log('Annullato. Niente è stato modificato.');
  process.exit(0);
}

try {
  d1(
    `UPDATE users SET pin_hash = NULL, pin_salt = NULL, failed_pin_attempts = 0, locked_until = NULL WHERE id = '${user.id}'`,
  );
  // Un reset del PIN che lascia vive le sessioni non è un reset.
  d1(`DELETE FROM sessions WHERE user_id = '${user.id}'`);
} catch (err) {
  console.error('\nAggiornamento fallito:', err.stderr?.toString() ?? err.message);
  process.exit(1);
}

console.log(`
Fatto. PIN azzerato e sessioni chiuse.

Ora apri l'app: al posto della tastiera numerica troverai "Nuovo PIN".
Scegline uno lì — attività, calendario, spesa e stime sono rimasti al loro posto.

I token del Tasto Azione e di Siri restano validi: non dipendono dal PIN.
`);
