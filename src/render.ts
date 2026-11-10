// Drawing (§11): each thread is a vertical string in its group's colour, hits are beads whose
// size is their velocity, and strings wobble when the playhead plucks them.

import { LABEL_W, cellL, cellR, fibreX, gapX, regionBox, rowY, type Layout, type Target } from './layout';
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
}

interface Wobble { amp: number; t0: number; freq: number; tau: number }

const FONT = '"Space Grotesk", system-ui, sans-serif';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private xNow = new Map<number, number>(); // animated x per thread id
  private alpha = new Map<number, number>(); // fade-in for new strings
  private wobble = new Map<string, Wobble>(); // by thread id, or "thread:row:slot" for a fibre
  private last = performance.now();

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
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
    const dt = Math.min(0.1, (nowMs - this.last) / 1000);
    this.last = nowMs;
    const now = nowMs / 1000;
    const still = reducedMotion();

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
      ctx.strokeStyle = 'rgba(105,117,127,0.13)';
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
          ctx.globalAlpha = a * 0.1;
          ctx.fillStyle = colour;
          ctx.fillRect(xs[ti] - L.pad, y - L.rowH / 2 + 1.5, L.colW, L.rowH - 3);
          ctx.globalAlpha = a * (0.38 + 0.22 * inside);
          ctx.strokeStyle = colour;
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
          ctx.fillStyle = colour;
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
      ctx.fillStyle = 'rgba(255,250,216,0.06)';
      ctx.fillRect(x0, ya, x1 - x0, yb - ya);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = UI.text;
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
      roundRect(ctx, 10, y - 8, 30, 16, 3);
      ctx.globalAlpha = (s.quiet?.[ri] ? 0.35 : 1) * away;
      ctx.fillStyle = hot ? UI.text : UI.tag;
      ctx.fill();
      ctx.fillStyle = UI.bg;
      ctx.fillText(tag, 25, y + 0.5);
      ctx.globalAlpha = 1;
    });

    if (u > 0) {
      ctx.fillStyle = UI.bg;
      ctx.fillRect(0, L.numTop - 2, L.width, L.height - L.numTop + 2);
    }
    this.drawStrip(p, L, s, xs);
  }

  private drawStrip(p: Pattern, L: Layout, s: ViewState, xs: number[]) {
    const { ctx } = this;
    const n = p.threads.length;
    const ny = L.numTop + L.numH / 2;
    const xa = gapX(L, 0), xb = gapX(L, n);
    ctx.fillStyle = UI.panel;
    roundRect(ctx, xa - 22, L.numTop - 2, xb - xa + 44, L.bandTop + L.bandH + 6 - L.numTop, 8);
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
    for (let ti = 0; ti < n; ti++) {
      const x = xs[ti];
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
        ctx.fillText('+', x, L.numTop + L.numH * 0.25);
        ctx.fillStyle = top ? UI.dim : UI.warn;
        ctx.fillText('–', x, L.numTop + L.numH * 0.75);
        continue;
      }
      const picked = s.stripSel === ti;
      if (picked) {
        ctx.fillStyle = UI.text;
        roundRect(ctx, x - pillW / 2, ny - 11, pillW, 22, 6);
        ctx.fill();
      }
      if ((ti + 1) % L.labelEvery !== 0 && ti !== 0 && !picked) continue;
      const groupStart = L.runs.some((r) => r.start === ti);
      ctx.font = `${groupStart || picked ? 600 : 400} 11px ${FONT}`;
      ctx.fillStyle = picked ? UI.bg : groupStart ? UI.text : UI.dim;
      ctx.fillText(String(ti + 1), x, ny);
    }
    ctx.globalAlpha = 1;

    // New-group "+" at both ends: always visible, brighter on hover.
    for (const end of ['front', 'back'] as const) {
      if (L.u > 0) break; // groups aren't changed from inside a region
      const hot = h.kind === end;
      const x = end === 'front' ? xa - 10 : xb + 10;
      ctx.fillStyle = hot ? UI.play : UI.border;
      ctx.globalAlpha = hot ? 1 : 0.55;
      roundRect(ctx, x - 8, ny - 8, 16, 16, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = UI.bg;
      ctx.font = `700 13px ${FONT}`;
      ctx.fillText('+', x, ny + 0.5);
      if (hot) tooltip(ctx, end === 'front' ? x - 8 : x + 8, L.numTop - 4, end === 'front' ? 'new group at start' : 'new group at end', end === 'front' ? 'left' : 'right');
    }

    // Gap targets: ✂ split, ⋈ merge.
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
      const x0 = xs[r.start] - L.pad + 1.5, x1 = xs[r.end - 1] + L.colW - L.pad - 1.5;
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
