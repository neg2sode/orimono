// Drawing (§11): each thread is a vertical string in its group's colour, hits are beads whose
// size is their velocity, and strings wobble when the playhead plucks them.

import { FRONT_X, LABEL_W, cellL, cellR, fibreX, gapX, midX, regionBox, rowY, type Layout, type Target } from './layout';
import { PALETTE, ROWS, UI } from './constants';
import type { Pattern, Rect } from './model';

export interface ViewState {
  tool: 'draw' | 'select';
  hover: Target;
  rect: Rect | null;
  groupSel: [number, number] | null;
  drop: { a: number; b: number; idx: number } | null;
  playheadId: number | null;
  hold: { threadId: number; ri: number; slot: number; dx: number } | null;
  /** Touch: the number whose menu is open. */
  stripSel: number | null;
  /** Whole rows picked by their name tags. */
  rowSel: [number, number] | null;
  /** Rows silenced by mute or by another row's solo (their tags are dimmed). */
  quiet?: boolean[];
  /** performance.now() of the last Random press: the user's own notes glow briefly. */
  glow: number;
  /** The area Random filled on that press (null = everything): only notes inside it glow. */
  glowRect: Rect | null;
  /** Thread level: the zoomed region under the pointer (a press goes inside it). */
  hoverRegion?: Rect | null;
  /** The end "+" that was just pressed: pressed again in the same place, it adds a cell. */
  endAdds?: 'front' | null;
  /** No room for another cell: the "+" signs are not shown. */
  full?: boolean;
  /** Where that press was (x): a single "+" waits there, like the one on a number. */
  endX?: number;
}

interface Wobble { amp: number; t0: number; freq: number; tau: number }

const FONT = '"Space Grotesk", system-ui, sans-serif';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export type FlightStyle = 'fling' | 'fountain' | 'thread';
export const FLIGHT_STYLES: FlightStyle[] = ['fling', 'fountain', 'thread'];
// How long one string's way out takes, and the time from the first string out to the last, in ms.
const FLIGHT_MS: Record<FlightStyle, number> = { fling: 750, fountain: 750, thread: 850 };
const SPREAD_MS: Record<FlightStyle, number> = { fling: 700, fountain: 700, thread: 220 }; // thread: a burst, nearly all at once

/** A piece of confetti: a bead like those on the strings, or a fleck of paper that flips as it falls. */
type Confetti = { x: number; y: number; vx: number; vy: number; rot: number; spin: number; size: number; bead: boolean; colour: string; delay: number; life: number; age: number };

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private xNow = new Map<number, number>(); // animated x per thread id
  private alpha = new Map<number, number>(); // fade-in for new strings
  private wobble = new Map<string, Wobble>(); // by thread id, or "thread:row:slot" for a fibre
  private last = performance.now();

  /** frozen: no motion at all (for small still pictures of a fabric). */
  constructor(private canvas: HTMLCanvasElement, private frozen = false) {
    this.ctx = canvas.getContext('2d')!;
  }

  // First launch: the strings come out of the welcome's gift box. Once its lid pops, they fly
  // out of it, middle ones first, each landing on its place and swinging. Then the row tags pop
  // down the left edge and the groups and numbers count in along the bottom. While the welcome
  // is up, closing the box draws the strings back in, and opening it sends them out again.
  private bloomAt: number | null = null; // when it began (-1: at the next frame)
  private bloomT = 0; // ms since then
  private nowMs = 0;
  /** How the strings travel out of the box (orimonoWelcome('thread') etc. to try one). */
  flightStyle: FlightStyle = 'fling';
  private flyAt: number | null = null; // when the current flight (out or in) began
  private flyOut = true;
  private stowed = false; // all the strings are in the box
  private landed = new Set<number>();
  private flyFrom: () => { x: number; y: number } | null = () => null;
  private static FLY = 1850; // ms after the bloom begins: the lid has popped

  /** from: where the strings fly out from, in the canvas's own px (the box's open top). */
  bloom(from: () => { x: number; y: number } | null) {
    this.bloomAt = -1;
    this.fly(true, from, Renderer.FLY);
  }

  /** Send the strings out of the box (out) or back into it, starting delay ms from now. */
  fly(out: boolean, from: () => { x: number; y: number } | null, delay = 0) {
    this.flyFrom = from;
    this.landed.clear();
    if (this.frozen || reducedMotion()) { this.flyAt = null; this.stowed = !out; return; }
    this.flyAt = performance.now() + delay;
    this.flyOut = out;
    this.stowed = false;
    this.confettiDue = out && this.flightStyle === 'thread';
  }

  // The surprise when the strings burst out of the box (thread): confetti in the strings' own
  // colours and the accent, shot up out of the box, fluttering down and fading.
  private confettiDue = false;
  private confetti: Confetti[] = [];
  private burst(p: Pattern) {
    const o = this.flyFrom();
    if (!o) return;
    const colours: string[] = [...new Set(Object.values(p.groups).map((g) => PALETTE[g.colour].hex))];
    colours.push(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#875946');
    const H = this.canvas.clientHeight || 800, power = Math.max(0.6, Math.min(1.3, H / 800));
    for (let k = 0; k < 110; k++) {
      const ang = (Math.random() - 0.5) * 2.2, speed = (420 + Math.random() * 700) * power; // a cone, mostly upward
      this.confetti.push({
        x: o.x + (Math.random() - 0.5) * 30, y: o.y, vx: Math.sin(ang) * speed, vy: -Math.cos(ang) * speed,
        rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 18, size: 3 + Math.random() * 4,
        bead: Math.random() < 0.35, colour: colours[k % colours.length], delay: Math.random() * 0.15, life: 1.8 + Math.random() * 1.1, age: 0,
      });
    }
  }
  private drawConfetti(dt: number) {
    if (!this.confetti.length) return;
    const { ctx } = this;
    this.confetti = this.confetti.filter((c) => c.age < c.delay + c.life);
    for (const c of this.confetti) {
      c.age += dt;
      if (c.age < c.delay) continue;
      // Thrown up, slowed by the air; flecks of paper drift down slowly, beads fall faster.
      c.vy += 1500 * dt;
      const drag = Math.exp(-(c.bead ? 1.2 : 2.6) * dt);
      c.vx *= drag;
      c.vy = Math.min(c.vy * drag, c.bead ? 520 : 170);
      c.x += (c.vx + (c.bead ? 0 : 30 * Math.sin(c.age * 7 + c.rot))) * dt;
      c.y += c.vy * dt;
      c.rot += c.spin * dt;
      const left = c.delay + c.life - c.age;
      ctx.globalAlpha = Math.min(1, left / 0.5) * 0.95;
      ctx.fillStyle = c.colour;
      ctx.beginPath();
      if (c.bead) ctx.arc(c.x, c.y, c.size * 0.6, 0, Math.PI * 2);
      else {
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(c.rot);
        ctx.scale(1, Math.cos(c.age * 9 + c.rot)); // flipping over as it falls
        ctx.rect(-c.size, -c.size * 0.45, c.size * 2, c.size * 0.9);
        ctx.restore();
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Every string at its place, now. */
  land() { this.flyAt = null; this.stowed = false; }

  private spread() { return this.flyOut ? SPREAD_MS[this.flightStyle] : 450; }
  private flightMs() { return this.flyOut ? FLIGHT_MS[this.flightStyle] : 500; }

  /** Where string i of n is between the box (0) and its place (1). Out: middle strings first;
      in: outer strings first. */
  private flight(i: number, n: number) {
    if (this.flyAt === null) return this.stowed ? 0 : 1;
    const mid = (n - 1) / 2, edge = mid > 0 ? Math.abs(i - mid) / mid : 0;
    const rank = this.flyOut ? edge : 1 - edge;
    const g = Math.max(0, Math.min(1, (this.nowMs - this.flyAt - rank * this.spread()) / this.flightMs()));
    return this.flyOut ? g : 1 - g;
  }

  /** Check the flight each frame: swing strings as they land, and finish when all are done. */
  private stepFlight(p: Pattern) {
    if (this.flyAt === null) return;
    const n = p.threads.length;
    if (this.confettiDue && this.nowMs >= this.flyAt) { this.confettiDue = false; this.burst(p); }
    p.threads.forEach((th, i) => {
      if (this.flyOut && this.flight(i, n) >= 1 && !this.landed.has(th.id)) {
        this.landed.add(th.id);
        this.pluck(th.id, 6, 0.35, 5);
      }
    });
    if (this.nowMs - this.flyAt > this.spread() + this.flightMs() + 50) {
      this.stowed = !this.flyOut;
      this.flyAt = null;
    }
  }

  /** How big row tag ri is drawn while the tags pop in (0: not yet; a little over 1 on the way). */
  private tagPop(ri: number) {
    const g = Math.max(0, Math.min(1, (this.bloomT - 2300 - ri * 45) / 320));
    return g <= 0 ? 0 : 1 + 3.4 * Math.pow(g - 1, 3) + 2.4 * Math.pow(g - 1, 2);
  }

  /** Clip the picture to what has come out so far. Returns true once everything is out. */
  private bloomClip(p: Pattern, L: Layout, xs: number[]) {
    const { ctx } = this;
    const STRIP = 2500, STRIP_MS = 900; // the numbers count in
    const t = this.bloomT, n = xs.length;
    const edge = (i: number) => Math.round(i <= 0 ? LABEL_W - 8 : i < n ? xs[i] - L.pad : L.width);
    const stripY = L.numTop - 2;
    ctx.beginPath();
    ctx.rect(0, 0, edge(0), stripY); // the row tags bring themselves in (tagPop)
    // Groups and numbers: one more number at each step, as if counted.
    const counted = Math.floor(Math.max(0, Math.min(1, (t - STRIP) / STRIP_MS)) * n);
    if (t >= STRIP) ctx.rect(0, stripY, counted >= n ? L.width : edge(counted + 1), L.height - stripY);
    // Strings: each column shows once its string has landed (in flight, drawFlying draws it).
    p.threads.forEach((_, i) => { if (this.flight(i, n) >= 1) ctx.rect(edge(i), 0, edge(i + 1) - edge(i), stripY); });
    ctx.clip();
    return t > STRIP + STRIP_MS + 200 && this.flyAt === null;
  }

  /** The strings on their way between the box and their places, in the chosen style:
      fling    - flung out in an arc, top end leading, bent while flying, straight as it lands;
      fountain - shot up like a drop to the top of its place, then unrolled down like a rope;
      thread   - bursts out of the box with confetti: each string's length shoots out of the box,
                 up and over to the top of its place and down it, like a thread through the eye of
                 a needle; what is not out yet is still inside the box. */
  private drawFlying(p: Pattern, L: Layout, xs: number[], top: number, bottom: number, colourOf: (ti: number) => string) {
    if (this.flyAt === null) return;
    const o = this.flyFrom() ?? { x: L.width / 2, y: L.height / 2 };
    const { ctx } = this, n = xs.length;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const ease = (v: number) => 1 - Math.pow(1 - clamp(v), 3);
    const inOut = (v: number) => { v = clamp(v); return v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2; };
    ctx.lineWidth = L.colW >= 22 ? 2 : 1.5;
    ctx.lineCap = 'round';
    p.threads.forEach((_, i) => {
      const g = this.flight(i, n);
      if (g <= 0 || g >= 1) return;
      const X = xs[i];
      ctx.globalAlpha = Math.min(1, g * 6) * 0.85;
      ctx.strokeStyle = colourOf(i);
      ctx.beginPath();
      if (this.flightStyle === 'fountain') {
        const q = g / 0.55, hop = Math.min(220, L.height * 0.35);
        const at = (v: number) => {
          v = clamp(v);
          return { x: o.x + (X - o.x) * v, y: o.y + (top - o.y) * v - hop * 4 * v * (1 - v) };
        };
        if (q < 1) { // a drop on its arc, with a short tail
          const h = at(q), t = at(q - 0.12);
          ctx.moveTo(t.x, Math.max(top, t.y));
          ctx.lineTo(h.x, Math.max(top, h.y));
        } else { // unrolling down from the top, its loose end swaying
          const d = ease((g - 0.55) / 0.45), end = top + (bottom - top) * d, sway = 14 * (1 - d) * Math.sin(g * 30);
          ctx.moveTo(X, top);
          ctx.quadraticCurveTo(X, (top + end) / 2, X + sway, end);
        }
      } else if (this.flightStyle === 'thread') {
        // The way: out of the box, up and over to the top of its place, then down it. Out, it
        // shoots (fast, then slowing as it lands); back in, it is drawn in smoothly.
        const way = this.threadWay(o, X, top, bottom), total = way.len[way.len.length - 1], len = bottom - top;
        const head = (this.flyOut ? ease(g) : inOut(g)) * total;
        this.tracePart(way, Math.max(0, head - len), head);
      } else { // fling
        const a = ease(g * 1.15), b = ease(g * 1.15 - 0.15); // the top leads, the bottom trails
        const lift = Math.min(160, L.height * 0.25) * Math.sin(Math.PI * a); // up out of the box, then down onto its place
        const tx = o.x + (X - o.x) * a, ty = Math.max(top, o.y + (top - o.y) * a - lift); // never above the grid's top
        const bx = o.x + (X - o.x) * b, by = o.y + (bottom - o.y) * b;
        const side = X < o.x ? -1 : 1, bend = 60 * (1 - g) * side; // whips outward while it flies
        ctx.moveTo(tx, ty);
        ctx.quadraticCurveTo((tx + bx) / 2 + bend, (ty + by) / 2, bx, by);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  /** The way a thread takes out of the box (o) to its place: up and over in a curve to the
      top of its place, then straight down it. As points with their distance along the way. */
  private threadWay(o: { x: number; y: number }, X: number, top: number, bottom: number) {
    const pts: { x: number; y: number }[] = [], len: number[] = [];
    const c1 = { x: o.x, y: o.y - 0.7 * (o.y - top) }, c2 = { x: X, y: top - 0.15 * Math.max(0, o.y - top) };
    const N = 40;
    for (let k = 0; k <= N; k++) {
      const t = k / N, u = 1 - t;
      pts.push({ x: u * u * u * o.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * X,
        y: Math.max(top, u * u * u * o.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * top) });
    }
    pts.push({ x: X, y: bottom });
    pts.forEach((q, k) => len.push(k ? len[k - 1] + Math.hypot(q.x - pts[k - 1].x, q.y - pts[k - 1].y) : 0));
    return { pts, len };
  }

  /** Add the part of a way between distances from and to to the current path. */
  private tracePart(way: { pts: { x: number; y: number }[]; len: number[] }, from: number, to: number) {
    const { pts, len } = way, ctx = this.ctx;
    const at = (d: number) => {
      let k = 1;
      while (k < len.length - 1 && len[k] < d) k++;
      const f = len[k] === len[k - 1] ? 0 : (d - len[k - 1]) / (len[k] - len[k - 1]);
      return { x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f, k };
    };
    if (to <= from) return;
    const a = at(from), b = at(to);
    ctx.moveTo(a.x, a.y);
    for (let k = a.k; k < b.k; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.lineTo(b.x, b.y);
  }

  /** Forget every string's place and swing: a different fabric is about to be drawn. */
  reset() {
    this.xNow.clear();
    this.alpha.clear();
    this.wobble.clear();
    this.fibreSwing.clear();
  }

  /** Set a string swinging. amp in px; tau = decay time; heavier beads swing further and slower. */
  pluck(threadId: number, amp: number, tau: number, freq: number) {
    if (reducedMotion()) return;
    this.wobble.set(String(threadId), { amp, t0: performance.now() / 1000, freq, tau });
  }

  /** The same for one fibre: the fine string of one row, at one of a thread's fibres. */
  pluckFibre(threadId: number, row: string, slot: number, amp: number, tau: number, freq: number) {
    if (reducedMotion()) return;
    this.wobble.set(`${threadId}:${row}:${slot}`, { amp, t0: performance.now() / 1000, freq, tau });
    this.fibreSwing.add(threadId);
  }
  private fibreSwing = new Set<number>(); // threads that may have a fibre swinging

  private displacement(key: string, u: number, now: number): number {
    const w = this.wobble.get(key);
    if (!w) return 0;
    const t = now - w.t0;
    const env = Math.exp(-t / w.tau);
    if (env < 0.01) {
      this.wobble.delete(key);
      return 0;
    }
    return w.amp * env * Math.sin(2 * Math.PI * w.freq * t) * Math.sin(Math.PI * u);
  }

  draw(p: Pattern, L: Layout, s: ViewState) {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(L.width * dpr) || canvas.height !== Math.round(L.height * dpr)) {
      canvas.width = Math.round(L.width * dpr);
      canvas.height = Math.round(L.height * dpr);
      canvas.style.width = `${L.width}px`;
      canvas.style.height = `${L.height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nowMs = performance.now();
    this.nowMs = nowMs;
    this.stepFlight(p);
    const dt = Math.min(0.1, (nowMs - this.last) / 1000);
    this.last = nowMs;
    const now = nowMs / 1000;
    const still = this.frozen || reducedMotion();

    // Springy positions: strings slide to their places when cells are added, removed or moved.
    const k = still || L.u > 0 ? 1 : 1 - Math.exp(-dt * 16); // the dive moves strings itself
    const xs = p.threads.map((t, i) => {
      const target = L.xs[i];
      let x = this.xNow.get(t.id);
      if (x === undefined) {
        x = i > 0 ? this.xNow.get(p.threads[i - 1].id) ?? target : target;
        this.alpha.set(t.id, still ? 1 : 0);
      }
      x += (target - x) * k;
      this.xNow.set(t.id, x);
      this.alpha.set(t.id, Math.min(1, (this.alpha.get(t.id) ?? 1) + dt * 5));
      return x;
    });
    const live = new Set(p.threads.map((t) => t.id));
    for (const id of [...this.xNow.keys()]) if (!live.has(id)) { this.xNow.delete(id); this.alpha.delete(id); }

    ctx.fillStyle = UI.bg;
    ctx.fillRect(0, 0, L.width, L.height);
    const blooming = this.bloomAt !== null && !still;
    if (!blooming) this.bloomAt = null;
    else {
      if (this.bloomAt! < 0) this.bloomAt = nowMs;
      this.bloomT = nowMs - this.bloomAt!;
      ctx.save();
      if (this.bloomClip(p, L, xs)) this.bloomAt = null;
    }

    const colourOf = (ti: number) => PALETTE[p.groups[p.threads[ti].group].colour].hex;

    // Group tint behind each group, a little stronger when selected.
    L.runs.forEach((r, i) => {
      const x0 = xs[r.start] - L.pad, x1 = xs[r.end - 1] + L.colW - L.pad;
      const sel = s.groupSel && i >= s.groupSel[0] && i <= s.groupSel[1];
      ctx.globalAlpha = sel ? 0.13 : 0.045;
      ctx.fillStyle = PALETTE[r.colour].hex;
      ctx.fillRect(x0, L.top - 6, x1 - x0, L.bottom - L.top + 12);
      ctx.globalAlpha = 1;
    });

    // Everything in the matrix stays between the row tags and the number strip (it can reach
    // past them when the view is inside a region).
    const reg = L.region, u = L.u;
    const inReg = (ti: number, ri: number) => !!reg && ti >= reg.t0 && ti <= reg.t1 && ri >= reg.r0 && ri <= reg.r1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(u > 0 ? LABEL_W - 8 : 0, 0, L.width, u > 0 ? L.numTop - 2 : L.height);
    ctx.clip();

    // Row guides.
    ROWS.forEach((_, ri) => {
      const y = rowY(L, ri);
      ctx.strokeStyle = 'rgba(128,128,128,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.max(LABEL_W - 6, xs[0] - L.pad - 6), Math.round(y) + 0.5);
      ctx.lineTo(xs[xs.length - 1] + L.colW - L.pad, Math.round(y) + 0.5);
      ctx.stroke();
    });

    // Playhead glow.
    const playIdx = s.playheadId === null ? -1 : p.threads.findIndex((t) => t.id === s.playheadId);
    if (playIdx >= 0) {
      ctx.fillStyle = colourOf(playIdx);
      ctx.globalAlpha = 0.12;
      ctx.fillRect(xs[playIdx] - L.pad + 1, L.top - 6, L.colW - 2, L.bottom - L.top + 12);
      ctx.globalAlpha = 1;
    }

    // Strings and beads.
    const span = L.bottom - L.top + 16;
    const y0 = L.top - 8;
    const rMax = Math.max(3, Math.min(15 + 9 * u, Math.min(L.colW, L.rowH) * 0.42));
    // After a Random press, the user's own notes (which Random kept) glow and fade out.
    const glow = Math.max(0, 1 - (nowMs - s.glow) / 900);
    p.threads.forEach((t, ti) => {
      if (this.flight(ti, p.threads.length) < 1) return; // in the box, or on its way (drawFlying)
      const colour = colourOf(ti);
      const a = this.alpha.get(t.id) ?? 1;
      const hold = s.hold && s.hold.threadId === t.id && s.hold.slot === 0 ? s.hold : null;
      const swinging = this.fibreSwing.has(t.id);
      const holdU = hold ? (rowY(L, hold.ri) - y0) / span : 0;
      const off = (y: number) => {
        const u = (y - y0) / span;
        if (hold) return hold.dx * (u < holdU ? u / holdU : (1 - u) / (1 - holdU));
        return this.displacement(String(t.id), u, now);
      };
      ctx.globalAlpha = a * (ti === playIdx ? 1 : 0.85);
      ctx.strokeStyle = colour;
      ctx.lineWidth = (L.colW >= 22 ? 2 : 1.5) + (reg && ti >= reg.t0 && ti <= reg.t1 ? u : 0);
      ctx.beginPath();
      const steps = 24;
      for (let k2 = 0; k2 <= steps; k2++) {
        const y = y0 + (span * k2) / steps;
        const x = xs[ti] + off(y);
        if (k2 === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ROWS.forEach((row, ri) => {
        const y = rowY(L, ri);
        const lane = t.lanes[row];
        const z = lane?.zoom ?? 1;
        const gr = s.glowRect;
        const inGlow = !gr || (ti >= gr.t0 && ti <= gr.t1 && ri >= gr.r0 && ri <= gr.r1);
        // A zoomed cell: its fibres are short, fine strings after the main one, each at its
        // true moment, carrying seed beads (smaller, so twelve fit in a column).
        // Among the threads a bead's size is its loudness, zoomed or not. Inside a region the
        // beads shrink to fit between the fibres.
        const zc = colour; // a zoomed cell keeps its own group's colour
        const fit = Math.max(1.8, Math.min(rMax * 0.62, (L.colW / z) * 0.42));
        const seedR = z > 1 ? rMax + (fit - rMax) * (inReg(ti, ri) ? u : 0) : rMax;
        // A fibre is one fine string running through every neighbouring row with the same
        // zoom. Pulled by a pluck, or swinging after one of its notes played, it moves as a
        // whole, like the main strings. fOff: how far fibre k is pushed sideways at height yy.
        const h = L.rowH * (0.3 + 0.2 * (inReg(ti, ri) ? u : 0));
        const reach = (L.colW / z) * 0.45;
        let ra = ri, rb = ri;
        if (z > 1 && (swinging || s.hold)) {
          while (ra > 0 && (t.lanes[ROWS[ra - 1]]?.zoom ?? 1) === z) ra--;
          while (rb < ROWS.length - 1 && (t.lanes[ROWS[rb + 1]]?.zoom ?? 1) === z) rb++;
        }
        const ya = L.top + ra * L.rowH, yb = L.top + (rb + 1) * L.rowH;
        const pulled = s.hold && s.hold.threadId === t.id && s.hold.slot > 0 && s.hold.ri >= ra && s.hold.ri <= rb ? s.hold : null;
        const fOff = (k: number, yy: number) => {
          const uu = (yy - ya) / (yb - ya);
          let d = 0;
          if (pulled && pulled.slot === k) {
            const hu = (rowY(L, pulled.ri) - ya) / (yb - ya);
            d = pulled.dx * (uu < hu ? uu / hu : (1 - uu) / (1 - hu));
          } else if (swinging) {
            for (let r = ra; r <= rb; r++) d += this.displacement(`${t.id}:${ROWS[r]}:${k}`, uu, now);
          }
          return Math.max(-reach, Math.min(reach, d));
        };
        if (z > 1) {
          // A zoomed cell is a place to go into: a soft patch of its colour marks it. Inside,
          // its fibres stand as full strings.
          const inside = inReg(ti, ri) ? u : 0;
          const nextPlain = (p.threads[ti + 1]?.lanes[row]?.zoom ?? 1) === 1;
          ctx.globalAlpha = a * 0.1;
          ctx.fillStyle = zc;
          ctx.fillRect(xs[ti] - L.pad, y - L.rowH / 2 + 1.5, L.colW + (nextPlain ? Math.max(0, L.pad - 3) : 0), L.rowH - 3);
          ctx.globalAlpha = a * (0.38 + 0.22 * inside);
          ctx.strokeStyle = zc;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let k = 1; k < z; k++) {
            const fx = fibreX(L, xs[ti], k, z);
            if (!pulled && !swinging) {
              ctx.moveTo(Math.round(fx) + 0.5, y - h);
              ctx.lineTo(Math.round(fx) + 0.5, y + h);
            } else {
              for (let j = 0; j <= 10; j++) {
                const py = y - h + (2 * h * j) / 10, px = fx + fOff(k, py);
                if (j === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
              }
            }
          }
          ctx.stroke();
        }
        for (let k = 0; k < z; k++) {
          const hit = lane?.slots[k];
          const x = k === 0 ? xs[ti] + off(y) : fibreX(L, xs[ti], k, z) + fOff(k, y);
          ctx.fillStyle = k === 0 ? colour : zc;
          if (hit) {
            ctx.globalAlpha = a;
            ctx.beginPath();
            const r = seedR * (0.42 + 0.58 * hit.v);
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
            if (z > 1 && r * 2 > L.colW / z) {
              // Beads closer together than they are wide: a dark rim keeps each one readable.
              ctx.strokeStyle = UI.bg;
              ctx.lineWidth = 1;
              ctx.stroke();
            }
            if (hit.mine && glow > 0 && inGlow) {
              ctx.globalAlpha = a * glow;
              ctx.strokeStyle = UI.text;
              ctx.lineWidth = z > 1 ? 1.5 : 2;
              ctx.beginPath();
              ctx.arc(x, y, r + 3 + 4 * (1 - glow), 0, Math.PI * 2);
              ctx.stroke();
            }
          } else if (k === 0) {
            ctx.globalAlpha = a * 0.4;
            ctx.beginPath();
            ctx.arc(x, y, 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });
      ctx.globalAlpha = 1;
    });

    if (![...this.wobble.keys()].some((k) => k.includes(':'))) this.fibreSwing.clear();

    // Thread level: the zoomed region under the pointer lights up (a press goes inside).
    if (s.hoverRegion && !reg) {
      const b = regionBox(L, s.hoverRegion);
      ctx.strokeStyle = UI.text;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      roundRect(ctx, b.x0 + 0.5, b.y0 + 1.5, b.x1 - b.x0 - 1, b.y1 - b.y0 - 3, 5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Hover ring on the cell under the pointer (Draw tool).
    if (s.hover.kind === 'cell' && !s.hold && !s.hoverRegion) {
      const hz = p.threads[s.hover.ti]?.lanes[ROWS[s.hover.ri]]?.zoom ?? 1;
      const x = fibreX(L, xs[s.hover.ti], s.hover.slot, hz), y = rowY(L, s.hover.ri);
      ctx.strokeStyle = UI.text;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, hz > 1 ? Math.max(3.5, Math.min(rMax * 0.62, (L.colW / hz) * 0.42) + 2) : rMax + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Matrix selection rectangle.
    if (s.rect) {
      const r = s.rect;
      const x0 = xs[r.t0] - L.pad, x1 = xs[r.t1] + L.colW - L.pad;
      const ya = L.top + r.r0 * L.rowH, yb = L.top + (r.r1 + 1) * L.rowH;
      ctx.fillStyle = 'rgba(191,191,191,0.06)';
      ctx.fillRect(x0, ya, x1 - x0, yb - ya);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = UI.bright;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, ya + 0.5, x1 - x0 - 1, yb - ya - 1);
      ctx.setLineDash([]);
    }

    // Inside a region: the threads around it fall into shadow, and a frame marks the region.
    if (reg) {
      const b = regionBox(L, reg);
      ctx.fillStyle = UI.bg;
      ctx.globalAlpha = 0.68 * u;
      ctx.fillRect(0, 0, L.width, b.y0);
      ctx.fillRect(0, b.y1, L.width, L.height - b.y1);
      ctx.fillRect(0, b.y0, b.x0, b.y1 - b.y0);
      ctx.fillRect(b.x1, b.y0, L.width - b.x1, b.y1 - b.y0);
      ctx.globalAlpha = 0.45 * u;
      ctx.strokeStyle = UI.text;
      ctx.lineWidth = 1;
      roundRect(ctx, b.x0 - 0.5, b.y0 - 0.5, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, 6);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // Row tags, in their own column on the left.
    if (u > 0) {
      ctx.fillStyle = UI.bg;
      ctx.fillRect(0, 0, LABEL_W - 8, L.numTop - 2);
    }
    ctx.font = `600 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ROWS.forEach((tag, ri) => {
      const y = rowY(L, ri);
      if (y > L.numTop - 10 && u > 0) return;
      const hot = ((s.hover.kind === 'cell' || s.hover.kind === 'label') && s.hover.ri === ri)
        || (!!s.rowSel && ri >= s.rowSel[0] && ri <= s.rowSel[1]);
      const away = reg && (ri < reg.r0 || ri > reg.r1) ? 1 - 0.7 * u : 1;
      const pop = blooming ? this.tagPop(ri) : 1;
      if (pop <= 0) return;
      ctx.save();
      ctx.translate(25, y);
      ctx.scale(pop, pop);
      ctx.translate(-25, -y);
      roundRect(ctx, 10, y - 8, 30, 16, 3);
      ctx.globalAlpha = (s.quiet?.[ri] ? 0.35 : 1) * away;
      ctx.fillStyle = hot ? UI.text : UI.tag;
      ctx.fill();
      ctx.fillStyle = hot ? UI.bg : UI.text;
      ctx.fillText(tag, 25, y + 0.5);
      ctx.globalAlpha = 1;
      ctx.restore();
    });

    if (u > 0) {
      ctx.fillStyle = UI.bg;
      ctx.fillRect(0, L.numTop - 2, L.width, L.height - L.numTop + 2);
    }
    this.drawStrip(p, L, s, xs);
    if (blooming) ctx.restore();
    this.drawFlying(p, L, xs, y0, y0 + span, colourOf);
    this.drawConfetti(dt);
  }

  private drawStrip(p: Pattern, L: Layout, s: ViewState, xs: number[]) {
    const { ctx } = this;
    const n = p.threads.length;
    const ny = L.numTop + L.numH / 2;
    const xa = gapX(L, 0), xb = gapX(L, n);
    ctx.fillStyle = UI.panel;
    const x0 = Math.min(xa - 12, FRONT_X - 14); // the strip reaches under the row tags, where the front "+" sits
    roundRect(ctx, x0, L.numTop - 2, Math.min(xb + 12, L.width - 4) - x0, L.bandTop + L.bandH + 6 - L.numTop, 8);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const h = s.hover;
    const pillW = Math.min(26, L.colW - 6), pillH = L.numH / 2 - 4;
    // Inside a region the fibres get their own count, 1 to the last fibre of the region, when
    // every row in it has the same number of fibres. Thread numbers fade away there.
    const reg = L.region;
    let fz = 0;
    if (reg) {
      fz = p.threads[reg.t0].lanes[ROWS[reg.r0]]?.zoom ?? 1;
      for (let ti = reg.t0; ti <= reg.t1; ti++) for (let ri = reg.r0; ri <= reg.r1; ri++) if ((p.threads[ti].lanes[ROWS[ri]]?.zoom ?? 1) !== fz) fz = 0;
    }
    if (reg && fz > 1) {
      const gap = L.colW / fz, every = gap >= 17 ? 1 : gap >= 9 ? 2 : gap >= 5 ? 4 : fz;
      ctx.globalAlpha = L.u;
      for (let ti = reg.t0; ti <= reg.t1; ti++) {
        for (let k = 0; k < fz; k += every) {
          ctx.font = `${k === 0 ? 600 : 400} 11px ${FONT}`;
          ctx.fillStyle = k === 0 ? UI.text : UI.dim;
          ctx.fillText(String((ti - reg.t0) * fz + k + 1), fibreX(L, xs[ti], k, fz), ny);
        }
      }
      ctx.globalAlpha = 1;
    }
    // After an end "+" was pressed: the cell whose number is under the pointer (if any) shows
    // the single "+" in place of its number.
    let endPill = -1;
    if (s.endAdds && s.endX !== undefined) {
      const near = xs.reduce((b, x, i) => (Math.abs(x - s.endX!) < Math.abs(xs[b] - s.endX!) ? i : b), 0);
      if (Math.abs(xs[near] - s.endX) < Math.min(22, L.colW / 2)) endPill = near;
    }
    for (let ti = 0; ti < n; ti++) {
      if (ti === endPill) continue;
      const x = xs[ti]; // a thread's number sits under its string
      if (reg) {
        const inside = ti >= reg.t0 && ti <= reg.t1;
        ctx.globalAlpha = inside ? (fz > 1 ? 1 - L.u : 1) : 1 - 0.65 * L.u;
        if (ctx.globalAlpha < 0.02) continue;
      }
      const hovered = (h.kind === 'add' || h.kind === 'del') && h.ti === ti;
      if (hovered) {
        // "+" above, "–" below, as two separate buttons.
        const top = h.kind === 'add';
        ctx.fillStyle = top ? UI.text : UI.warn;
        ctx.globalAlpha = 0.16;
        roundRect(ctx, x - pillW / 2, top ? L.numTop + 2 : L.numTop + L.numH / 2 + 2, pillW, pillH, 5);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.font = `600 14px ${FONT}`;
        ctx.fillStyle = top ? UI.text : UI.dim;
        if (!s.full) ctx.fillText('+', x, L.numTop + L.numH * 0.25);
        ctx.fillStyle = top ? UI.dim : UI.warn;
        ctx.fillText('–', x, L.numTop + L.numH * 0.75);
        continue;
      }
      const picked = s.stripSel === ti;
      if (picked) {
        ctx.fillStyle = UI.bright;
        roundRect(ctx, x - pillW / 2, ny - 11, pillW, 22, 6);
        ctx.fill();
      }
      if (ti % L.labelEvery !== 0 && !picked) continue; // narrow cells: every 2nd or 4th number, counting from 1
      const groupStart = L.runs.some((r) => r.start === ti);
      ctx.font = `${groupStart || picked ? 600 : 400} 11px ${FONT}`;
      ctx.fillStyle = picked ? UI.bg : groupStart ? UI.text : UI.dim;
      ctx.fillText(String(ti + 1), x, ny);
    }
    ctx.globalAlpha = 1;

    // New-group "+" at the start, under the row tags: always visible (while there is room for
    // another cell), brighter on hover. Few people add groups, so there is none at the end.
    for (const end of ['front'] as const) {
      if (L.u > 0 || s.full) break; // groups aren't changed from inside a region
      const x = FRONT_X;
      if (s.endAdds === end && s.endX !== undefined) {
        // Just pressed: under the pointer there is now a single "+" for more cells in the new
        // group, drawn like the "+" on a number (with no "–" beneath it). If a cell's number
        // is right there, the "+" stands in its place.
        const px = endPill >= 0 ? xs[endPill] : s.endX;
        ctx.fillStyle = UI.text;
        ctx.globalAlpha = 0.16;
        roundRect(ctx, px - pillW / 2, ny - pillH / 2, pillW, pillH, 5);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.font = `600 14px ${FONT}`;
        ctx.fillStyle = UI.text;
        ctx.fillText('+', px, ny + 0.5);
        tooltip(ctx, px - pillW / 2, L.numTop - 4, 'add a cell', 'left');
        if (Math.abs(x - s.endX) < 24) continue; // it stands where the group "+" was
      }
      const hot = h.kind === end && s.endAdds !== end;
      ctx.fillStyle = hot ? UI.play : UI.border;
      ctx.globalAlpha = hot ? 1 : 0.55;
      roundRect(ctx, x - 8, ny - 8, 16, 16, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = hot ? UI.text : UI.bg;
      ctx.font = `700 13px ${FONT}`;
      ctx.fillText('+', x, ny + 0.5);
      if (hot) tooltip(ctx, x - 8, L.numTop - 4, 'new group at start', 'left');
    }

    // Gap targets: ✂ split, ⋈ merge.
    if (h.kind === 'split' || h.kind === 'merge') {
      // The label sits halfway between the two numbers. A split is a straight cut there; a
      // merge's line steps across to where the two groups meet, just before the next string.
      const x = midX(L, h.g), edge = h.kind === 'split' ? x : gapX(L, h.g);
      ctx.strokeStyle = h.kind === 'split' ? UI.text : UI.play;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(x, L.numTop + 3);
      ctx.lineTo(x, L.numTop + L.numH - 9);
      ctx.lineTo(edge, L.bandTop - 2);
      ctx.lineTo(edge, L.bandTop + L.bandH + 2);
      ctx.stroke();
      ctx.fillStyle = UI.panel;
      ctx.fillRect(x - 8, ny - 8, 16, 16);
      ctx.fillStyle = h.kind === 'split' ? UI.text : UI.play;
      ctx.font = `600 13px ${FONT}`;
      ctx.fillText(h.kind === 'split' ? '✂' : '⋈', x, ny);
      tooltip(ctx, x + 10, L.numTop - 4, h.kind === 'split' ? 'split here' : 'merge');
    }

    // Group band.
    L.runs.forEach((r, i) => {
      const x0 = xs[r.start] - L.pad + 1.5, x1 = xs[r.end - 1] + L.colW - L.pad - 1.5;
      const sel = s.groupSel && i >= s.groupSel[0] && i <= s.groupSel[1];
      const hot = h.kind === 'band' && h.run === i;
      ctx.fillStyle = PALETTE[r.colour].hex;
      ctx.globalAlpha = sel || hot ? 1 : 0.8;
      roundRect(ctx, x0, L.bandTop, x1 - x0, L.bandH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.strokeStyle = UI.bright;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x0 - 2, L.bandTop - 2, x1 - x0 + 4, L.bandH + 4, 4);
        ctx.stroke();
      }
    });

    // Where dragged groups would land.
    if (s.drop) {
      const rest = L.runs.filter((_, i) => i < s.drop!.a || i > s.drop!.b);
      const x = s.drop.idx < rest.length ? cellL(L, rest[s.drop.idx].start) : cellR(L, n - 1);
      ctx.strokeStyle = UI.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, L.top - 6);
      ctx.lineTo(x, L.bandTop + L.bandH + 4);
      ctx.stroke();
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), r);
}

function tooltip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, align: CanvasTextAlign = 'left') {
  ctx.save();
  ctx.font = `500 10px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = UI.secondary;
  ctx.fillText(text, x, y);
  ctx.restore();
}
