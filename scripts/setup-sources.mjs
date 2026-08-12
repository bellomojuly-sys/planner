#!/usr/bin/env node
/**
 * Registra i database Notion nel planner.
 *
 * Nota sulla struttura reale del workspace: University e Heemia NON sono
 * database separati. Sono opzioni della proprietà `Area` dentro il database
 * condiviso `Tasks` — la pagina Heemia lo dice esplicitamente ("You add them
 * in Tasks and set Area = Heemia"). Quindi qui si collegano due database, non
 * quattro, e le quattro aree vengono instradate riga per riga dal valore di
 * `Area`.
 *
 * Uso:
 *   PLANNER_URL=https://tuo-worker.workers.dev \
 *   PLANNER_TOKEN=<token con scope full> \
 *   npm run seed
 *
 * Il token si genera dall'app: Impostazioni → Tasto Azione iPhone, scegliendo
 * scope "full" (oppure via POST /api/auth/tokens).
 */

const BASE = (process.env.PLANNER_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.PLANNER_TOKEN;

/**
 * `area` qui è solo il ripiego per le righe senza `Area` compilata. Le righe
 * che ce l'hanno vengono instradate dal loro valore.
 */
const SOURCES = [
  {
    externalId: '22dcf789-3820-40c9-8299-fffd0a518382',
    name: 'Tasks',
    area: 'general',
    color: '#7c8cf8',
    note: 'Database condiviso — instrada Heemia, University, Personal, health dalla colonna Area.',
  },
  {
    externalId: 'e32eaadf-2a02-4e9e-9a2f-c2d0c660fa89',
    name: 'Task MG Integration',
    area: 'mg',
    color: '#4bb8a9',
    note: 'Database dedicato MG, proprietà in italiano.',
  },
];

if (!TOKEN) {
  console.error(`
Manca PLANNER_TOKEN.

  1. Apri l'app → Impostazioni → Tasto Azione iPhone → Genera token
     (oppure POST /api/auth/tokens con {"name":"setup","scope":"full"})
  2. PLANNER_URL=… PLANNER_TOKEN=… npm run seed
`);
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });

  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${path} → ${res.status}: ${body.message ?? text}`);
  }
  return body;
}

const existing = await api('/settings');
const already = new Set(existing.sources.map((s) => s.externalId).filter(Boolean));

for (const source of SOURCES) {
  if (already.has(source.externalId)) {
    console.log(`•  ${source.name} — già collegato, salto`);
    continue;
  }

  process.stdout.write(`→  ${source.name} … `);
  try {
    // Il server ricava da solo la mappa delle proprietà dallo schema Notion,
    // quindi non c'è nessun JSON da scrivere a mano qui.
    const result = await api('/settings/sources', {
      method: 'POST',
      body: JSON.stringify({
        externalId: source.externalId,
        name: source.name,
        area: source.area,
        color: source.color,
      }),
    });

    const skipped = result.sync?.tasksSkipped ?? 0;
    console.log(
      `ok — ${result.sync?.tasksUpserted ?? 0} attività importate` +
        (skipped > 0 ? `, ${skipped} righe ignorate (Meeting/Deadline)` : ''),
    );
    if (source.note) console.log(`   ${source.note}`);
  } catch (err) {
    console.log('errore');
    console.error(`   ${err.message}`);
    // Un database che fallisce non deve impedire il collegamento dell'altro.
  }
}

const after = await api('/settings');
console.log('\nDatabase collegati:');
for (const s of after.sources) {
  console.log(
    `  ${s.enabled ? '✓' : '×'} ${s.name} (ripiego area: ${s.area})` +
      (s.lastSyncError ? `  ⚠ ${s.lastSyncError}` : ''),
  );
}

const plan = await api('/plan?days=14');
const byArea = {};
for (const b of plan.blocks) {
  if (b.area) byArea[b.area] = (byArea[b.area] ?? 0) + 1;
}
console.log('\nBlocchi pianificati per area:');
for (const [area, count] of Object.entries(byArea).sort()) {
  console.log(`  ${area.padEnd(12)} ${count}`);
}
if (Object.keys(byArea).length === 0) {
  console.log('  (nessuno — controlla che le attività non siano tutte completate)');
}
