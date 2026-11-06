// Sample playback (§10.4): velocity picks the closest recorded strength, takes alternate at
// random (never the same twice in a row), sounds ring past their cell, and each row
// chokes its own previous sound. A closed or pedal hat also chokes the open hat.

import type { RowTag } from './constants';

interface TakeDef { file: string; leadMs: number }
interface LayerDef { loudDb: number; takes: TakeDef[] }
interface RowDef { tag: RowTag; name: string; gainDb: number; floorMs: number; chokes: RowTag[]; layers: LayerDef[] }
interface Manifest { rows: RowDef[] }

interface Take { buffer: AudioBuffer; lead: number }
interface Layer { loudDb: number; takes: Take[] }
interface Row { def: RowDef; layers: Layer[]; lastTake: Take | null }
interface Voice { src: AudioBufferSourceNode; gain: GainNode; base: number }

const CHOKE_FADE = 0.004; // seconds: short enough to feel instant, long enough not to click

export class Engine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private master: GainNode;
  private rows = new Map<RowTag, Row>();
  private voices = new Map<RowTag, Voice>();

  constructor() {
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(limiter).connect(this.ctx.destination);
  }

  async load(base = `${import.meta.env.BASE_URL}kit/`, onProgress?: (done: number, total: number) => void) {
    const manifest: Manifest = await (await fetch(`${base}manifest.json`)).json();
    const total = manifest.rows.reduce((n, r) => n + r.layers.reduce((m, l) => m + l.takes.length, 0), 0);
    let done = 0;
    const decode = async (t: TakeDef): Promise<Take> => {
      const buf = await (await fetch(base + t.file)).arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(buf);
      onProgress?.(++done, total);
      return { buffer, lead: (t.leadMs ?? 0) / 1000 };
    };
    await Promise.all(
      manifest.rows.map(async (def) => {
        const layers = await Promise.all(
          def.layers.map(async (l) => ({ loudDb: l.loudDb, takes: await Promise.all(l.takes.map(decode)) })),
        );
        this.rows.set(def.tag, { def, layers, lastTake: null });
      }),
    );
  }

  get loaded() {
    return this.rows.size > 0;
  }

  /** Browsers only allow sound after a user gesture. */
  resume() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  /**
   * Play one hit on a row at audio time `when` with velocity v (0–1).
   * A preview (tapping a cell) plays straight away and stays out of the choke bookkeeping,
   * so it never cancels a hit the scheduler has already booked.
   */
  play(tag: RowTag, v: number, when = this.ctx.currentTime, preview = false) {
    const row = this.rows.get(tag);
    if (!row) return;

    // Velocity → target loudness, relative to the loudest strength (0 dB).
    const lowest = Math.min(...row.layers.map((l) => l.loudDb));
    const range = Math.max(24, -lowest);
    const target = -(1 - v) * range;
    let layer = row.layers[0];
    for (const l of row.layers) if (Math.abs(l.loudDb - target) < Math.abs(layer.loudDb - target)) layer = l;
    const trimDb = Math.max(-30, Math.min(4, target - layer.loudDb));

    // A random take, never the same one twice in a row.
    const choices = layer.takes.length > 1 ? layer.takes.filter((t) => t !== row.lastTake) : layer.takes;
    const take = choices[Math.floor(Math.random() * choices.length)];
    row.lastTake = take;

    // Sounds that swell (shakes) start early by their lead-in, so the loud part lands on `when`.
    // If that moment has already passed (a tap, or a late booking), skip into the sound instead.
    const now = this.ctx.currentTime;
    const startAt = preview ? now : Math.max(now, when - take.lead);
    const offset = preview ? take.lead : Math.max(0, now - (when - take.lead));

    const src = this.ctx.createBufferSource();
    src.buffer = take.buffer;
    const gain = this.ctx.createGain();
    const base = dbToGain(row.def.gainDb + trimDb);
    gain.gain.setValueAtTime(base, startAt);
    let out: AudioNode = src;
    // Sounds with only one recorded strength get a little duller when played softly.
    if (row.layers.length === 1 && v < 0.7) {
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500 + v * 16000;
      src.connect(lp);
      out = lp;
    }
    out.connect(gain).connect(this.master);

    if (preview) {
      src.start(startAt, offset);
      src.onended = () => { src.disconnect(); gain.disconnect(); };
      return;
    }
    this.choke(tag, startAt);
    for (const other of row.def.chokes) this.choke(other, startAt);
    src.start(startAt, offset);
    const voice = { src, gain, base };
    this.voices.set(tag, voice);
    src.onended = () => {
      if (this.voices.get(tag) === voice) this.voices.delete(tag);
      src.disconnect();
      gain.disconnect();
    };
  }

  private choke(tag: RowTag, when: number) {
    const voice = this.voices.get(tag);
    if (!voice) return;
    voice.gain.gain.setValueAtTime(voice.base, when);
    voice.gain.gain.linearRampToValueAtTime(0, when + CHOKE_FADE);
    try {
      voice.src.stop(when + CHOKE_FADE + 0.002);
    } catch {
      /* already stopped */
    }
    this.voices.delete(tag);
  }

  /** Stop everything right now (Stop button). */
  silence() {
    const now = this.ctx.currentTime;
    for (const tag of [...this.voices.keys()]) this.choke(tag, now);
  }
}

const dbToGain = (db: number) => Math.pow(10, db / 20);
