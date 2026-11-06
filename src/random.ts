// Random: fills hits musically into whatever groups the user has built (§10.3).
// It never changes lengths, groups, colours or zooms, and never touches the user's own notes.
//
// Every rule is about places inside a group (start, middle, end), never about bars or 4/4,
// so each style follows whatever structure is on screen. Each press picks a style.

import { ROWS, type RowTag } from './constants';
import { getHit, runs, setHits, type Hit, type Pattern, type Rect } from './model';

type Rng = () => number;
/** One note inside a group: position from the group start, row, strength. */
type Note = [pos: number, row: RowTag, v: number];

interface Tools {
  chance: (x: number) => boolean;
  pick: <T>(xs: T[]) => T;
  /** Prefer rows inside the selection, so a selection always gets something to play. */
  prefer: (pool: RowTag[]) => RowTag[];
}
interface GroupInfo { len: number; gi: number; count: number }

export interface Style {
  name: string;
  /** Kit styles can end the loop with a fill. */
  fills: boolean;
  /** Chance of a crash on the very first beat of the loop. */
  crash: number;
  /** Per press: choose this press's voices, then return a function that writes one group. */
  setup: (t: Tools) => (g: GroupInfo, t: Tools) => Note[];
}

const mid = (len: number) => Math.floor(len / 2);

export const STYLES: Style[] = [
  {
    name: 'Backbeat',
    fills: true,
    crash: 0.4,
    setup: ({ pick, prefer }) => {
      const back = pick(prefer(['SD', 'SD', 'SD', 'CP']));
      const steady = pick(prefer(['CH', 'CH', 'RD', 'SH']));
      const sparsePool = prefer(['HT', 'FT', 'BG', 'CG', 'DB', 'CB', 'CL', 'TB']);
      const sparse = [...new Set<RowTag>([pick(sparsePool), pick(sparsePool)])];
      return ({ len }, { chance }) => {
        const out: Note[] = [];
        for (let pos = 0; pos < len; pos++) {
          const start = pos === 0;
          if ((start && chance(0.92)) || (!start && chance(0.08))) out.push([pos, 'BD', start ? 0.9 : 0.6]);
          if (pos === mid(len) && len >= 2 && chance(0.85)) out.push([pos, back, 0.82]);
          // A soft ghost note just before the backbeat (it uses the drums' quiet recordings).
          else if (back === 'SD' && len >= 3 && pos === mid(len) - 1 && pos > 0 && chance(0.3)) out.push([pos, 'SD', 0.24]);
          const last = pos === len - 1 && len >= 3;
          if (steady === 'CH' && last && chance(0.25)) out.push([pos, 'OH', 0.65]);
          else if (steady === 'RD' ? pos % 2 === 0 : chance(0.88)) out.push([pos, steady, start ? 0.8 : 0.55]);
          for (const row of sparse) if (chance(0.09)) out.push([pos, row, 0.65]);
        }
        return out;
      };
    },
  },
  {
    name: 'Space',
    fills: false,
    crash: 0.5,
    setup: ({ pick, prefer }) => {
      const back = pick(prefer(['CP', 'SD']));
      const wash = pick(prefer(['RD', 'OH', 'SH']));
      return ({ len, gi }, { chance }) => {
        const out: Note[] = [];
        if (gi === 0) out.push([0, 'BD', 0.95]);
        else if (chance(0.35)) out.push([0, 'BD', 0.75]);
        if (gi % 2 === 1 && len >= 2) out.push([mid(len), back, 0.8]);
        if (chance(0.5)) out.push([0, wash, 0.55]);
        if (len >= 3 && chance(0.2)) out.push([len - 1, 'BD', 0.5]);
        return out;
      };
    },
  },
  {
    name: 'Busy',
    fills: true,
    crash: 0.3,
    setup: () => ({ len }, { chance }) => {
      const out: Note[] = [];
      for (let pos = 0; pos < len; pos++) {
        const start = pos === 0, last = pos === len - 1;
        // Hats on every cell, accented on starts and middles.
        if (last && len >= 3 && chance(0.35)) out.push([pos, 'OH', 0.6]);
        else out.push([pos, 'CH', start ? 0.85 : pos === mid(len) ? 0.6 : pos % 2 ? 0.38 : 0.48]);
        // Kick on the start, and pushed one cell early into the next group.
        if (start && chance(0.8)) out.push([pos, 'BD', 0.85]);
        else if (last && len >= 2 && chance(0.45)) out.push([pos, 'BD', 0.7]);
        else if (!start && chance(0.12)) out.push([pos, 'BD', 0.55]);
        if (pos === mid(len) && len >= 2 && chance(0.9)) out.push([pos, 'SD', 0.85]);
        else if (!start && chance(0.3)) out.push([pos, 'SD', 0.2]);
      }
      return out;
    },
  },
  {
    name: 'Hand drums',
    fills: false,
    crash: 0,
    setup: () => ({ len, gi }, { chance }) => {
      const out: Note[] = [];
      for (let pos = 0; pos < len; pos++) {
        const start = pos === 0, last = pos === len - 1;
        if (chance(0.95)) out.push([pos, 'SH', start ? 0.6 : 0.35]);
        if (last && len >= 2 && chance(0.85)) out.push([pos, 'CG', 0.85]);
        else if (pos === mid(len) && chance(0.3)) out.push([pos, 'CG', 0.6]);
        if (start ? chance(0.6) : pos % 2 === 1 && chance(0.7)) out.push([pos, 'BG', start ? 0.75 : 0.5]);
        if (start && chance(0.8)) out.push([pos, 'CB', 0.7]);
        // Claves: a figure taken from the groups themselves, on the start of even groups
        // and the middle of odd ones.
        if ((gi % 2 === 0 && start) || (gi % 2 === 1 && pos === mid(len) && len >= 2)) out.push([pos, 'CL', 0.75]);
        if (!start && chance(0.1)) out.push([pos, 'DB', 0.6]);
      }
      return out;
    },
  },
  {
    name: 'Toms',
    fills: true,
    crash: 0.5,
    setup: () => ({ len }, { chance }) => {
      const out: Note[] = [];
      for (let pos = 0; pos < len; pos++) {
        const start = pos === 0;
        if (start && chance(0.9)) out.push([pos, 'BD', 0.9]);
        if (pos === mid(len) && len >= 2 && chance(0.8)) out.push([pos, 'FT', 0.85]);
        else if (pos === len - 1 && len >= 3 && chance(0.4)) out.push([pos, 'FT', 0.6]);
        if (pos === mid(len) + 1 && pos < len && chance(0.6)) out.push([pos, 'HT', 0.7]);
        else if (!start && chance(0.12)) out.push([pos, 'HT', 0.55]);
        if (pos % 2 === 0 && chance(0.7)) out.push([pos, 'TB', start ? 0.6 : 0.42]);
      }
      return out;
    },
  },
  {
    name: 'Ride',
    fills: false,
    crash: 0.25,
    setup: () => ({ len }, { chance }) => {
      const out: Note[] = [];
      for (let pos = 0; pos < len; pos++) {
        const start = pos === 0, last = pos === len - 1;
        // Ride on every cell; the strongest one leans into the next group.
        out.push([pos, 'RD', last && len >= 2 ? 0.8 : start ? 0.6 : 0.42]);
        if (pos === mid(len) && len >= 2 && chance(0.85)) out.push([pos, 'PH', 0.6]);
        if (!start && chance(0.15)) out.push([pos, 'SD', 0.4]);
        if (start && chance(0.7)) out.push([pos, 'BD', 0.38]);
      }
      return out;
    },
  },
];

const FILL_CHANCE = 0.3;
const RHYME_CHANCE = 0.35;

/**
 * Fill the pattern (or the selection) with a style. Without a selection, rows holding any of the
 * user's own notes are left alone. With a selection, Random fills around the user's notes there.
 */
export function randomFill(p: Pattern, area: Rect | null, rng: Rng = Math.random, styles?: number[]): Pattern {
  return randomFillStyled(p, area, rng, styles).pattern;
}

/** styles: style indexes to try in order (the first that plays something in the area wins). */
export function randomFillStyled(p: Pattern, area: Rect | null, rng: Rng = Math.random, styles?: number[]) {
  const rect: Rect = area ?? { t0: 0, t1: p.threads.length - 1, r0: 0, r1: ROWS.length - 1 };
  const inRows = (row: RowTag) => {
    const ri = ROWS.indexOf(row);
    return ri >= rect.r0 && ri <= rect.r1;
  };
  const t: Tools = {
    chance: (x) => rng() < x,
    pick: (xs) => xs[Math.floor(rng() * xs.length)],
    prefer: (pool) => {
      const inside = pool.filter(inRows);
      return inside.length ? inside : pool;
    },
  };

  // Rows Random may write: without a selection, rows with the user's notes are theirs.
  const mineAt = (ti: number, row: RowTag) => !!getHit(p, ti, row)?.mine;
  const ownRows = new Set<RowTag>(area ? [] : ROWS.filter((r) => p.threads.some((_, ti) => mineAt(ti, r))));

  // A style that has something to say inside the area (a selected cowbell row gets nothing from
  // "Busy", so that press moves on to another style).
  const order = styles ?? shuffle(STYLES.map((_, i) => i), rng);
  for (const si of order) {
    const notes = compose(p, STYLES[si], t, rng);
    const cells: { ti: number; row: RowTag; hit: Hit | null }[] = [];
    let some = false;
    for (let ti = rect.t0; ti <= rect.t1; ti++) {
      for (const row of ROWS) {
        if (!inRows(row) || ownRows.has(row) || mineAt(ti, row)) continue;
        const v = notes.get(`${ti}:${row}`);
        if (v !== undefined) some = true;
        cells.push({ ti, row, hit: v === undefined ? null : { v } });
      }
    }
    if (some || si === order[order.length - 1]) return { pattern: setHits(p, cells), style: si };
  }
  return { pattern: p, style: -1 };
}

/** All of one style's notes for the whole pattern, keyed "thread:row". */
function compose(p: Pattern, style: Style, t: Tools, rng: Rng): Map<string, number> {
  const group = style.setup(t);
  const rs = runs(p);
  const notes = new Map<string, number>();
  // Strengths are kept fairly even (dynamics are for plucking): each style's value is pulled
  // 40% of the way towards 0.72, plus a small wobble.
  const vary = (v: number) => Math.max(0.1, Math.min(1, 0.72 + (v - 0.72) * 0.6 + (rng() - 0.5) * 0.08));

  // Sometimes groups of the same length rhyme: they share one figure, and the last of them
  // changes its second half. Otherwise every group is rolled on its own.
  const rhyme = t.chance(RHYME_CHANCE);
  const figures = new Map<number, Note[]>();
  const lastOfLen = new Map<number, number>();
  rs.forEach((r, gi) => lastOfLen.set(r.end - r.start, gi));

  rs.forEach((r, gi) => {
    const len = r.end - r.start;
    const info = { len, gi, count: rs.length };
    let fig: Note[];
    if (!rhyme) fig = group(info, t);
    else {
      if (!figures.has(len)) figures.set(len, group(info, t));
      fig = figures.get(len)!;
      if (lastOfLen.get(len) === gi && gi > 0 && len >= 3) {
        const fresh = group(info, t);
        fig = [...fig.filter(([pos]) => pos < mid(len)), ...fresh.filter(([pos]) => pos >= mid(len))];
      }
    }
    for (const [pos, row, v] of fig) notes.set(`${r.start + pos}:${row}`, vary(v));
  });

  if (rs.length && t.chance(style.crash)) notes.set(`0:CR`, vary(0.8));

  // A fill to end the loop: the second half of the last group walks down the toms, or rolls
  // on the snare, louder and louder. Hats rest under it.
  const last = rs[rs.length - 1];
  if (style.fills && last && last.end - last.start >= 3 && rs.length >= 2 && t.chance(FILL_CHANCE)) {
    const len = last.end - last.start, from = mid(len);
    const toms = t.chance(0.6);
    for (let pos = from; pos < len; pos++) {
      const ti = last.start + pos;
      for (const row of ['CH', 'OH', 'RD', 'SH', 'HT', 'FT', 'SD'] as RowTag[]) notes.delete(`${ti}:${row}`);
      const u = (pos - from) / Math.max(1, len - 1 - from);
      if (toms) notes.set(`${ti}:${u < 0.5 ? 'HT' : 'FT'}`, vary(0.7 + 0.2 * u));
      else notes.set(`${ti}:SD`, vary(0.4 + 0.5 * u));
    }
  }
  return notes;
}

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
