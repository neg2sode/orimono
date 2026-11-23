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

/** A row's fader: level in dB (0 = the kit's own level), mute and solo. */
export interface RowMix { db: number; mute: boolean; solo: boolean }

const CHOKE_FADE = 0.004; // seconds: short enough to feel instant, long enough not to click

type Session = { type: string };
const session = () => (navigator as Navigator & { audioSession?: Session }).audioSession;

export class Engine {
  // The sound output. It can be replaced (renew) when the phone hands it back broken after the
  // screen was off: on iPhones it comes back late (~1.5 s) or obeying the silent switch again.
  // The decoded sounds are kept and reused by the new output.
  private _ctx!: AudioContext;
  get ctx() { return this._ctx; }
  private master!: GainNode;
  private rows = new Map<RowTag, Row>();
  private voices = new Map<RowTag, Voice>();
  /** Every booked or sounding voice, so Stop can silence hits that haven't started yet. */
  private live = new Set<Voice>();
  private buses = new Map<RowTag, GainNode>();
  private mixState: Partial<Record<RowTag, RowMix>> = {};
  /** How many times the output has been replaced (shown by orimonoSound()). */
  renewals = 0;

  constructor() {
    this.claimSession(false);
    this.build();
  }

  // An instrument, not a notification: on iPhones that allow it (iOS 17 and later), ask to
  // sound even when the silent switch is on. Elsewhere this does nothing. After the screen has
  // been off iOS can forget the request, so `again` withdraws it and asks afresh.
  private claimSession(again: boolean) {
    try {
      const s = session();
      if (!s) return;
      if (again) s.type = 'auto';
      s.type = 'playback';
    } catch { /* not supported: the silent switch decides */ }
  }

  private build() {
    this._ctx = new AudioContext({ latencyHint: 'interactive' });
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(limiter).connect(this.ctx.destination);
    this.buses.clear();
    for (const tag of this.rows.keys()) this.addBus(tag);
    this.applyMix();
  }

  private addBus(tag: RowTag) {
    const bus = this.ctx.createGain();
    bus.connect(this.master);
    this.buses.set(tag, bus);
  }

  /** Throw the sound output away and make a fresh one, keeping the loaded sounds. Only while
   *  nothing is playing: the new output's clock starts again from zero. */
  renew() {
    const old = this._ctx;
    this.live.clear();
    this.voices.clear();
    this.claimSession(true);
    this.build();
    this.renewals++;
    void old.close().catch(() => { /* already closed */ });
  }

  /** Let the sound output rest while the page is out of sight and nothing plays. */
  rest() {
    if (this.ctx.state === 'running') void this.ctx.suspend().catch(() => {});
  }

  /** For orimonoSound(): what the phone or browser says about the output. */
  info() {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return { session: session()?.type ?? 'n/a', baseLatency: c.baseLatency, outputLatency: c.outputLatency, renewals: this.renewals };
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
        this.addBus(def.tag);
      }),
    );
    this.applyMix();
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
    out.connect(gain).connect(this.buses.get(tag) ?? this.master);

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
    this.live.add(voice);
    src.onended = () => {
      this.live.delete(voice);
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

  /** Set the faders (all rows at once); takes effect immediately, also on ringing sounds. */
  setMix(mix: Partial<Record<RowTag, RowMix>>) {
    this.mixState = mix;
    this.applyMix();
  }

  private applyMix() {
    const anySolo = Object.values(this.mixState).some((m) => m?.solo);
    const now = this.ctx.currentTime;
    for (const [tag, bus] of this.buses) {
      const m = this.mixState[tag];
      const on = !(m?.mute) && (!anySolo || !!m?.solo);
      bus.gain.setTargetAtTime(on ? dbToGain(m?.db ?? 0) : 0, now, 0.015);
    }
  }

  /** Stop everything right now (Stop button). */
  silence() {
    const now = this.ctx.currentTime;
    for (const v of this.live) {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setTargetAtTime(0, now, 0.002);
      try {
        v.src.stop(now + 0.02);
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
    this.voices.clear();
  }
}

const dbToGain = (db: number) => Math.pow(10, db / 20);
