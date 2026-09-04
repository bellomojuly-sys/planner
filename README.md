# Planner

Personal planning agent for Giulia. It reads tasks from Notion and fixed
commitments from Google Calendar, interprets Italian voice commands with Claude,
and fills the free time with work and gym blocks while respecting energy,
priority and dependencies.

It runs on **Cloudflare Workers** (free plan): always on, reachable over 4G away
from home, and the briefings fire on their own without the Mac being awake.

---

## How it works

```
iPhone (Action button)         PWA (iPhone / Mac)
  Apple dictation                    │
        │ text                       │ cookie + PIN
        ▼                            ▼
   ┌──────────────────────────────────────────┐
   │        Cloudflare Worker (Hono)          │
   │                                          │
   │  Claude ──► intents ──► tasks            │
   │                          │               │
   │                     scheduler            │
   │                    (energy bands,        │
   │                     dependencies, gaps)  │
   │                          │               │
   │                       outbox ──► Notion  │
   │                              └──► Google │
   └────────────┬─────────────────────────────┘
                │
         D1 (SQLite) · KV (cache)
```

The Notion, Google and Claude keys live only in the Worker secrets. **The
browser never sees them**: every outbound call leaves from the server.

---

## Requirements

- Node 20+
- A Cloudflare account (free)
- A Notion internal integration
- A Google Cloud project with the Calendar API enabled
- An Anthropic API key

---

## Installation

### 1. Dependencies and keys

```bash
npm install
node scripts/gen-keys.mjs
```

The script prints `MASTER_KEY` (encryption at rest) and the VAPID pair (push
notifications). Copy them where indicated. If you change `MASTER_KEY`, data
already encrypted becomes unreadable.

### 2. Database and cache

```bash
npx wrangler d1 create giulia-personal-planner-db --location weur
npx wrangler kv namespace create CACHE
```

Paste the two ids into `wrangler.toml`, then apply the schema:

```bash
npm run db:migrate:local     # for development
npm run db:migrate:remote    # in production
```

### 3. Notion

**There are two databases, not four.** University and Heemia are not separate
databases: they are options of the `Area` property inside the shared `Tasks`
database. The Heemia page in Notion says so explicitly ("You add them in Tasks
and set Area = Heemia"). Every row is routed by its own `Area` value, not by the
database it came from.

| Notion database | ID | Areas it feeds |
|---|---|---|
| `Tasks` | `22dcf789-3820-40c9-8299-fffd0a518382` | Heemia, University, Personal, health, Carriera / ICT |
| `Task MG Integration` | `e32eaadf-2a02-4e9e-9a2f-c2d0c660fa89` | MG Integration |

Steps:

1. https://www.notion.so/my-integrations → **New integration** → copy the token.
2. In Notion open **Tasks** → `···` menu → **Connections** → add the
   integration. Repeat for **Task MG Integration**.
3. Link the two databases, either from the app under **Settings** → *Notion
   databases*, or in one go:

```bash
PLANNER_URL=https://your-worker.workers.dev PLANNER_TOKEN=<full token> npm run seed
```

Properties are recognised from the schema, so nothing needs renaming. The
matching is **driven by the Notion type, not by the name alone**: a deadline has
to be a `date`, an estimate has to be a `number`. Without that constraint
"Created Date" would win the search for the deadline because it contains "date",
and "Estimate Confidence" (a High/Medium/Low label) would win the search for the
duration because it contains "estimate". Two errors that do not raise an error,
they just produce a wrong plan.

**Ignored rows.** The `Tasks` database keeps meetings and deadlines alongside
tasks (`Type` = Task | Meeting | Deadline). Only `Task` rows get scheduled: a
meeting is already an event on Google Calendar, and a `Deadline` such as an exam
date is a marker, not work to be done. Skipped rows are counted in the sync
report.

**Extra columns read**, because your schema already has them:
`Earliest Start` / `Data minima di inizio` (start constraint),
`Actual Time` / `Tempo effettivo` (real time spent),
`Scheduling Mode` / `Modalita scheduling`, where *Locked* and *Fixed* mean "one
single session, not splittable". They do not set the manual lock: that comes
from dragging the block inside the app.

`Carriera / ICT` is a dedicated planner area, with its own colour, filter and
semantic matching.

### 4. Google Calendar

In the Google Cloud Console: enable the **Google Calendar API**, create an
**OAuth client ID** of type *Web application*, and add
`http://127.0.0.1:8976/callback` to the redirect URIs. Then:

```bash
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… node scripts/google-auth.mjs
```

The browser opens once; the script prints the refresh token.

After saving the credentials, open **Settings → Google calendars** and press
**Detect or refresh calendars**. The main writable calendar becomes the
destination for the blocks the planner creates; the others start as **Fixed
commitment**, so `eitje` shifts, lectures, exams and appointments are read even
when they are not in the `primary` calendar. Each source can then be set to:

- **Fixed commitment**: subtracts available time;
- **Context only**: shows up in the planner and in the briefings, but does not
  block slots;
- **Ignore**: not synchronised;
- **Planner destination**: receives the generated blocks (only one, and it has
  to be writable).

Events marked *Available* in Google and all-day reminders stay contextual: a
trip or an all-day deadline does not wipe out a whole day of planning by itself.

### 5. Secrets

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

Locally, put them in `.dev.vars` instead (already in `.gitignore`).

### 6. Deploy

```bash
npm run deploy
```

Open the Worker URL, complete the initial setup (name, email, PIN) and link the
Notion databases from the settings.

---

## Installing on the iPhone

1. Open the URL in **Safari** (not Chrome: on iOS only Safari can install a
   PWA).
2. **Share** → **Add to Home Screen**.
3. Open the app from the icon, unlock it with the PIN.
4. **Settings** → **Enable notifications**, required for the 07:00 briefing. iOS
   allows web notifications **only** for installed PWAs, so step 2 cannot be
   skipped.

For the Action button, see [`shortcuts/README.md`](shortcuts/README.md).

On the Mac the same URL works; in Safari use **File → Add to Dock** to get it as
a separate app.

---

## What it does, in detail

### Planning

The time bands come from the settings and are all editable:

| Band | Default | What lands there |
|--------|-------------|------------------|
| Morning | start of day → 13:00 | Demanding work (high energy) |
| Afternoon | 13:00 → 18:00 | Medium work |
| Evening | 18:00 → end of day | Light activities and gym |

Free time is computed by subtracting the fixed Google Calendar commitments from
the waking hours, with a configurable travel margin before and after each one.

A task competes **first** only for its ideal band across the whole planning
horizon, and only falls back to a less suitable band if it finds no room. That
is why light work does not take Tuesday morning and leave deep work for the
evening.

Tasks longer than the maximum block (90 minutes by default) are split into
consecutive parts, unless they are marked as not splittable.

### Dependencies

Three ways to create them:

- **Notion relations**: a *Relation* property named "Dipende da", "Blocked by"
  or similar is read automatically.
- **Automatic from phases**: "Fase 15", "Fase 16", "Fase 17" of the same project
  are chained on their own.
- **By voice**: "before X I have to do Y".

When you move Phase 15, by dragging it on the calendar or by saying so, 16, 17
and 18 move accordingly. There is no dedicated code path for the cascade: the
topological order means a dependent is never considered before its prerequisite
has finished.

Cycles are detected and reported; the tasks involved stay unplanned instead of
blocking everything else.

### Estimates that improve

Claude estimates duration, energy, priority and area. Every completed task
records the real time spent and feeds a correction factor per bucket (area,
energy and keyword): if administrative work for MG systematically takes 1.6x the
estimate, the planner starts reserving 48 minutes for a 30-minute estimate. The
average is visible under **Settings** → *Estimate accuracy*.

### Automatic replanning

It triggers when: you move a block, you add an urgent task, you complete
something, or an event changes on Google Calendar. The cron runs every 5 minutes
but **only replans if something actually changed**, so it does not rewrite
calendar events for nothing.

Blocks moved by hand stay fixed until you unlock them.

### Briefing and review

- **07:00**: the day's plan.
- **20:30**, or **30 minutes after the shift ends** if the shift finishes later.

The Cloudflare cron runs in UTC and cannot express "30 minutes after a shift
that ends at a different time every day". That is why the 5-minute tick computes
what is actually due in local Rome time, with a per-`jobKey` lock guaranteeing a
single run per day. As a side effect, daylight saving time is handled without
special cases.

### Offline

The service worker caches the app shell and the last downloaded plan, so the day
stays readable without a connection (with a warning that the data is saved, not
live). Notes dictated offline go into an IndexedDB queue and are sent as soon as
the connection returns, with an idempotency key that prevents duplicates.

---

## Privacy and security

- **Encryption at rest** (AES-256-GCM) for third-party credentials, push
  notification keys and **the raw text of every voice note**. A database dump
  reveals none of it.
- **PIN** with HMAC-SHA256, per-user salt and a server-side key kept separate
  from the database; progressive lockout after 5 attempts: 1 min, 2, 4, up to an
  hour. PBKDF2 rows created by earlier versions stay verifiable.
- **Sessions** in `HttpOnly` `Secure` `SameSite=Lax` cookies; the database holds
  only the SHA-256 hash, so a data leak does not produce valid sessions.
- **Separate tokens for the Action button**, with capture-only permission.
- **Strict CSP**: the PWA loads nothing from third-party domains.
- **No API key in the browser**, ever.

---

## Reliability

Every write towards Notion or Google goes through an **outbox** in the local
database. If Notion is unreachable while you dictate a note, the note is saved
anyway and the send is retried with exponential backoff (30 s to 30 min, 6
attempts). Non-retryable requests, a 400 or a revoked credential, die
immediately instead of clogging the queue.

The backoff uses *full jitter*: during one cron tick several calls towards Notion
and Google start together, and without jitter they would all retry in sync,
hammering a service that is recovering.

The errors shown in the app are always in Italian and never contain internal
details or external response bodies: those stay in the logs.

---

## Commands

```bash
npm run dev              # API (:8787) + front end (:5173) together
npm run typecheck
npm test                 # 28 scheduler tests
npm run db:generate      # regenerate migrations after a schema change
npm run deploy
```

---

## Becoming a multi-user product

The data model is already multi-tenant: **every row owned by the user carries
`userId`** and no query assumes it implicitly. The `users` table already has
`plan`, `planStatus` and `trialEndsAt`, unused today but present so that moving
to billing does not have to touch every query.

Going SaaS needs, in order:

1. **Registration**: replace `getSoleUser()` in `src/auth/session.ts`, which is
   deliberately the only place assuming a single user (and raises an explicit
   error if it finds more than one, instead of picking at random).
2. **Per-user OAuth**: today the Notion and Google credentials are Worker
   secrets. The `credentials` table is already able to hold them encrypted per
   user: what changes is the read site, not the schema.
3. **Cron**: the loop in `src/jobs/cron.ts` already iterates over all users and
   isolates errors per user. Past a few hundred users, move the fan-out to
   Cloudflare Queues.
4. **Payments**: Stripe, writing to `plan` / `planStatus`.
5. **Database**: D1 handles personal use with margin. For larger volumes, the
   Drizzle schema ports to Postgres by changing dialect.
