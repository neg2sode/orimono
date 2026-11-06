// The pattern: an ordered list of threads, each belonging to one coloured group.
// Every edit is a pure function: it returns a new pattern and never changes the old one,
// so undo is just keeping old patterns. (Design plan §4, §7, §9.)

import { MAX_THREADS, MIN_THREADS, PALETTE, REST_BIRTHS, ROWS, SHELF_ORDER, type RowTag } from './constants';
import { colourDistance } from './colour';

export interface Hit {
  /** How hard it's played, 0–1. */
  v: number;
}

/**
 * One instrument on one thread. `zoom` is the number of fibres (1 = not zoomed),
 * `slots` has exactly `zoom` entries. Always zoom 1 in the MVP; stored from day one (§12).
 */
export interface Lane {
  zoom: number;
  slots: (Hit | null)[];
}

export interface Thread {
  id: number;
  group: number;
  /** Only rows with something in them are stored; a missing row is zoom 1, empty. */
  lanes: Partial<Record<RowTag, Lane>>;
}

export interface Group {
  id: number;
  colour: number;
}

export interface Shelf {
  /** Colours that recently left the pattern and can't be used for a few births. */
  resting: { colour: number; left: number }[];
  /** Where colour reuse continues from, once every colour is in use (index into SHELF_ORDER). */
  reuse: number;
}

export interface Pattern {
  threads: Thread[];
  groups: Record<number, Group>;
  shelf: Shelf;
  bpm: number;
  nextId: number;
}

export interface Run {
  group: number;
  colour: number;
  start: number; // first thread index
  end: number; // one past the last thread index
}

const clone = <T>(x: T): T => structuredClone(x);

// ---------------------------------------------------------------- basics

export function fresh(): Pattern {
  const p: Pattern = { threads: [], groups: {}, shelf: { resting: [], reuse: 0 }, bpm: 120, nextId: 1 };
  for (let g = 0; g < 4; g++) {
    const gid = p.nextId++;
    p.groups[gid] = { id: gid, colour: g };
    for (let i = 0; i < 4; i++) p.threads.push({ id: p.nextId++, group: gid, lanes: {} });
  }
  return p;
}

/** The groups in order, as runs of side-by-side threads. */
export function runs(p: Pattern): Run[] {
  const out: Run[] = [];
  p.threads.forEach((t, i) => {
    const last = out[out.length - 1];
    if (last && last.group === t.group) last.end = i + 1;
    else out.push({ group: t.group, colour: p.groups[t.group].colour, start: i, end: i + 1 });
  });
  return out;
}

export function runIndexOf(p: Pattern, threadIndex: number): number {
  return runs(p).findIndex((r) => threadIndex >= r.start && threadIndex < r.end);
}

export function usedColours(p: Pattern): Set<number> {
  return new Set(Object.values(p.groups).map((g) => g.colour));
}

/** Total length in threads. Every thread has length 1 (§4.3). */
export const length = (p: Pattern) => p.threads.length;

// ---------------------------------------------------------------- colours (dye shelf, §9.1)

/**
 * A colour for a newborn group: the first free colour in shelf order (not used, not resting).
 * If every colour is in use, cycle through the shelf, skipping the neighbours' colours.
 * Every birth counts down the resting colours.
 */
function birthColour(p: Pattern, neighbours: (number | undefined)[]): number {
  const used = usedColours(p);
  const resting = new Set(p.shelf.resting.map((r) => r.colour));
  let colour = SHELF_ORDER.find((c) => !used.has(c) && !resting.has(c));
  if (colour === undefined) {
    const avoid = new Set(neighbours.filter((c): c is number => c !== undefined));
    for (let k = 0; k < SHELF_ORDER.length; k++) {
      const i = (p.shelf.reuse + k) % SHELF_ORDER.length;
      if (!avoid.has(SHELF_ORDER[i])) {
        colour = SHELF_ORDER[i];
        p.shelf.reuse = (i + 1) % SHELF_ORDER.length;
        break;
      }
    }
    colour ??= SHELF_ORDER[0];
  }
  for (const r of p.shelf.resting) r.left--;
  p.shelf.resting = p.shelf.resting.filter((r) => r.left > 0);
  return colour;
}

function newGroup(p: Pattern, neighbours: (number | undefined)[]): number {
  const id = p.nextId++;
  p.groups[id] = { id, colour: birthColour(p, neighbours) };
  return id;
}

/** Drop groups with no threads, and let colours that left the pattern rest. */
function tidy(before: Pattern, p: Pattern): Pattern {
  const live = new Set(p.threads.map((t) => t.group));
  for (const id of Object.keys(p.groups).map(Number)) if (!live.has(id)) delete p.groups[id];
  const now = usedColours(p);
  for (const c of usedColours(before)) {
    if (!now.has(c) && !p.shelf.resting.some((r) => r.colour === c)) {
      p.shelf.resting.push({ colour: c, left: REST_BIRTHS });
    }
  }
  return p;
}

const neighbourColour = (p: Pattern, threadIndex: number) => {
  const t = p.threads[threadIndex];
  return t ? p.groups[t.group].colour : undefined;
};

// ---------------------------------------------------------------- hits

export function getHit(p: Pattern, ti: number, row: RowTag, slot = 0): Hit | null {
  return p.threads[ti]?.lanes[row]?.slots[slot] ?? null;
}

function laneFor(t: Thread, row: RowTag): Lane {
  return (t.lanes[row] ??= { zoom: 1, slots: [null] });
}

function pruneLane(t: Thread, row: RowTag) {
  const l = t.lanes[row];
  if (l && l.zoom === 1 && l.slots.every((s) => s === null)) delete t.lanes[row];
}

/** Set (or clear, with null) one hit. */
export function setHit(p: Pattern, ti: number, row: RowTag, hit: Hit | null, slot = 0): Pattern {
  if (!p.threads[ti]) return p;
  const q = clone(p);
  const t = q.threads[ti];
  laneFor(t, row).slots[slot] = hit ? { v: clamp01(hit.v) } : null;
  pruneLane(t, row);
  return q;
}

export function setHits(p: Pattern, cells: { ti: number; row: RowTag; hit: Hit | null }[]): Pattern {
  const q = clone(p);
  for (const c of cells) {
    const t = q.threads[c.ti];
    if (!t) continue;
    laneFor(t, c.row).slots[0] = c.hit ? { v: clamp01(c.hit.v) } : null;
    pruneLane(t, c.row);
  }
  return q;
}

export interface Rect {
  t0: number;
  t1: number; // inclusive
  r0: number;
  r1: number; // inclusive, indices into ROWS
}

export function clearRect(p: Pattern, r: Rect): Pattern {
  const q = clone(p);
  for (let ti = r.t0; ti <= r.t1; ti++) {
    const t = q.threads[ti];
    if (!t) continue;
    for (let ri = r.r0; ri <= r.r1; ri++) delete t.lanes[ROWS[ri]];
  }
  return q;
}

/** A copied block of lanes: clip[ri][ti]. */
export type Clip = (Lane | null)[][];

export function copyRect(p: Pattern, r: Rect): Clip {
  const clip: Clip = [];
  for (let ri = r.r0; ri <= r.r1; ri++) {
    const row: (Lane | null)[] = [];
    for (let ti = r.t0; ti <= r.t1; ti++) row.push(clone(p.threads[ti]?.lanes[ROWS[ri]] ?? null));
    clip.push(row);
  }
  return clip;
}

export function pasteClip(p: Pattern, clip: Clip, atThread: number, atRow: number): Pattern {
  const q = clone(p);
  clip.forEach((row, dr) =>
    row.forEach((lane, dt) => {
      const t = q.threads[atThread + dt];
      const tag = ROWS[atRow + dr];
      if (!t || !tag) return;
      if (lane) t.lanes[tag] = clone(lane);
      else delete t.lanes[tag];
    }),
  );
  return q;
}

// ---------------------------------------------------------------- cells (number lane, §7)

const emptyThread = (p: Pattern, group: number): Thread => ({ id: p.nextId++, group, lanes: {} });

/** "+" on a number: one empty thread right after it, in the same group. */
export function insertAfter(p: Pattern, ti: number): Pattern {
  if (!p.threads[ti] || p.threads.length >= MAX_THREADS) return p;
  const q = clone(p);
  q.threads.splice(ti + 1, 0, emptyThread(q, q.threads[ti].group));
  return q;
}

/** "+" on the front gap: a new 1-thread group with a new colour. */
export function insertFront(p: Pattern): Pattern {
  if (p.threads.length >= MAX_THREADS) return p;
  const q = clone(p);
  const g = newGroup(q, [neighbourColour(q, 0)]);
  q.threads.unshift(emptyThread(q, g));
  return q;
}

/** "–" on a number: delete that cell. A group's last cell takes the group with it. */
export function deleteCell(p: Pattern, ti: number): Pattern {
  if (!p.threads[ti] || p.threads.length <= MIN_THREADS) return p;
  const q = clone(p);
  q.threads.splice(ti, 1);
  return tidy(p, q);
}

// ---------------------------------------------------------------- gaps (boundaries, §7)

/** Gap g sits between thread g-1 and thread g (1 ≤ g < length). */
export const isBoundary = (p: Pattern, g: number) =>
  g > 0 && g < p.threads.length && p.threads[g - 1].group !== p.threads[g].group;

/** ✂ Split a group at gap g: the back part becomes a new group with a new colour. */
export function split(p: Pattern, g: number): Pattern {
  if (g <= 0 || g >= p.threads.length || isBoundary(p, g)) return p;
  const q = clone(p);
  const old = q.threads[g].group;
  let end = g;
  while (end < q.threads.length && q.threads[end].group === old) end++;
  const ng = newGroup(q, [q.groups[old].colour, neighbourColour(q, end)]);
  for (let i = g; i < end; i++) q.threads[i].group = ng;
  return q;
}

/** ⋈ Merge the two groups either side of gap g, in the front group's colour. */
export function merge(p: Pattern, g: number): Pattern {
  if (!isBoundary(p, g)) return p;
  const q = clone(p);
  const back = q.threads[g].group;
  const front = q.threads[g - 1].group;
  for (let i = g; i < q.threads.length && q.threads[i].group === back; i++) q.threads[i].group = front;
  return tidy(p, q);
}

// ---------------------------------------------------------------- whole groups (Select tool, §7)

/** Threads covered by runs a..b (inclusive run indices). */
function runSpan(p: Pattern, a: number, b: number): [number, number] {
  const rs = runs(p);
  return [rs[a].start, rs[b].end];
}

/** Move runs a..b so they sit before run `to` (an index in the list *without* the moved runs). */
export function moveGroups(p: Pattern, a: number, b: number, to: number): Pattern {
  const rs = runs(p);
  if (a < 0 || b >= rs.length || a > b) return p;
  const rest = rs.length - (b - a + 1);
  to = Math.max(0, Math.min(rest, to));
  if (to === a) return p;
  const q = clone(p);
  const [s, e] = runSpan(q, a, b);
  const block = q.threads.splice(s, e - s);
  const remaining = runs(q);
  const at = to < remaining.length ? remaining[to].start : q.threads.length;
  q.threads.splice(at, 0, ...block);
  return q;
}

export function mergeGroups(p: Pattern, a: number, b: number): Pattern {
  const rs = runs(p);
  if (a < 0 || b >= rs.length || a >= b) return p;
  const q = clone(p);
  const [s, e] = runSpan(q, a, b);
  for (let i = s; i < e; i++) q.threads[i].group = rs[a].group;
  return tidy(p, q);
}

/** Copy runs a..b right after themselves, hits and zooms included; each copy gets a new colour. */
export function duplicateGroups(p: Pattern, a: number, b: number): Pattern {
  const rs = runs(p);
  if (a < 0 || b >= rs.length || a > b) return p;
  const [s, e] = runSpan(p, a, b);
  if (p.threads.length + (e - s) > MAX_THREADS) return p;
  const q = clone(p);
  const after = neighbourColour(q, e);
  const copies: Thread[] = [];
  let prevColour: number | undefined = q.groups[rs[b].group].colour;
  for (let r = a; r <= b; r++) {
    const g = newGroup(q, [prevColour, r === b ? after : undefined]);
    prevColour = q.groups[g].colour;
    for (let i = rs[r].start; i < rs[r].end; i++) {
      copies.push({ id: q.nextId++, group: g, lanes: clone(q.threads[i].lanes) });
    }
  }
  q.threads.splice(e, 0, ...copies);
  return q;
}

export function deleteGroups(p: Pattern, a: number, b: number): Pattern {
  const rs = runs(p);
  if (a < 0 || b >= rs.length || a > b) return p;
  const [s, e] = runSpan(p, a, b);
  if (p.threads.length - (e - s) < MIN_THREADS) return p;
  const q = clone(p);
  q.threads.splice(s, e - s);
  return tidy(p, q);
}

/**
 * Draw tool on a group's bar: give the group the palette colour closest to its neighbours that
 * isn't either neighbour's colour. Each further click steps to the next closest. Colours used
 * elsewhere or resting come last, so a colour normally still appears only once (§9.1).
 */
export function recolour(p: Pattern, run: number): Pattern {
  const rs = runs(p);
  const r = rs[run];
  if (!r) return p;
  const neighbours = [rs[run - 1]?.colour, rs[run + 1]?.colour].filter((c): c is number => c !== undefined);
  const usedElsewhere = new Set(rs.filter((_, i) => i !== run).map((x) => x.colour));
  const resting = new Set(p.shelf.resting.map((x) => x.colour));
  const closeness = (c: number) =>
    neighbours.length ? neighbours.reduce((sum, n) => sum + colourDistance(c, n), 0) / neighbours.length : 0;
  const rank = (c: number) => (usedElsewhere.has(c) ? 2 : resting.has(c) ? 1 : 0);
  const candidates = PALETTE.map((_, c) => c)
    .filter((c) => !neighbours.includes(c))
    .sort((a, b) => rank(a) - rank(b) || closeness(a) - closeness(b));
  if (!candidates.length) return p;
  const at = candidates.indexOf(r.colour);
  const next = candidates[(at + 1) % candidates.length];
  if (next === r.colour) return p;
  const q = clone(p);
  q.groups[r.group].colour = next;
  q.shelf.resting = q.shelf.resting.filter((x) => x.colour !== next);
  return tidy(p, q);
}

// ---------------------------------------------------------------- tempo, persistence

export function setBpm(p: Pattern, bpm: number): Pattern {
  const q = clone(p);
  q.bpm = Math.round(bpm * 10) / 10;
  return q;
}

/** Light check that a stored pattern is usable; returns null if not. */
export function parse(json: unknown): Pattern | null {
  const p = json as Pattern;
  if (!p || !Array.isArray(p.threads) || !p.threads.length || typeof p.bpm !== 'number' || !p.groups || !p.shelf) {
    return null;
  }
  if (!p.threads.every((t) => p.groups[t.group] && typeof t.id === 'number' && t.lanes)) return null;
  return p;
}

function clamp01(v: number) {
  return Math.max(0.05, Math.min(1, v));
}
