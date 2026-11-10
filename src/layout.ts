// Screen geometry: where every string, row and number sits, and what is under the pointer.

import { ROWS } from './constants';
import { isBoundary, runs, zoomOf, type Pattern, type Rect, type Run } from './model';

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
  /** The x of each thread's string, by index. A thread's cell runs from just before its
   *  string (`pad`) to just before the next one: time runs left to right inside it. */
  xs: number[];
  pad: number;
  runs: Run[];
  /** Number labels every n threads when columns are narrow. */
  labelEvery: number;
  /** Fibre level: the part of the pattern being looked into, and how far in the view is
   *  (0 = thread level, 1 = fully inside; in between while the view dives in or out). */
  region: Rect | null;
  u: number;
}

/** The view diving into a region: u runs 0 → 1 (already eased). */
export interface Camera { region: Rect; u: number }
const PEEK = 52; // inside a region, this much of the threads around it stays in view

/** frozenColW: keep this column width (while + / – is clicked repeatedly in one place). */
export function computeLayout(p: Pattern, viewW: number, viewH: number, frozenColW?: number, cam?: Camera): Layout {
  const n = p.threads.length;
  const rs = runs(p);
  let sameGaps = 0;
  for (let i = 1; i < rs.length; i++) if (rs[i].colour === rs[i - 1].colour) sameGaps++;
  const avail = viewW - LABEL_W - PAD_R - sameGaps * SAME_COLOUR_GAP;
  // Fill the window: columns and rows stretch (within limits that keep beads in proportion).
  let colW = frozenColW ?? Math.max(12, Math.min(140, avail / n));
  let rowH = Math.max(18, Math.min(56, (viewH - TOP - STRIP_H - 12) / ROWS.length));
  const place = (w: number) => {
    const out: number[] = [];
    let x = LABEL_W + padOf(w);
    rs.forEach((r, ri) => {
      if (ri > 0 && r.colour === rs[ri - 1].colour) x += SAME_COLOUR_GAP;
      for (let i = r.start; i < r.end; i++) {
        out.push(x);
        x += w;
      }
    });
    return out;
  };
  let xs = place(colW);
  let top = TOP;
  let numTop = TOP + rowH * ROWS.length + 8;
  let width = Math.max(viewW, xs[n - 1] + colW - padOf(colW) + PAD_R);
  let height = Math.max(viewH, numTop + STRIP_H);

  // Diving into a region: the same picture, magnified until the region fills the window. Its box
  // slides and grows from where it sits among the threads to the middle of the window.
  const r = cam && cam.u > 0 && cam.region.t1 < n ? cam.region : null;
  if (r && cam) {
    const u = cam.u, mix = (a: number, b: number) => a + (b - a) * u;
    const nT = r.t1 - r.t0 + 1, nR = r.r1 - r.r0 + 1;
    const gaps = rs.filter((g, i) => i > 0 && g.start > r.t0 && g.start <= r.t1 && g.colour === rs[i - 1].colour).length * SAME_COLOUR_GAP;
    const areaX = LABEL_W + PEEK, areaW = Math.max(120, viewW - PEEK - areaX);
    const areaY = PEEK * 0.8, areaH = Math.max(80, viewH - STRIP_H - 8 - PEEK * 0.8 - areaY);
    const colIn = Math.max(colW, Math.min(480, (areaW - gaps) / nT));
    const rowIn = Math.max(rowH, Math.min(110, areaH / nR));
    const x0 = mix(xs[r.t0], areaX + (areaW - nT * colIn - gaps) / 2 + padOf(colIn));
    const y0 = mix(TOP + r.r0 * rowH, areaY + (areaH - nR * rowIn) / 2);
    colW = mix(colW, colIn);
    rowH = mix(rowH, rowIn);
    xs = place(colW);
    const shift = x0 - xs[r.t0];
    xs = xs.map((x) => x + shift);
    top = y0 - r.r0 * rowH;
    numTop = mix(numTop, viewH - STRIP_H);
    width = viewW;
    height = viewH;
  }
  return {
    width, height, rowH, colW, top, bottom: top + rowH * ROWS.length, numTop,
    bandTop: numTop + NUM_H + BAND_GAP, bandH: BAND_H, numH: NUM_H, xs, runs: rs,
    labelEvery: colW >= 18 ? 1 : colW >= 10 ? 2 : 4, pad: padOf(colW),
    region: r, u: r && cam ? cam.u : 0,
  };
}

/** How far before its string a thread's cell starts: room for a bead, small next to the cell. */
const padOf = (colW: number) => Math.min(colW / 2, Math.max(colW / 16, Math.min(16, colW * 0.3)));

/** Left and right edge of thread i's cell. */
export const cellL = (L: Layout, i: number) => L.xs[i] - L.pad;
export const cellR = (L: Layout, i: number) => L.xs[i] + L.colW - L.pad;

/** The box around an area of cells. */
export function regionBox(L: Layout, r: Rect) {
  // On the right it runs up to the next string, so the last fibres of any zoom are inside.
  return { x0: cellL(L, r.t0), x1: Math.max(cellR(L, r.t1), L.xs[r.t1] + L.colW - 3), y0: L.top + r.r0 * L.rowH, y1: L.top + (r.r1 + 1) * L.rowH };
}

/** Where fibre k of a ×z cell is drawn, given its string's x: at its true moment. */
export const fibreX = (L: Layout, stringX: number, k: number, z: number) => stringX + (k * L.colW) / z;

export const rowY = (L: Layout, ri: number) => L.top + L.rowH * (ri + 0.5);

/** The x of gap g (between thread g-1 and g). Gap 0 is the front, gap n the back. */
export function gapX(L: Layout, g: number) {
  const n = L.xs.length;
  if (g <= 0) return cellL(L, 0);
  if (g >= n) return cellR(L, n - 1);
  return (cellR(L, g - 1) + cellL(L, g)) / 2;
}

/** The thread whose cell holds x (with a few px of slack at the two ends), or -1. */
function threadAtX(L: Layout, x: number): number {
  const n = L.xs.length;
  if (x < cellL(L, 0) - 5 || x > cellR(L, n - 1) + 5) return -1;
  for (let i = n - 1; i > 0; i--) if (x >= gapX(L, i)) return i;
  return 0;
}

export type Target =
  /** A note position: thread ti, fibre `slot` (0 when not zoomed). `col` is the column under
   *  the pointer, which is what rectangle selection uses. */
  | { kind: 'cell'; ti: number; ri: number; slot: number; col: number }
  | { kind: 'add'; ti: number } // "+" on a number
  | { kind: 'del'; ti: number } // "–" on a number
  | { kind: 'front' } // "+" before the first number: new group at the start
  | { kind: 'back' } // "+" after the last number: new group at the end
  | { kind: 'split'; g: number }
  | { kind: 'merge'; g: number }
  | { kind: 'band'; run: number }
  | { kind: 'label'; ri: number } // a row's name tag
  | { kind: 'out' } // fibre level: anywhere outside the region
  | { kind: 'none' };

export function hitTest(L: Layout, p: Pattern, x: number, y: number): Target {
  const n = L.xs.length;
  if (L.region) {
    // Fibre level: notes go on the fibres of the region; anywhere else leads back out.
    const r = L.region, b = regionBox(L, r);
    if (y >= L.numTop - 4) return { kind: 'none' };
    const ri = Math.floor((y - L.top) / L.rowH);
    if (ri < r.r0 || ri > r.r1) return { kind: 'out' };
    if (x < LABEL_W - 8) return { kind: 'label', ri };
    if (x < b.x0 || x > b.x1) return { kind: 'out' };
    let best = { ti: r.t0, slot: 0 }, bestD = Infinity;
    for (let ti = r.t0; ti <= r.t1; ti++) {
      const z = zoomOf(p, ti, ROWS[ri]);
      for (let k = 0; k < z; k++) {
        const d = Math.abs(x - fibreX(L, L.xs[ti], k, z));
        if (d < bestD) { bestD = d; best = { ti, slot: k }; }
      }
    }
    return { kind: 'cell', ti: best.ti, ri, slot: best.slot, col: best.ti };
  }
  if (y >= L.top && y < L.bottom) {
    if (x < LABEL_W - 8) return { kind: 'label', ri: Math.floor((y - L.top) / L.rowH) };
    const ri = Math.floor((y - L.top) / L.rowH);
    const col = threadAtX(L, x);
    if (col < 0) return { kind: 'none' };
    return { kind: 'cell', ti: col, ri, slot: 0, col };
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
    const run = L.runs.findIndex((r) => x >= cellL(L, r.start) - 4 && x <= cellR(L, r.end - 1) + 4);
    return run >= 0 ? { kind: 'band', run } : { kind: 'none' };
  }
  return { kind: 'none' };
}

/** Touch: the number nearest to x (or the front/back "+"), ignoring the fine gap zones. */
export function touchStripTarget(L: Layout, x: number): { kind: 'front' } | { kind: 'back' } | { kind: 'num'; ti: number } {
  const n = L.xs.length;
  if (x < gapX(L, 0)) return { kind: 'front' };
  if (x > gapX(L, n)) return { kind: 'back' };
  return { kind: 'num', ti: Math.max(0, threadAtX(L, x)) };
}

export const inNumberLane = (L: Layout, y: number) => y >= L.numTop && y < L.numTop + L.numH;

/** Where a dragged run of groups would land: an index among the runs that aren't being moved. */
export function dropIndex(L: Layout, x: number, a: number, b: number): number {
  const rest = L.runs.filter((_, i) => i < a || i > b);
  let idx = 0;
  for (const r of rest) {
    const mid = (cellL(L, r.start) + cellR(L, r.end - 1)) / 2;
    if (x > mid) idx++;
  }
  return idx;
}
