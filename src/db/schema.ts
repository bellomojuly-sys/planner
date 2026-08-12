import { sql, relations } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * Every user-owned row carries `userId`. Today there is exactly one row in
 * `users`, but no query is allowed to assume that — the repository layer in
 * `src/db/repo.ts` refuses to build a statement without a tenant filter. That
 * discipline is what makes the multi-user turn cheap later.
 *
 * Timestamps are epoch milliseconds (integer) rather than SQLite datetimes:
 * unambiguous across timezones, and the scheduler does arithmetic on them
 * constantly.
 */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now());

const updatedAt = () =>
  integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),

    // HMAC-SHA256 with a server-side pepper for new rows. Positive iteration
    // counts identify legacy PBKDF2 hashes; 0 identifies HMAC v1.
    pinHash: text('pin_hash'),
    pinSalt: text('pin_salt'),
    pinIterations: integer('pin_iterations').notNull().default(210_000),
    // Throttles brute force against a 6-digit space.
    failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
    lockedUntil: integer('locked_until'),

    timezone: text('timezone').notNull().default('Europe/Rome'),
    locale: text('locale').notNull().default('it-IT'),

    // Reserved for the SaaS turn. Unused today, but present so the billing
    // migration does not have to touch every query.
    plan: text('plan', { enum: ['personal', 'pro', 'team'] })
      .notNull()
      .default('personal'),
    planStatus: text('plan_status', {
      enum: ['active', 'past_due', 'canceled'],
    })
      .notNull()
      .default('active'),
    trialEndsAt: integer('trial_ends_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // SHA-256 of the cookie value. A database leak does not yield live sessions.
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId, t.expiresAt),
  ],
);

/**
 * Long-lived, narrowly-scoped tokens. The iPhone Shortcut holds a `capture`
 * token: it can POST one utterance and nothing else. If the phone is lost,
 * revoking this row costs nothing else.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    scope: text('scope', { enum: ['capture', 'read', 'full'] })
      .notNull()
      .default('capture'),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_tokens_token_idx').on(t.tokenHash),
    index('api_tokens_user_idx').on(t.userId),
  ],
);

/**
 * Third-party credentials, AES-GCM encrypted with MASTER_KEY before they ever
 * reach this table. The browser never sees these — every outbound call to
 * Notion, Google and Claude originates in the Worker.
 */
export const credentials = sqliteTable(
  'credentials',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', {
      enum: ['notion', 'google', 'anthropic'],
    }).notNull(),
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    expiresAt: integer('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('credentials_user_provider_idx').on(t.userId, t.provider)],
);

// ---------------------------------------------------------------------------
// Preferences that drive the scheduler
// ---------------------------------------------------------------------------

export const settings = sqliteTable('settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Day boundaries, local minutes from midnight.
  dayStartMinutes: integer('day_start_minutes').notNull().default(7 * 60),
  dayEndMinutes: integer('day_end_minutes').notNull().default(22 * 60 + 30),

  // Energy zone cutoffs. Demanding work lands before `morningEnd`, medium work
  // before `afternoonEnd`, light work and gym after it.
  morningEndMinutes: integer('morning_end_minutes').notNull().default(13 * 60),
  afternoonEndMinutes: integer('afternoon_end_minutes')
    .notNull()
    .default(18 * 60),

  // Never schedule a block shorter than this; never run one longer without a
  // break. Both in minutes.
  minBlockMinutes: integer('min_block_minutes').notNull().default(20),
  maxBlockMinutes: integer('max_block_minutes').notNull().default(90),
  breakMinutes: integer('break_minutes').notNull().default(10),
  // Travel/decompression padding kept clear around every fixed commitment.
  bufferAroundEventsMinutes: integer('buffer_around_events_minutes')
    .notNull()
    .default(15),

  gymSessionsPerWeek: integer('gym_sessions_per_week').notNull().default(3),
  gymDurationMinutes: integer('gym_duration_minutes').notNull().default(75),
  gymPreferredDays: text('gym_preferred_days').notNull().default('1,3,5'),

  briefingMinutes: integer('briefing_minutes').notNull().default(7 * 60),
  reviewMinutes: integer('review_minutes').notNull().default(20 * 60 + 30),
  // When a shift ends after the fixed review time, the review slides to
  // shift-end + this many minutes instead.
  reviewAfterShiftMinutes: integer('review_after_shift_minutes')
    .notNull()
    .default(30),

  // Substring matches that mark a Google event as an immovable shift/lesson.
  fixedEventKeywords: text('fixed_event_keywords')
    .notNull()
    .default('turno,ristorante,lezione,esame,shift,lesson'),

  planningHorizonDays: integer('planning_horizon_days').notNull().default(14),
  autoRescheduleEnabled: integer('auto_reschedule_enabled', {
    mode: 'boolean',
  })
    .notNull()
    .default(true),
  pushEnabled: integer('push_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),

  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Task sources (Notion databases)
// ---------------------------------------------------------------------------

export const taskSources = sqliteTable(
  'task_sources',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['notion', 'local'] })
      .notNull()
      .default('notion'),
    // Notion data-source id.
    externalId: text('external_id'),
    name: text('name').notNull(),
    // Default area stamped on tasks from this database.
    area: text('area').notNull(),
    color: text('color').notNull().default('#7c8cf8'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * Maps our canonical fields onto whatever the Notion database actually
     * calls its properties. Adding University and Heemia later is a row here,
     * not a code change.
     */
    propertyMap: text('property_map', { mode: 'json' })
      .$type<NotionPropertyMap>()
      .notNull(),
    lastSyncedAt: integer('last_synced_at'),
    lastSyncCursor: text('last_sync_cursor'),
    lastSyncError: text('last_sync_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('task_sources_user_idx').on(t.userId, t.enabled)],
);

export interface NotionPropertyMap {
  title: string;
  status?: string;
  /** Status values that mean "finished". */
  doneValues?: string[];
  due?: string;
  priority?: string;
  estimate?: string;
  /** Real elapsed time already recorded in Notion. */
  actual?: string;
  area?: string;
  energy?: string;
  notes?: string;
  dependsOn?: string;
  /** Free-text prerequisites, for rows where the relation is not filled in. */
  dependencyHints?: string;
  earliestStart?: string;
  /**
   * Distinguishes real work from calendar markers. A database that keeps
   * meetings and deadlines alongside tasks would otherwise have its exams
   * booked as if they were work to be done.
   */
  typeProperty?: string;
  /** Values of `typeProperty` that represent schedulable work. */
  schedulableTypes?: string[];
  /** Locked/Fixed rows must stay in a single block. */
  schedulingMode?: string;
  /**
   * Canonical area -> the label this database actually uses for it, e.g.
   * `{ university: 'University', mg: 'MG Integration' }`. Needed when writing
   * a task back, so a voice-captured University task lands under the right
   * Area instead of an empty one.
   */
  areaValues?: Partial<Record<Area, string>>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const AREAS = [
  'general',
  'mg',
  'university',
  'heemia',
  'career',
  'personal',
  'health',
  'errand',
] as const;
export type Area = (typeof AREAS)[number];

export const ENERGY = ['high', 'medium', 'low'] as const;
export type Energy = (typeof ENERGY)[number];

export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').references(() => taskSources.id, {
      onDelete: 'set null',
    }),
    /** Notion page id. Null for tasks born from a voice capture. */
    externalId: text('external_id'),

    title: text('title').notNull(),
    notes: text('notes'),
    area: text('area').$type<Area>().notNull().default('general'),

    status: text('status', {
      enum: ['inbox', 'todo', 'scheduled', 'in_progress', 'done', 'cancelled'],
    })
      .notNull()
      .default('todo'),

    // 1 = drop everything, 4 = whenever.
    priority: integer('priority').notNull().default(3),
    energy: text('energy').$type<Energy>().notNull().default('medium'),

    /** What Claude (or Giulia) thinks it takes. */
    estimatedMinutes: integer('estimated_minutes').notNull().default(30),
    /** Adjusted by the learned bias factor. What the scheduler actually books. */
    plannedMinutes: integer('planned_minutes').notNull().default(30),
    /** Ground truth, recorded on completion. Feeds the learning loop. */
    actualMinutes: integer('actual_minutes'),
    estimateSource: text('estimate_source', {
      enum: ['claude', 'notion', 'user', 'learned'],
    })
      .notNull()
      .default('claude'),
    estimateConfidence: real('estimate_confidence').notNull().default(0.5),

    dueAt: integer('due_at'),
    /** Not workable before this instant, e.g. a blocked phase. */
    earliestStartAt: integer('earliest_start_at'),
    completedAt: integer('completed_at'),

    /** Long tasks may occupy several blocks; see `scheduledBlocks`. */
    splittable: integer('splittable', { mode: 'boolean' })
      .notNull()
      .default(true),
    /** Set when Giulia drags a block by hand. The scheduler stops moving it. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),

    /** Free-text phase label ("Fase 15") used to auto-wire dependency chains. */
    phaseLabel: text('phase_label'),
    phaseOrder: integer('phase_order'),
    projectKey: text('project_key'),

    isGym: integer('is_gym', { mode: 'boolean' }).notNull().default(false),

    /** Notion write-back bookkeeping. */
    dirty: integer('dirty', { mode: 'boolean' }).notNull().default(false),
    lastPushedAt: integer('last_pushed_at'),
    externalUpdatedAt: integer('external_updated_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_user_status_idx').on(t.userId, t.status),
    index('tasks_user_due_idx').on(t.userId, t.dueAt),
    index('tasks_project_idx').on(t.userId, t.projectKey, t.phaseOrder),
    uniqueIndex('tasks_external_idx').on(t.userId, t.sourceId, t.externalId),
  ],
);

/**
 * `taskId` cannot start until `dependsOnId` is finished. Moving Fase 15
 * cascades through this edge list to 16, 17 and 18.
 */
export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    dependsOnId: text('depends_on_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    /** Minimum gap between predecessor end and successor start. */
    lagMinutes: integer('lag_minutes').notNull().default(0),
    createdBy: text('created_by', { enum: ['user', 'claude', 'phase_rule'] })
      .notNull()
      .default('user'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('task_dep_unique_idx').on(t.taskId, t.dependsOnId),
    index('task_dep_reverse_idx').on(t.userId, t.dependsOnId),
  ],
);

/**
 * A concrete placement on the calendar. One task can own several blocks when
 * it is split across sittings.
 */
export const scheduledBlocks = sqliteTable(
  'scheduled_blocks',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    kind: text('kind', { enum: ['task', 'gym', 'break', 'buffer'] })
      .notNull()
      .default('task'),
    /** Index within a split task, 0-based. */
    partIndex: integer('part_index').notNull().default(0),
    partCount: integer('part_count').notNull().default(1),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /** Mirrored into Google Calendar; this is the event id there. */
    googleEventId: text('google_event_id'),
    syncState: text('sync_state', {
      enum: ['pending', 'synced', 'failed', 'deleted'],
    })
      .notNull()
      .default('pending'),
    syncError: text('sync_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('blocks_user_time_idx').on(t.userId, t.startAt),
    index('blocks_task_idx').on(t.taskId),
    index('blocks_sync_idx').on(t.userId, t.syncState),
  ],
);

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const calendarEvents = sqliteTable(
  'calendar_events',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    location: text('location'),
    startAt: integer('start_at').notNull(),
    endAt: integer('end_at').notNull(),
    allDay: integer('all_day', { mode: 'boolean' }).notNull().default(false),
    /**
     * `fixed`   — immovable: restaurant shift, lesson, exam. Blocks time.
     * `soft`    — occupies time but the scheduler may overlap light work.
     * `planner` — written by us, mirroring a scheduled block.
     */
    kind: text('kind', { enum: ['fixed', 'soft', 'planner'] })
      .notNull()
      .default('soft'),
    isShift: integer('is_shift', { mode: 'boolean' }).notNull().default(false),
    etag: text('etag'),
    cancelled: integer('cancelled', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Detects "the calendar moved under us" between syncs. */
    contentHash: text('content_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cal_external_idx').on(t.userId, t.calendarId, t.externalId),
    index('cal_user_time_idx').on(t.userId, t.startAt),
  ],
);

/**
 * Which Google calendars to read, and what each one means.
 *
 * Reading only `primary` is not enough: shifts arrive from a rota app on their
 * own imported calendar, lessons sit on a university calendar, and the gym has
 * its own. Those are exactly the fixed commitments the plan must be built
 * around, so each calendar carries an explicit role instead of being guessed
 * at by name.
 */
export const calendarSources = sqliteTable(
  'calendar_sources',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    summary: text('summary').notNull(),
    /**
     * `busy`    — its events are immovable; the scheduler works around them.
     * `context` — shown in the app and the briefing, but does not block time.
     * `ignore`  — not read at all.
     * `planner` — where our own task blocks are written. Exactly one.
     */
    role: text('role', { enum: ['busy', 'context', 'ignore', 'planner'] })
      .notNull()
      .default('ignore'),
    /** Colour used for this calendar's events in the day grid. */
    color: text('color').notNull().default('#9aa3b8'),
    accessRole: text('access_role', {
      enum: ['freeBusyReader', 'reader', 'writer', 'owner'],
    })
      .notNull()
      .default('reader'),
    primary: integer('primary', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('calendar_sources_idx').on(t.userId, t.calendarId)],
);

export const calendarSyncState = sqliteTable(
  'calendar_sync_state',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calendarId: text('calendar_id').notNull(),
    /** Google incremental sync token. Cheap polling instead of full refetch. */
    syncToken: text('sync_token'),
    lastSyncedAt: integer('last_synced_at'),
    lastError: text('last_error'),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('calendar_sync_state_idx').on(t.userId, t.calendarId)],
);

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

export const shoppingItems = sqliteTable(
  'shopping_items',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    quantity: real('quantity').notNull().default(1),
    unit: text('unit').notNull().default('pz'),
    category: text('category').notNull().default('altro'),
    store: text('store'),
    /** Direct buy link when the item is easier to order than to fetch. */
    url: text('url'),
    estimatedPrice: real('estimated_price'),
    notes: text('notes'),
    status: text('status', { enum: ['open', 'bought', 'cancelled'] })
      .notNull()
      .default('open'),
    urgent: integer('urgent', { mode: 'boolean' }).notNull().default(false),
    completedAt: integer('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('shopping_user_status_idx').on(t.userId, t.status)],
);

// ---------------------------------------------------------------------------
// Voice capture + learning
// ---------------------------------------------------------------------------

export const captures = sqliteTable(
  'captures',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Encrypted: raw speech is the most personal payload in the system. */
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    source: text('source', {
      enum: ['action_button', 'web', 'shortcut', 'api'],
    })
      .notNull()
      .default('action_button'),
    status: text('status', {
      enum: ['pending', 'interpreted', 'applied', 'failed', 'needs_review'],
    })
      .notNull()
      .default('pending'),
    /** Claude's parsed intents, kept for audit and for undo. */
    interpretation: text('interpretation', { mode: 'json' }).$type<unknown>(),
    appliedSummary: text('applied_summary'),
    error: text('error'),
    /** Idempotency: the Shortcut may retry over flaky cellular. */
    clientRequestId: text('client_request_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('captures_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('captures_client_req_idx').on(t.userId, t.clientRequestId),
  ],
);

/** One row per finished task: what we predicted vs. what it really took. */
export const durationSamples = sqliteTable(
  'duration_samples',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    area: text('area').$type<Area>().notNull(),
    energy: text('energy').$type<Energy>().notNull(),
    titleSample: text('title_sample'),
    estimatedMinutes: integer('estimated_minutes').notNull(),
    actualMinutes: integer('actual_minutes').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('samples_bucket_idx').on(t.userId, t.area, t.energy)],
);

/**
 * The learned correction. `biasFactor` multiplies a fresh estimate:
 * >1 means Giulia consistently takes longer than predicted in this bucket.
 */
export const estimateModel = sqliteTable(
  'estimate_model',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `area:mg|energy:high` or `kw:fattura` for keyword-level corrections. */
    bucketKey: text('bucket_key').notNull(),
    biasFactor: real('bias_factor').notNull().default(1),
    sampleCount: integer('sample_count').notNull().default(0),
    meanAbsErrorMinutes: real('mean_abs_error_minutes').notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('estimate_bucket_idx').on(t.userId, t.bucketKey)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    trigger: text('trigger', {
      enum: [
        'cron',
        'capture',
        'manual',
        'calendar_change',
        'task_moved',
        'urgent_task',
        'dependency_cascade',
      ],
    }).notNull(),
    status: text('status', { enum: ['running', 'ok', 'partial', 'failed'] })
      .notNull()
      .default('running'),
    blocksPlaced: integer('blocks_placed').notNull().default(0),
    blocksMoved: integer('blocks_moved').notNull().default(0),
    tasksUnplaced: integer('tasks_unplaced').notNull().default(0),
    /** Human-readable Italian diff, shown in the UI after a reshuffle. */
    summary: text('summary', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    durationMs: integer('duration_ms'),
    startedAt: createdAt(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('runs_user_idx').on(t.userId, t.startedAt)],
);

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    /** Encrypted: these keys let anyone holding them push to the device. */
    ciphertext: text('ciphertext').notNull(),
    iv: text('iv').notNull(),
    failureCount: integer('failure_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('push_endpoint_idx').on(t.userId, t.endpoint)],
);

/**
 * Guarantees the 07:00 briefing fires once even though cron ticks every five
 * minutes. `jobKey` is `briefing:2026-08-12`; the unique index is the lock.
 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    jobKey: text('job_key').notNull(),
    status: text('status', { enum: ['ok', 'failed'] })
      .notNull()
      .default('ok'),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('job_runs_key_idx').on(t.userId, t.jobKey)],
);

/** Outbound work that must survive a failed request: Notion and Google writes. */
export const outbox = sqliteTable(
  'outbox',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: [
        'notion_upsert',
        'notion_complete',
        'google_upsert',
        'google_delete',
        'push',
      ],
    }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** Exponential backoff: the job runner ignores rows until this instant. */
    nextAttemptAt: integer('next_attempt_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    lastError: text('last_error'),
    status: text('status', { enum: ['pending', 'done', 'dead'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_ready_idx').on(t.status, t.nextAttemptAt)],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  source: one(taskSources, {
    fields: [tasks.sourceId],
    references: [taskSources.id],
  }),
  blocks: many(scheduledBlocks),
  dependencies: many(taskDependencies, { relationName: 'dependent' }),
}));

export const blocksRelations = relations(scheduledBlocks, ({ one }) => ({
  task: one(tasks, {
    fields: [scheduledBlocks.taskId],
    references: [tasks.id],
  }),
}));

export const depsRelations = relations(taskDependencies, ({ one }) => ({
  task: one(tasks, {
    fields: [taskDependencies.taskId],
    references: [tasks.id],
    relationName: 'dependent',
  }),
  dependsOn: one(tasks, {
    fields: [taskDependencies.dependsOnId],
    references: [tasks.id],
    relationName: 'prerequisite',
  }),
}));

export type User = typeof users.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type ScheduledBlock = typeof scheduledBlocks.$inferSelect;
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type CalendarSource = typeof calendarSources.$inferSelect;
export type ShoppingItem = typeof shoppingItems.$inferSelect;
export type TaskSource = typeof taskSources.$inferSelect;
export type TaskDependency = typeof taskDependencies.$inferSelect;

export const schema = {
  users,
  sessions,
  apiTokens,
  credentials,
  settings,
  taskSources,
  tasks,
  taskDependencies,
  scheduledBlocks,
  calendarEvents,
  calendarSources,
  calendarSyncState,
  shoppingItems,
  captures,
  durationSamples,
  estimateModel,
  scheduleRuns,
  pushSubscriptions,
  jobRuns,
  outbox,
  tasksRelations,
  blocksRelations,
  depsRelations,
};

export { sql };
