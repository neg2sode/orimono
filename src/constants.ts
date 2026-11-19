// Palette and fixed settings, from the design plan §9.

export const PALETTE = [
  { name: 'Clay', hex: '#C0827F' },
  { name: 'Peach', hex: '#ECB088' },
  { name: 'Honey', hex: '#EDD49D' },
  { name: 'Ivory', hex: '#FFFAD8' },
  { name: 'Lime', hex: '#E5F8B9' },
  { name: 'Sage', hex: '#CDE6A8' },
  { name: 'Cream', hex: '#F4E5BC' },
  { name: 'Sand', hex: '#D1BB89' },
  { name: 'Caramel', hex: '#DBA868' },
  { name: 'Khaki', hex: '#B5B17E' },
  { name: 'Teal', hex: '#8BC0BC' },
  { name: 'Slate', hex: '#8694A1' },
  { name: 'Latte', hex: '#B99980' },
] as const;

/** The dye shelf, read backwards from the opening colours (§9.1). */
export const SHELF_ORDER = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
/** How many new groups a removed colour waits before it can be used again. */
export const REST_BIRTHS = 3;

// The interface is neutral grey, so the colours of fibres, threads and fabrics are the only
// colours that stand out. One accent (`play`) marks actions; `warn` marks what removes things.
// The same values are in style.css.
export const UI = {
  bg: '#191919',
  panel: '#242424',
  border: '#6E6E6E',
  dim: '#8A8A8A',
  secondary: '#A0A0A0',
  text: '#BFBFBF',
  bright: '#E8E8E8', // used sparingly: where you are, what is picked or selected, and "Stop"
  tag: '#3A3A3A',
  play: '#DBA868',
  warn: '#E1707C',
};

/** Rows top to bottom (§4.2). Must match public/kit/manifest.json. */
export const ROWS = [
  'CR', 'RD', 'OH', 'CH', 'PH', 'SH', 'TB', 'CB', 'CL', 'CP', 'BG', 'CG', 'DB', 'HT', 'FT', 'SD', 'BD',
] as const;
export type RowTag = (typeof ROWS)[number];

export const MIN_THREADS = 1;
export const MAX_THREADS = 128;
export const DEFAULT_VELOCITY = 0.75;
export const MAX_ZOOM = 7; // most fibres one thread can split into (older saves may hold finer ones; they still play)
export const BPM_MIN = 10;
export const BPM_MAX = 300;
export const DEFAULT_BPM = 72;

/** Seconds per thread (base cell): one beat = 4 threads (§4.1). */
export const threadSeconds = (bpm: number) => 60 / (bpm * 4);
