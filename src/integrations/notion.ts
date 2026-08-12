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
 * Picks the property that best fits a field.
 *
 * Two rules make this reliable where a plain substring search is not:
 *
 *  - **The Notion type is a hard gate.** A due date must be a `date`. Without
 *    this, "Created Date" wins the search for a deadline simply because it
 *    contains the word "date".
 *  - **Candidates are ordered, most specific first**, and an exact name always
 *    beats a partial one. Without this, "Estimate Confidence" (a High/Medium/
 *    Low label) is chosen over "Estimated Time" for the duration, because both
 *    contain "estimate".
 *
 * Both of those were real mis-mappings against real databases, and both fail
 * silently — a planner scheduling against creation dates looks like it works.
 */
function pick(
  info: NotionDatabaseInfo,
  types: string[],
  patterns: RegExp[],
): string | undefined {
  const candidates = info.properties.filter((p) => types.includes(p.type));
  for (const pattern of patterns) {
    const hit = candidates.find((p) => pattern.test(p.name.trim()));
    if (hit) return hit.name;
  }
  return undefined;
}

export function guessPropertyMap(info: NotionDatabaseInfo): NotionPropertyMap {
  const title = info.properties.find((p) => p.type === 'title')?.name ?? 'Name';

  const status = pick(
    info,
    ['status', 'select', 'checkbox'],
    [/^(stato|status)$/i, /\b(stato|status)\b/i, /^(fatto|done|completat)/i],
  );

  const doneValues = info.properties
    .find((p) => p.name === status)
    ?.options?.filter((o) => /fatt|complet|done|chius|archiv/i.test(o));

  const typeProperty = pick(info, ['select'], [/^(type|tipo)$/i]);

  const areaProperty = pick(
    info,
    ['select', 'multi_select'],
    [/^(area|categoria|category)$/i, /\barea\b/i, /categor/i],
  );

  // Reverse the area taxonomy by running each real option through the same
  // normaliser the read path uses, so reads and writes cannot disagree.
  const areaValues: Partial<Record<Area, string>> = {};
  for (const option of info.properties.find((p) => p.name === areaProperty)?.options ?? []) {
    const canonical = /general/i.test(option)
      ? 'general'
      : normalizeArea(option, 'general');
    // normalizeArea returns the fallback for labels it does not recognise;
    // only record a mapping we are actually confident about.
    if (canonical === 'general' && !/general/i.test(option)) continue;
    if (!areaValues[canonical]) areaValues[canonical] = option;
  }

  return {
    title,
    status,
    doneValues: doneValues?.length ? doneValues : ['Done', 'Fatto', 'Completato'],

    // Deliberately excludes "Data minima di inizio" / "Earliest Start", which
    // are start constraints, not deadlines.
    due: pick(
      info,
      ['date'],
      [/^(scadenza|due date|due)$/i, /^scadenz/i, /\bdue\b/i, /deadline/i],
    ),

    priority: pick(
      info,
      ['select', 'status', 'number'],
      [/^(priorit[àa]|priority)$/i, /priorit/i],
    ),

    // Number-typed, so the High/Medium/Low confidence labels cannot win.
    estimate: pick(
      info,
      ['number'],
      [
        /^(durata stimata|estimated time|stima)$/i,
        /^durata/i,
        /^estimat/i,
        /\b(stimat|estimat)/i,
        /tempo previsto/i,
      ],
    ),

    actual: pick(
      info,
      ['number'],
      [/^(tempo effettivo|actual time)$/i, /effettiv/i, /\bactual\b/i, /reale/i],
    ),

    // Select-typed, so a free-text "Progetto/Cliente" cannot be mistaken for
    // the area taxonomy.
    area: areaProperty,
    areaValues,

    energy: pick(
      info,
      ['select'],
      [/^(energia|energy level|energy)$/i, /energ/i, /sforzo|effort/i],
    ),

    notes: pick(
      info,
      ['rich_text'],
      [/^(note|notes|descrizione|description)$/i, /^note/i, /descriz/i],
    ),

    dependsOn: pick(
      info,
      ['relation'],
      [/^(dipende da|blocked by|depends on)$/i, /^dipende/i, /block/i, /depend/i],
    ),

    dependencyHints: pick(
      info,
      ['rich_text'],
      [/^(dipendenze testuali|dependency hints)$/i, /dipendenz/i, /dependenc/i],
    ),

    earliestStart: pick(
      info,
      ['date'],
      [
        /^(data minima di inizio|earliest start)$/i,
        /minima di inizio/i,
        /earliest/i,
      ],
    ),

    typeProperty,
    // Only used when `typeProperty` exists; a row whose type is blank is
    // always treated as work.
    schedulableTypes: typeProperty
      ? ['Task', 'Attività', 'Attivita', 'Todo', 'To-do']
      : undefined,

    schedulingMode: pick(
      info,
      ['select'],
      [/^(modalita scheduling|scheduling mode)$/i, /scheduling/i, /modalit/i],
    ),
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
  actualMinutes: number | null;
  earliestStartAt: number | null;
  area: string | null;
  energy: Energy | null;
  dependsOnExternalIds: string[];
  dependencyHints: string | null;
  /** Locked/Fixed rows must not be split across sittings. */
  splittable: boolean;
  externalUpdatedAt: number;
  /**
   * False for rows that are calendar markers rather than work — meetings that
   * already exist in Google Calendar, and deadlines like an exam date.
   */
  schedulable: boolean;
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

/** Exported for tests: this translation is where routing correctness lives. */
export function mapPage(page: any, map: NotionPropertyMap): NotionTask | null {
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

  const typeValue = map.typeProperty
    ? parseSelectish(props[map.typeProperty])
    : null;
  const allowedTypes = map.schedulableTypes ?? [];
  // A blank type is treated as work: only an explicit Meeting/Deadline is
  // excluded, so a half-filled row is never silently dropped.
  const schedulable =
    !map.typeProperty ||
    !typeValue ||
    allowedTypes.some((t) => t.toLowerCase() === typeValue.toLowerCase());

  const mode = map.schedulingMode
    ? parseSelectish(props[map.schedulingMode])?.toLowerCase()
    : null;

  return {
    externalId: page.id,
    title,
    notes: map.notes ? plainText(props[map.notes]?.rich_text) || null : null,
    done: statusValue ? doneValues.includes(statusValue.toLowerCase()) : false,
    dueAt: map.due ? parseDate(props[map.due]) : null,
    priority: map.priority ? parsePriority(props[map.priority]) : null,
    estimatedMinutes: map.estimate ? parseMinutes(props[map.estimate]) : null,
    actualMinutes: map.actual ? parseMinutes(props[map.actual]) : null,
    earliestStartAt: map.earliestStart ? parseDate(props[map.earliestStart]) : null,
    area: map.area ? parseSelectish(props[map.area]) : null,
    energy: map.energy ? parseEnergy(props[map.energy]) : null,
    dependsOnExternalIds: map.dependsOn
      ? (props[map.dependsOn]?.relation ?? []).map((r: any) => r.id)
      : [],
    dependencyHints: map.dependencyHints
      ? plainText(props[map.dependencyHints]?.rich_text) || null
      : null,
    // "Locked"/"Bloccata" and "Fixed"/"Fissa" mean the work happens in one
    // sitting. They deliberately do not set the pinned flag: pinning is what
    // the app's manual drag does, and a pinned task with no placed block
    // would never be scheduled at all.
    splittable: !mode || !/lock|blocc|fixed|fiss/.test(mode),
    externalUpdatedAt: Date.parse(page.last_edited_time ?? '') || Date.now(),
    schedulable,
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
    area?: Area;
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

  // Only write a label this database actually offers — inventing an option
  // makes Notion reject the whole page.
  const areaLabel = task.area ? map.areaValues?.[task.area] : undefined;
  if (map.area && areaLabel) {
    properties[map.area] = { select: { name: areaLabel } };
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

/**
 * Maps a Notion `Area` value onto our canonical enum.
 *
 * This is what lets a single Notion database feed several planner areas:
 * University and Heemia are not separate databases, they are options of the
 * `Area` select in the shared Tasks database, and each row is routed by its
 * own value rather than by which database it came from.
 *
 * Ordered most specific first — "MG Integration" must not be caught by the
 * generic `integration` branch before the Heemia and University checks run.
 */
export function normalizeArea(raw: string | null, fallback: Area): Area {
  if (!raw) return fallback;
  const s = raw.toLowerCase();
  if (/heemia/.test(s)) return 'heemia';
  if (/\bmg\b|integration/.test(s)) return 'mg';
  if (/univ|esame|exam|studio|corso|lezione/.test(s)) return 'university';
  if (/salut|health|palestra|medic|benessere/.test(s)) return 'health';
  if (/spesa|commission|errand/.test(s)) return 'errand';
  if (/person/.test(s)) return 'personal';
  // "Carriera / ICT" lands here. It has no dedicated planner area yet, so it
  // is filed under general rather than being dropped.
  return fallback;
}
