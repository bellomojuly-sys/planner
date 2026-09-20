/**
 * Thin API client. Every response carries an Italian `message` on failure, so
 * the UI never has to invent error copy.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiResult<T> {
  data: T;
  /** Set when the service worker served this from cache. */
  offline: boolean;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'offline', 'Nessuna connessione.');
  }

  const offline = response.headers.get('X-Planner-Offline') === '1';
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.error ?? 'internal',
      body.message ?? 'Errore imprevisto.',
      body.details,
    );
  }

  return { data: body as T, offline };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export interface Block {
  id: string;
  taskId: string | null;
  title: string;
  start: number;
  end: number;
  kind: 'task' | 'gym' | 'break' | 'buffer';
  pinned: boolean;
  partIndex: number;
  partCount: number;
  syncState: 'pending' | 'synced' | 'failed' | 'deleted';
  area: string | null;
  energy: 'high' | 'medium' | 'low' | null;
  priority: number | null;
}

export interface CalendarEventView {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  kind: 'fixed' | 'soft' | 'planner';
  isShift: boolean;
  location: string | null;
  calendarId: string;
  calendarName: string;
  color: string;
}

export interface PlanResponse {
  range: { from: number; to: number; timezone: string };
  blocks: Block[];
  events: CalendarEventView[];
  lastRun: {
    trigger: string;
    status: string;
    at: number;
    summary: {
      changes?: string[];
      unplaced?: Array<{ title: string; reason: string; outcome: string }>;
      briefing?: string[];
      decisions?: Array<{
        taskId: string;
        title: string;
        planningClass: 'constraint' | 'objective' | 'preference';
        executionClass: 'you_do' | 'jarvis_does' | 'hybrid';
        outcome:
          | 'keep'
          | 'move'
          | 'postpone'
          | 'delegation_candidate'
          | 'needs_decision';
        reason: string;
        reservedMinutes: number;
      }>;
      warnings?: string[];
      applied?: boolean;
      requiresConfirmation?: boolean;
      confirmationReasons?: Array<'permanent_task_conflict' | 'near_term_change'>;
      blockedByStaleData?: boolean;
    } | null;
  } | null;
}

export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  area: string;
  status: string;
  priority: number;
  energy: 'high' | 'medium' | 'low';
  estimatedMinutes: number;
  plannedMinutes: number;
  actualMinutes: number | null;
  dueAt: number | null;
  pinned: boolean;
  location: string | null;
  travelMinutes: number;
  preparationMinutes: number;
  recoveryMinutes: number;
  flexibility: 'fixed' | 'low' | 'medium' | 'high';
}

export interface ShoppingItemView {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  category: string;
  store: string | null;
  url: string | null;
  estimatedPrice: number | null;
  notes: string | null;
  status: 'open' | 'bought' | 'cancelled';
  urgent: boolean;
}

export interface SettingsView {
  settings: Record<string, number | string | boolean>;
  sources: Array<{
    id: string;
    name: string;
    area: string;
    color: string;
    enabled: boolean;
    lastSyncedAt: number | null;
    lastSyncError: string | null;
  }>;
  calendars: Array<{
    id: string;
    calendarId: string;
    summary: string;
    role: 'busy' | 'context' | 'ignore' | 'planner';
    color: string;
    accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
    primary: boolean;
    enabled: boolean;
    kind: 'google' | 'ics';
    /** Only the host of the feed: the full URL is a credential. */
    feedUrl: string | null;
  }>;
  accuracy: { samples: number; meanRatio: number; withinTolerance: number };
  integrations: Record<string, boolean>;
}
