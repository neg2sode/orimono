// The project as saved: the table (fabrics in order), the drawer and the settings. The same
// shape is kept in the browser (autosave) and written to a project file. Undo history is not saved.
//
// A project file is that same JSON with a mark saying it is an Orimono project:
//   { "app": "orimono", "v": 1, "saved": "2026-11-24T…", "fabrics": […], "own": […], "cur": 0,
//     "bpm": 72, "seen": true, "shelf": { "fabrics": [{ "pattern": …, "bpm": null }], "sounds": [] },
//     "mix": { "BD": { "db": 0, "mute": false, "solo": false } } }
// fabrics: each fabric's pattern, its bpm being the tempo it plays at.
// own: whether each fabric keeps a tempo of its own (its tie to the table's tempo thread cut).
// cur: the open fabric. bpm: the table's tempo. seen: whether the table has been visited.
//
// Reading the browser's save is forgiving (a bad fabric is left out, missing parts are filled in),
// so old saves keep opening. Reading a file is strict: anything wrong and the whole file is refused,
// so nothing is ever half-opened.

import type { RowMix } from './audio';
import { BPM_MAX, BPM_MIN, ROWS, type RowTag } from './constants';
import { parse, type Pattern } from './model';

export const PROJECT_VERSION = 1;
export const MAX_FABRICS = 99;
export const FILE_EXT = '.orimono';

export interface Stored { pattern: Pattern; bpm: number | null }
export type Mix = Partial<Record<RowTag, RowMix>>;
export interface Project {
  fabrics: Pattern[];
  own: boolean[];
  cur: number;
  bpm: number;
  seen: boolean;
  shelf: { fabrics: Stored[]; sounds: unknown[] };
  /** null: no levels were saved (a very old save keeps them elsewhere). */
  mix: Mix | null;
}

/** The project as JSON data (what autosave keeps). */
export function projectData(p: Project) {
  return { v: PROJECT_VERSION, fabrics: p.fabrics, own: p.own, cur: p.cur, bpm: p.bpm, seen: p.seen, shelf: p.shelf, mix: p.mix ?? {} };
}

/** The text of a project file. */
export function projectFile(p: Project, now = new Date()): string {
  const { v, ...rest } = projectData(p);
  return JSON.stringify({ app: 'orimono', v, saved: now.toISOString(), ...rest });
}

/** A file name for a project saved on this day, like orimono-2026-11-24.orimono. */
export function fileName(now = new Date()): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `orimono-${d}${FILE_EXT}`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const bpmOk = (x: unknown) => isNum(x) && x >= BPM_MIN && x <= BPM_MAX;

/** A fabric checked all the way down: every part a pattern needs, in range. (Older fabrics may be
 * longer than today's 99 cells or finer than ×7, from before those limits; they still open.) */
function soundPattern(x: unknown): Pattern | null {
  if (!isObj(x) || !Array.isArray(x.threads) || !x.threads.length || !isObj(x.groups) || !isObj(x.shelf)) return null;
  if (!bpmOk(x.bpm) || !isInt(x.nextId)) return null;
  for (const g of Object.values(x.groups)) if (!isObj(g) || !isInt(g.id) || !isInt(g.colour)) return null;
  if (!Array.isArray(x.shelf.resting) || !isInt(x.shelf.reuse)) return null;
  for (const t of x.threads) {
    if (!isObj(t) || !isInt(t.id) || !isInt(t.group) || !isObj(t.lanes)) return null;
    for (const [tag, lane] of Object.entries(t.lanes)) {
      if (!(ROWS as readonly string[]).includes(tag)) continue; // a row that left the kit: dropped by parse
      if (!isObj(lane) || !isInt(lane.zoom) || lane.zoom < 1 || lane.zoom > 64) return null;
      if (!Array.isArray(lane.slots) || lane.slots.length !== lane.zoom) return null;
      for (const h of lane.slots) if (h !== null && !(isObj(h) && isNum(h.v))) return null;
    }
  }
  return parse(x);
}

function soundMix(x: unknown): Mix | null {
  if (!isObj(x)) return null;
  for (const [tag, m] of Object.entries(x)) {
    if (!(ROWS as readonly string[]).includes(tag)) continue;
    if (!isObj(m) || !isNum(m.db) || typeof m.mute !== 'boolean' || typeof m.solo !== 'boolean') return null;
  }
  return x as Mix;
}

/**
 * Read a saved project. `strict` is for files: anything wrong refuses the whole of it (null).
 * 'newer': made by a newer Orimono than this one.
 */
export function readProject(raw: unknown, strict: boolean): Project | 'newer' | null {
  if (!isObj(raw) || !Array.isArray(raw.fabrics)) return null;
  if (strict && raw.app !== 'orimono') return null;
  if (isNum(raw.v) && raw.v > PROJECT_VERSION) return 'newer';
  if (strict && raw.v !== PROJECT_VERSION) return null;
  const own = Array.isArray(raw.own) ? raw.own : [];
  const shelfIn = isObj(raw.shelf) && Array.isArray(raw.shelf.fabrics) ? raw.shelf.fabrics : null;
  const mix = soundMix(raw.mix);
  if (strict) {
    if (!raw.fabrics.length || raw.fabrics.length > MAX_FABRICS || !bpmOk(raw.bpm)) return null;
    if (!isObj(raw.shelf) || !shelfIn || !mix) return null;
    if (!Array.isArray(raw.own) || raw.own.length !== raw.fabrics.length || !raw.own.every((o) => typeof o === 'boolean')) return null;
  }
  const fabrics: Pattern[] = [], owns: boolean[] = [];
  let cur = isInt(raw.cur) ? raw.cur : 0;
  raw.fabrics.forEach((f, i) => {
    const p = strict ? soundPattern(f) : parse(f);
    if (p) { fabrics.push(p); owns.push(!!own[i]); } else if (i < cur) cur--;
  });
  if (strict && fabrics.length !== raw.fabrics.length) return null;
  const stored: Stored[] = [];
  for (const s of shelfIn ?? []) {
    const p = isObj(s) ? (strict ? soundPattern(s.pattern) : parse(s.pattern)) : null;
    const bpm = isObj(s) && bpmOk(s.bpm) ? (s.bpm as number) : null;
    if (strict && (!p || !isObj(s) || (s.bpm !== null && bpm === null))) return null;
    if (p) stored.push({ pattern: p, bpm });
  }
  if (!fabrics.length) return null;
  return {
    fabrics,
    own: owns,
    cur: Math.max(0, Math.min(fabrics.length - 1, cur)),
    bpm: isNum(raw.bpm) ? raw.bpm : fabrics[0].bpm,
    seen: !!raw.seen,
    shelf: { fabrics: stored, sounds: isObj(raw.shelf) && Array.isArray(raw.shelf.sounds) ? raw.shelf.sounds : [] },
    mix,
  };
}

/** Read a project file's text. Strict: a broken file, or one that isn't a project, gives null. */
export function readFile(text: string): Project | 'newer' | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  return readProject(raw, true);
}
