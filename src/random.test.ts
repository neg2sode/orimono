import { describe, expect, it } from 'vitest';
import { deleteCell, fresh, getHit, insertAfter, runs, setHit } from './model';
import { STYLES, randomFill, randomFillStyled } from './random';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe('Random (scenario 6)', () => {
  it('fills hits but never changes groups or length', () => {
    let p = insertAfter(fresh(), 5);
    p = deleteCell(p, p.threads.length - 1); // 4+5+4+3
    const q = randomFill(p, null, seeded(1));
    expect(runs(q)).toEqual(runs(p));
    expect(q.threads.map((t) => t.id)).toEqual(p.threads.map((t) => t.id));
    expect(q.threads.some((t) => Object.keys(t.lanes).length > 0)).toBe(true);
  });

  it('Backbeat puts kicks mostly on group starts', () => {
    let starts = 0, onStart = 0;
    for (let s = 1; s <= 40; s++) {
      const q = randomFill(fresh(), null, seeded(s), [0]);
      for (const r of runs(q)) {
        starts++;
        if (getHit(q, r.start, 'BD')) onStart++;
      }
    }
    expect(onStart / starts).toBeGreaterThan(0.8);
  });

  it('with a selection, only touches the selection', () => {
    const p = fresh();
    const q = randomFill(p, { t0: 4, t1: 7, r0: 16, r1: 16 }, seeded(3));
    q.threads.forEach((t, i) => {
      const keys = Object.keys(t.lanes);
      if (i < 4 || i > 7) expect(keys).toEqual([]);
      else expect(keys.every((k) => k === 'BD')).toBe(true);
    });
  });

  it('every style plays something on 4+4+4+4', () => {
    STYLES.forEach((_, i) => {
      const q = randomFill(fresh(), null, seeded(7), [i]);
      expect(q.threads.some((t) => Object.keys(t.lanes).length > 0)).toBe(true);
    });
  });

  it('never touches your notes, and leaves rows holding them alone', () => {
    let p = setHit(fresh(), 1, 'BD', { v: 0.3, mine: true });
    p = setHit(p, 2, 'SD', { v: 0.9 }); // a Random-made note
    for (let s = 1; s <= 20; s++) {
      const q = randomFill(p, null, seeded(s));
      expect(getHit(q, 1, 'BD')).toEqual({ v: 0.3, mine: true });
      q.threads.forEach((_, ti) => { if (ti !== 1) expect(getHit(q, ti, 'BD')).toBeNull(); });
    }
  });

  it('with a selection, fills around your notes', () => {
    const p = setHit(fresh(), 1, 'BD', { v: 0.3, mine: true });
    const q = randomFill(p, { t0: 0, t1: 15, r0: 16, r1: 16 }, seeded(2), [0]);
    expect(getHit(q, 1, 'BD')).toEqual({ v: 0.3, mine: true });
    expect(getHit(q, 0, 'BD')?.mine).toBeUndefined();
    expect(q.threads.filter((_, ti) => getHit(q, ti, 'BD')).length).toBeGreaterThan(1);
  });

  it('a selected row gets a style that plays in it', () => {
    for (let s = 1; s <= 10; s++) {
      const { pattern: q } = randomFillStyled(fresh(), { t0: 0, t1: 15, r0: 7, r1: 7 }, seeded(s)); // cowbell
      expect(q.threads.some((_, ti) => getHit(q, ti, 'CB'))).toBe(true);
    }
  });
});
