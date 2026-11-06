import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import './style.css';

import { BPM_MAX, BPM_MIN, DEFAULT_VELOCITY, ROWS, threadSeconds, type RowTag } from './constants';
import { Engine, type RowMix } from './audio';
import { History } from './history';
import { LABEL_W, computeLayout, dropIndex, hitTest, inNumberLane, touchStripTarget, type Layout, type Target } from './layout';
import {
  clearRect, copyRect, deleteCell, deleteGroups, duplicateGroups, fresh, getHit, insertAfter, insertFront,
  insertBack, isBoundary, merge, mergeGroups, moveGroups, parse, pasteClip, recolour, runs, setBpm, setHit, split, type Clip, type Pattern, type Rect,
} from './model';
import { STYLES, randomFillStyled } from './random';
import { Renderer, type ViewState } from './render';
import { Scheduler } from './scheduler';

const STORE_KEY = 'orimono.pattern.v1';
const OLD_STORE_KEY = 'rubber-grid.pattern.v1'; // name before 6 Nov 2026
const HOLD_MS = 400; // long press → pluck
const MOVE_TOLERANCE = 8; // px of movement allowed before a press becomes a swipe

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('grid');
const stage = $<HTMLElement>('stage');
const actions = $<HTMLDivElement>('actions');

// ---------------------------------------------------------------- state

function loadSaved(): Pattern {
  try {
    const raw = localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY);
    if (raw) return parse(JSON.parse(raw)) ?? fresh();
  } catch {
    /* ignore a broken save */
  }
  return fresh();
}

let saveTimer = 0;
const history = new History(loadSaved(), () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => localStorage.setItem(STORE_KEY, JSON.stringify(history.current)), 300);
  updatePanel();
});
const pattern = () => history.current;

const engine = new Engine();

// Row faders: one level per row, for every pattern (kept in this browser, not in undo).
const MIX_KEY = 'orimono.mix.v1';
let mix: Partial<Record<RowTag, RowMix>> = {};
try { mix = JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}'); } catch { /* ignore */ }
engine.setMix(mix);
function setRowMix(tag: RowTag, change: Partial<RowMix>) {
  mix = { ...mix, [tag]: { db: 0, mute: false, solo: false, ...mix[tag], ...change } };
  engine.setMix(mix);
  localStorage.setItem(MIX_KEY, JSON.stringify(mix));
}
const scheduler = new Scheduler(engine, pattern);
const renderer = new Renderer(canvas);

const view: ViewState = {
  tool: 'draw', hover: { kind: 'none' }, rect: null, groupSel: null, drop: null, playheadId: null, hold: null, stripSel: null, rowSel: null, glow: 0, glowRect: null,
};
let lastPointer = 'mouse'; // 'touch' shows Copy / Paste buttons for a selection
let touchColW: number | null = null; // touch number menu open: columns hold still
let clip: Clip | null = null;
let layout: Layout = computeLayout(pattern(), stage.clientWidth, stage.clientHeight);
let shiftHeld = false;
// After a "+" / "–" click, column widths hold still until the pointer moves, so the same number
// stays under the pointer and can be clicked again and again.
let stripAnchor: { x: number; y: number; colW: number } | null = null;
const selecting = () => view.tool === 'select' || shiftHeld;

// ---------------------------------------------------------------- loading

engine
  .load(undefined, (done, total) => ($('loading').textContent = `Loading sounds… ${done}/${total}`))
  .then(() => {
    $('loading').remove();
    $<HTMLButtonElement>('play').disabled = false;
  })
  .catch((err) => {
    console.error(err);
    $('loading').textContent = 'Could not load the sounds. Run "npm run kit", then reload.';
    $('loading').classList.add('error');
  });

// ---------------------------------------------------------------- panel

function updatePanel() {
  const p = pattern();
  $('bpm').textContent = p.bpm.toFixed(p.bpm % 1 ? 1 : 0);
  $('len').textContent = `${p.threads.length} thread${p.threads.length === 1 ? '' : 's'}`;
  $('secs').textContent = `${(p.threads.length * threadSeconds(p.bpm)).toFixed(2)} s`;
  $<HTMLButtonElement>('undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = !history.canRedo;
  // Knob: 40–300 BPM over a 270° sweep, on a log scale (72 sits a little before ten o'clock).
  const t = Math.log(p.bpm / BPM_MIN) / Math.log(BPM_MAX / BPM_MIN);
  const ang = -135 + 270 * t;
  $('knob-tick').setAttribute('transform', `rotate(${ang} 24 24)`);
  $('knob-arc').setAttribute('d', arc(24, 24, 19, -135, ang));
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const pt = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function togglePlay() {
  if (!engine.loaded) return;
  if (scheduler.playing) {
    scheduler.stop();
    view.playheadId = null;
  } else scheduler.start();
  const b = $<HTMLButtonElement>('play');
  b.textContent = scheduler.playing ? 'Stop' : 'Play';
  b.classList.toggle('playing', scheduler.playing);
}

function setTool(tool: 'draw' | 'select') {
  view.tool = tool;
  $('tool-draw').classList.toggle('on', tool === 'draw');
  $('tool-select').classList.toggle('on', tool === 'select');
  if (tool === 'draw') clearSelection();
}

function clearSelection() {
  view.stripSel = null;
  touchColW = null;
  view.rowSel = null;
  view.rect = null;
  view.groupSel = null;
  view.drop = null;
  showActions();
}

/** The selected area as a rectangle, whatever was picked: groups (all rows), rows (all threads),
 * or a free rectangle. Random, Clear, Copy and Paste all work on it. */
function selRect(): Rect | null {
  const n = pattern().threads.length, last = ROWS.length - 1;
  if (view.groupSel) {
    const rs = runs(pattern());
    const a = rs[view.groupSel[0]], b = rs[view.groupSel[1]];
    return a && b ? { t0: a.start, t1: b.end - 1, r0: 0, r1: last } : null;
  }
  if (view.rowSel) return { t0: 0, t1: n - 1, r0: view.rowSel[0], r1: view.rowSel[1] };
  return view.rect;
}

/** Structure edits move indices around, so selections are dropped after them. */
function applyStructure(next: Pattern) {
  history.apply(next);
  clearSelection();
}

// Buttons clicked with the mouse give focus back, so Space always means Play/Stop.
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b && e.detail > 0) b.blur();
});

$('play').onclick = togglePlay;
// Random: each press picks a style, never the same one twice in a row; Shift keeps the style.
let lastStyle = -1;
let styleTimer = 0;
$('random').onclick = (e) => {
  engine.resume();
  const others = STYLES.map((_, i) => i).filter((i) => i !== lastStyle).sort(() => Math.random() - 0.5);
  const order = e.shiftKey && lastStyle >= 0 ? [lastStyle, ...others] : [...others, ...(lastStyle >= 0 ? [lastStyle] : [])];
  const { pattern: next, style } = randomFillStyled(pattern(), selRect(), Math.random, order);
  history.apply(next);
  if (style < 0) return;
  lastStyle = style;
  const tag = $('style-tag');
  tag.textContent = STYLES[style].name;
  tag.classList.add('show');
  window.clearTimeout(styleTimer);
  styleTimer = window.setTimeout(() => tag.classList.remove('show'), 2200);
  view.glow = performance.now(); // your own notes glow briefly: Random kept them
  view.glowRect = selRect();
};
$('clear').onclick = doClearRect;
$('undo').onclick = () => { history.undo(); clearSelection(); };
$('redo').onclick = () => { history.redo(); clearSelection(); };
$('tool-draw').onclick = () => setTool('draw');
$('tool-select').onclick = () => setTool('select');
$('sounds').onclick = () => $<HTMLDialogElement>('credits').showModal();

// New sits behind the length readout: picking it shows what it does before it does it.
{
  const pop = $('new-pop');
  const close = () => { pop.hidden = true; $('length').classList.remove('on'); };
  $('length').onclick = (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    close();
    if (open) { pop.hidden = false; $('length').classList.add('on'); }
  };
  $('new').onclick = () => {
    const f = fresh();
    f.bpm = pattern().bpm;
    applyStructure(f);
    close();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !(e.target as HTMLElement).closest('#new-pop, #length')) close();
  });
}

// Tempo knob: drag up/down (Shift for finer), scroll, arrow keys, or double-click to type.
// The knob works on a log scale, so slow tempos get fine control (about 3 px per BPM near 72,
// 1 px per BPM near 200), and it always lands on whole BPM. Typing allows one decimal.
// One drag = one undo step.
{
  const knob = $('knob');
  const LOG_PER_PX = 0.0045; // change in ln(BPM) per pixel dragged
  const clampBpm = (b: number) => Math.max(BPM_MIN, Math.min(BPM_MAX, b));
  const toBpm = (u: number) => clampBpm(Math.round(Math.exp(u)));
  let startY = 0, startU = 0;
  knob.addEventListener('pointerdown', (e) => {
    knob.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startU = Math.log(pattern().bpm);
    history.begin();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    const next = toBpm(startU + (startY - e.clientY) * LOG_PER_PX * (e.shiftKey ? 0.25 : 1));
    if (next !== pattern().bpm) history.apply(setBpm(pattern(), next));
  });
  const done = () => { history.end(); updatePanel(); };
  knob.addEventListener('pointerup', done);
  knob.addEventListener('pointercancel', done);
  // Scroll: a mouse wheel notch is one BPM; a trackpad's many small scroll events add up smoothly.
  let wheelTimer = 0, wheelU = 0, wheeling = false;
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!wheeling) { history.begin(); wheeling = true; wheelU = Math.log(pattern().bpm); }
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const notch = Math.abs(px) >= 50; // a mouse wheel click
    const cur = pattern().bpm;
    if (notch) wheelU = Math.log(Math.round(cur) - Math.sign(px));
    else wheelU -= px * LOG_PER_PX * 0.5;
    const next = toBpm(wheelU);
    if (next !== cur) history.apply(setBpm(pattern(), next));
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => { wheeling = false; done(); }, 400);
  }, { passive: false });
  knob.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const b = pattern().bpm;
    history.apply(setBpm(pattern(), clampBpm(step > 0 ? Math.floor(b) + 1 : Math.ceil(b) - 1)));
  });
  const input = $<HTMLInputElement>('bpm-input');
  const openInput = () => {
    input.value = String(pattern().bpm);
    input.hidden = false;
    input.focus();
    input.select();
  };
  knob.addEventListener('dblclick', openInput);
  $('bpm').addEventListener('dblclick', openInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = String(pattern().bpm); input.blur(); }
  });
  input.addEventListener('blur', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) history.apply(setBpm(pattern(), clampBpm(v)));
    input.hidden = true;
  });
}

// ---------------------------------------------------------------- action bar

function button(label: string, onClick: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = !!opts.disabled;
  if (opts.danger) b.className = 'danger';
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

function mixLine(tag: RowTag) {
  const m = { db: 0, mute: false, solo: false, ...mix[tag] };
  const line = document.createElement('div');
  line.className = 'mix-line';
  const name = document.createElement('span');
  name.className = 'mix-tag';
  name.textContent = tag;
  const fader = document.createElement('input');
  fader.type = 'range';
  fader.min = '-24'; fader.max = '12'; fader.step = '0.1';
  fader.value = String(m.db);
  fader.title = 'Level: drag, or arrow keys for 0.1 dB steps (double-click for 0 dB)';
  const val = document.createElement('span');
  val.className = 'mix-db';
  const show = (db: number) => (val.textContent = `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);
  show(m.db);
  const set = () => { setRowMix(tag, { db: +fader.value }); show(+fader.value); };
  fader.oninput = set;
  fader.ondblclick = () => { fader.value = '0'; set(); };
  const toggle = (label: string, key: 'mute' | 'solo', title: string) => {
    const b = button(label, () => { setRowMix(tag, { [key]: !mix[tag]?.[key] }); b.classList.toggle('on', !!mix[tag]?.[key]); });
    b.classList.add('mix-toggle');
    b.classList.toggle('on', m[key]);
    b.title = title;
    return b;
  };
  line.append(name, fader, val, toggle('M', 'mute', 'Mute'), toggle('S', 'solo', 'Solo'));
  return line;
}

/** Copy the fader levels as one line of text (to share, or to make them the kit's defaults). */
function copyLevels() {
  const text = ROWS.map((t) => `${t} ${(mix[t]?.db ?? 0) >= 0 ? '+' : ''}${(mix[t]?.db ?? 0).toFixed(1)}`).join(', ');
  void navigator.clipboard?.writeText(text);
}

function showActions() {
  actions.replaceChildren();
  actions.classList.remove('mix');
  const L = layout;
  if (view.groupSel) {
    const [a, b] = view.groupSel;
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'drag to move';
    actions.append(
      hint,
      ...(b > a ? [button('Merge', doMergeGroups)] : []),
      button('Duplicate', doDuplicate),
      button('Delete', doDeleteGroups, { danger: true }),
    );
    const x = (L.xs[L.runs[a].start] + L.xs[L.runs[b].end - 1]) / 2;
    place(x, L.numTop - (lastPointer === "touch" ? 66 : 50)); // above the numbers: below the band is off-screen
  } else if (view.stripSel !== null) {
    // Touch: one number's actions as big buttons, instead of the fine targets made for a pointer.
    const ti = view.stripSel, p = pattern(), n = p.threads.length;
    // Like repeated clicks with a pointer: columns hold still while this menu is open, so the
    // number stays under the menu; they re-fit when it closes.
    const keep = (next: Pattern, sel: number | null) => {
      const w = touchColW;
      applyStructure(next);
      view.stripSel = sel;
      touchColW = sel === null ? null : w;
      showActions();
    };
    actions.append(
      button('+ cell', () => keep(insertAfter(p, ti), ti)),
      button('– cell', () => keep(deleteCell(p, ti), n > 1 ? Math.min(ti, n - 2) : null), { danger: true, disabled: n <= 1 }),
      ...(ti < n - 1
        ? [isBoundary(p, ti + 1)
          ? button('⋈ merge with next', () => keep(merge(p, ti + 1), ti))
          : button(`✂ split after ${ti + 1}`, () => keep(split(p, ti + 1), ti))]
        : []),
    );
    place(L.xs[ti], L.numTop - 60);
  } else if (view.rowSel) {
    // Row actions: a fader per selected row, with mute and solo.
    actions.classList.add('mix');
    const [r0, r1] = view.rowSel;
    for (let ri = r0; ri <= r1; ri++) actions.append(mixLine(ROWS[ri]));
    const foot = document.createElement('div');
    foot.className = 'mix-foot';
    if (lastPointer === 'touch') foot.append(button('Copy', doCopy), button('Paste', doPaste, { disabled: !clip }));
    foot.append(button('Copy levels', copyLevels));
    actions.append(foot);
    actions.hidden = false;
    const w = actions.offsetWidth, h = actions.offsetHeight;
    const yTop = L.top + r0 * L.rowH, yBot = L.top + (r1 + 1) * L.rowH;
    const y = yBot + 6 + h <= L.numTop ? yBot + 6 : Math.max(4, yTop - h - 6);
    place(LABEL_W + 8 + w / 2, y);
  } else if (lastPointer === 'touch' && selRect()) {
    // Touch has no ⌘C / ⌘V, so a selection offers them as buttons. (Random and Clear are in the toolbar.)
    const r = selRect()!;
    actions.append(button('Copy', doCopy), button('Paste', doPaste, { disabled: !clip }));
    const x = (L.xs[r.t0] + L.xs[r.t1]) / 2;
    const below = L.top + (r.r1 + 1) * L.rowH + 6;
    place(x, r.r1 > ROWS.length - 5 ? L.top + r.r0 * L.rowH - 60 : below);
  }
  actions.hidden = !actions.childElementCount;
}

function place(x: number, y: number) {
  actions.hidden = false;
  const w = actions.offsetWidth;
  actions.style.left = `${Math.max(8, Math.min(layout.width - w - 8, x - w / 2))}px`;
  actions.style.top = `${Math.max(4, y)}px`;
}

function doMergeGroups() {
  if (!view.groupSel) return;
  const [a, b] = view.groupSel;
  history.apply(mergeGroups(pattern(), a, b));
  view.groupSel = [a, a];
  showActions();
}
function doDuplicate() {
  if (!view.groupSel) return;
  const [a, b] = view.groupSel;
  history.apply(duplicateGroups(pattern(), a, b));
  showActions();
}
function doDeleteGroups() {
  if (!view.groupSel) return;
  applyStructure(deleteGroups(pattern(), ...view.groupSel));
}
/** Clear notes in the selection, or everywhere if nothing is selected. Groups stay. */
function doClearRect() {
  const all = { t0: 0, t1: pattern().threads.length - 1, r0: 0, r1: ROWS.length - 1 };
  history.apply(clearRect(pattern(), selRect() ?? all));
}
function doCopy() {
  const r = selRect();
  if (r) clip = copyRect(pattern(), r);
  showActions();
}
function doPaste() {
  const r = selRect();
  if (r && clip) history.apply(pasteClip(pattern(), clip, r.t0, r.r0));
}

// ---------------------------------------------------------------- pointer gestures

type Gesture =
  | { kind: 'draw'; mode: 'fill' | 'erase'; x0: number; y0: number; last: string; timer: number; ti: number; ri: number; before: number | null }
  | { kind: 'pluck'; ti: number; ri: number; x0: number; v0: number }
  | { kind: 'rect'; ti: number; ri: number }
  | { kind: 'band-select'; anchor: number }
  | { kind: 'row-select'; anchor: number }
  | { kind: 'band-move'; a: number; b: number; x0: number; moved: boolean; run: number }
  | { kind: 'strip'; target: Target | { kind: 'num'; ti: number } };

let gesture: Gesture | null = null;
let lastPreview = 0;

function point(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function preview(row: RowTag, v: number) {
  const now = performance.now();
  if (now - lastPreview < 35) return; // a fast swipe shouldn't machine-gun
  lastPreview = now;
  engine.resume();
  engine.play(row, v, undefined, true);
}

function paint(ti: number, ri: number, mode: 'fill' | 'erase') {
  const row = ROWS[ri];
  const has = !!getHit(pattern(), ti, row);
  if (mode === 'fill' && !has) {
    history.apply(setHit(pattern(), ti, row, { v: DEFAULT_VELOCITY, mine: true }));
    preview(row, DEFAULT_VELOCITY);
  } else if (mode === 'erase' && has) {
    history.apply(setHit(pattern(), ti, row, null));
  }
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  engine.resume();
  const { x, y } = point(e);
  const t = hitTest(layout, pattern(), x, y);
  canvas.setPointerCapture(e.pointerId);
  lastPointer = e.pointerType;

  if (t.kind === 'label') {
    if (!selecting()) { clearSelection(); preview(ROWS[t.ri], DEFAULT_VELOCITY); return; }
    const sel = view.rowSel;
    const anchor = sel && e.shiftKey ? (t.ri >= sel[0] ? sel[0] : sel[1]) : t.ri;
    clearSelection();
    view.rowSel = [Math.min(anchor, t.ri), Math.max(anchor, t.ri)];
    gesture = { kind: 'row-select', anchor };
    showActions();
    return;
  }

  if (t.kind === 'cell') {
    if (selecting()) {
      view.groupSel = null;
      view.rowSel = null;
      gesture = { kind: 'rect', ti: t.ti, ri: t.ri };
      view.rect = { t0: t.ti, t1: t.ti, r0: t.ri, r1: t.ri };
      showActions();
      return;
    }
    clearSelection();
    history.begin();
    const row = ROWS[t.ri];
    const before = getHit(pattern(), t.ti, row)?.v ?? null;
    const mode = before === null ? 'fill' : 'erase';
    paint(t.ti, t.ri, mode);
    gesture = {
      kind: 'draw', mode, x0: x, y0: y, last: `${t.ti}:${t.ri}`, ti: t.ti, ri: t.ri, before,
      timer: window.setTimeout(() => startPluck(), HOLD_MS),
    };
    return;
  }

  if (t.kind === 'band') {
    if (!selecting()) {
      // Draw tool: paint the group a nearby colour (one undo step per click).
      applyStructure(recolour(pattern(), t.run));
      return;
    }
    view.rect = null;
    view.rowSel = null;
    const sel = view.groupSel;
    if (sel && t.run >= sel[0] && t.run <= sel[1] && !e.shiftKey) {
      gesture = { kind: 'band-move', a: sel[0], b: sel[1], x0: x, moved: false, run: t.run };
    } else if (sel && e.shiftKey) {
      view.groupSel = [Math.min(sel[0], t.run), Math.max(sel[1], t.run)];
      gesture = { kind: 'band-select', anchor: sel[0] <= t.run ? sel[0] : sel[1] };
    } else {
      view.groupSel = [t.run, t.run];
      gesture = { kind: 'band-select', anchor: t.run };
    }
    showActions();
    return;
  }

  if (e.pointerType === 'touch' && inNumberLane(layout, y)) {
    const tt = touchStripTarget(layout, x);
    if (tt.kind === 'num') {
      const again = view.stripSel === tt.ti;
      clearSelection();
      view.stripSel = again ? null : tt.ti;
      if (!again) touchColW = layout.colW;
      showActions();
    } else gesture = { kind: 'strip', target: tt };
    return;
  }

  if (t.kind !== 'none') gesture = { kind: 'strip', target: t };
  else clearSelection();
});

function startPluck() {
  if (!gesture || gesture.kind !== 'draw') return;
  const { ti, ri, before, x0 } = gesture;
  const row = ROWS[ri];
  // Past the threshold the cell is guaranteed to hold a hit, whatever the first press did.
  const v0 = before ?? DEFAULT_VELOCITY;
  history.apply(setHit(pattern(), ti, row, { v: v0, mine: true }));
  gesture = { kind: 'pluck', ti, ri, x0, v0 };
  view.hold = { threadId: pattern().threads[ti].id, ri, dx: 0 };
}

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = point(e);
  // Up/down between + and – keeps the anchor; moving sideways or leaving the number lane lets go.
  if (stripAnchor && (Math.abs(x - stripAnchor.x) > 4 || !inNumberLane(layout, y))) stripAnchor = null;
  else if (stripAnchor) stripAnchor.y = y;
  const t = hitTest(layout, pattern(), x, y);
  if (!gesture) {
    view.hover = selecting() && t.kind === 'cell' ? { kind: 'none' } : t;
    canvas.style.cursor = t.kind === 'none' ? 'default' : t.kind === 'label' ? 'pointer' : t.kind === 'band' && selecting() ? 'grab' : t.kind === 'band' ? 'copy' : 'pointer';
    return;
  }
  const g = gesture;
  if (g.kind === 'draw') {
    if (Math.hypot(x - g.x0, y - g.y0) > MOVE_TOLERANCE) window.clearTimeout(g.timer);
    if (t.kind === 'cell') {
      const key = `${t.ti}:${t.ri}`;
      if (key !== g.last) {
        window.clearTimeout(g.timer);
        g.last = key;
        paint(t.ti, t.ri, g.mode);
      }
      view.hover = t;
    }
  } else if (g.kind === 'pluck') {
    // Pull sideways: the further you pull, the harder the hit.
    const dx = x - g.x0;
    const pull = Math.max(-34, Math.min(34, dx * 0.6));
    if (view.hold) view.hold.dx = pull;
    if (Math.abs(dx) > 3) {
      const v = Math.max(0.12, Math.min(1, Math.abs(dx) / 70));
      history.apply(setHit(pattern(), g.ti, ROWS[g.ri], { v, mine: true }));
    }
  } else if (g.kind === 'rect') {
    if (t.kind === 'cell') {
      view.rect = {
        t0: Math.min(g.ti, t.ti), t1: Math.max(g.ti, t.ti), r0: Math.min(g.ri, t.ri), r1: Math.max(g.ri, t.ri),
      };
      showActions();
    }
  } else if (g.kind === 'row-select') {
    const ri = Math.max(0, Math.min(ROWS.length - 1, Math.floor((y - layout.top) / layout.rowH)));
    view.rowSel = [Math.min(g.anchor, ri), Math.max(g.anchor, ri)];
    showActions();
  } else if (g.kind === 'band-select') {
    if (t.kind === 'band') {
      view.groupSel = [Math.min(g.anchor, t.run), Math.max(g.anchor, t.run)];
      showActions();
    }
  } else if (g.kind === 'band-move') {
    if (Math.abs(x - g.x0) > 6) g.moved = true;
    if (g.moved) {
      view.drop = { a: g.a, b: g.b, idx: dropIndex(layout, x, g.a, g.b) };
      actions.hidden = true;
      canvas.style.cursor = 'grabbing';
    }
  }
});

function endGesture(e: PointerEvent) {
  const g = gesture;
  gesture = null;
  if (!g) return;
  const { x, y } = point(e);
  if (g.kind === 'draw') {
    window.clearTimeout(g.timer);
    history.end();
  } else if (g.kind === 'pluck') {
    const hit = getHit(pattern(), g.ti, ROWS[g.ri]);
    const v = hit?.v ?? g.v0;
    engine.play(ROWS[g.ri], v, undefined, true);
    const id = pattern().threads[g.ti].id;
    renderer.pluck(id, (view.hold?.dx ?? 0) * 0.6, 0.12 + 0.12 * v, 6);
    view.hold = null;
    history.end();
  } else if (g.kind === 'band-move') {
    if (g.moved && view.drop) {
      const idx = view.drop.idx;
      history.apply(moveGroups(pattern(), g.a, g.b, idx));
      view.groupSel = [idx, idx + (g.b - g.a)];
    } else if (!g.moved) {
      view.groupSel = [g.run, g.run];
    }
    view.drop = null;
    showActions();
  } else if (g.kind === 'strip') {
    const t = e.pointerType === 'touch' && inNumberLane(layout, y) ? touchStripTarget(layout, x) : hitTest(layout, pattern(), x, y);
    if (JSON.stringify(t) !== JSON.stringify(g.target)) return;
    const p = pattern();
    if (t.kind === 'add' || t.kind === 'del') {
      if (e.pointerType !== 'touch') stripAnchor = { x, y, colW: layout.colW };
      applyStructure(t.kind === 'add' ? insertAfter(p, t.ti) : deleteCell(p, t.ti));
    }
    else if (t.kind === 'front') applyStructure(insertFront(p));
    else if (t.kind === 'back') applyStructure(insertBack(p));
    else if (t.kind === 'split') applyStructure(split(p, t.g));
    else if (t.kind === 'merge') applyStructure(merge(p, t.g));
  }
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('pointerleave', () => { stripAnchor = null; if (!gesture) view.hover = { kind: 'none' }; });

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
  const el = e.target as HTMLInputElement;
  if (el.tagName === 'INPUT' && el.type !== 'range') return; // typing; a fader still lets Space play
  if (el.type === 'range' && e.code !== 'Space') return;
  if ($<HTMLDialogElement>('credits').open) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); clearSelection(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); doDuplicate(); }
  else if (mod && e.key.toLowerCase() === 'c') { doCopy(); }
  else if (mod && e.key.toLowerCase() === 'v') { doPaste(); }
  else if (mod) return;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (view.groupSel) doDeleteGroups();
    else if (selRect()) doClearRect(); // the key never clears everything; the Clear button can
  }
  else if (e.key.toLowerCase() === 'd') setTool('draw');
  else if (e.key.toLowerCase() === 's') setTool('select');
  else if (e.key.toLowerCase() === 'm') doMergeGroups();
  else if (e.key === 'Escape') clearSelection();
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });
window.addEventListener('blur', () => (shiftHeld = false));

// ---------------------------------------------------------------- frame loop

// How long a string keeps swinging, in cells: heavier beads swing a little longer (§11.2).
// Measured in cells, so faster tempos give shorter wobbles and the grid never looks all-a-shimmer.
const SWING_CELLS: Partial<Record<RowTag, number>> = { BD: 1.6, FT: 1.4, HT: 1.2, DB: 1.1, CG: 1.1, BG: 1.0, SD: 1.0 };

function frame() {
  const p = pattern();
  layout = computeLayout(p, stage.clientWidth, stage.clientHeight, stripAnchor?.colW ?? touchColW ?? undefined);
  if (stripAnchor && !gesture) view.hover = hitTest(layout, p, stripAnchor.x, stripAnchor.y);
  const cell = threadSeconds(p.bpm);
  for (const f of scheduler.due()) {
    view.playheadId = f.threadId;
    if (f.hits.length) {
      const v = Math.max(...f.hits.map((h) => h.v));
      const cells = Math.max(0.7, ...f.hits.map((h) => SWING_CELLS[h.row] ?? 0.7));
      const tau = Math.min(0.35, (cells * cell) / 2.5); // decays to ~8% within `cells` cells
      const freq = Math.max(3, Math.min(16, 1.2 / (cells * cell))); // about one swing per wobble
      renderer.pluck(f.threadId, 0.8 + 2.2 * v, tau, freq);
    }
  }
  const anySolo = ROWS.some((t) => mix[t]?.solo);
  const quiet = ROWS.map((t) => !!mix[t]?.mute || (anySolo && !mix[t]?.solo));
  renderer.draw(p, layout, { ...view, rect: selRect(), quiet });
  requestAnimationFrame(frame);
}

updatePanel();
requestAnimationFrame(frame);

// Development-only handle for automated checks; not present in production builds.
if (import.meta.env.DEV) Object.assign(window, { __rg: { engine, scheduler, history } });
