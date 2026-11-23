// A link for a fabric: the whole beat packed into the part of a web address after the "#"
// (which is never sent to a server). It carries one fabric's threads, groups, colours, notes,
// fibres and tempo. It does not carry sounds or row levels.
//
// The beat is written bit by bit, then spelled in link-safe letters (6 bits each). The first
// letter is a version mark, so old links keep opening when the format changes.
//
// Version 1, in order:
//   tempo            12 bits   (BPM × 10) − 100
//   threads − 1       7 bits
//   group starts      1 bit for every thread after the first: "a new group starts here"
//   group colours     4 bits per group
//   rows in use      17 bits, top row first (the kit's rows as they were for version 1)
//   for each row in use:
//     fibres here?    1 bit
//     no fibres:      1 bit per thread: a note or not
//     fibres:         per thread, 1 bit "split?"; if split, 4 bits (fibres − 2) and 1 bit per
//                     fibre; if not, 1 bit: a note or not
//     then for each note of the row, in time order: strength in 16 steps (4 bits), and
//     1 bit: drawn by the user (Random leaves those alone)

import { BPM_MAX, BPM_MIN, MAX_LINK_THREADS, PALETTE } from './constants';
import type { Hit, Lane, Pattern } from './model';

const VERSION = '1';
const ROWS_V1 = ['CR', 'RD', 'OH', 'CH', 'PH', 'SH', 'TB', 'CB', 'CL', 'CP', 'BG', 'CG', 'DB', 'HT', 'FT', 'SD', 'BD'] as const;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const V_MIN = 0.05, STEPS = 15; // strength: 16 steps from 0.05 to 1
const MAX_FIBRES = 12; // the finest any save has held

class Writer {
  private bits: number[] = [];
  put(value: number, width: number) { for (let i = width - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
  text() {
    let out = '';
    for (let i = 0; i < this.bits.length; i += 6) {
      let v = 0;
      for (let k = 0; k < 6; k++) v = (v << 1) | (this.bits[i + k] ?? 0);
      out += LETTERS[v];
    }
    return out;
  }
}

class Reader {
  private bits: number[] = [];
  private at = 0;
  constructor(text: string) {
    for (const ch of text) {
      const v = LETTERS.indexOf(ch);
      if (v < 0) throw new Error('not a link letter');
      for (let k = 5; k >= 0; k--) this.bits.push((v >> k) & 1);
    }
  }
  get(width: number) {
    if (this.at + width > this.bits.length) throw new Error('link too short');
    let v = 0;
    for (let i = 0; i < width; i++) v = (v << 1) | this.bits[this.at++];
    return v;
  }
}

const laneOf = (p: Pattern, ti: number, row: string): Lane | undefined => (p.threads[ti].lanes as Record<string, Lane | undefined>)[row];

/** The fabric as link text (what goes after the "#"). The tempo is the one it plays at. */
export function packFabric(p: Pattern, bpm: number): string {
  const w = new Writer(), n = p.threads.length;
  w.put(Math.round(Math.max(BPM_MIN, Math.min(BPM_MAX, bpm)) * 10) - 100, 12);
  w.put(n - 1, 7);
  const colours: number[] = [];
  p.threads.forEach((t, i) => {
    const starts = i === 0 || t.group !== p.threads[i - 1].group;
    if (i > 0) w.put(starts ? 1 : 0, 1);
    if (starts) colours.push(p.groups[t.group].colour);
  });
  for (const c of colours) w.put(c, 4);
  // A row is in use if it has a note, or fibres (a region stays a region, empty or not).
  const used = ROWS_V1.map((row) => p.threads.some((_, ti) => { const l = laneOf(p, ti, row); return !!l && (l.zoom > 1 || !!l.slots[0]); }));
  for (const u of used) w.put(u ? 1 : 0, 1);
  ROWS_V1.forEach((row, ri) => {
    if (!used[ri]) return;
    const lanes = p.threads.map((_, ti) => laneOf(p, ti, row));
    const fibres = lanes.some((l) => !!l && l.zoom > 1);
    w.put(fibres ? 1 : 0, 1);
    const notes: Hit[] = [];
    for (const l of lanes) {
      const z = l?.zoom ?? 1;
      if (fibres) w.put(z > 1 ? 1 : 0, 1);
      if (z > 1) w.put(z - 2, 4);
      for (let k = 0; k < z; k++) {
        const h = l?.slots[k] ?? null;
        w.put(h ? 1 : 0, 1);
        if (h) notes.push(h);
      }
    }
    for (const h of notes) {
      w.put(Math.max(0, Math.min(STEPS, Math.round(((h.v - V_MIN) / (1 - V_MIN)) * STEPS))), 4);
      w.put(h.mine ? 1 : 0, 1);
    }
  });
  return VERSION + w.text();
}

/** The fabric and tempo a link holds; 'newer' if it was made by a later Orimono; null if it is not a link at all. */
export function unpackFabric(text: string): { pattern: Pattern; bpm: number } | 'newer' | null {
  if (!text) return null;
  if (text[0] !== VERSION) return /^[2-9A-Za-z]/.test(text) && text.length > 8 ? 'newer' : null;
  try {
    const r = new Reader(text.slice(1));
    const bpm = (r.get(12) + 100) / 10;
    const n = r.get(7) + 1;
    if (bpm < BPM_MIN || bpm > BPM_MAX || n > MAX_LINK_THREADS) return null;
    const p: Pattern = { threads: [], groups: {}, shelf: { resting: [], reuse: 0 }, bpm, nextId: 1 };
    const starts = [true];
    for (let i = 1; i < n; i++) starts.push(r.get(1) === 1);
    const gids: number[] = [];
    for (const s of starts) {
      if (!s) continue;
      const colour = r.get(4);
      if (colour >= PALETTE.length) return null;
      const id = p.nextId++;
      p.groups[id] = { id, colour };
      gids.push(id);
    }
    let g = -1;
    for (const s of starts) {
      if (s) g++;
      p.threads.push({ id: p.nextId++, group: gids[g], lanes: {} });
    }
    const used = ROWS_V1.map(() => r.get(1) === 1);
    ROWS_V1.forEach((row, ri) => {
      if (!used[ri]) return;
      const fibres = r.get(1) === 1;
      const notes: Hit[] = [];
      for (const t of p.threads) {
        const z = fibres && r.get(1) === 1 ? r.get(4) + 2 : 1;
        if (z > MAX_FIBRES) throw new Error('too many fibres');
        const slots: (Hit | null)[] = [];
        for (let k = 0; k < z; k++) {
          if (r.get(1) === 1) { const h: Hit = { v: 0 }; slots.push(h); notes.push(h); }
          else slots.push(null);
        }
        if (z > 1 || slots[0]) (t.lanes as Record<string, Lane>)[row] = { zoom: z, slots };
      }
      for (const h of notes) {
        h.v = Math.round((V_MIN + (r.get(4) / STEPS) * (1 - V_MIN)) * 1000) / 1000;
        if (r.get(1) === 1) h.mine = true;
      }
    });
    return { pattern: p, bpm };
  } catch {
    return null;
  }
}
