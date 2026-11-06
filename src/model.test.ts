import { describe, expect, it } from 'vitest';
import { PALETTE } from './constants';
import {
  clearRect, copyRect, deleteCell, deleteGroups, duplicateGroups, fresh, getHit, insertAfter, insertFront,
  isBoundary, merge, mergeGroups, moveGroups, pasteClip, recolour, runs, setHit, split, type Pattern,
} from './model';
import { colourDistance } from './colour';

const shape = (p: Pattern) => runs(p).map((r) => r.end - r.start).join('+');
const colours = (p: Pattern) => runs(p).map((r) => PALETTE[r.colour].name).join(' ');

describe('fresh pattern', () => {
  it('is 4+4+4+4 in Clay Peach Honey Ivory', () => {
    const p = fresh();
    expect(shape(p)).toBe('4+4+4+4');
    expect(colours(p)).toBe('Clay Peach Honey Ivory');
  });
});

describe('number lane (§14 scenarios 2–5)', () => {
  it('"+" on cell 6 gives 4+5+4+4; "–" on the last gives 4+5+4+3', () => {
    let p = insertAfter(fresh(), 5);
    expect(shape(p)).toBe('4+5+4+4');
    p = deleteCell(p, p.threads.length - 1);
    expect(shape(p)).toBe('4+5+4+3');
  });

  it('a new front group is Latte; after deleting it, the next ones are Slate, Teal, Khaki, then Latte again', () => {
    let p = insertFront(fresh());
    expect(colours(p)).toBe('Latte Clay Peach Honey Ivory');
    p = deleteCell(p, 0);
    const born: string[] = [];
    for (let i = 0; i < 4; i++) {
      p = insertFront(p);
      born.push(PALETTE[runs(p)[0].colour].name);
    }
    expect(born).toEqual(['Slate', 'Teal', 'Khaki', 'Latte']);
  });

  it('never goes below one thread', () => {
    let p = fresh();
    for (let i = 0; i < 20; i++) p = deleteCell(p, 0);
    expect(p.threads.length).toBe(1);
  });

  it('inserted cells are empty and keep neighbours\' hits', () => {
    let p = setHit(fresh(), 5, 'BD', { v: 1 });
    p = insertAfter(p, 4);
    expect(getHit(p, 5, 'BD')).toBeNull();
    expect(getHit(p, 6, 'BD')?.v).toBe(1);
  });
});

describe('gaps: split and merge (scenario 5a)', () => {
  it('split 1|2 then merge Peach+Honey gives 1+3+8+4; colours as expected', () => {
    let p = split(fresh(), 1);
    expect(shape(p)).toBe('1+3+4+4+4');
    expect(colours(p)).toBe('Clay Latte Peach Honey Ivory');
    const g = runs(p)[3].start; // gap between Peach and Honey
    expect(isBoundary(p, g)).toBe(true);
    p = merge(p, g);
    expect(shape(p)).toBe('1+3+8+4');
    expect(colours(p)).toBe('Clay Latte Peach Ivory');
  });

  it('split on an existing boundary and merge inside a group do nothing', () => {
    const p = fresh();
    expect(split(p, 4)).toBe(p);
    expect(merge(p, 2)).toBe(p);
  });

  it('a merged-away colour rests, then returns', () => {
    let p = merge(fresh(), 4); // Peach merged into Clay
    expect(p.shelf.resting.map((r) => PALETTE[r.colour].name)).toEqual(['Peach']);
  });
});

describe('whole groups', () => {
  it('moves a run, carrying colour and hits', () => {
    let p = setHit(fresh(), 12, 'SD', { v: 0.5 }); // in Ivory
    p = moveGroups(p, 3, 3, 0);
    expect(colours(p)).toBe('Ivory Clay Peach Honey');
    expect(getHit(p, 0, 'SD')?.v).toBe(0.5);
  });

  it('duplicates runs right after themselves with new colours and copied hits', () => {
    let p = setHit(fresh(), 0, 'BD', { v: 0.9 });
    p = duplicateGroups(p, 0, 1);
    expect(shape(p)).toBe('4+4+4+4+4+4');
    expect(colours(p)).toBe('Clay Peach Latte Slate Honey Ivory');
    expect(getHit(p, 8, 'BD')?.v).toBe(0.9);
    expect(new Set(p.threads.map((t) => t.id)).size).toBe(p.threads.length);
  });

  it('merges a run of groups into the first colour', () => {
    const p = mergeGroups(fresh(), 1, 2);
    expect(shape(p)).toBe('4+8+4');
    expect(colours(p)).toBe('Clay Peach Ivory');
  });

  it('deletes groups but never the whole pattern', () => {
    const p = deleteGroups(fresh(), 1, 2);
    expect(shape(p)).toBe('4+4');
    expect(deleteGroups(fresh(), 0, 3).threads.length).toBe(16);
  });
});

describe('colour reuse once every colour is in use (scenario 5b)', () => {
  it('reuses colours, never next to the same colour at birth', () => {
    let p = fresh();
    for (let i = 0; i < 9; i++) p = insertFront(p); // uses up all 13 colours
    expect(new Set(runs(p).map((r) => r.colour)).size).toBe(13);
    for (let i = 0; i < 30; i++) {
      p = insertFront(p);
      const rs = runs(p);
      expect(rs[0].colour).not.toBe(rs[1].colour);
    }
  });

  it('a split never makes a neighbour of its own colour', () => {
    let p = fresh();
    for (let i = 0; i < 9; i++) p = insertFront(p);
    for (let k = 0; k < 10; k++) {
      p = insertAfter(p, p.threads.length - 1);
      p = split(p, p.threads.length - 1);
      const rs = runs(p);
      expect(rs[rs.length - 1].colour).not.toBe(rs[rs.length - 2].colour);
    }
  });
});

describe('matrix selection', () => {
  it('copies, clears and pastes a block', () => {
    let p = setHit(fresh(), 0, 'BD', { v: 1 });
    p = setHit(p, 1, 'SD', { v: 0.5 });
    const rect = { t0: 0, t1: 1, r0: 16, r1: 17 }; // SD, BD
    const clip = copyRect(p, rect);
    p = clearRect(p, rect);
    expect(getHit(p, 0, 'BD')).toBeNull();
    p = pasteClip(p, clip, 4, 16);
    expect(getHit(p, 4, 'BD')?.v).toBe(1);
    expect(getHit(p, 5, 'SD')?.v).toBe(0.5);
  });
});

describe('edits never change the old pattern (undo depends on it)', () => {
  it('leaves the input untouched', () => {
    const p = fresh();
    const before = JSON.stringify(p);
    insertFront(p); split(p, 2); merge(p, 4); duplicateGroups(p, 0, 3); setHit(p, 0, 'BD', { v: 1 });
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe('recolour with the Draw tool', () => {
  it('fixes two same-colour neighbours with a close but different colour', () => {
    let p = fresh();
    const ids = runs(p).map((r) => r.group);
    p = structuredClone(p);
    p.groups[ids[1]].colour = p.groups[ids[0]].colour; // Clay next to Clay
    const q = recolour(p, 1);
    const rs = runs(q);
    expect(rs[1].colour).not.toBe(rs[0].colour);
    expect(rs[1].colour).not.toBe(rs[2].colour);
    // It picks an unused colour, and the nearest such one to its neighbours.
    const used = new Set([rs[0].colour, rs[2].colour, rs[3].colour]);
    expect(used.has(rs[1].colour)).toBe(false);
  });

  it('steps through colours on repeated clicks and never matches a neighbour', () => {
    let p = fresh();
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) {
      p = recolour(p, 1);
      const rs = runs(p);
      expect(rs[1].colour).not.toBe(rs[0].colour);
      expect(rs[1].colour).not.toBe(rs[2].colour);
      seen.add(rs[1].colour);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('the first click picks the free colour closest to the neighbours', () => {
    const p = fresh(); // Clay | Peach | Honey | Ivory
    const q = recolour(p, 1); // Peach sits between Clay and Honey
    const c = runs(q)[1].colour;
    const score = (x: number) => (colourDistance(x, 0) + colourDistance(x, 2)) / 2;
    for (const other of [4, 5, 6, 7, 8, 9, 10, 11, 12]) expect(score(c)).toBeLessThanOrEqual(score(other) + 1e-9);
  });
});
