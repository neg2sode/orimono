import { describe, expect, it } from 'vitest';
import { GM_NOTE, PPQ, hitsOf, midi, wav } from './export';
import { fresh, setHit, single, zoomRect } from './model';

/** Read a format-0 MIDI file back: header and every event with its absolute tick. */
function readMidi(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
  expect(str(0)).toBe('MThd');
  const format = dv.getUint16(8), tracks = dv.getUint16(10), ppq = dv.getUint16(12);
  expect(str(14)).toBe('MTrk');
  const len = dv.getUint32(18), end = 22 + len;
  expect(end).toBe(bytes.length);
  let o = 22, tick = 0;
  const vlq = () => { let n = 0, b; do { b = bytes[o++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
  const evs: { tick: number; kind: string; a?: number; b?: number; us?: number; text?: string }[] = [];
  while (o < end) {
    tick += vlq();
    const st = bytes[o++];
    if (st === 0xff) {
      const type = bytes[o++], n = vlq(), data = bytes.slice(o, o + n);
      o += n;
      if (type === 0x51) evs.push({ tick, kind: 'tempo', us: (data[0] << 16) | (data[1] << 8) | data[2] });
      else if (type === 0x2f) evs.push({ tick, kind: 'end' });
      else evs.push({ tick, kind: `text${type}`, text: new TextDecoder().decode(data) });
    } else {
      evs.push({ tick, kind: (st & 0xf0) === 0x90 ? 'on' : 'off', a: bytes[o++], b: bytes[o++] });
      expect(st & 0x0f).toBe(9); // channel 10
    }
  }
  return { format, tracks, ppq, evs };
}

const beat = () => {
  let p = fresh(); // 16 threads
  p = setHit(p, 0, 'BD', { v: 1, mine: true });
  p = setHit(p, 4, 'SD', { v: 0.5 });
  p = zoomRect(p, { t0: 8, t1: 8, r0: 3, r1: 3 }, 3); // closed hat row, ×3
  p = setHit(p, 8, 'CH', { v: 0.8 }, 1);
  p = setHit(p, 8, 'CH', { v: 0.8 }, 2);
  return p;
};

describe('MIDI export', () => {
  it('is a format-0 drum file at 1680 ticks a beat', () => {
    const m = readMidi(midi([{ pattern: beat(), bpm: 72 }]));
    expect([m.format, m.tracks, m.ppq]).toEqual([0, 1, PPQ]);
  });

  it('places every hit on its exact tick, fibres included, with its strength', () => {
    const m = readMidi(midi([{ pattern: beat(), bpm: 72 }]));
    const ons = m.evs.filter((e) => e.kind === 'on').map((e) => [e.tick, e.a, e.b]);
    expect(ons).toEqual([
      [0, GM_NOTE.BD, 127],
      [4 * 420, GM_NOTE.SD, 64],
      [8 * 420 + 140, GM_NOTE.CH, 102], // fibre 2 of 3
      [8 * 420 + 280, GM_NOTE.CH, 102], // fibre 3 of 3
    ]);
    expect(m.evs.filter((e) => e.kind === 'off').length).toBe(4);
  });

  it('is exactly one time round long, with the tempo at the start', () => {
    const m = readMidi(midi([{ pattern: beat(), bpm: 72 }]));
    expect(m.evs.at(-1)).toMatchObject({ kind: 'end', tick: 16 * 420 });
    expect(m.evs.find((e) => e.kind === 'tempo')).toMatchObject({ tick: 0, us: Math.round(60e6 / 72) });
  });

  it('changes tempo where a fabric has its own, and names each fabric', () => {
    const one = single();
    const m = readMidi(midi([{ pattern: beat(), bpm: 72 }, { pattern: one, bpm: 144 }, { pattern: one, bpm: 144 }], ['Fabric 1', 'Fabric 2', 'Fabric 3']));
    expect(m.evs.filter((e) => e.kind === 'tempo').map((e) => [e.tick, e.us])).toEqual([[0, Math.round(60e6 / 72)], [16 * 420, Math.round(60e6 / 144)]]);
    expect(m.evs.filter((e) => e.kind === 'text6').map((e) => [e.tick, e.text])).toEqual([[0, 'Fabric 1'], [16 * 420, 'Fabric 2'], [17 * 420, 'Fabric 3']]);
    expect(m.evs.at(-1)).toMatchObject({ kind: 'end', tick: 18 * 420 });
  });
});

describe('the hits of an export', () => {
  it('are in seconds, each fabric at its own tempo, one after another', () => {
    const { hits, seconds } = hitsOf([{ pattern: beat(), bpm: 60 }, { pattern: setHit(single(), 0, 'CP', { v: 1 }), bpm: 120 }]);
    // at 60 BPM a thread is 0.25 s; at 120, 0.125 s
    expect(hits.map((h) => [h.row, +h.time.toFixed(4)])).toEqual([['BD', 0], ['SD', 1], ['CH', 2.0833], ['CH', 2.1667], ['CP', 4]]);
    expect(seconds).toBeCloseTo(4.125);
  });
});

describe('WAV', () => {
  it('has a correct 16-bit stereo header and clips nothing out of range', async () => {
    const l = new Float32Array([0, 0.5, -1, 2]), r = new Float32Array([0, -0.5, 1, -2]);
    const b = new Uint8Array(await wav([l, r], 48000).arrayBuffer());
    const dv = new DataView(b.buffer);
    expect(String.fromCharCode(...b.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...b.slice(8, 12))).toBe('WAVE');
    expect([dv.getUint16(22, true), dv.getUint32(24, true), dv.getUint16(34, true)]).toEqual([2, 48000, 16]);
    expect(dv.getUint32(40, true)).toBe(4 * 2 * 2);
    expect(b.length).toBe(44 + 16);
    expect(dv.getInt16(44 + 12, true)).toBe(32767); // 2 clipped to full scale
    expect(dv.getInt16(44 + 14, true)).toBe(-32768);
  });
});
