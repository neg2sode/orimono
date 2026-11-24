// Taking a beat away as sound (WAV) or as notes (MIDI). What is exported is what Play plays:
// out on the table the whole paragraph (every fabric in order, each at its own tempo), otherwise
// the open fabric. One time round, exactly as long as the loop.

import { ROWS, threadSeconds, type RowTag } from './constants';
import type { Pattern } from './model';

/** One fabric of what is exported, at the tempo it plays at. */
export interface Part { pattern: Pattern; bpm: number }

/** Every hit, in seconds from the start, and the whole length. */
export function hitsOf(parts: Part[]): { hits: { row: RowTag; v: number; time: number }[]; seconds: number } {
  const hits: { row: RowTag; v: number; time: number }[] = [];
  let start = 0;
  for (const { pattern, bpm } of parts) {
    const sec = threadSeconds(bpm);
    pattern.threads.forEach((t, i) => {
      for (const row of ROWS) {
        const lane = t.lanes[row];
        lane?.slots.forEach((h, k) => { if (h) hits.push({ row, v: h.v, time: start + (i + k / lane.zoom) * sec }); });
      }
    });
    start += pattern.threads.length * sec;
  }
  hits.sort((a, b) => a.time - b.time);
  return { hits, seconds: start };
}

// ---------------------------------------------------------------- WAV

/** 16-bit PCM WAV from channels of samples (-1..1). */
export function wav(channels: Float32Array[], sampleRate: number): Blob {
  const n = channels[0]?.length ?? 0, ch = channels.length, data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, o += 2) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- MIDI

/** General MIDI drum notes for the kit's rows (channel 10). Darbuka has no GM note: it gets
 *  High Timbale, the nearest bright hand drum not already used. */
export const GM_NOTE: Record<RowTag, number> = {
  CR: 49, // Crash Cymbal 1
  RD: 51, // Ride Cymbal 1
  OH: 46, // Open Hi-Hat
  CH: 42, // Closed Hi-Hat
  PH: 44, // Pedal Hi-Hat
  SH: 82, // Shaker
  TB: 54, // Tambourine
  CB: 56, // Cowbell
  CL: 75, // Claves
  CP: 39, // Hand Clap
  BG: 61, // Low Bongo
  CG: 63, // Open Hi Conga
  DB: 65, // High Timbale (for the darbuka)
  HT: 50, // High Tom
  FT: 43, // High Floor Tom
  SD: 38, // Acoustic Snare
  BD: 36, // Bass Drum 1
};

/** Ticks per beat. A thread is a quarter of a beat, 420 ticks, which every split from ×1 to ×7
 *  divides exactly, so fibres land on whole ticks. (Older, finer splits are rounded.) */
export const PPQ = 1680;
const THREAD_TICKS = PPQ / 4;

/**
 * A Standard MIDI File (format 0, one track, channel 10): every hit as a short drum note with its
 * strength as velocity, a tempo at the start of each fabric whose tempo differs from the one
 * before, and a marker naming each fabric when there is more than one. Mute and solo are not
 * applied: MIDI carries the notes, the levels are the listener's.
 */
export function midi(parts: Part[], names: string[] = []): Uint8Array<ArrayBuffer> {
  type Ev = { tick: number; order: number; bytes: number[] };
  const evs: Ev[] = [];
  const text = (type: number, s: string) => { const b = [...new TextEncoder().encode(s)]; return [0xff, type, ...vlq(b.length), ...b]; };
  evs.push({ tick: 0, order: 0, bytes: text(0x03, 'Orimono') });
  let start = 0, lastBpm = NaN;
  parts.forEach(({ pattern, bpm }, f) => {
    if (bpm !== lastBpm) {
      const us = Math.round(60_000_000 / bpm);
      evs.push({ tick: start, order: 1, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
      lastBpm = bpm;
    }
    if (parts.length > 1) evs.push({ tick: start, order: 2, bytes: text(0x06, names[f] ?? `Fabric ${f + 1}`) });
    pattern.threads.forEach((t, i) => {
      for (const row of ROWS) {
        const lane = t.lanes[row];
        if (!lane) continue;
        const len = Math.max(1, Math.min(Math.round(THREAD_TICKS / lane.zoom), PPQ / 8)); // short: drums don't hold
        lane.slots.forEach((h, k) => {
          if (!h) return;
          const at = start + i * THREAD_TICKS + Math.round((k * THREAD_TICKS) / lane.zoom);
          const vel = Math.max(1, Math.min(127, Math.round(h.v * 127)));
          evs.push({ tick: at, order: 4, bytes: [0x99, GM_NOTE[row], vel] });
          evs.push({ tick: at + len, order: 3, bytes: [0x89, GM_NOTE[row], 0] }); // offs before ons at the same tick
        });
      }
    });
    start += pattern.threads.length * THREAD_TICKS;
  });
  evs.push({ tick: start, order: 9, bytes: [0xff, 0x2f, 0x00] }); // end of track: exactly one time round
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let at = 0;
  for (const e of evs) {
    const tick = Math.min(e.tick, start);
    track.push(...vlq(tick - at), ...e.bytes);
    at = tick;
  }
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff, // MThd: format 0, 1 track
    0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track, // MTrk
  ]);
}

/** A MIDI variable-length number. */
function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
