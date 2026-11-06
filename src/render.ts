// Drawing (§11): each thread is a vertical string in its group's colour, hits are beads whose
// size is their velocity, and strings wobble when the playhead plucks them.

import { LABEL_W, gapX, rowY, type Layout, type Target } from './layout';
import { PALETTE, ROWS, UI } from './constants';
import type { Pattern, Rect } from './model';

export interface ViewState {
  tool: 'draw' | 'select';
  hover: Target;
  rect: Rect | null;
  groupSel: [number, number] | null;
  drop: { a: number; b: number; idx: number } | null;
  playheadId: number | null;
  hold: { threadId: number; ri: number; dx: number } | null;
}

interface Wobble { amp: number; t0: number; freq: number; tau: number }

const FONT = '"Space Grotesk", system-ui, sans-serif';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private xNow = new Map<number, number>(); // animated x per thread id
  private alpha = new Map<number, number>(); // fade-in for new strings
  private wobble = new Map<number, Wobble>();
  private last = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  /** Set a string swinging. amp in px; tau = decay time; heavier beads swing further and slower. */
  pluck(threadId: number, amp: number, tau: number, freq: number) {
    if (reducedMotion()) return;
    this.wobble.set(threadId, { amp, t0: performance.now() / 1000, freq, tau });
  }

  private displacement(threadId: number, u: number, now: number): number {
    const w = this.wobble.get(threadId);
    if (!w) return 0;
    const t = now - w.t0;
    const env = Math.exp(-t / w.tau);
    if (env < 0.01) {
      this.wobble.delete(threadId);
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
    const dt = Math.min(0.1, (nowMs - this.last) / 1000);
    this.last = nowMs;
    const now = nowMs / 1000;
    const still = reducedMotion();

    // Springy positions: strings slide to their places when cells are added, removed or moved.
    const k = still ? 1 : 1 - Math.exp(-dt * 16);
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

    const colourOf = (ti: number) => PALETTE[p.groups[p.threads[ti].group].colour].hex;

    // Group tint behind each group, a little stronger when selected.
    L.runs.forEach((r, i) => {
      const x0 = xs[r.start] - L.colW / 2, x1 = xs[r.end - 1] + L.colW / 2;
      const sel = s.groupSel && i >= s.groupSel[0] && i <= s.groupSel[1];
      ctx.globalAlpha = sel ? 0.13 : 0.045;
      ctx.fillStyle = PALETTE[r.colour].hex;
      ctx.fillRect(x0, L.top - 6, x1 - x0, L.bottom - L.top + 12);
      ctx.globalAlpha = 1;
    });

    // Row guides and label tags.
    ctx.font = `600 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ROWS.forEach((tag, ri) => {
      const y = rowY(L, ri);
      ctx.strokeStyle = 'rgba(105,117,127,0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LABEL_W - 6, Math.round(y) + 0.5);
      ctx.lineTo(xs[xs.length - 1] + L.colW / 2, Math.round(y) + 0.5);
      ctx.stroke();
      const hot = s.hover.kind === 'cell' && s.hover.ri === ri;
      roundRect(ctx, 10, y - 8, 30, 16, 3);
      ctx.fillStyle = hot ? UI.text : UI.tag;
      ctx.fill();
      ctx.fillStyle = UI.bg;
      ctx.fillText(tag, 25, y + 0.5);
    });

    // Playhead glow.
    const playIdx = s.playheadId === null ? -1 : p.threads.findIndex((t) => t.id === s.playheadId);
    if (playIdx >= 0) {
      ctx.fillStyle = colourOf(playIdx);
      ctx.globalAlpha = 0.12;
      ctx.fillRect(xs[playIdx] - L.colW / 2 + 1, L.top - 6, L.colW - 2, L.bottom - L.top + 12);
      ctx.globalAlpha = 1;
    }

    // Strings and beads.
    const span = L.bottom - L.top + 16;
    const y0 = L.top - 8;
    const rMax = Math.max(3, Math.min(L.colW, L.rowH) * 0.42);
    p.threads.forEach((t, ti) => {
      const colour = colourOf(ti);
      const a = this.alpha.get(t.id) ?? 1;
      const hold = s.hold && s.hold.threadId === t.id ? s.hold : null;
      const holdU = hold ? (rowY(L, hold.ri) - y0) / span : 0;
      const off = (y: number) => {
        const u = (y - y0) / span;
        if (hold) return hold.dx * (u < holdU ? u / holdU : (1 - u) / (1 - holdU));
        return this.displacement(t.id, u, now);
      };
      ctx.globalAlpha = a * (ti === playIdx ? 1 : 0.85);
      ctx.strokeStyle = colour;
      ctx.lineWidth = L.colW >= 22 ? 2 : 1.5;
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
        const x = xs[ti] + off(y);
        const hit = t.lanes[row]?.slots[0];
        ctx.fillStyle = colour;
        if (hit) {
          ctx.globalAlpha = a;
          ctx.beginPath();
          ctx.arc(x, y, rMax * (0.42 + 0.58 * hit.v), 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalAlpha = a * 0.4;
          ctx.beginPath();
          ctx.arc(x, y, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
    });

    // Hover ring on the cell under the pointer (Draw tool).
    if (s.hover.kind === 'cell' && !s.hold) {
      const x = xs[s.hover.ti], y = rowY(L, s.hover.ri);
      ctx.strokeStyle = UI.text;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, rMax + 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Matrix selection rectangle.
    if (s.rect) {
      const r = s.rect;
      const x0 = xs[r.t0] - L.colW / 2, x1 = xs[r.t1] + L.colW / 2;
      const ya = L.top + r.r0 * L.rowH, yb = L.top + (r.r1 + 1) * L.rowH;
      ctx.fillStyle = 'rgba(255,250,216,0.06)';
      ctx.fillRect(x0, ya, x1 - x0, yb - ya);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = UI.text;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, ya + 0.5, x1 - x0 - 1, yb - ya - 1);
      ctx.setLineDash([]);
    }

    this.drawStrip(p, L, s, xs);
  }

  private drawStrip(p: Pattern, L: Layout, s: ViewState, xs: number[]) {
    const { ctx } = this;
    const n = p.threads.length;
    const ny = L.numTop + L.numH / 2;
    ctx.fillStyle = UI.panel;
    roundRect(ctx, LABEL_W - 14, L.numTop - 2, xs[n - 1] + L.colW / 2 - LABEL_W + 22, L.bandTop + L.bandH + 6 - L.numTop, 8);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const h = s.hover;
    for (let ti = 0; ti < n; ti++) {
      const x = xs[ti];
      const hovered = (h.kind === 'add' || h.kind === 'del') && h.ti === ti;
      if (hovered) {
        // "+" above, "–" below: one target, one meaning.
        const top = h.kind === 'add', bot = h.kind === 'del';
        ctx.font = `600 14px ${FONT}`;
        ctx.fillStyle = top ? UI.text : UI.dim;
        ctx.fillText('+', x, L.numTop + L.numH * 0.27);
        ctx.fillStyle = bot ? UI.warn : UI.dim;
        ctx.fillText('–', x, L.numTop + L.numH * 0.75);
        continue;
      }
      if ((ti + 1) % L.labelEvery !== 0 && ti !== 0) continue;
      const groupStart = L.runs.some((r) => r.start === ti);
      ctx.font = `${groupStart ? 600 : 400} 11px ${FONT}`;
      ctx.fillStyle = groupStart ? UI.secondary : UI.dim;
      ctx.fillText(String(ti + 1), x, ny);
    }

    // Gap targets: front "+", ✂ split, ⋈ merge.
    if (h.kind === 'front') {
      const x = gapX(L, 0) - 6;
      ctx.fillStyle = UI.play;
      roundRect(ctx, x - 9, ny - 9, 18, 18, 9);
      ctx.fill();
      ctx.fillStyle = UI.bg;
      ctx.font = `700 14px ${FONT}`;
      ctx.fillText('+', x, ny + 0.5);
      tooltip(ctx, x + 14, L.numTop - 4, 'new group');
    }
    if (h.kind === 'split' || h.kind === 'merge') {
      const x = gapX(L, h.g);
      ctx.strokeStyle = h.kind === 'split' ? UI.text : UI.play;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, L.numTop + 3);
      ctx.lineTo(x, L.bandTop + L.bandH + 2);
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
      const x0 = xs[r.start] - L.colW / 2 + 1.5, x1 = xs[r.end - 1] + L.colW / 2 - 1.5;
      const sel = s.groupSel && i >= s.groupSel[0] && i <= s.groupSel[1];
      const hot = h.kind === 'band' && h.run === i;
      ctx.fillStyle = PALETTE[r.colour].hex;
      ctx.globalAlpha = sel || hot ? 1 : 0.8;
      roundRect(ctx, x0, L.bandTop, x1 - x0, L.bandH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (sel) {
        ctx.strokeStyle = UI.text;
        ctx.lineWidth = 1.5;
        roundRect(ctx, x0 - 2, L.bandTop - 2, x1 - x0 + 4, L.bandH + 4, 4);
        ctx.stroke();
      }
    });

    if (h.kind === 'band' && s.tool === 'draw') {
      const r = L.runs[h.run];
      if (r) tooltip(ctx, xs[r.start] - L.colW / 2, L.bandTop + L.bandH + 14, 'click: nudge colour');
    }

    // Where dragged groups would land.
    if (s.drop) {
      const rest = L.runs.filter((_, i) => i < s.drop!.a || i > s.drop!.b);
      const x = s.drop.idx < rest.length ? xs[rest[s.drop.idx].start] - L.colW / 2 : xs[n - 1] + L.colW / 2;
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

function tooltip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.font = `500 10px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = UI.secondary;
  ctx.fillText(text, x, y);
  ctx.restore();
}
