import { describe, expect, it } from 'vitest';
import { fresh, insertAfter, setHit, single, zoomRect, type Pattern } from './model';
import { fileName, projectData, projectFile, readFile, readProject, type Project } from './project';

const busy = (): Pattern => {
  let p = insertAfter(fresh(), 3);
  p = setHit(p, 0, 'BD', { v: 1, mine: true });
  p = setHit(p, 2, 'SD', { v: 0.6 });
  p = zoomRect(p, { t0: 4, t1: 5, r0: 3, r1: 3 }, 3);
  return { ...p, bpm: 96 };
};
const sample = (): Project => ({
  fabrics: [busy(), { ...single(), bpm: 140 }, fresh()],
  own: [false, true, false],
  cur: 1,
  bpm: 96,
  seen: true,
  shelf: { fabrics: [{ pattern: busy(), bpm: null }, { pattern: fresh(), bpm: 50 }], sounds: [] },
  mix: { BD: { db: -6, mute: false, solo: false }, CH: { db: 0, mute: true, solo: false } },
});
const opened = (text: string) => {
  const got = readFile(text);
  if (!got || got === 'newer') throw new Error('did not open');
  return got;
};

describe('a project file', () => {
  it('opens back exactly as it was saved', () => {
    const p = sample();
    expect(opened(projectFile(p))).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it('is the autosave with a mark saying what it is', () => {
    const p = sample();
    const file = JSON.parse(projectFile(p, new Date('2026-11-24T10:00:00Z')));
    const { app, saved, ...rest } = file;
    expect(app).toBe('orimono');
    expect(saved).toBe('2026-11-24T10:00:00.000Z');
    expect(rest).toEqual(JSON.parse(JSON.stringify(projectData(p))));
  });

  it('is named after the day', () => {
    expect(fileName(new Date(2026, 10, 4))).toBe('orimono-2026-11-04.orimono');
  });

  it('still opens a fabric from before the limits (longer than 99 cells, finer than ×7)', () => {
    // Built by hand: today's edits stop at 99 cells and ×7.
    const long = fresh();
    const g = long.threads[0].group;
    long.threads = Array.from({ length: 120 }, (_, i) => ({ id: 1000 + i, group: g, lanes: {} }));
    long.threads[0].lanes.BD = { zoom: 12, slots: Array.from({ length: 12 }, (_, k) => (k % 5 ? null : { v: 0.8 })) };
    const p = { ...sample(), fabrics: [long], own: [false], cur: 0 };
    expect(opened(projectFile(p)).fabrics[0].threads.length).toBe(120);
  });

  describe('is refused, whole, when', () => {
    const file = () => JSON.parse(projectFile(sample()));
    const refused = (f: unknown) => expect(readFile(typeof f === 'string' ? f : JSON.stringify(f))).toBeNull();
    it('it is not JSON', () => refused('{"app": "orimono", "v": 1, "fabr'));
    it('it is empty', () => refused(''));
    it('it is JSON but not a project', () => refused({ hello: 'world' }));
    it('it has no mark (a browser save, or someone else\'s JSON)', () => { const f = file(); delete f.app; refused(f); });
    it('it has no fabrics', () => refused({ ...file(), fabrics: [], own: [] }));
    it('one fabric is broken', () => { const f = file(); f.fabrics[1].threads[0].lanes = { BD: { zoom: 2, slots: [null] } }; refused(f); });
    it('one fabric is missing its groups', () => { const f = file(); delete f.fabrics[2].groups; refused(f); });
    it('a hit is not a number', () => { const f = file(); f.fabrics[0].threads[0].lanes.BD.slots[0].v = 'loud'; refused(f); });
    it('a stored fabric is broken', () => { const f = file(); f.shelf.fabrics[0].pattern = { threads: [] }; refused(f); });
    it('the tempo is out of range', () => refused({ ...file(), bpm: 9000 }));
    it('the levels are broken', () => refused({ ...file(), mix: { BD: { db: 'loud' } } }));
    it('own does not match the fabrics', () => refused({ ...file(), own: [true] }));
  });

  it('from a newer Orimono is told apart from a broken one', () => {
    expect(readFile(JSON.stringify({ ...JSON.parse(projectFile(sample())), v: 2 }))).toBe('newer');
  });
});

describe('the browser\'s own save', () => {
  it('opens leniently: a broken fabric is left out and the open one stays the same', () => {
    const d = JSON.parse(JSON.stringify(projectData(sample())));
    d.fabrics[0] = { nonsense: true };
    const got = readProject(d, false);
    if (!got || got === 'newer') throw new Error('did not open');
    expect(got.fabrics.length).toBe(2);
    expect(got.cur).toBe(0); // fabric 2 of 3 became fabric 1 of 2
    expect(got.own).toEqual([true, false]);
  });

  it('opens a save from before the drawer and the levels', () => {
    const got = readProject({ v: 1, fabrics: [busy()], own: [false], cur: 0, bpm: 96, seen: false }, false);
    if (!got || got === 'newer') throw new Error('did not open');
    expect(got.shelf).toEqual({ fabrics: [], sounds: [] });
    expect(got.mix).toBeNull(); // the levels then live in their older place
  });

  it('opens a save with no tempo of its own: the first fabric\'s', () => {
    const got = readProject({ fabrics: [busy()] }, false);
    if (!got || got === 'newer') throw new Error('did not open');
    expect(got.bpm).toBe(96);
  });
});
