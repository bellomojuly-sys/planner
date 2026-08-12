# Planner

Agente di pianificazione personale per Giulia. Legge le attività da Notion e gli
impegni fissi da Google Calendar, interpreta comandi vocali in italiano con
Claude, e riempie il tempo libero con blocchi di lavoro e palestra rispettando
energia, priorità e dipendenze.

Gira su **Cloudflare Workers** (piano gratuito): sempre attivo, raggiungibile
anche in 4G fuori casa, e con i briefing che partono da soli senza bisogno che
il Mac sia acceso.

---

## Come funziona

```
iPhone (tasto Azione)          PWA (iPhone / Mac)
  dettatura Apple                    │
        │ testo                      │ cookie + PIN
        ▼                            ▼
   ┌──────────────────────────────────────────┐
   │        Cloudflare Worker (Hono)          │
   │                                          │
   │  Claude ──► intenti ──► attività         │
   │                          │               │
   │                     scheduler            │
   │                    (fasce di energia,    │
   │                     dipendenze, gap)     │
   │                          │               │
   │                       outbox ──► Notion  │
   │                              └──► Google │
   └────────────┬─────────────────────────────┘
                │
         D1 (SQLite) · KV (cache)
```

Le chiavi di Notion, Google e Claude stanno solo nei secret del Worker. **Il
browser non le vede mai**: ogni chiamata verso l'esterno parte dal server.

---

## Requisiti

- Node 20+
- Un account Cloudflare (gratuito)
- Un'integrazione interna Notion
- Un progetto Google Cloud con la Calendar API attiva
- Una chiave API Anthropic

---

## Installazione

### 1. Dipendenze e chiavi

```bash
npm install
node scripts/gen-keys.mjs
```

Lo script stampa `MASTER_KEY` (cifratura a riposo) e la coppia VAPID (notifiche
push). Copiali dove indicato — se cambi `MASTER_KEY` i dati già cifrati non
saranno più leggibili.

### 2. Database e cache

```bash
npx wrangler d1 create planner-db
npx wrangler kv namespace create CACHE
```

Incolla i due id in `wrangler.toml` al posto dei segnaposto, poi applica lo
schema:

```bash
npm run db:migrate:local     # per lo sviluppo
npm run db:migrate:remote    # in produzione
```

### 3. Notion

1. https://www.notion.so/my-integrations → **New integration** → copia il token.
2. In Notion, apri *General Tasks* → menu `···` → **Connections** → aggiungi
   l'integrazione. Ripeti per *MG Integration* (e più avanti per University e
   Heemia).

I database si collegano poi dall'app, in **Impostazioni** → *Database Notion*.
Le proprietà (stato, scadenza, stima, priorità…) vengono riconosciute
automaticamente dai loro nomi, quindi non serve rinominare nulla in Notion.

### 4. Google Calendar

In Google Cloud Console: abilita **Google Calendar API**, crea un **ID client
OAuth** di tipo *Applicazione web*, e aggiungi
`http://127.0.0.1:8976/callback` fra gli URI di reindirizzamento. Poi:

```bash
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs
```

Si apre il browser una volta sola; lo script stampa il refresh token.

### 5. Secret

```bash
npx wrangler secret put MASTER_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

In locale, mettili invece in `.dev.vars` (già in `.gitignore`).

### 6. Deploy

```bash
npm run deploy
```

Apri l'URL del Worker, completa la configurazione iniziale (nome, email, PIN) e
collega i database Notion dalle impostazioni.

---

## Installazione sull'iPhone

1. Apri l'URL in **Safari** (non Chrome — su iOS solo Safari può installare una
   PWA).
2. **Condividi** → **Aggiungi a Home**.
3. Apri l'app dall'icona, sblocca col PIN.
4. **Impostazioni** → **Attiva notifiche** — necessario per il briefing delle
   07:00. iOS consente le notifiche web **solo** alle PWA installate, quindi il
   passaggio 2 non è saltabile.

Per il tasto Azione, vedi [`shortcuts/README.md`](shortcuts/README.md).

Su Mac funziona lo stesso URL; in Safari **File → Aggiungi al Dock** per
averlo come app separata.

---

## Cosa fa, in dettaglio

### Pianificazione

Le fasce orarie vengono dalle impostazioni e sono tutte modificabili:

| Fascia | Predefinita | Cosa ci finisce |
|--------|-------------|-----------------|
| Mattina | inizio giornata → 13:00 | Lavoro impegnativo (energia alta) |
| Pomeriggio | 13:00 → 18:00 | Lavoro medio |
| Sera | 18:00 → fine giornata | Attività leggere e palestra |

Il tempo libero si calcola sottraendo dagli orari di veglia gli impegni fissi di
Google Calendar, con un margine di viaggio configurabile prima e dopo ciascuno.

Un'attività compete **prima** solo per la sua fascia ideale su tutto l'orizzonte
di pianificazione, e solo se non trova posto ripiega su una fascia meno adatta.
Per questo un lavoro leggero non occupa il martedì mattina lasciando il lavoro
profondo alla sera.

Le attività più lunghe del blocco massimo (90 min di default) vengono divise in
parti consecutive, a meno che non siano marcate come non divisibili.

### Dipendenze

Tre modi per crearle:

- **Relazioni Notion**: una proprietà di tipo *Relation* chiamata "Dipende da",
  "Blocked by" o simile viene letta automaticamente.
- **Automatiche dalle fasi**: "Fase 15", "Fase 16", "Fase 17" dello stesso
  progetto vengono concatenate da sole.
- **A voce**: «prima di X devo fare Y».

Quando sposti la Fase 15 — trascinandola sul calendario o dicendolo a voce —
16, 17 e 18 si spostano di conseguenza. Non c'è un percorso di codice dedicato
alla cascata: l'ordine topologico fa sì che un dipendente non venga mai
considerato prima della fine del suo prerequisito.

I cicli vengono rilevati e segnalati; le attività coinvolte restano non
pianificate invece di bloccare tutto il resto.

### Stime che migliorano

Claude stima durata, energia, priorità e area. Ogni attività completata
registra il tempo reale e alimenta un fattore di correzione per fascia
(area, energia e parola chiave): se il lavoro amministrativo per MG richiede
sistematicamente 1,6× il previsto, il planner inizia a riservare 48 minuti per
una stima di 30. La media si vede in **Impostazioni** → *Precisione delle
stime*.

### Ripianificazione automatica

Scatta quando: sposti un blocco, aggiungi un'attività urgente, completi
qualcosa, o cambia un evento su Google Calendar. Il cron gira ogni 5 minuti ma
**ripianifica solo se qualcosa è davvero cambiato**, per non riscrivere gli
eventi del calendario a vuoto.

I blocchi spostati a mano restano fissi finché non li sblocchi.

### Briefing e revisione

- **07:00** — piano della giornata.
- **20:30**, oppure **30 minuti dopo la fine del turno** se il turno finisce più
  tardi.

Il cron di Cloudflare gira in UTC e non può esprimere "30 minuti dopo un turno
che finisce a un orario diverso ogni giorno". Per questo il tick di 5 minuti
calcola cosa è davvero scaduto nell'ora locale di Roma, con un lock per
`jobKey` che garantisce una sola esecuzione al giorno. Come effetto collaterale,
l'ora legale è gestita senza casi speciali.

### Offline

Il service worker tiene in cache la shell dell'app e l'ultimo piano scaricato,
quindi la giornata resta leggibile senza rete (con un avviso che i dati sono
salvati, non in diretta). Le note dettate offline finiscono in una coda
IndexedDB e partono da sole appena torna la linea, con una chiave di idempotenza
che evita i doppioni.

---

## Privacy e sicurezza

- **Cifratura a riposo** (AES-256-GCM) per credenziali di terze parti, chiavi
  delle notifiche push e **testo grezzo di ogni nota vocale**. Un dump del
  database non rivela nulla di tutto ciò.
- **PIN** con PBKDF2-SHA256 (210.000 iterazioni) e blocco progressivo dopo 5
  tentativi: 1 min, 2, 4… fino a un'ora.
- **Sessioni** in cookie `HttpOnly` `Secure` `SameSite=Lax`; nel database c'è
  solo l'hash SHA-256, quindi una fuga di dati non produce sessioni valide.
- **Token separati per il tasto Azione**, con permesso di sola cattura.
- **CSP restrittiva**: la PWA non carica nulla da domini terzi.
- **Nessuna chiave API nel browser**, mai.

---

## Affidabilità

Ogni scrittura verso Notion o Google passa da una **outbox** sul database
locale. Se Notion è irraggiungibile mentre detti una nota, la nota è comunque
salvata e l'invio viene ritentato con backoff esponenziale (30 s → 30 min, 6
tentativi). Le richieste non ritentabili — un 400, una credenziale revocata —
muoiono subito invece di intasare la coda.

Il backoff usa *full jitter*: durante un tick del cron partono più chiamate
verso Notion e Google insieme, e senza jitter riproverebbero tutte in sincrono
martellando un servizio che si sta riprendendo.

Gli errori mostrati nell'app sono sempre in italiano e non contengono mai
dettagli interni o corpi di risposta esterni: quelli restano nei log.

---

## Comandi

```bash
npm run dev              # API (:8787) + front end (:5173) insieme
npm run typecheck
npm test                 # 28 test sullo scheduler
npm run db:generate      # rigenera le migrazioni dopo aver cambiato lo schema
npm run deploy
```

---

## Diventare un prodotto multi-utente

Il modello dati è già multi-tenant: **ogni riga di proprietà dell'utente porta
`userId`** e nessuna query lo assume implicito. Sulla tabella `users` esistono
già `plan`, `planStatus` e `trialEndsAt`, inutilizzati oggi ma presenti perché
la migrazione alla fatturazione non debba toccare ogni query.

Per passare a SaaS servono, nell'ordine:

1. **Registrazione** — sostituire `getSoleUser()` in `src/auth/session.ts`, che
   è deliberatamente l'unico punto che presume un solo utente (e solleva un
   errore esplicito se ne trova più d'uno, invece di scegliere a caso).
2. **OAuth per utente** — oggi le credenziali Notion e Google sono secret del
   Worker. La tabella `credentials` è già pronta a contenerle cifrate per
   utente: va cambiato il punto di lettura, non lo schema.
3. **Cron** — il ciclo in `src/jobs/cron.ts` itera già su tutti gli utenti e
   isola gli errori per utente. Oltre qualche centinaio di utenti conviene
   spostare il fan-out su Cloudflare Queues.
4. **Pagamenti** — Stripe, che scrive su `plan` / `planStatus`.
5. **Database** — D1 regge un uso personale con margine. Per volumi maggiori,
   lo schema Drizzle è portabile su Postgres cambiando dialetto.
