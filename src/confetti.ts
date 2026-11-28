// Confetti: the surprise when the gift box opens. It is drawn on its own canvas over everything
// (the machine, the welcome card and the box), shot up out of the box's open top, fluttering
// down and fading. Some pieces are beads like those on the strings, the rest flecks of paper
// that flip over as they fall. None under the reduced-motion preference.

type Piece = { x: number; y: number; vx: number; vy: number; rot: number; spin: number; size: number; bead: boolean; colour: string; delay: number; life: number; age: number };

let canvas: HTMLCanvasElement | null = null;
let pieces: Piece[] = [];
let last = 0;
let running = false;

/** Burst out of (x, y), in the window's px, in these colours. */
export function burst(x: number, y: number, colours: string[]) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !colours.length) return;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'confetti';
    document.body.append(canvas);
  }
  const power = Math.max(0.6, Math.min(1.3, innerHeight / 800));
  for (let k = 0; k < 120; k++) {
    const ang = (Math.random() - 0.5) * 2.2, speed = (480 + Math.random() * 760) * power; // a cone, mostly upward
    pieces.push({
      x: x + (Math.random() - 0.5) * 30, y, vx: Math.sin(ang) * speed, vy: -Math.cos(ang) * speed,
      rot: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 18, size: 3 + Math.random() * 4,
      bead: Math.random() < 0.35, colour: colours[k % colours.length], delay: Math.random() * 0.12, life: 2 + Math.random() * 1.4, age: 0,
    });
  }
  if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
}

function frame(now: number) {
  const cv = canvas!, ctx = cv.getContext('2d')!;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(innerWidth * dpr) || cv.height !== Math.round(innerHeight * dpr)) {
    cv.width = Math.round(innerWidth * dpr);
    cv.height = Math.round(innerHeight * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  pieces = pieces.filter((c) => c.age < c.delay + c.life);
  for (const c of pieces) {
    c.age += dt;
    if (c.age < c.delay) continue;
    // Thrown up, slowed by the air; flecks of paper drift down slowly, beads fall faster.
    c.vy += 1500 * dt;
    const drag = Math.exp(-(c.bead ? 1.2 : 2.6) * dt);
    c.vx *= drag;
    c.vy = Math.min(c.vy * drag, c.bead ? 520 : 160);
    c.x += (c.vx + (c.bead ? 0 : 30 * Math.sin(c.age * 7 + c.rot))) * dt;
    c.y += c.vy * dt;
    c.rot += c.spin * dt;
    ctx.globalAlpha = Math.min(1, (c.delay + c.life - c.age) / 0.6) * 0.95;
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
  if (pieces.length) requestAnimationFrame(frame);
  else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}
