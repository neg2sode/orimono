import { describe, expect, it } from 'vitest';
import { ROWS } from './constants';
import { packFabric, unpackFabric } from './link';
import { deleteCell, fresh, insertAfter, runs, setHit, single, split, zoomRect, type Pattern } from './model';
import { randomFill } from './random';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}
const open = (text: string) => {
  const got = unpackFabric(text);
  if (!got || got === 'newer') throw new Error('did not open');
  return got;
};
/** What a link must keep: group lengths and colours, and every lane's fibres and notes. */
const shape = (p: Pattern) => ({
  groups: runs(p).map((r) => [r.end - r.start, r.colour]),
  lanes: p.threads.map((t) => ROWS.map((row) => {
    const l = t.lanes[row];
    return l && (l.zoom > 1 || l.slots[0]) ? [l.zoom, l.slots.map((h) => (h ? (h.mine ? 'mine' : 'random') : null))] : null;
  })),
});

describe('a link for a fabric', () => {
  it('keeps the kit rows of version 1', () => {
    expect([...ROWS]).toEqual(['CR', 'RD', 'OH', 'CH', 'PH', 'SH', 'TB', 'CB', 'CL', 'CP', 'BG', 'CG', 'DB', 'HT', 'FT', 'SD', 'BD']);
  });

  it('carries an empty fabric and its tempo', () => {
    const got = open(packFabric(fresh(), 72.5));
    expect(got.bpm).toBe(72.5);
    expect(shape(got.pattern)).toEqual(shape(fresh()));
    expect(open(packFabric(single(), 300)).pattern.threads.length).toBe(1);
  });

  it('carries groups, notes and who drew them', () => {
    for (let s = 1; s <= 30; s++) {
      let p = insertAfter(fresh(), 5);
      p = split(deleteCell(p, p.threads.length - 1), 2);
      p = randomFill(p, null, seeded(s));
      p = setHit(p, 3, 'CB', { v: 0.9, mine: true });
      const text = packFabric(p, 120);
      const got = open(text);
      expect(shape(got.pattern)).toEqual(shape(p));
      expect(packFabric(got.pattern, got.bpm)).toBe(text); // opening and sharing again changes nothing
    }
  });

  it('carries fibres, empty regions included', () => {
    let p = zoomRect(fresh(), { t0: 4, t1: 7, r0: 3, r1: 3 }, 3);
    p = setHit(p, 5, 'CH', { v: 0.6, mine: true }, 2);
    p = zoomRect(p, { t0: 0, t1: 1, r0: 16, r1: 16 }, 7); // a region with nothing in it
    p = setHit(p, 9, 'CH', { v: 0.75, mine: true });
    const got = open(packFabric(p, 96)).pattern;
    expect(shape(got)).toEqual(shape(p));
    expect(got.threads[5].lanes.CH!.slots[2]!.v).toBeCloseTo(0.6, 1);
  });

  it('keeps strength to within half a step of sixteen', () => {
    for (const v of [0.05, 0.2, 0.44, 0.72, 0.75, 0.89, 1]) {
      const got = open(packFabric(setHit(fresh(), 0, 'BD', { v }), 72)).pattern;
      expect(Math.abs(got.threads[0].lanes.BD!.slots[0]!.v - v)).toBeLessThan(0.033);
    }
  });

  it('stays short', () => {
    const p = randomFill(fresh(), null, seeded(7));
    expect(packFabric(p, 72).length).toBeLessThan(110);
  });

  it('turns away what is not a link', () => {
    expect(unpackFabric('')).toBeNull();
    expect(unpackFabric('1')).toBeNull();
    expect(unpackFabric('1!!!')).toBeNull();
    expect(unpackFabric('hello')).toBeNull();
    expect(unpackFabric('2' + packFabric(fresh(), 72).slice(1) + 'AAAAAAAA')).toBe('newer');
  });
});
