import { describe, expect, it } from 'vitest';
import { deleteCell, fresh, getHit, insertAfter, runs } from './model';
import { randomFill } from './random';

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

  it('puts kicks mostly on group starts', () => {
    let starts = 0, onStart = 0;
    for (let s = 1; s <= 40; s++) {
      const q = randomFill(fresh(), null, seeded(s));
      for (const r of runs(q)) {
        starts++;
        if (getHit(q, r.start, 'BD')) onStart++;
      }
    }
    expect(onStart / starts).toBeGreaterThan(0.8);
  });

  it('with a selection, only touches the selection', () => {
    const p = fresh();
    const q = randomFill(p, { t0: 4, t1: 7, r0: 17, r1: 17 }, seeded(3));
    q.threads.forEach((t, i) => {
      const keys = Object.keys(t.lanes);
      if (i < 4 || i > 7) expect(keys).toEqual([]);
      else expect(keys.every((k) => k === 'BD')).toBe(true);
    });
  });
});
