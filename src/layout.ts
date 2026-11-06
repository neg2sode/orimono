// Screen geometry: where every string, row and number sits, and what is under the pointer.

import { ROWS } from './constants';
import { isBoundary, runs, type Pattern, type Run } from './model';

export const LABEL_W = 60;
const PAD_R = 28;
const TOP = 14;
const SAME_COLOUR_GAP = 9; // extra space between side-by-side groups of the same colour (§9.1)
const NUM_H = 44; // number lane: "+" in the top half, "–" in the bottom half
const BAND_GAP = 4;
const BAND_H = 12; // group band
export const STRIP_H = NUM_H + BAND_GAP + BAND_H + 10;

export interface Layout {
  width: number;
  height: number;
  rowH: number;
  colW: number;
  top: number;
  bottom: number; // bottom of the matrix
  numTop: number;
  bandTop: number;
  bandH: number;
  numH: number;
  /** Centre x of each thread, by index. */
  xs: number[];
  runs: Run[];
  /** Number labels every n threads when columns are narrow. */
  labelEvery: number;
}

export function computeLayout(p: Pattern, viewW: number, viewH: number): Layout {
  const n = p.threads.length;
  const rs = runs(p);
  let sameGaps = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i].colour === rs[i - 1].colour) sameGaps++;
  const avail = viewW - LABEL_W - PAD_R - sameGaps * SAME_COLOUR_GAP;
  // Fill the window: columns and rows stretch (within limits that keep beads in proportion).
  const colW = Math.max(12, Math.min(140, avail / n));
  const rowH = Math.max(18, Math.min(56, (viewH - TOP - STRIP_H - 12) / ROWS.length));
  const xs: number[] = [];
  let x = LABEL_W + colW / 2;
  rs.forEach((r, ri) => {
    if (ri > 0 && r.colour === rs[ri - 1].colour) x += SAME_COLOUR_GAP;
    for (let i = r.start; i < r.end; i++) {
      xs.push(x);
      x += colW;
    }
  });
  const bottom = TOP + rowH * ROWS.length;
  const numTop = bottom + 8;
  const width = Math.max(viewW, x - colW / 2 + PAD_R);
  return {
    width, height: Math.max(viewH, numTop + STRIP_H), rowH, colW, top: TOP, bottom, numTop,
    bandTop: numTop + NUM_H + BAND_GAP, bandH: BAND_H, numH: NUM_H, xs, runs: rs,
    labelEvery: colW >= 18 ? 1 : colW >= 10 ? 2 : 4,
  };
}

export const rowY = (L: Layout, ri: number) => L.top + L.rowH * (ri + 0.5);

/** The x of gap g (between thread g-1 and g). Gap 0 is the front, gap n the back. */
export function gapX(L: Layout, g: number) {
  const n = L.xs.length;
  if (g <= 0) return L.xs[0] - L.colW / 2;
  if (g >= n) return L.xs[n - 1] + L.colW / 2;
  return (L.xs[g - 1] + L.xs[g]) / 2;
}

function threadAtX(L: Layout, x: number): number {
  let best = -1, bestD = Infinity;
  L.xs.forEach((cx, i) => {
    const d = Math.abs(x - cx);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD <= L.colW / 2 + 5 ? best : -1;
}

export type Target =
  | { kind: 'cell'; ti: number; ri: number }
  | { kind: 'add'; ti: number } // "+" on a number
  | { kind: 'del'; ti: number } // "–" on a number
  | { kind: 'front' } // "+" before the first number: new group at the start
  | { kind: 'back' } // "+" after the last number: new group at the end
  | { kind: 'split'; g: number }
  | { kind: 'merge'; g: number }
  | { kind: 'band'; run: number }
  | { kind: 'none' };

export function hitTest(L: Layout, p: Pattern, x: number, y: number): Target {
  const n = L.xs.length;
  if (y >= L.top && y < L.bottom) {
    const ti = threadAtX(L, x);
    if (ti < 0) return { kind: 'none' };
    return { kind: 'cell', ti, ri: Math.floor((y - L.top) / L.rowH) };
  }
  if (y >= L.numTop && y < L.numTop + L.numH) {
    // Gaps get a zone either side of the boundary; numbers get the rest.
    const zone = Math.max(4, Math.min(8, L.colW * 0.22));
    if (x < gapX(L, 0) + Math.min(zone, 4)) return x > gapX(L, 0) - 20 ? { kind: 'front' } : { kind: 'none' };
    if (x > gapX(L, n) - Math.min(zone, 4)) return x < gapX(L, n) + 20 ? { kind: 'back' } : { kind: 'none' };
    for (let g = 1; g < n; g++) {
      if (Math.abs(x - gapX(L, g)) < zone) return isBoundary(p, g) ? { kind: 'merge', g } : { kind: 'split', g };
    }
    const ti = threadAtX(L, x);
    if (ti < 0) return { kind: 'none' };
    return y < L.numTop + L.numH / 2 ? { kind: 'add', ti } : { kind: 'del', ti };
  }
  if (y >= L.bandTop - 3 && y < L.bandTop + L.bandH + 5) {
    const run = L.runs.findIndex((r) => x >= L.xs[r.start] - L.colW / 2 - 4 && x <= L.xs[r.end - 1] + L.colW / 2 + 4);
    return run >= 0 ? { kind: 'band', run } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Touch: the number nearest to x (or the front/back "+"), ignoring the fine gap zones. */
export function touchStripTarget(L: Layout, x: number): { kind: 'front' } | { kind: 'back' } | { kind: 'num'; ti: number } {
  const n = L.xs.length;
  if (x < gapX(L, 0)) return { kind: 'front' };
  if (x > gapX(L, n)) return { kind: 'back' };
  let best = 0;
  L.xs.forEach((cx, i) => { if (Math.abs(x - cx) < Math.abs(x - L.xs[best])) best = i; });
  return { kind: 'num', ti: best };
}

export const inNumberLane = (L: Layout, y: number) => y >= L.numTop && y < L.numTop + L.numH;

/** Where a dragged run of groups would land: an index among the runs that aren't being moved. */
export function dropIndex(L: Layout, x: number, a: number, b: number): number {
  const rest = L.runs.filter((_, i) => i < a || i > b);
  let idx = 0;
  for (const r of rest) {
    const mid = (L.xs[r.start] + L.xs[r.end - 1]) / 2;
    if (x > mid) idx++;
  }
  return idx;
}
