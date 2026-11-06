// Lookahead scheduler (§10.4): a timer wakes every ~25 ms and books every hit due in the next
// ~100 ms on the audio clock. It reads the live pattern each time, so edits apply while playing.
// The playhead remembers which thread is next by id: if that thread is deleted, it carries on
// from whichever thread now sits in its place.

import { ROWS, threadSeconds, type RowTag } from './constants';
import type { Engine } from './audio';
import type { Pattern } from './model';

const WAKE_MS = 25;
const AHEAD_S = 0.15; // must exceed the longest sample lead-in (≤ 0.12 s)

export interface Fired {
  time: number; // audio time
  threadId: number;
  hits: { row: RowTag; v: number; slot: number; zoom: number }[];
}

export class Scheduler {
  playing = false;
  private timer = 0;
  private nextIdx = 0;
  private nextId = -1;
  private nextTime = 0;
  /** Threads already booked, waiting for their moment, for the playhead and string plucks. */
  private queue: Fired[] = [];

  constructor(private engine: Engine, private pattern: () => Pattern) {}

  start() {
    if (this.playing) return;
    this.engine.resume();
    const p = this.pattern();
    this.playing = true;
    this.nextIdx = 0;
    this.nextId = p.threads[0].id;
    this.nextTime = this.engine.ctx.currentTime + 0.06;
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
    const p = this.pattern();
    const ctx = this.engine.ctx;
    // If audio fell far behind (tab was asleep), jump forward rather than play a burst.
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < ctx.currentTime + AHEAD_S) {
      const n = p.threads.length;
      if (p.threads[this.nextIdx]?.id !== this.nextId) {
        const found = p.threads.findIndex((t) => t.id === this.nextId);
        this.nextIdx = found >= 0 ? found : this.nextIdx % n;
      }
      const thread = p.threads[this.nextIdx];
      const dur = threadSeconds(p.bpm);
      const fired: Fired = { time: this.nextTime, threadId: thread.id, hits: [] };
      for (const row of ROWS) {
        const lane = thread.lanes[row];
        if (!lane) continue;
        lane.slots.forEach((hit, k) => {
          if (!hit) return;
          // Exact position inside the thread: k / zoom (zoom is 1 in the MVP).
          this.engine.play(row, hit.v, this.nextTime + (dur * k) / lane.zoom);
          fired.hits.push({ row, v: hit.v, slot: k, zoom: lane.zoom });
        });
      }
      this.queue.push(fired);
      this.nextTime += dur;
      this.nextIdx = (this.nextIdx + 1) % n;
      this.nextId = p.threads[this.nextIdx].id;
    }
  }

  /** Threads whose moment has come since the last call (for the playhead and plucks). */
  due(): Fired[] {
    const now = this.engine.ctx.currentTime;
    const out: Fired[] = [];
    while (this.queue.length && this.queue[0].time <= now) out.push(this.queue.shift()!);
    return out;
  }
}
