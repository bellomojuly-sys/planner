import { describe, expect, it } from 'vitest';
import { findOrphans } from '../src/services/prune-orphans';
import { plannerEventId } from '../src/integrations/google-calendar';

describe('orphan calendar events', () => {
  const blocks = [
    { id: 'b1', googleEventId: 'e1' },
    { id: 'b2', googleEventId: null },
  ];

  it('removes an event whose block no longer exists', () => {
    expect(findOrphans([{ eventId: 'old', plannerBlockId: 'gone' }], blocks)).toEqual(['old']);
  });

  it('removes a second event written for the same block', () => {
    expect(
      findOrphans(
        [
          { eventId: 'e1', plannerBlockId: 'b1' },
          { eventId: 'e1-copy', plannerBlockId: 'b1' },
        ],
        blocks,
      ),
    ).toEqual(['e1-copy']);
  });

  it('leaves an event for a block still being pushed', () => {
    expect(findOrphans([{ eventId: 'x', plannerBlockId: 'b2' }], blocks)).toEqual([]);
  });
});

describe('stable event ids', () => {
  it('turns a block UUID into a valid Google event id', () => {
    const id = plannerEventId('7A941CC3-743A-49D3-97CA-C473CD1641A5');
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(id).toBe(plannerEventId('7a941cc3-743a-49d3-97ca-c473cd1641a5'));
  });
});
