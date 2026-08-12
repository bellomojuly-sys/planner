import { describe, it, expect } from 'vitest';
import { guessPropertyMap, normalizeArea } from '../src/integrations/notion';
import type { NotionDatabaseInfo } from '../src/integrations/notion';

/**
 * These fixtures are the real property schemas of Giulia's two Notion
 * databases, read back from the workspace. They exist because the previous
 * substring-based matcher mapped `due` to "Created Date" and `estimate` to
 * "Estimate Confidence" on this exact data — mistakes that produce a plausible
 * looking but wrong plan rather than an error.
 */

/** Tasks — the shared database. Area routes rows to University/Heemia/etc. */
const TASKS: NotionDatabaseInfo = {
  id: '22dcf789-3820-40c9-8299-fffd0a518382',
  title: 'Tasks',
  properties: [
    { name: 'Actual Time', type: 'number' },
    {
      name: 'Area',
      type: 'select',
      options: [
        'Heemia',
        'MG Integration',
        'University',
        'Carriera / ICT',
        'Personal',
        'health',
      ],
    },
    { name: 'Blocked By', type: 'relation' },
    { name: 'Capture ID', type: 'rich_text' },
    { name: 'Created Date', type: 'created_time' },
    { name: 'Dependency Hints', type: 'rich_text' },
    { name: 'Due', type: 'formula' },
    { name: 'Due Date', type: 'date' },
    { name: 'Earliest Start', type: 'date' },
    {
      name: 'Energy Level',
      type: 'select',
      options: ['High Focus', 'Medium', 'Low / Admin'],
    },
    {
      name: 'Estimate Confidence',
      type: 'select',
      options: ['High', 'Medium', 'Low'],
    },
    { name: 'Estimated Time', type: 'number' },
    { name: 'Google Event ID', type: 'rich_text' },
    { name: 'Next Action', type: 'checkbox' },
    {
      name: 'Priority',
      type: 'select',
      options: ['P1 - Critical', 'P2 - Important', 'P3 - Nice to have'],
    },
    { name: 'Project', type: 'relation' },
    { name: 'Schedule Reason', type: 'rich_text' },
    { name: 'Scheduled Block', type: 'date' },
    {
      name: 'Scheduling Mode',
      type: 'select',
      options: ['Flexible', 'User Preferred', 'Locked', 'Fixed'],
    },
    {
      name: 'Status',
      type: 'select',
      options: ['Not Started', 'In Progress', 'Waiting', 'Done'],
    },
    { name: 'Task Name', type: 'title' },
    { name: 'Type', type: 'select', options: ['Task', 'Meeting', 'Deadline'] },
    { name: 'Voice Transcript', type: 'rich_text' },
    { name: 'Waiting On', type: 'rich_text' },
  ],
};

/** Task MG Integration — a separate database, property names in Italian. */
const MG: NotionDatabaseInfo = {
  id: 'e32eaadf-2a02-4e9e-9a2f-c2d0c660fa89',
  title: 'Task MG Integration',
  properties: [
    { name: 'Blocco pianificato', type: 'date' },
    { name: 'Confidenza stima', type: 'select', options: ['Alta', 'Media', 'Bassa'] },
    { name: 'Data minima di inizio', type: 'date' },
    { name: 'Dipende da', type: 'relation' },
    { name: 'Dipendenze testuali', type: 'rich_text' },
    { name: 'Duplicato', type: 'checkbox' },
    { name: 'Durata stimata', type: 'number' },
    {
      name: 'Energia',
      type: 'select',
      options: ['High Focus', 'Medium', 'Low / Admin'],
    },
    { name: 'Google Event ID', type: 'rich_text' },
    { name: 'ID acquisizione', type: 'rich_text' },
    {
      name: 'Modalita scheduling',
      type: 'select',
      options: ['Flessibile', 'Preferita dall utente', 'Bloccata', 'Fissa'],
    },
    { name: 'Motivo pianificazione', type: 'rich_text' },
    { name: 'Priorita', type: 'select', options: ['Alta', 'Media', 'Bassa'] },
    { name: 'Progetto/Cliente', type: 'rich_text' },
    { name: 'Responsabile', type: 'select', options: ['Giulia', 'Micaela'] },
    { name: 'Scadenza', type: 'date' },
    {
      name: 'Stato',
      type: 'status',
      options: ['Not started', 'In progress', 'Done'],
    },
    { name: 'Task', type: 'title' },
    { name: 'Tempo effettivo', type: 'number' },
    { name: 'Trascrizione vocale', type: 'rich_text' },
  ],
};

describe('property mapping — Tasks (shared database)', () => {
  const map = guessPropertyMap(TASKS);

  it('finds the title and status', () => {
    expect(map.title).toBe('Task Name');
    expect(map.status).toBe('Status');
    expect(map.doneValues).toEqual(['Done']);
  });

  it('picks the deadline, not the creation date', () => {
    // The regression: "Created Date" contains "date" and used to win.
    expect(map.due).toBe('Due Date');
  });

  it('picks the estimated duration, not the confidence label', () => {
    // The regression: "Estimate Confidence" contains "estimate" and used to win.
    expect(map.estimate).toBe('Estimated Time');
    expect(map.actual).toBe('Actual Time');
  });

  it('maps the remaining scheduling inputs', () => {
    expect(map.area).toBe('Area');
    expect(map.energy).toBe('Energy Level');
    expect(map.priority).toBe('Priority');
    expect(map.dependsOn).toBe('Blocked By');
    expect(map.dependencyHints).toBe('Dependency Hints');
    expect(map.earliestStart).toBe('Earliest Start');
    expect(map.schedulingMode).toBe('Scheduling Mode');
  });

  it('recognises the Type column so meetings are not booked as work', () => {
    expect(map.typeProperty).toBe('Type');
    expect(map.schedulableTypes).toContain('Task');
    expect(map.schedulableTypes).not.toContain('Meeting');
    expect(map.schedulableTypes).not.toContain('Deadline');
  });

  it('builds the reverse area map used when writing back', () => {
    expect(map.areaValues).toMatchObject({
      university: 'University',
      heemia: 'Heemia',
      mg: 'MG Integration',
      personal: 'Personal',
      health: 'health',
      career: 'Carriera / ICT',
    });
  });
});

describe('property mapping — Task MG Integration (Italian)', () => {
  const map = guessPropertyMap(MG);

  it('finds the title and status', () => {
    expect(map.title).toBe('Task');
    expect(map.status).toBe('Stato');
    expect(map.doneValues).toEqual(['Done']);
  });

  it('picks the deadline, not the earliest-start date', () => {
    // The regression: "Data minima di inizio" contains "data" and used to win.
    expect(map.due).toBe('Scadenza');
    expect(map.earliestStart).toBe('Data minima di inizio');
  });

  it('picks the estimated duration, not the confidence label', () => {
    // The regression: "Confidenza stima" contains "stima" and used to win.
    expect(map.estimate).toBe('Durata stimata');
    expect(map.actual).toBe('Tempo effettivo');
  });

  it('does not mistake a free-text project field for the area taxonomy', () => {
    // "Progetto/Cliente" is rich_text, so the type gate excludes it.
    expect(map.area).toBeUndefined();
  });

  it('maps the remaining scheduling inputs', () => {
    expect(map.energy).toBe('Energia');
    expect(map.priority).toBe('Priorita');
    expect(map.dependsOn).toBe('Dipende da');
    expect(map.dependencyHints).toBe('Dipendenze testuali');
    expect(map.schedulingMode).toBe('Modalita scheduling');
  });

  it('applies no type filter when the database has no Type column', () => {
    expect(map.typeProperty).toBeUndefined();
    expect(map.schedulableTypes).toBeUndefined();
  });
});

describe('area routing from a single database', () => {
  it('routes every real Area option to the right planner area', () => {
    expect(normalizeArea('University', 'general')).toBe('university');
    expect(normalizeArea('Heemia', 'general')).toBe('heemia');
    expect(normalizeArea('MG Integration', 'general')).toBe('mg');
    expect(normalizeArea('Personal', 'general')).toBe('personal');
    expect(normalizeArea('health', 'general')).toBe('health');
  });

  it('routes Carriera / ICT to its own area', () => {
    expect(normalizeArea('Carriera / ICT', 'general')).toBe('career');
    expect(normalizeArea('Career development', 'general')).toBe('career');
  });

  it('does not let the generic integration rule swallow Heemia', () => {
    // Ordering matters: a Heemia row must never be filed as MG.
    expect(normalizeArea('Heemia', 'mg')).toBe('heemia');
  });

  it('keeps the source default when the row has no area at all', () => {
    expect(normalizeArea(null, 'mg')).toBe('mg');
  });
});

// ---------------------------------------------------------------------------

import { mapPage } from '../src/integrations/notion';

const TASKS_MAP = guessPropertyMap(TASKS);

/** Builds a Notion page payload in the shape the API actually returns. */
function page(props: Record<string, unknown>) {
  return {
    id: 'page-1',
    last_edited_time: '2026-08-12T10:00:00.000Z',
    properties: {
      'Task Name': { title: [{ plain_text: 'Ripassare Analisi II' }] },
      ...props,
    },
  };
}

describe('row translation', () => {
  it('routes a University row to the university area', () => {
    const task = mapPage(
      page({
        Area: { select: { name: 'University' } },
        'Due Date': { date: { start: '2026-09-15' } },
        'Estimated Time': { number: 120 },
        'Energy Level': { select: { name: 'High Focus' } },
        Priority: { select: { name: 'P1 - Critical' } },
        Type: { select: { name: 'Task' } },
      }),
      TASKS_MAP,
    )!;

    expect(normalizeArea(task.area, 'general')).toBe('university');
    expect(task.estimatedMinutes).toBe(120);
    expect(task.energy).toBe('high');
    expect(task.priority).toBe(1);
    expect(task.dueAt).toBe(Date.parse('2026-09-15'));
    expect(task.schedulable).toBe(true);
  });

  it('routes a Heemia row to the heemia area', () => {
    const task = mapPage(
      page({
        Area: { select: { name: 'Heemia' } },
        'Energy Level': { select: { name: 'Low / Admin' } },
      }),
      TASKS_MAP,
    )!;

    expect(normalizeArea(task.area, 'general')).toBe('heemia');
    expect(task.energy).toBe('low');
  });

  it('excludes an exam Deadline from schedulable work', () => {
    const task = mapPage(
      page({
        Area: { select: { name: 'University' } },
        Type: { select: { name: 'Deadline' } },
        'Due Date': { date: { start: '2026-09-20' } },
      }),
      TASKS_MAP,
    )!;

    // Scheduling a deadline marker would book study time for the exam date
    // itself, on top of whatever real revision work is already planned.
    expect(task.schedulable).toBe(false);
  });

  it('excludes a Meeting, which already lives in Google Calendar', () => {
    const task = mapPage(page({ Type: { select: { name: 'Meeting' } } }), TASKS_MAP)!;
    expect(task.schedulable).toBe(false);
  });

  it('treats a row with no Type set as work', () => {
    const task = mapPage(page({ Type: { select: null } }), TASKS_MAP)!;
    expect(task.schedulable).toBe(true);
  });

  it('marks Locked and Fixed rows as unsplittable, without pinning them', () => {
    const locked = mapPage(
      page({ 'Scheduling Mode': { select: { name: 'Locked' } } }),
      TASKS_MAP,
    )!;
    const flexible = mapPage(
      page({ 'Scheduling Mode': { select: { name: 'Flexible' } } }),
      TASKS_MAP,
    )!;

    expect(locked.splittable).toBe(false);
    expect(flexible.splittable).toBe(true);
  });

  it('reads the start constraint and the recorded real duration', () => {
    const task = mapPage(
      page({
        'Earliest Start': { date: { start: '2026-08-20' } },
        'Actual Time': { number: 95 },
      }),
      TASKS_MAP,
    )!;

    expect(task.earliestStartAt).toBe(Date.parse('2026-08-20'));
    expect(task.actualMinutes).toBe(95);
  });

  it('reads Done from the Status select', () => {
    const done = mapPage(page({ Status: { select: { name: 'Done' } } }), TASKS_MAP)!;
    const open = mapPage(
      page({ Status: { select: { name: 'In Progress' } } }),
      TASKS_MAP,
    )!;

    expect(done.done).toBe(true);
    expect(open.done).toBe(false);
  });

  it('skips a row with no title, which is an empty Notion placeholder', () => {
    expect(
      mapPage({ id: 'x', properties: { 'Task Name': { title: [] } } }, TASKS_MAP),
    ).toBeNull();
  });
});
