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

export const UI = {
  bg: '#151A1F',
  panel: '#2F2923',
  border: '#69757F',
  dim: '#9F8F82',
  secondary: '#B99980',
  text: '#FFFAD8',
  tag: '#EDD49D',
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
export const MAX_ZOOM = 12; // most fibres one thread can split into

/**
 * Each zoom has its own colour, brighter than any group dye so a region stands out from the
 * threads. The hue follows what the number is made of: twos are green (2, 4, 8 drift towards
 * teal), threes yellow (9 a deeper gold), 5 orange-red, 7 red-magenta, 11 violet. Mixed numbers
 * sit between their parts: 6 and 12 yellow-green, 10 orange.
 */
export const ZOOM_COLOURS: Record<number, string> = {
  2: '#6EDC7F', 4: '#46D39A', 8: '#2FC7B5',
  3: '#F4DA3A', 9: '#EDB422',
  6: '#B9DE3F', 12: '#8FDB55',
  5: '#FF7448', 10: '#FF9F3D',
  7: '#F0508E', 11: '#B07CF2',
};
export const zoomColour = (z: number) => ZOOM_COLOURS[z] ?? '#FFFAD8';
export const BPM_MIN = 10;
export const BPM_MAX = 300;
export const DEFAULT_BPM = 72;

/** Seconds per thread (base cell): one beat = 4 threads (§4.1). */
export const threadSeconds = (bpm: number) => 60 / (bpm * 4);
