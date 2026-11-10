// Lookahead scheduler (§10.4): a timer wakes every ~25 ms and books every hit due in the next
// ~150 ms on the audio clock. It reads the live pattern each time, so edits apply while playing.
// A thread's fibres are booked as their moments come up, not all at once, and always in time
// order (a hit chokes whatever its row booked before it, so order matters).
// The playhead remembers which thread it is on by id: if that thread is deleted, it carries on
// from whichever thread now sits in its place.

import { ROWS, threadSeconds, type RowTag } from './constants';
import type { Engine } from './audio';
import type { Pattern } from './model';

const WAKE_MS = 25;
const AHEAD_S = 0.15; // must exceed the longest sample lead-in (≤ 0.12 s)

/** Hits that share one moment. `start` marks the first moment of a thread (the playhead moves). */
export interface Fired {
  time: number; // audio time
  threadId: number;
  start: boolean;
  hits: { row: RowTag; v: number; slot: number; zoom: number }[];
}

export class Scheduler {
  playing = false;
  private timer = 0;
  private idx = 0;
  private id = -1;
  /** When the current thread starts, and how much of it (0–1) is already booked. */
  private threadTime = 0;
  private booked = 0;
  /** Moments already booked, waiting for their time, for the playhead and string plucks. */
  private queue: Fired[] = [];
  /** Playing a stretch once: the id of its last thread, and (once booked) when it ends. */
  private lastId: number | null = null;
  private endAt: number | null = null;
  private rows: readonly RowTag[] = ROWS;
  /** Called when a play-once stretch has finished. */
  onEnd: (() => void) | null = null;
  /** Called each time the pattern comes round to its start, with the audio time of that start. */
  onLoop: ((time: number) => void) | null = null;
  /** A tempo to play at instead of the pattern's own (for listening slowly inside a region). */
  bpm: (() => number | null) | null = null;
  /** Looping the whole pattern (not playing a stretch once). */
  get looping() { return this.playing && this.lastId === null; }
  private tempo(p: Pattern) { return this.bpm?.() ?? p.bpm; }

  constructor(private engine: Engine, private pattern: () => Pattern) {}

  /** Loop the whole pattern, or with `once` play threads from..to (indices, and only `rows`) a single time. */
  start(once?: { from: number; to: number; rows?: readonly RowTag[] }) {
    if (this.playing) return;
    this.engine.resume();
    const p = this.pattern();
    this.playing = true;
    this.idx = once ? Math.min(once.from, p.threads.length - 1) : 0;
    this.id = p.threads[this.idx].id;
    this.lastId = once ? p.threads[Math.min(once.to, p.threads.length - 1)].id : null;
    this.endAt = null;
    this.rows = once?.rows ?? ROWS;
    this.threadTime = this.engine.ctx.currentTime + 0.06;
    this.booked = 0;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), WAKE_MS);
  }

  stop() {
    this.playing = false;
    window.clearInterval(this.timer);
    this.queue = [];
    this.engine.silence();
  }

  private tick() {
    let p = this.pattern();
    const now = this.engine.ctx.currentTime;
    // If audio fell far behind (tab was asleep), jump forward rather than play a burst.
    if (this.threadTime + this.booked * threadSeconds(this.tempo(p)) < now - 0.2) {
      this.threadTime = now + 0.02;
      this.booked = 0;
    }
    if (this.endAt !== null) {
      // The stretch is fully booked: when its time is up, playing ends by itself. Notes ring out.
      if (now >= this.endAt) {
        this.playing = false;
        window.clearInterval(this.timer);
        this.onEnd?.();
      }
      return;
    }
    const horizon = now + AHEAD_S;
    for (;;) {
      const n = p.threads.length;
      if (p.threads[this.idx]?.id !== this.id) {
        const found = p.threads.findIndex((t) => t.id === this.id);
        this.idx = found >= 0 ? found : this.idx % n;
        this.id = p.threads[this.idx].id;
      }
      const thread = p.threads[this.idx];
      const dur = threadSeconds(this.tempo(p));
      // Book the part of this thread, as a fraction, that falls inside the lookahead window.
      const upTo = Math.min(1, (horizon - this.threadTime) / dur);
      if (upTo <= this.booked) break;
      const moments = new Map<number, Fired>();
      const at = (f: number) => {
        let m = moments.get(f);
        if (!m) moments.set(f, (m = { time: this.threadTime + f * dur, threadId: thread.id, start: f === 0, hits: [] }));
        return m;
      };
      if (this.booked === 0) at(0);
      for (const row of this.rows) {
        const lane = thread.lanes[row];
        if (!lane) continue;
        lane.slots.forEach((hit, k) => {
          const f = k / lane.zoom; // exact position inside the thread
          if (hit && f >= this.booked && f < upTo) at(f).hits.push({ row, v: hit.v, slot: k, zoom: lane.zoom });
        });
      }
      for (const m of [...moments.values()].sort((a, b) => a.time - b.time)) {
        for (const h of m.hits) this.engine.play(h.row, h.v, m.time);
        this.queue.push(m);
      }
      this.booked = upTo;
      if (upTo < 1) break;
      this.threadTime += dur;
      this.booked = 0;
      if (thread.id === this.lastId) {
        this.endAt = this.threadTime;
        break;
      }
      this.idx = (this.idx + 1) % n;
      if (this.idx === 0 && this.onLoop) {
        // The loop is starting again: whoever listens may hand over a different pattern here.
        this.onLoop(this.threadTime);
        p = this.pattern();
      }
      this.id = p.threads[this.idx].id;
    }
  }

  /** Moments whose time has come since the last call (for the playhead and plucks). */
  due(): Fired[] {
    const now = this.engine.ctx.currentTime;
    const out: Fired[] = [];
    while (this.queue.length && this.queue[0].time <= now) out.push(this.queue.shift()!);
    return out;
  }
}
