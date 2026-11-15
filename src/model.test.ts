import { describe, expect, it } from 'vitest';
import { PALETTE } from './constants';
import {
  clearRect, copyRect, deleteCell, deleteGroups, duplicateGroups, fresh, getHit, insertAfter, insertBack, insertFront, setBpm,
  isBoundary, merge, mergeGroups, moveGroups, pasteClip, recolour, runs, setHit, split, type Pattern,
  clearRect as clearCells, notesBetween, regionAt, splitPlain, zoomOf, zoomPlan, zoomRect,
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

  it('a new back group is 1 cell with a fresh colour at the end', () => {
    const p = insertBack(fresh());
    expect(shape(p)).toBe('4+4+4+4+1');
    expect(new Set(runs(p).map((r) => r.colour)).size).toBe(5);
  });

  it('starts at 72 BPM and keeps one typed decimal', () => {
    expect(fresh().bpm).toBe(72);
    expect(setBpm(fresh(), 72.54).bpm).toBe(72.5);
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
    const rect = { t0: 0, t1: 1, r0: 15, r1: 16 }; // SD, BD
    const clip = copyRect(p, rect);
    p = clearRect(p, rect);
    expect(getHit(p, 0, 'BD')).toBeNull();
    p = pasteClip(p, clip, 4, 15);
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

describe('zoom: threads into fibres (§8.2, scenario 10)', () => {
  const cell = { t0: 0, t1: 0, r0: 16, r1: 16 }; // one kick cell
  const kick = (p: ReturnType<typeof fresh>) => p.threads[0].lanes.BD;

  it('splits a cell; its note stays on the beat', () => {
    const p = zoomRect(setHit(fresh(), 0, 'BD', { v: 0.8 }), cell, 3);
    expect(kick(p)).toEqual({ zoom: 3, slots: [{ v: 0.8 }, null, null] });
    expect(zoomOf(p, 1, 'BD')).toBe(1);
  });

  it('×2 → ×6 just happens and keeps every note', () => {
    let p = zoomRect(fresh(), cell, 2);
    p = setHit(p, 0, 'BD', { v: 0.5 }, 1); // halfway through the thread
    expect(zoomPlan(p, cell, 6)).toEqual({ changed: 1, lost: 0, from: [] });
    p = zoomRect(p, cell, 6);
    expect(kick(p)?.zoom).toBe(6);
    expect(kick(p)?.slots[3]).toEqual({ v: 0.5 }); // still halfway
  });

  it('asking ×2 of a ×6 cell changes nothing: the finer zoom stays', () => {
    const p = zoomRect(fresh(), cell, 6);
    expect(zoomPlan(p, cell, 2).changed).toBe(0);
    expect(zoomRect(p, cell, 2)).toEqual(p);
  });

  it('×2 → ×3 keeps notes on the beat and counts the ones it would clear', () => {
    let p = zoomRect(fresh(), cell, 2);
    p = setHit(setHit(p, 0, 'BD', { v: 1 }, 0), 0, 'BD', { v: 0.5 }, 1);
    expect(zoomPlan(p, cell, 3)).toEqual({ changed: 1, lost: 1, from: [2] });
    p = zoomRect(p, cell, 3);
    expect(kick(p)).toEqual({ zoom: 3, slots: [{ v: 1 }, null, null] });
  });

  it('×1 removes the zoom, and an empty plain cell is not stored', () => {
    let p = zoomRect(fresh(), cell, 4);
    p = setHit(p, 0, 'BD', { v: 0.5 }, 2);
    expect(zoomPlan(p, cell, 1)).toEqual({ changed: 1, lost: 1, from: [4] });
    p = zoomRect(p, cell, 1);
    expect(kick(p)).toBeUndefined();
    expect(zoomPlan(p, cell, 1).changed).toBe(0);
  });

  it('only the selected rows and threads are split, up to ×7', () => {
    const p = zoomRect(fresh(), { t0: 2, t1: 3, r0: 15, r1: 16 }, 7);
    expect([zoomOf(p, 1, 'BD'), zoomOf(p, 2, 'BD'), zoomOf(p, 3, 'SD'), zoomOf(p, 4, 'SD'), zoomOf(p, 2, 'FT')]).toEqual([1, 7, 7, 1, 1]);
    expect(zoomRect(p, cell, 8)).toBe(p);
  });

  it('Clear empties a zoomed cell but leaves it zoomed', () => {
    let p = zoomRect(fresh(), cell, 3);
    p = clearCells(setHit(p, 0, 'BD', { v: 0.5 }, 2), cell);
    expect(kick(p)).toEqual({ zoom: 3, slots: [null, null, null] });
  });

  it('an exact change makes ×6 into ×3, keeping every other note', () => {
    let p = zoomRect(fresh(), cell, 6);
    p = setHit(setHit(p, 0, 'BD', { v: 1 }, 2), 0, 'BD', { v: 0.5 }, 3);
    expect(zoomPlan(p, cell, 3, true)).toEqual({ changed: 1, lost: 1, from: [6] });
    expect(kick(zoomRect(p, cell, 3, true))).toEqual({ zoom: 3, slots: [null, { v: 1 }, null] });
  });

  it('opening a region splits plain cells and leaves zoomed ones as they are', () => {
    const area = { t0: 0, t1: 1, r0: 16, r1: 16 };
    let p = setHit(zoomRect(fresh(), cell, 3), 1, 'BD', { v: 1 });
    p = splitPlain(p, area, 2);
    expect([zoomOf(p, 0, 'BD'), zoomOf(p, 1, 'BD')]).toEqual([3, 2]);
    expect(p.threads[1].lanes.BD).toEqual({ zoom: 2, slots: [{ v: 1 }, null] });
    expect(splitPlain(p, area, 4)).toBe(p);
  });

  it('a region is found from any of its cells, and notes between the beats are counted', () => {
    let p = zoomRect(fresh(), { t0: 2, t1: 4, r0: 14, r1: 15 }, 3);
    p = zoomRect(p, { t0: 5, t1: 5, r0: 15, r1: 15 }, 4);
    expect(regionAt(p, 3, 15)).toEqual({ t0: 2, t1: 4, r0: 14, r1: 15 });
    expect(regionAt(p, 5, 15)).toEqual({ t0: 5, t1: 5, r0: 15, r1: 15 });
    expect(regionAt(p, 0, 0)).toBeNull();
    p = setHit(setHit(p, 2, 'SD', { v: 1 }, 0), 3, 'SD', { v: 1 }, 2);
    expect(notesBetween(p, { t0: 2, t1: 4, r0: 14, r1: 15 })).toBe(1);
  });
});
