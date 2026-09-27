import type { Area } from '../db/schema';

/**
 * Keyword area inference for quick-add and voice capture, so a task typed as
 * "post Heemia" lands in Heemia without Giulia choosing the area by hand.
 *
 * It is deliberately conservative: it returns `null` when nothing matches, so
 * the caller keeps its own default, and callers only apply it when the area is
 * still the generic default — an area picked on purpose is never overridden.
 * The markers mirror the domain routing in `agents/registry` so the quick form
 * and "Organizza con Dani" agree on where work belongs. More specific areas
 * come first: an "MG Heemia" note resolves to the first marker that hits.
 */
const AREA_MARKERS: ReadonlyArray<readonly [Area, readonly string[]]> = [
  ['heemia', ['heemia']],
  [
    'mg',
    ['mg', 'dmg', 'mg integration', 'integration', 'integrazione', 'onboarding', 'proposal'],
  ],
  [
    'university',
    [
      'università',
      'universita',
      'university',
      'berzi',
      'amexio',
      'dani',
      'portfolio',
      'decision log',
      'esame',
      'esami',
      'appello',
      'lezione',
      'lezioni',
      'professore',
      'docente',
      'fontys',
      'tentamen',
      'studiare',
    ],
  ],
  [
    'career',
    ['linkedin', 'cv', 'curriculum', 'carriera', 'colloquio', 'candidatura', 'ict'],
  ],
  [
    'health',
    ['palestra', 'medico', 'dottore', 'dottoressa', 'dentista', 'salute', 'fisioterapia', 'visita'],
  ],
  ['errand', ['spesa', 'posta', 'pacco', 'farmacia', 'ritirare', 'ritiro']],
  [
    'personal',
    [
      'burocrazia',
      'assicurazione',
      'documenti',
      'documento',
      'banca',
      'bolletta',
      'affitto',
      'contratto',
      'permesso',
      'rinnovo',
    ],
  ],
];

/**
 * Returns the inferred area for a task title, or `null` when no marker matches.
 * Matching is whole-word and accent-preserving: "posta" does not fire on
 * "imposta", and multi-word markers like "decision log" match only in order.
 */
export function inferArea(title: string): Area | null {
  const padded = ` ${title.toLocaleLowerCase('it').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  for (const [area, markers] of AREA_MARKERS) {
    if (markers.some((marker) => padded.includes(` ${marker} `))) return area;
  }
  return null;
}
