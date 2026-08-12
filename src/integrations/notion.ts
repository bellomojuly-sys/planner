import { assertOk, fetchWithTimeout, withRetry } from '../lib/retry';
import { PlannerError } from '../lib/errors';
import type { NotionPropertyMap, TaskSource, Area, Energy } from '../db/schema';

/**
 * Notion access via the REST API rather than the SDK: the surface we need is
 * four endpoints, and pinning the API version explicitly means a Notion SDK
 * release cannot silently change how tasks are read.
 */

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': VERSION,
    'Content-Type': 'application/json',
  };
}

async function notionFetch<T>(
  token: string,
  path: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetchWithTimeout(
        `${API}${path}`,
        { ...init, headers: headers(token) },
        20_000,
      );
      await assertOk(res, label);
      return (await res.json()) as T;
    },
    { label, attempts: 4 },
  );
}

// ---------------------------------------------------------------------------
// Discovery — used by the setup flow to build a property map
// ---------------------------------------------------------------------------

export interface NotionDatabaseInfo {
  id: string;
  title: string;
  properties: Array<{ name: string; type: string; options?: string[] }>;
}

export async function describeDatabase(
  token: string,
  databaseId: string,
): Promise<NotionDatabaseInfo> {
  const db = await notionFetch<any>(
    token,
    `/databases/${databaseId}`,
    { method: 'GET' },
    'notion.describeDatabase',
  );

  return {
    id: db.id,
    title: plainText(db.title) || 'Senza titolo',
    properties: Object.entries(db.properties ?? {}).map(
      ([name, prop]: [string, any]) => ({
        name,
        type: prop.type,
        options:
          prop.select?.options?.map((o: any) => o.name) ??
          prop.status?.options?.map((o: any) => o.name) ??
          prop.multi_select?.options?.map((o: any) => o.name),
      }),
    ),
  };
}

export async function listAccessibleDatabases(
  token: string,
): Promise<Array<{ id: string; title: string }>> {
  const res = await notionFetch<any>(
    token,
    '/search',
    {
      method: 'POST',
      body: JSON.stringify({
        filter: { value: 'database', property: 'object' },
        page_size: 50,
      }),
    },
    'notion.search',
  );

  return (res.results ?? []).map((db: any) => ({
    id: db.id,
    title: plainText(db.title) || 'Senza titolo',
  }));
}

/**
 * Best-effort guess at which Notion property means what, so adding the
 * University and Heemia databases later is a one-click confirmation rather
 * than manual JSON editing.
 */
export function guessPropertyMap(
  info: NotionDatabaseInfo,
): NotionPropertyMap {
  const byType = (type: string) =>
    info.properties.filter((p) => p.type === type);
  const named = (...candidates: string[]) =>
    info.properties.find((p) =>
      candidates.some((c) => p.name.toLowerCase().includes(c)),
    )?.name;

  const statusProp =
    byType('status')[0]?.name ?? named('stato', 'status', 'fatto', 'done');

  const doneValues =
    info.properties
      .find((p) => p.name === statusProp)
      ?.options?.filter((o) =>
        /fatt|complet|done|chius|archiv/i.test(o),
      ) ?? ['Done', 'Fatto'];

  return {
    title: byType('title')[0]?.name ?? 'Name',
    status: statusProp,
    doneValues,
    due: named('scadenz', 'due', 'data', 'date'),
    priority: named('priorit', 'priority'),
    estimate: named('stima', 'durat', 'estimate', 'tempo'),
    area: named('area', 'progetto', 'project', 'categoria'),
    energy: named('energia', 'energy', 'sforzo', 'effort'),
    notes: named('note', 'descriz', 'notes'),
    dependsOn: named('dipend', 'depends', 'blocc', 'blocked'),
  };
}

// ---------------------------------------------------------------------------
// Reading tasks
// ---------------------------------------------------------------------------

export interface NotionTask {
  externalId: string;
  title: string;
  notes: string | null;
  done: boolean;
  dueAt: number | null;
  priority: number | null;
  estimatedMinutes: number | null;
  area: string | null;
  energy: Energy | null;
  dependsOnExternalIds: string[];
  externalUpdatedAt: number;
}

/**
 * Pulls every page changed since `since`. Notion has no true delta feed, so
 * this filters on last_edited_time — which is why the sync is idempotent and
 * safe to run every five minutes.
 */
export async function fetchTasks(
  token: string,
  source: TaskSource,
  since: number | null,
): Promise<NotionTask[]> {
  if (!source.externalId) {
    throw new PlannerError('config_missing', {
      message: `source ${source.id} has no Notion database id`,
      userMessage: `Il database Notion "${source.name}" non è configurato.`,
    });
  }

  const out: NotionTask[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (since) {
      body.filter = {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: new Date(since).toISOString() },
      };
    }

    const page = await notionFetch<any>(
      token,
      `/databases/${source.externalId}/query`,
      { method: 'POST', body: JSON.stringify(body) },
      `notion.query(${source.name})`,
    );

    for (const result of page.results ?? []) {
      const task = mapPage(result, source.propertyMap);
      if (task) out.push(task);
    }

    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);

  return out;
}

function mapPage(page: any, map: NotionPropertyMap): NotionTask | null {
  const props = page.properties ?? {};
  const title = plainText(props[map.title]?.title);
  // A row with no title is an empty placeholder in Notion, not a task.
  if (!title) return null;

  const statusValue = map.status
    ? (props[map.status]?.status?.name ??
      props[map.status]?.select?.name ??
      (props[map.status]?.checkbox === true ? 'Done' : undefined))
    : undefined;

  const doneValues = (map.doneValues ?? ['Done', 'Fatto', 'Completato']).map(
    (v) => v.toLowerCase(),
  );

  return {
    externalId: page.id,
    title,
    notes: map.notes ? plainText(props[map.notes]?.rich_text) || null : null,
    done: statusValue ? doneValues.includes(statusValue.toLowerCase()) : false,
    dueAt: map.due ? parseDate(props[map.due]) : null,
    priority: map.priority ? parsePriority(props[map.priority]) : null,
    estimatedMinutes: map.estimate ? parseMinutes(props[map.estimate]) : null,
    area: map.area ? parseSelectish(props[map.area]) : null,
    energy: map.energy ? parseEnergy(props[map.energy]) : null,
    dependsOnExternalIds: map.dependsOn
      ? (props[map.dependsOn]?.relation ?? []).map((r: any) => r.id)
      : [],
    externalUpdatedAt: Date.parse(page.last_edited_time ?? '') || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Writing back
// ---------------------------------------------------------------------------

export async function markTaskDone(
  token: string,
  externalId: string,
  map: NotionPropertyMap,
): Promise<void> {
  if (!map.status) return;

  const doneValue = map.doneValues?.[0] ?? 'Done';
  // The property may be a status, a select, or a plain checkbox depending on
  // how the database was built; try the declared shape and fall back.
  const attempts = [
    { [map.status]: { status: { name: doneValue } } },
    { [map.status]: { select: { name: doneValue } } },
    { [map.status]: { checkbox: true } },
  ];

  let lastError: unknown;
  for (const properties of attempts) {
    try {
      await notionFetch(
        token,
        `/pages/${externalId}`,
        { method: 'PATCH', body: JSON.stringify({ properties }) },
        'notion.markDone',
      );
      return;
    } catch (err) {
      if (err instanceof PlannerError && err.retryable) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

export async function createTask(
  token: string,
  databaseId: string,
  map: NotionPropertyMap,
  task: {
    title: string;
    notes?: string | null;
    dueAt?: number | null;
    estimatedMinutes?: number | null;
  },
): Promise<string> {
  const properties: Record<string, unknown> = {
    [map.title]: { title: [{ text: { content: task.title.slice(0, 2000) } }] },
  };

  if (map.notes && task.notes) {
    properties[map.notes] = {
      rich_text: [{ text: { content: task.notes.slice(0, 2000) } }],
    };
  }
  if (map.due && task.dueAt) {
    properties[map.due] = {
      date: { start: new Date(task.dueAt).toISOString().slice(0, 10) },
    };
  }
  if (map.estimate && task.estimatedMinutes) {
    properties[map.estimate] = { number: task.estimatedMinutes };
  }

  const created = await notionFetch<any>(
    token,
    '/pages',
    {
      method: 'POST',
      body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
    },
    'notion.createTask',
  );

  return created.id;
}

// ---------------------------------------------------------------------------
// Property parsers — Notion's value shapes vary a lot between property types
// ---------------------------------------------------------------------------

function plainText(value: any): string {
  if (!Array.isArray(value)) return '';
  return value.map((v: any) => v?.plain_text ?? '').join('').trim();
}

function parseDate(prop: any): number | null {
  const start = prop?.date?.start;
  if (!start) return null;
  const ts = Date.parse(start);
  return Number.isNaN(ts) ? null : ts;
}

function parseSelectish(prop: any): string | null {
  return (
    prop?.select?.name ??
    prop?.status?.name ??
    prop?.multi_select?.[0]?.name ??
    (typeof prop?.rich_text !== 'undefined' ? plainText(prop.rich_text) : null) ??
    null
  );
}

/** Accepts a number, or a select whose label encodes urgency in words. */
function parsePriority(prop: any): number | null {
  if (typeof prop?.number === 'number') {
    return Math.min(4, Math.max(1, Math.round(prop.number)));
  }
  const label = parseSelectish(prop)?.toLowerCase();
  if (!label) return null;
  if (/urgent|alta|high|p1|🔥/.test(label)) return 1;
  if (/media|medium|p2/.test(label)) return 2;
  if (/bassa|low|p3/.test(label)) return 3;
  if (/quando|someday|p4/.test(label)) return 4;
  return null;
}

/** Handles "1h 30", "90", "1,5 ore" — all of which appear in real databases. */
function parseMinutes(prop: any): number | null {
  if (typeof prop?.number === 'number' && prop.number > 0) {
    return Math.round(prop.number);
  }
  const label = parseSelectish(prop);
  if (!label) return null;

  const hoursMatch = /(\d+(?:[.,]\d+)?)\s*(?:h|ore|ora)/i.exec(label);
  const minsMatch = /(\d+)\s*(?:m|min)/i.exec(label);

  let total = 0;
  if (hoursMatch?.[1]) total += Number(hoursMatch[1].replace(',', '.')) * 60;
  if (minsMatch?.[1]) total += Number(minsMatch[1]);
  if (total === 0) {
    const bare = /^\s*(\d+)\s*$/.exec(label);
    if (bare?.[1]) total = Number(bare[1]);
  }

  return total > 0 ? Math.round(total) : null;
}

function parseEnergy(prop: any): Energy | null {
  const label = parseSelectish(prop)?.toLowerCase();
  if (!label) return null;
  if (/alt|high|profond|deep|hard/.test(label)) return 'high';
  if (/medi|medium|normal/.test(label)) return 'medium';
  if (/bass|low|leggero|light|easy/.test(label)) return 'low';
  return null;
}

/** Maps a free-text Notion area onto our canonical enum. */
export function normalizeArea(raw: string | null, fallback: Area): Area {
  if (!raw) return fallback;
  const s = raw.toLowerCase();
  if (/mg|integration/.test(s)) return 'mg';
  if (/univ|esame|studio|lezione/.test(s)) return 'university';
  if (/heemia/.test(s)) return 'heemia';
  if (/salut|health|palestra|medic/.test(s)) return 'health';
  if (/spesa|commission|errand/.test(s)) return 'errand';
  if (/person/.test(s)) return 'personal';
  return fallback;
}
