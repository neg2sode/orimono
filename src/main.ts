import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import './style.css';

import { BPM_MAX, BPM_MIN, DEFAULT_VELOCITY, MAX_ZOOM, PALETTE, ROWS, threadSeconds, type RowTag } from './constants';
import { openPicker, restoreAccent, setAccent } from './picker';
import { Engine, type RowMix } from './audio';
import { History } from './history';
import { LABEL_W, cellL, cellR, computeLayout, dropIndex, hitTest, inNumberLane, touchStripTarget, type Layout, type Target } from './layout';
import {
  clearRect, copyRect, deleteCell, deleteGroups, duplicateGroups, fresh, getHit, insertAfter, insertFront,
  insertBack, isBoundary, merge, single, mergeGroups, moveGroups, notesBetween, parse, pasteClip, recolour, regionAt, runs, setHit, split, splitPlain, zoomOf, zoomPlan, zoomRect,
  type Clip, type Pattern, type Rect,
} from './model';
import { packFabric, unpackFabric } from './link';
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

// A project is a row of fabrics. A fabric is one whole pattern: everything on one thread-level
// screen. Fabrics follow each other in order (a "paragraph"); one of them is open at a time.
// Each fabric keeps its own undo history. The tempo belongs to the paragraph.
const PROJECT_KEY = 'orimono.project.v1';
/** bpm: the fabric's own tempo once its tie to the table's tempo thread is cut; null while tied. */
interface Item { id: number; history: History; bpm: number | null }
// The shelf: fabrics put away for later (each with its own tempo, if its tie was cut), and room
// for sound resources in a later phase.
interface Stored { pattern: Pattern; bpm: number | null }
let shelf: { fabrics: Stored[]; sounds: unknown[] } = { fabrics: [], sounds: [] };
const MAX_FABRICS = 99;

let saveTimer = 0;
// Two tabs of Orimono share one saved project. When another tab saves (a link opened there, or
// work done there), this tab is out of date: it stops saving, so it can't overwrite the newer
// work, and loads the project again (at once if it is in view, otherwise when it is next looked at).
let stale = false;
window.addEventListener('storage', (e) => {
  if (e.key !== PROJECT_KEY || stale) return;
  stale = true;
  window.clearTimeout(saveTimer);
  if (document.hidden) document.addEventListener('visibilitychange', () => location.reload(), { once: true });
  else location.reload();
});
function saveNow() {
  window.clearTimeout(saveTimer);
  if (stale) return;
  // A project: the table (fabrics in order), the shelf, and settings (tempo, row levels).
  const fabrics = items.map((it) => ({ ...it.history.current, bpm: it.bpm ?? projectBpm }));
  const own = items.map((it) => it.bpm !== null);
  localStorage.setItem(PROJECT_KEY, JSON.stringify({ v: 1, fabrics, own, cur, bpm: projectBpm, seen, shelf, mix }));
}
function save() {
  window.clearTimeout(saveTimer);
  if (stale) return;
  saveTimer = window.setTimeout(saveNow, 300);
}
window.addEventListener('pagehide', () => { if (items.length) saveNow(); }); // nothing is lost by leaving quickly
let nextItemId = 1;
const makeItem = (p: Pattern, bpm: number | null = null): Item => ({ id: nextItemId++, bpm, history: new History(p, () => { save(); updatePanel(); }) });
const bpmOf = (it: Item | undefined) => it?.bpm ?? projectBpm;
let savedMix: Partial<Record<RowTag, RowMix>> | null = null;

let items: Item[] = [];
let cur = 0; // the open fabric
let projectBpm = fresh().bpm;
let seen = false; // has the table of fabrics been visited yet?
// The welcome: shown once, with Play in the middle of it. Pressing Play starts the music and the
// button flies to its place in the toolbar, so a first beat is drawn while it is already playing.
const WELCOME_KEY = 'orimono.welcomed';
let welcoming = !localStorage.getItem(WELCOME_KEY);
try {
  const raw = JSON.parse(localStorage.getItem(PROJECT_KEY) ?? 'null');
  if (raw && Array.isArray(raw.fabrics)) {
    items = (raw.fabrics as unknown[]).map((f, i) => { const p = parse(f); return p ? makeItem(p, raw.own?.[i] ? p.bpm : null) : null; }).filter((x): x is Item => !!x);
    if (raw.shelf && Array.isArray(raw.shelf.fabrics)) {
      const kept = (raw.shelf.fabrics as { pattern?: unknown; bpm?: unknown }[]).map((f) => ({ pattern: parse(f?.pattern), bpm: typeof f?.bpm === 'number' ? f.bpm : null }));
      shelf = { fabrics: kept.filter((f): f is Stored => !!f.pattern), sounds: raw.shelf.sounds ?? [] };
    }
    if (raw.mix && typeof raw.mix === 'object') savedMix = raw.mix;
    cur = Math.max(0, Math.min(items.length - 1, raw.cur | 0));
    if (typeof raw.bpm === 'number') projectBpm = raw.bpm;
    seen = !!raw.seen;
  } else {
    // A save from before fabrics: one pattern, which becomes the first fabric.
    const old = JSON.parse(localStorage.getItem(STORE_KEY) ?? localStorage.getItem(OLD_STORE_KEY) ?? 'null');
    const p = old && parse(old);
    if (p) { items = [makeItem(p)]; projectBpm = p.bpm; }
  }
} catch {
  /* ignore a broken save */
}
if (!items.length) items = [makeItem(fresh())];

// A link (the part of the address after "#") holds one fabric. It arrives as a new fabric at
// the end of the table and is the one shown; nothing already here is changed. If all there is
// here is the untouched opening fabric, the linked one takes its place, tempo and all.
let arrivalNote = '';
if (location.hash.length > 1) {
  const got = unpackFabric(location.hash.slice(1));
  const blank = (p: Pattern) => p.threads.length === 16 && Object.keys(p.groups).length === 4 && p.threads.every((t) => !Object.keys(t.lanes).length);
  if (got === 'newer') arrivalNote = 'This link was made by a newer Orimono. Reload the page, then open the link again.';
  else if (!got) arrivalNote = "This link couldn't be opened: part of it may be missing.";
  else if (items.length === 1 && blank(items[0].history.current) && !shelf.fabrics.length) {
    items = [makeItem(got.pattern)];
    projectBpm = got.bpm;
    cur = 0;
  } else if (items.length < MAX_FABRICS) {
    items.push(makeItem(got.pattern, got.bpm === projectBpm ? null : got.bpm)); // another tempo: it keeps its own
    cur = items.length - 1;
  } else arrivalNote = 'The table is full (99 fabrics), so the linked fabric could not be added.';
  window.history.replaceState(null, '', location.pathname + location.search); // a refresh must not add it again
  save();
}
// A link pasted into the address while Orimono is open only changes the "#" part: load it.
window.addEventListener('hashchange', () => { if (location.hash.length > 1) { saveNow(); location.reload(); } });
let history = items[cur].history;
const pattern = () => history.current;

const engine = new Engine();

// Row faders: one level per row, for the whole project (saved with it, not in undo).
const MIX_KEY = 'orimono.mix.v2'; // where levels lived before projects (Nov 2026)
let mix: Partial<Record<RowTag, RowMix>> = {};
try { mix = savedMix ?? JSON.parse(localStorage.getItem(MIX_KEY) ?? '{}'); } catch { /* ignore */ }
engine.setMix(mix);
function setRowMix(tag: RowTag, change: Partial<RowMix>) {
  mix = { ...mix, [tag]: { db: 0, mute: false, solo: false, ...mix[tag], ...change } };
  engine.setMix(mix);
  save();
}
// What is playing: usually the open fabric; out on the table, each fabric in turn.
let playId = items[cur].id;
const scheduler = new Scheduler(engine, () => items.find((it) => it.id === playId)?.history.current ?? pattern());
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
// After an end "+" makes a new group, pressing again in the same place adds a cell to that
// group; a new group needs the pointer (or the tap) to go somewhere else first.
let endAnchor: { x: number; y: number; end: 'front' | 'back'; p: Pattern } | null = null;
// (Only while the pattern is still as that press left it: not after an undo or another edit.)
const atEndAnchor = (x: number, y: number) => !!endAnchor && endAnchor.p === history.current && Math.hypot(x - endAnchor.x, y - endAnchor.y) < 14;
const selecting = () => !fibre && (view.tool === 'select' || shiftHeld);

// Fibre level: the view is inside one zoomed region (a rectangle of cells split into fibres).
// Notes are drawn on threads at thread level and on fibres in here, never across.
let fibre: { region: Rect; ids: number[] } | null = null;
let zoomU = 0, zoomGoal = 0; // how far in the view is, and where it is heading (0 threads, 1 fibres)
let lastFactor = 2; // fibres per thread for a newly opened region
const DIVE_MS = 560;
const diving = () => zoomU !== zoomGoal;
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

// ---------------------------------------------------------------- loading

engine
  .load(undefined, (done, total) => ($('loading').textContent = `Loading sounds… ${done}/${total}`))
  .then(() => {
    $('loading').remove();
    $<HTMLButtonElement>('play').disabled = false;
    $<HTMLButtonElement>('welcome-play').disabled = false;
  })
  .catch((err) => {
    console.error(err);
    $('loading').textContent = 'Could not load the sounds. Run "npm run kit", then reload.';
    $('loading').classList.add('error');
  });

// ---------------------------------------------------------------- panel

// Inside a region the tempo knob becomes a listening speed: it reads the rate of the fibres
// (72 BPM in a ×3 region reads 216) and turning it changes only how fast Play runs in there.
// The pattern's own tempo is untouched. While the whole pattern is looping, the knob is the
// pattern's tempo as usual.
let localBpm: number | null = null; // the listening tempo inside the region, in thread terms
const listening = () => !!fibre && zoomGoal === 1 && !scheduler.looping;
function tempoScale() {
  if (!listening() || !fibre) return 1;
  const r = fibre.region;
  let z = 1;
  for (let ti = r.t0; ti <= r.t1; ti++) for (let ri = r.r0; ri <= r.r1; ri++) z = Math.max(z, zoomOf(pattern(), ti, ROWS[ri]));
  return z;
}
/** The open fabric plays at its own tempo if its tie is cut; out on the table the knob is always the table's. */
const ownTempo = () => !tableOpen && items[cur].bpm !== null;
const baseBpm = () => (tableOpen ? projectBpm : bpmOf(items[cur]));
const tempoReading = () => Math.round((listening() ? localBpm ?? baseBpm() : baseBpm()) * tempoScale() * 10) / 10;
function setTempo(reading: number) {
  if (listening()) { localBpm = reading / tempoScale(); updatePanel(); }
  else {
    const v = Math.round(reading * 10) / 10;
    if (ownTempo()) items[cur].bpm = v; // a cut fabric: its own tempo
    else projectBpm = v; // the table's tempo: every tied fabric plays at it
    save();
    updatePanel();
    if (tableOpen && !tableBusy) renderTable(); // cut fabrics keep their length, so their share of the cloth changes
  }
}
scheduler.bpm = () => (fibre && zoomGoal === 1 && !scheduler.looping ? localBpm : null) ?? bpmOf(items.find((it) => it.id === playId));

function updatePanel() {
  const p = pattern();
  const shown = tempoReading(), real = shown / tempoScale();
  $('bpm').textContent = shown.toFixed(shown % 1 ? 1 : 0);
  document.querySelector('.tempo')!.classList.toggle('local', listening());
  document.querySelector('.tempo')!.classList.toggle('own', !listening() && ownTempo());
  $('knob').title = listening()
    ? 'Listening speed in here, counted in fibres. It does not change the tempo outside.'
    : 'Tempo: drag up/down, scroll or arrow keys (whole BPM). Double-click to type an exact value, like 72.5.';
  if (fibre && zoomGoal === 1) {
    // Inside a region the readout is about the region: its fibres, and how long Play takes.
    const r = fibre.region, nT = r.t1 - r.t0 + 1, z = regionFactor(r);
    $('len').textContent = z ? `${nT * z} fibres` : `${nT} thread${nT === 1 ? '' : 's'}`;
    $('secs').textContent = `${(nT * threadSeconds(real)).toFixed(2)} s`;
  } else if (tableOpen) {
    // Out on the table the readout is about the whole paragraph.
    const total = items.reduce((n, it) => n + it.history.current.threads.length * threadSeconds(bpmOf(it)), 0);
    $('len').textContent = `${items.length} fabric${items.length === 1 ? '' : 's'}`;
    $('secs').textContent = `${total.toFixed(2)} s`;
  } else {
    const which = items.length > 1 ? `${cur + 1}/${items.length} · ` : ''; // which fabric this is
    $('len').textContent = `${which}${p.threads.length} thread${p.threads.length === 1 ? '' : 's'}`;
    $('secs').textContent = `${(p.threads.length * threadSeconds(baseBpm())).toFixed(2)} s`;
  }
  $<HTMLButtonElement>('undo').disabled = tableOpen || !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = tableOpen || !history.canRedo;
  // Knob: 10–300 BPM over a 270° sweep, on a log scale.
  const t = Math.log(real / BPM_MIN) / Math.log(BPM_MAX / BPM_MIN);
  const ang = -135 + 270 * t;
  $('knob-tick').setAttribute('transform', `rotate(${ang} 24 24)`);
  $('knob-arc').setAttribute('d', arc(24, 24, 19, -135, ang));
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const pt = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

function showPlaying() {
  updatePanel(); // whether the knob is the tempo or the listening speed depends on what is playing
  const b = $<HTMLButtonElement>('play');
  b.textContent = scheduler.playing ? 'Stop' : 'Play';
  b.classList.toggle('playing', scheduler.playing);
}
let playEnded = 0; // when a play-once stretch finished; the playhead leaves a moment later
scheduler.onEnd = () => { playEnded = performance.now(); showPlaying(); };

function togglePlay() {
  if (!engine.loaded) return;
  const fromWelcome = welcoming;
  if (scheduler.playing) {
    scheduler.stop();
    view.playheadId = null;
  } else if (fibre && zoomGoal === 1) {
    const r = fibre.region; // inside a region: just the region, once
    scheduler.start({ from: r.t0, to: r.t1, rows: ROWS.slice(r.r0, r.r1 + 1) });
  } else {
    // Among the threads the open fabric loops. Out on the table the fabrics play in turn, round
    // and round, from wherever the shuttle rests.
    const from = tableOpen ? startPlace() : { it: items[cur], index: 0 };
    playId = from.it.id;
    scheduler.start(undefined, from.index);
    cameFrom = null;
    stopFade = null;
    shuttleAt = tableOpen ? { id: playId, index: from.index, time: scheduler.startTime } : null;
    if (tableOpen) pulseThread();
  }
  playEnded = 0;
  showPlaying();
  markPlaying();
  window.setTimeout(checkSound, 500);
  if (fromWelcome) closeWelcome(true);
}

/** Put the welcome away. After Play, its button flies to the toolbar's Play button (now "Stop"). */
function closeWelcome(fly: boolean) {
  if (!welcoming) return;
  welcoming = false;
  localStorage.setItem(WELCOME_KEY, '1');
  const el = $('welcome'), big = $('welcome-play'), real = $('play');
  const done = () => { el.hidden = true; document.body.classList.remove('welcoming'); };
  document.body.classList.remove('intro'); // its animations would hold the card in view
  if (!fly || still()) return done();
  const a = big.getBoundingClientRect(), b = real.getBoundingClientRect();
  const flying = real.cloneNode(true) as HTMLElement;
  flying.removeAttribute('id');
  flying.style.cssText = `position:fixed;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;margin:0;z-index:70;pointer-events:none`;
  document.body.append(flying);
  big.style.visibility = 'hidden';
  el.classList.add('leaving');
  const from = `translate(${a.left + a.width / 2 - b.left - b.width / 2}px, ${a.top + a.height / 2 - b.top - b.height / 2}px) scale(${a.height / b.height})`;
  void flying.animate([{ transform: from }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.65,0,.35,1)' }).finished.then(() => { flying.remove(); done(); });
}
if (welcoming) {
  // First launch: the machine comes out part by part (toolbar, row tags, groups and numbers,
  // strings), and the welcome comes up last, like a title.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.body.classList.add('intro');
    renderer.bloom();
    window.setTimeout(() => document.body.classList.remove('intro'), 6600);
  }
  document.body.classList.add('welcoming');
  $('welcome').hidden = false;
  $('welcome-play').onclick = togglePlay;
  $('welcome').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeWelcome(false); }); // a press outside the card: straight to the machine
}

// If Play is on but the browser has not let the sound start (or the sounds never loaded), say
// so on screen instead of playing silently.
function checkSound() {
  const blocked = scheduler.playing && engine.ctx.state !== 'running';
  let note = document.getElementById('sound-note');
  if (!blocked) { note?.remove(); return; }
  if (!note) {
    note = document.createElement('div');
    note.id = 'sound-note';
    document.body.append(note);
  }
  note.textContent = `The browser is holding the sound back (audio is "${engine.ctx.state}"). Click anywhere to let it through.`;
}
// Any press or key is a chance to wake the sound, not only Play.
for (const type of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(type, () => { engine.resume(); window.setTimeout(checkSound, 300); }, true);
}
scheduler.onLoop = (time) => {
  if (!tableOpen || items.length < 2) return;
  const i = items.findIndex((it) => it.id === playId);
  playId = items[(i + 1) % items.length].id;
  window.setTimeout(markPlaying, Math.max(0, (time - engine.ctx.currentTime) * 1000));
};

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
  // One level at a time: inside a region Random fills its fibres; at thread level it fills
  // threads and leaves zoomed cells alone.
  const area = fibre ? fibre.region : selRect();
  if (!fibre && area && allZoomed(area)) return;
  const { pattern: next, style } = randomFillStyled(pattern(), area, Math.random, order);
  history.apply(next);
  if (style < 0) return;
  lastStyle = style;
  const tag = $('style-tag');
  tag.textContent = STYLES[style].name;
  tag.classList.add('show');
  window.clearTimeout(styleTimer);
  styleTimer = window.setTimeout(() => tag.classList.remove('show'), 2200);
  view.glow = performance.now(); // your own notes glow briefly: Random kept them
  view.glowRect = area;
};
$('clear').onclick = doClearRect;
$('fab-dup').onclick = () => { if (tableSel >= 0) duplicateFabric(tableSel); };
$('fab-del').onclick = () => { if (shelfSel >= 0) void deleteStored(shelfSel); else if (tableSel >= 0) void deleteFabric(tableSel); };

// ---------------------------------------------------------------- zoom (fibre · thread · fabric)

/** A yes/no question in the app's own style. Resolves true for yes. */
function ask(text: string, yes: string): Promise<boolean> {
  const dlg = $<HTMLDialogElement>('ask');
  $('ask-text').textContent = text;
  $('ask-yes').textContent = yes;
  dlg.returnValue = 'no';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true }));
}

const times = (n: number) => `×${n}`;

function allZoomed(r: Rect) {
  for (let ti = r.t0; ti <= r.t1; ti++) for (let ri = r.r0; ri <= r.r1; ri++) if (zoomOf(pattern(), ti, ROWS[ri]) === 1) return false;
  return true;
}

/** The zoom of the region, if all its cells share one. */
function regionFactor(r: Rect): number | null {
  const z = zoomOf(pattern(), r.t0, ROWS[r.r0]);
  for (let ti = r.t0; ti <= r.t1; ti++) for (let ri = r.r0; ri <= r.r1; ri++) if (zoomOf(pattern(), ti, ROWS[ri]) !== z) return null;
  return z;
}

/** Go inside an area. Its plain cells are split into fibres; zoomed cells stay as they are. */
function enterFibre(r: Rect) {
  if (fibre || diving()) return;
  const p = pattern();
  const zs = new Set<number>();
  for (let ti = r.t0; ti <= r.t1; ti++) for (let ri = r.r0; ri <= r.r1; ri++) zs.add(zoomOf(p, ti, ROWS[ri]));
  zs.delete(1);
  const next = splitPlain(p, r, zs.size === 1 ? [...zs][0] : lastFactor);
  history.apply(next);
  clearSelection();
  view.hover = { kind: 'none' };
  view.hoverRegion = null;
  stage.scrollTo(0, 0);
  fibre = { region: { ...r }, ids: next.threads.slice(r.t0, r.t1 + 1).map((t) => t.id) };
  zoomGoal = 1;
  localBpm = null; // every visit starts at true speed
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) zoomU = 1;
  updateLevel();
}

/** Back out to the threads. The region stays a region, empty or not: only Clear (out among the
 * threads) or ×1 turns it back into plain cells. */
function leaveFibre() {
  if (!fibre || zoomGoal === 0) return;
  zoomGoal = 0;
  $('zoom-pop').hidden = true;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { zoomU = 0; fibre = null; }
  view.hover = { kind: 'none' };
  updateLevel();
}

/** Inside a region: change how many fibres each of its threads has (1 = none: back to plain cells). */
async function setFactor(m: number) {
  if (!fibre || diving() || m < 1 || m > MAX_ZOOM) return;
  const r = fibre.region;
  const plan = zoomPlan(pattern(), r, m, true);
  if (plan.lost) {
    const notes = `${plan.lost} note${plan.lost === 1 ? '' : 's'} between the beats will be cleared.`;
    const from = plan.from.map(times).join(' and ');
    const ok = await ask(m === 1 ? `Remove the fibres here? ${notes}` : `Change ${from} to ${times(m)} here? ${notes}`, m === 1 ? 'Remove fibres' : `Change to ${times(m)}`);
    if (!ok || !fibre) return;
  }
  if (m === 1) {
    zoomGoal = 0; // leaving, so the region no longer has to be zoomed
    history.apply(zoomRect(pattern(), r, 1, true));
    updateLevel();
    return;
  }
  lastFactor = m;
  history.apply(zoomRect(pattern(), r, m, true));
  updateLevel();
}

/** Toolbar state that depends on the level. */
function updateLevel() {
  const inside = !!fibre && zoomGoal === 1;
  updatePanel();
  $('fibre-count').hidden = !inside;
  $<HTMLButtonElement>('tool-select').disabled = inside || tableOpen;
  for (const id of ['tool-draw', 'random', 'clear', 'length']) $<HTMLButtonElement>(id).disabled = tableOpen;
  // On the table the thread tools make way for what can be done with a picked fabric.
  document.body.classList.toggle('at-table', tableOpen);
  $<HTMLButtonElement>('fab-dup').disabled = tableSel < 0 || items.length >= MAX_FABRICS;
  $<HTMLButtonElement>('fab-del').disabled = shelfSel < 0 && (tableSel < 0 || items.length < 2);
  $<HTMLButtonElement>('undo').disabled = tableOpen || !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = tableOpen || !history.canRedo;
  if (fibre) {
    const z = regionFactor(fibre.region);
    $('fib-n').textContent = z ? times(z) : '×…';
    $('zoom-pop').hidden = true;
    $<HTMLButtonElement>('fib-less').disabled = (z ?? 2) <= 1;
    $<HTMLButtonElement>('fib-more').disabled = (z ?? 2) >= MAX_ZOOM;
  }
  $('clear').title = inside
    ? 'Clear the notes in this region. (Undoable)'
    : 'Clear notes in the selection, or all notes if nothing is selected. Groups stay. (Undoable)';
}

{
  const pop = $('zoom-pop');
  const stepBase = () => {
    if (!fibre) return 2;
    let z = 1;
    const r = fibre.region;
    for (let ti = r.t0; ti <= r.t1; ti++) for (let ri = r.r0; ri <= r.r1; ri++) z = Math.max(z, zoomOf(pattern(), ti, ROWS[ri]));
    return z;
  };
  $('fib-less').onclick = () => void setFactor(Math.min(MAX_ZOOM, stepBase() - 1));
  $('fib-more').onclick = () => void setFactor(stepBase() + 1);
  // One button, one way at a time: in to fibres with a selection, out to fabric without one,
  // and back to the threads from either.
  // The number itself opens every choice at once. When the region has notes between the beats,
  // the choices that keep all of them stand out from the ones that would clear some.
  $('fib-n').onclick = (e) => {
    e.stopPropagation();
    if (!fibre || diving()) return;
    const wasOpen = !pop.hidden && pop.dataset.for === 'factor';
    pop.replaceChildren();
    pop.dataset.for = 'factor';
    pop.hidden = wasOpen;
    if (wasOpen) return;
    const r = fibre.region, now = regionFactor(r), has = notesBetween(pattern(), r) > 0;
    const grid = document.createElement('div');
    grid.className = 'zoom-grid';
    let anyLoss = false;
    for (let m = 1; m <= MAX_ZOOM; m++) {
      const lost = zoomPlan(pattern(), r, m, true).lost;
      const b = button(times(m), () => { pop.hidden = true; void setFactor(m); });
      if (m === now) b.classList.add('on');
      else if (has && lost) { b.classList.add('lossy'); anyLoss = true; }
      else if (has) b.classList.add('keeps');
      b.title = m === 1 ? 'No fibres: back to plain cells' : lost ? `${m} fibres per thread: clears ${lost} note${lost === 1 ? '' : 's'}` : `${m} fibres per thread`;
      grid.append(b);
    }
    const head = document.createElement('p');
    head.textContent = 'Fibres per thread';
    pop.append(head, grid);
    if (anyLoss) {
      const foot = document.createElement('p');
      foot.className = 'zoom-foot';
      foot.textContent = 'Bright: keeps every note. Dim: clears some notes between the beats (it asks first).';
      pop.append(foot);
    }
  };
  // One button. With a selection, or inside a region, the whole of it goes between threads and
  // fibres. Otherwise it has two halves: the thread line slides on to the next fabric (once
  // there is more than one), and the grid zooms out to the table of fabrics.
  let zoomTouch = false, armed = 0;
  $('zoom').addEventListener('pointerdown', (e) => { zoomTouch = e.pointerType === 'touch'; });
  $('zoom').onclick = (e) => {
    e.stopPropagation();
    if (diving() || tableBusy) return;
    if (tableOpen) return closeTable(tableSel >= 0 ? tableSel : cur);
    if (fibre) return leaveFibre();
    const r = selRect();
    if (r) return enterFibre(r);
    const box = $('zoom').getBoundingClientRect();
    if (e.detail === 0 || e.clientX > box.left + box.width / 2) return openTable();
    if (items.length < 2) return;
    const line = document.querySelector('#zoom .z-thread')!;
    if (zoomTouch && !line.classList.contains('armed')) {
      // Touch has no hover: the first tap shows where this goes, a second tap goes.
      line.classList.add('armed');
      window.clearTimeout(armed);
      armed = window.setTimeout(() => line.classList.remove('armed'), 2600);
      return;
    }
    line.classList.remove('armed');
    nextFabric();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !(e.target as HTMLElement).closest('.zoom-wrap')) pop.hidden = true;
  });
}
$('undo').onclick = () => { history.undo(); clearSelection(); updateLevel(); };
$('redo').onclick = () => { history.redo(); clearSelection(); updateLevel(); };
$('tool-draw').onclick = () => setTool('draw');
$('tool-select').onclick = () => setTool('select');
// A short note at the bottom of the screen that goes away by itself.
let toastTimer = 0;
function toast(text: string, ms = 2000) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.append(el); }
  el.textContent = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.remove(), ms);
}
if (arrivalNote) toast(arrivalNote, 9000);

// Share: the open fabric as a link. Copied on a computer; handed to the share sheet on a phone.
const SHARED_KEY = 'orimono.shared';
$('share').onclick = async () => {
  const url = `${location.origin}${location.pathname}#${packFabric(pattern(), bpmOf(items[cur]))}`;
  let said = 'Link copied.';
  try {
    if (matchMedia('(pointer: coarse)').matches && navigator.share) { await navigator.share({ title: 'Orimono', url }); said = ''; }
    else await navigator.clipboard.writeText(url);
  } catch (err) {
    if ((err as Error).name === 'AbortError') return; // the share sheet was closed
    window.prompt('Copy this link:', url);
    said = '';
  }
  // The first time, say what a link holds.
  if (!localStorage.getItem(SHARED_KEY)) {
    localStorage.setItem(SHARED_KEY, '1');
    toast(`${said} A link carries this fabric's beat and tempo. Sounds and row levels stay with you.`.trim(), 8000);
  } else if (said) toast(said);
};
$('sounds').onclick = () => $<HTMLDialogElement>('credits').showModal();

// New sits behind the length readout: picking it shows what it does before it does it.
{
  const pop = $('new-pop');
  const close = () => { pop.hidden = true; $('length').classList.remove('on'); };
  $('length').onclick = (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    close();
    if (open) {
      pop.hidden = false;
      $('length').classList.add('on');
      $('new-what').textContent = items.length === 1 ? 'This will reset everything: the work here, the tempo and the row levels.' : 'This will reset the work here.';
    }
  };
  $('new').onclick = () => {
    applyStructure(fresh());
    if (items.length === 1) {
      // The only fabric: a clean start all round, tempo and row levels too.
      projectBpm = fresh().bpm;
      items[0].bpm = null;
      mix = {};
      engine.setMix(mix);
      save();
      updateLevel();
    }
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
  const clampBpm = (b: number) => Math.max(BPM_MIN * tempoScale(), Math.min(BPM_MAX * tempoScale(), b));
  const toBpm = (u: number) => clampBpm(Math.round(Math.exp(u)));
  let startY = 0, startU = 0;
  knob.addEventListener('pointerdown', (e) => {
    knob.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startU = Math.log(tempoReading());
    history.begin();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!knob.hasPointerCapture(e.pointerId)) return;
    const next = toBpm(startU + (startY - e.clientY) * LOG_PER_PX * (e.shiftKey ? 0.25 : 1));
    if (next !== tempoReading()) setTempo(next);
  });
  const done = () => { history.end(); updatePanel(); };
  knob.addEventListener('pointerup', done);
  knob.addEventListener('pointercancel', done);
  // Scroll: a mouse wheel notch is one BPM; a trackpad's many small scroll events add up smoothly.
  let wheelTimer = 0, wheelU = 0, wheeling = false;
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!wheeling) { history.begin(); wheeling = true; wheelU = Math.log(tempoReading()); }
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const notch = Math.abs(px) >= 50; // a mouse wheel click
    const cur = tempoReading();
    if (notch) wheelU = Math.log(Math.round(cur) - Math.sign(px));
    else wheelU -= px * LOG_PER_PX * 0.5;
    const next = toBpm(wheelU);
    if (next !== cur) setTempo(next);
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => { wheeling = false; done(); }, 400);
  }, { passive: false });
  knob.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    e.stopPropagation();
    const b = tempoReading();
    setTempo(clampBpm(step > 0 ? Math.floor(b) + 1 : Math.ceil(b) - 1));
  });
  const input = $<HTMLInputElement>('bpm-input');
  const openInput = () => {
    input.value = String(tempoReading());
    input.hidden = false;
    input.focus();
    input.select();
  };
  knob.addEventListener('dblclick', openInput);
  $('bpm').addEventListener('dblclick', openInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = String(tempoReading()); input.blur(); }
  });
  input.addEventListener('blur', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) setTempo(clampBpm(v));
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
    if (lastPointer === 'touch') {
      foot.append(button('Copy', doCopy), button('Paste', doPaste, { disabled: !clip }));
      actions.append(foot);
    }
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
  // Inside a region: its notes go, its fibres stay.
  if (fibre) return history.apply(clearRect(pattern(), fibre.region));
  // At thread level everything in the area goes, and emptied regions become plain cells again.
  const area = selRect() ?? { t0: 0, t1: pattern().threads.length - 1, r0: 0, r1: ROWS.length - 1 };
  history.apply(zoomRect(clearRect(pattern(), area), area, 1));
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

// ---------------------------------------------------------------- fabrics: the table

const table = $('table'), cards = $('cards');
let tableOpen = false; // out on the table of fabrics
let tableBusy = false; // the view is on its way out or back in
let tableSel = -1; // the picked fabric, or -1 for none
let sliding = false;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const DIVE = { duration: 520, easing: 'cubic-bezier(.65,0,.35,1)' };

/** Open fabric i among the threads. If something is playing, it carries straight on with this fabric. */
function switchTo(i: number) {
  cur = Math.max(0, Math.min(items.length - 1, i));
  history = items[cur].history;
  clearSelection();
  renderer.reset();
  view.playheadId = null;
  view.hover = { kind: 'none' };
  view.hoverRegion = null;
  if (scheduler.playing && playId !== items[cur].id) {
    scheduler.stop();
    playId = items[cur].id;
    scheduler.start();
  }
  playId = scheduler.playing ? playId : items[cur].id;
  updateLevel();
  save();
}

// On the table a fabric is drawn as plain cloth: strings, beads and group colours, nothing
// else. Its width is its length in time, so a thread is as wide in one fabric as in the next
// (at the same tempo), and the shuttle crosses every fabric at one steady speed.
const CLOTH_H = 150, CLOTH_BAND = 5;
const clothPad = (cw: number) => Math.min(4, cw * 0.3); // how far inside its cell a string sits

function drawCloth(cv: HTMLCanvasElement, p: Pattern, w: number, h = CLOTH_H) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const n = p.threads.length, cw = w / n, rh = (h - CLOTH_BAND) / ROWS.length, pad = clothPad(cw);
  ctx.fillStyle = '#1f1f1f';
  ctx.fillRect(0, 0, w, h);
  for (const r of runs(p)) {
    const hex = PALETTE[r.colour].hex, x0 = r.start * cw, x1 = r.end * cw;
    ctx.fillStyle = hex;
    ctx.globalAlpha = 0.07;
    ctx.fillRect(x0, 0, x1 - x0, h - CLOTH_BAND);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(x0 + 0.5, h - CLOTH_BAND + 1, x1 - x0 - 1, CLOTH_BAND - 1);
  }
  const rMax = Math.max(1.2, Math.min(3.8, cw * 0.42, rh * 0.48));
  p.threads.forEach((t, i) => {
    const hex = PALETTE[p.groups[t.group].colour].hex, x = i * cw + pad;
    ctx.fillStyle = hex;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(Math.round(x) - 0.5, 0, 1, h - CLOTH_BAND);
    ctx.globalAlpha = 1;
    ROWS.forEach((row, ri) => {
      const lane = t.lanes[row];
      lane?.slots.forEach((hit, k) => {
        if (!hit) return;
        ctx.beginPath();
        ctx.arc(x + (k * cw) / lane.zoom, (ri + 0.5) * rh, rMax * (0.45 + 0.55 * hit.v) * (lane.zoom > 1 ? 0.75 : 1), 0, Math.PI * 2);
        ctx.fill();
      });
    });
  });
}

const cardEls = () => [...cards.querySelectorAll<HTMLElement>('.card')];
const lengthOf = (it: Item) => `${(it.history.current.threads.length * threadSeconds(bpmOf(it))).toFixed(2)} s`;

function markPlaying() {
  cardEls().forEach((c, i) => c.classList.toggle('playing', scheduler.playing && items[i]?.id === playId));
  if (!scheduler.playing) {
    // Stopped: the shuttle fades out where it was and fades in again where it rests.
    if (shuttleAt && lastShuttle && tableOpen) stopFade = { ...lastShuttle, t0: performance.now(), pps: pxPerSecond() };
    shuttleAt = null;
    cameFrom = null;
  }
}

// The shuttle. Out on the table, playing is a shuttle carried along the strand over each line of
// fabrics, left to right, trailing its thread. It rests where playing will start (drag it to
// choose), follows the real playhead, and never jumps: at the end of a line it runs on to the
// right edge and fades, while the next one is already gliding in from the left edge of the line
// below, arriving at that line's first fabric exactly on time.
let playStart: { id: number; index: number } | null = null; // where the shuttle rests
let shuttleAt: { id: number; index: number; time: number } | null = null; // the playhead: fabric, thread, when it began
let cameFrom: { id: number; time: number } | null = null; // the fabric just left, and when
let shuttleDrag = false;
let lastShuttle: { x: number; g: { y: number; h: number } } | null = null; // where the moving shuttle was last drawn
let stopFade: { x: number; g: { y: number; h: number }; t0: number; pps: number } | null = null;
const shuttles = [0, 1, 2].map(() => {
  const el = document.createElement('div');
  el.className = 'shuttle';
  el.innerHTML = '<i></i>';
  return el;
});

function startPlace() {
  const it = items.find((x) => x.id === playStart?.id) ?? items[0];
  const index = it.id === playStart?.id ? Math.min(playStart.index, it.history.current.threads.length - 1) : 0;
  return { it, index };
}

/** Where fabric i's cloth sits on the table. */
function clothAt(i: number) {
  const card = cardEls()[i], pic = card.querySelector<HTMLElement>('.card-pic')!, n = items[i].history.current.threads.length;
  const cw = pic.offsetWidth / n;
  return { left: card.offsetLeft, right: card.offsetLeft + pic.offsetWidth, y: card.offsetTop + pic.offsetTop, h: pic.offsetHeight, cw, pad: clothPad(cw), n };
}

function showShuttle(k: number, x: number, g: { y: number; h: number }, opacity: number, onCloth: boolean, trail: boolean) {
  const el = shuttles[k];
  if (!el.isConnected) cards.append(el);
  el.style.transform = `translate(${x}px, ${g.y}px)`;
  el.style.height = `${g.h}px`;
  el.style.opacity = String(opacity);
  el.classList.toggle('line', onCloth);
  el.classList.toggle('trail', trail);
  el.classList.toggle('rest', k === 0); // the leading shuttle can always be picked up
}
const hideShuttle = (k: number) => shuttles[k].remove();

function moveShuttle() {
  for (const f of scheduler.due()) {
    if (!f.start) continue;
    const it = items.find((x) => x.history.current === f.of);
    const index = it ? f.of.threads.findIndex((t) => t.id === f.threadId) : -1;
    if (!it || index < 0) continue;
    if (shuttleAt && (shuttleAt.id !== it.id || index < shuttleAt.index)) cameFrom = { id: shuttleAt.id, time: f.time };
    shuttleAt = { id: it.id, index, time: f.time };
  }
  if (!cardEls().length) return;
  const i = shuttleAt ? items.findIndex((it) => it.id === shuttleAt!.id) : -1;
  if (!scheduler.playing || !shuttleAt || i < 0 || shuttleDrag) {
    // At rest: waiting at the place playing will start from.
    const { it, index } = startPlace(), g = clothAt(items.indexOf(it));
    // Stopped a moment ago: it glides on and fades over a short run, just as it does at the
    // end of a line, while the resting one fades in.
    const ran = stopFade ? ((performance.now() - stopFade.t0) / 1000) * stopFade.pps : 0;
    const f = stopFade ? Math.min(1, ran / 24) : 1;
    showShuttle(0, g.left + g.pad + index * g.cw, g, f, true, false);
    hideShuttle(1);
    if (stopFade && f < 1) showShuttle(2, stopFade.x + ran, stopFade.g, 1 - f, false, true);
    else { hideShuttle(2); stopFade = null; }
    return;
  }
  const now = engine.ctx.currentTime, pps = pxPerSecond(), edge = 14, far = cards.clientWidth - 14;
  const g = clothAt(i), sec = threadSeconds(bpmOf(items[i]));
  const into = Math.max(0, Math.min(1, (now - shuttleAt.time) / sec));
  lastShuttle = { x: g.left + g.pad + (shuttleAt.index + into) * g.cw, g };
  showShuttle(0, lastShuttle.x, g, 1, true, true);
  // The next fabric, when it is not simply the neighbour on the right: its shuttle comes in
  // from the left edge, timed to reach the fabric's first thread as this one finishes.
  const j = (i + 1) % items.length, gj = clothAt(j);
  const x = gj.left + gj.pad - (g.n - shuttleAt.index - into) * sec * pps;
  if (!(j === i + 1 && gj.y === g.y) && x >= edge) showShuttle(1, x, gj, Math.min(1, (x - edge) / 24), false, true);
  else hideShuttle(1);
  // The fabric just left, likewise: its shuttle runs on to the right edge and fades.
  const k = cameFrom ? items.findIndex((it) => it.id === cameFrom!.id) : -1;
  if (cameFrom && k >= 0) {
    const gk = clothAt(k), xo = gk.right + gk.pad + (now - cameFrom.time) * pps;
    // It fades out within a short run past the end of the cloth, however much room is left.
    const run = Math.min(24, far - gk.right - gk.pad), gone = xo - gk.right - gk.pad; // as quick as the fade-in
    if (!(i === k + 1 && gk.y === g.y) && gone < run) showShuttle(2, xo, gk, Math.max(0, 1 - gone / run), false, true);
    else { hideShuttle(2); if (gone >= run) cameFrom = null; }
  } else hideShuttle(2);
}

// Drag the shuttle along the strands to choose where playing starts (it snaps to a thread).
// Dragged while playing, it carries on from where it is let go.
{
  const head = shuttles[0];
  const place = (e: PointerEvent) => {
    const box = cards.getBoundingClientRect(), x = e.clientX - box.left, y = e.clientY - box.top;
    let best = 0, bestD = Infinity;
    items.forEach((_, i) => {
      const g = clothAt(i);
      const d = Math.abs(y - g.y) * 1000 + (x < g.left ? g.left - x : x > g.right ? x - g.right : 0); // the nearest line first, then the fabric
      if (d < bestD) { bestD = d; best = i; }
    });
    const g = clothAt(best);
    playStart = { id: items[best].id, index: Math.max(0, Math.min(g.n - 1, Math.round((x - g.left - g.pad) / g.cw))) };
  };
  head.addEventListener('pointerdown', (e) => { head.setPointerCapture(e.pointerId); shuttleDrag = true; place(e); e.stopPropagation(); });
  head.addEventListener('pointermove', (e) => { if (shuttleDrag) place(e); });
  const end = () => {
    if (!shuttleDrag) return;
    shuttleDrag = false;
    if (scheduler.playing) { togglePlay(); togglePlay(); } // carry on from the new place
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  head.addEventListener('click', (e) => e.stopPropagation());
}

function pickCard(i: number) {
  tableSel = Math.max(-1, Math.min(items.length - 1, i));
  renderTable();
  if (tableSel >= 0) cardEls()[tableSel]?.scrollIntoView({ block: 'nearest' });
  updateLevel();
}
// A press on the bare table lets go of the picked fabric.
table.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.card, .shuttle, .stored') && (tableSel >= 0 || shelfSel >= 0)) { shelfSel = -1; pickCard(-1); } });

/** How wide a second of music is on the table: a thread at the table's tempo is about 22 px,
 * less if the longest fabric would not fit on one line. */
function pxPerSecond() {
  const room = Math.max(200, table.clientWidth - 36 - 72);
  const longest = Math.max(...items.map((it) => it.history.current.threads.length * threadSeconds(bpmOf(it))));
  return Math.min(22 / threadSeconds(projectBpm), room / longest);
}
// Exactly its length in time, however short: the shuttle keeps one speed over every fabric.
const clothWidth = (it: Item, pps: number) => Math.max(6, Math.round(it.history.current.threads.length * threadSeconds(bpmOf(it)) * pps));

function renderTable() {
  const scroll = table.scrollTop;
  cards.replaceChildren();
  const pps = pxPerSecond(), h = CLOTH_H;
  let prevW = Infinity, prevHigh = false;
  items.forEach((it, i) => {
    const card = document.createElement('div');
    card.className = `card${i === tableSel ? ' sel' : ''}${it.bpm !== null ? ' cut' : ''}`;
    card.dataset.i = String(i);
    const w = clothWidth(it, pps);
    card.style.width = `${w}px`;
    // The number hangs straight above the fabric's first thread, where the shuttle waits to
    // play it from the start. After a very short fabric the next number sits higher, so the
    // two never touch.
    const x0 = clothPad(w / it.history.current.threads.length);
    const high = prevW < 30 && !prevHigh, laneH = high ? 96 : 68, H = laneH - 26;
    prevW = w;
    prevHigh = high;
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.style.height = `${laneH}px`;
    const n = document.createElement('button');
    n.className = 'card-n';
    n.style.left = `${x0 - 13}px`;
    n.textContent = String(i + 1);
    // The tie from the number down to the table's tempo thread, with a bow in it, clear of both
    // the number and the shuttle. Cut the bow and the fabric keeps a tempo of its own; tie it
    // again and it follows the table's.
    const c = H - 28; // the bow's height on the tie
    const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    art.setAttribute('class', 'tie-art');
    art.setAttribute('width', '32');
    art.setAttribute('height', String(H));
    art.style.left = `${x0 - 16}px`;
    art.innerHTML = `<path class="tie-up" d="M16 0 V${c - 3}" style="transform-origin:16px 0"/>`
      + `<path class="tie-down" d="M16 ${c + 3} V${H}" style="transform-origin:16px ${H}px"/>`
      + `<g class="bow" style="transform-origin:16px ${c}px"><path d="M16 ${c} C7 ${c - 9} 2 ${c + 2} 16 ${c} C30 ${c + 2} 25 ${c - 9} 16 ${c}"/><circle cx="16" cy="${c}" r="2.2"/></g>`;
    const tie = document.createElement('button');
    tie.className = 'tie';
    tie.style.left = `${x0 - 13}px`;
    tie.style.top = `${26 + c - 10}px`;
    tie.style.setProperty('--above', `${-(26 + c - 10) - 16}px`); // for the mark, when there is no room beside the bow
    if (w < 44) card.classList.add('narrow');
    const picked = i === tableSel;
    const label = () => {
      tie.title = !picked ? "A bow in the tie to the table's tempo. Pick the fabric's number to cut or tie it"
        : it.bpm === null ? 'Cut: this fabric keeps a tempo of its own (set it inside, with the tempo knob)' : `Tie: follow the table's tempo again (its own is ${it.bpm} BPM)`;
      tie.dataset.mark = it.bpm === null ? '✂' : '⋈';
      n.title = `Fabric ${i + 1}, ${lengthOf(it)}${it.bpm !== null ? `, own tempo ${it.bpm} BPM` : ''}. Tap to pick, drag to move or to put away`;
    };
    label();
    // With the number picked, a press on the bow cuts (or ties) it. Otherwise the bow is just
    // there to be played with: pull it sideways and let go, and it springs back like a string.
    const up = art.querySelector<SVGPathElement>('.tie-up')!, down = art.querySelector<SVGPathElement>('.tie-down')!, bow = art.querySelector<SVGGElement>('.bow')!;
    let spring = 0;
    const pull = (dx: number) => {
      up.setAttribute('d', `M16 0 L${16 + dx} ${c - 3}`);
      down.setAttribute('d', `M${16 + dx} ${c + 3} L16 ${H}`);
      bow.style.transition = dx ? 'none' : '';
      bow.style.transform = dx ? `translateX(${dx}px)` : '';
    };
    const letGo = (from: number) => {
      cancelAnimationFrame(spring);
      const t0 = performance.now();
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        if (t > 0.8 || still()) return pull(0);
        pull(from * Math.exp(-t / 0.16) * Math.cos(2 * Math.PI * 6 * t));
        spring = requestAnimationFrame(step);
      };
      step();
    };
    let px = 0, pulled = 0, moved = false, touch = false, armed = 0;
    tie.addEventListener('pointerdown', (e) => { tie.setPointerCapture(e.pointerId); touch = e.pointerType === 'touch'; px = e.clientX; pulled = 0; moved = false; cancelAnimationFrame(spring); e.stopPropagation(); });
    tie.addEventListener('pointermove', (e) => {
      if (!tie.hasPointerCapture(e.pointerId) || it.bpm !== null) return;
      if (Math.abs(e.clientX - px) > 3) moved = true;
      pulled = Math.max(-13, Math.min(13, (e.clientX - px) * 0.7));
      if (moved) pull(pulled);
    });
    tie.addEventListener('pointerup', () => {
      if (moved) return letGo(pulled);
      if (!picked) { if (it.bpm === null) letGo(7); return; }
      if (touch && !tie.classList.contains('armed')) {
        // Touch has no hover: the first tap shows the mark, a second tap does it.
        tie.classList.add('armed');
        window.clearTimeout(armed);
        armed = window.setTimeout(() => tie.classList.remove('armed'), 3000);
        return;
      }
      tie.classList.remove('armed');
      // Cutting keeps the tempo it had, so nothing moves: only the bow comes undone (or is tied).
      pull(0);
      it.bpm = it.bpm === null ? projectBpm : null;
      card.classList.toggle('cut', it.bpm !== null);
      label();
      save();
      updatePanel();
      if (it.bpm === null) window.setTimeout(() => { if (tableOpen && !tableBusy) renderTable(); }, 560);
    });
    tie.addEventListener('click', (e) => e.stopPropagation());
    lane.append(art, tie, n);
    const pic = document.createElement('canvas');
    pic.className = 'card-pic';
    pic.style.width = `${w}px`;
    pic.style.height = `${h}px`;
    pic.title = 'Go into this fabric';
    pic.onclick = () => closeTable(i);
    card.append(lane, pic);
    dragCard(n, card, i);
    cards.append(card);
    drawCloth(pic, it.history.current, w);
  });
  // The working edge: where new cloth is made.
  const add = document.createElement('div');
  add.className = 'card add';
  add.style.width = '44px';
  const plus = button('+', addFabric);
  plus.className = 'card-add';
  plus.title = 'A new fabric at the end: one cell, to grow as you like';
  plus.style.height = `${h}px`;
  add.append(plus);
  cards.append(add);
  drawThread();
  renderShelf();
  table.scrollTop = scroll;
  markPlaying();
  updatePanel();
}

// ---------------------------------------------------------------- fabrics: the shelf

const shelfEl = $('shelf');
let shelfSel = -1; // the picked fabric on the shelf, or -1
const SHELF_H = 54;

/** Where a fabric dropped at this point would land among the cards, in reading order, and where to draw the mark. */
function dropPlace(clientX: number, clientY: number, skip?: HTMLElement) {
  const others = cardEls().filter((c) => c !== skip);
  const before = (c: HTMLElement) => {
    const b = c.getBoundingClientRect();
    return clientY > b.bottom || (clientY >= b.top && clientX > b.left + b.width / 2);
  };
  const real = others.filter((c) => !c.classList.contains('add'));
  const to = Math.min(real.filter(before).length, real.length);
  const at = real[to], mark = at ?? real[real.length - 1];
  const pic = mark?.querySelector<HTMLElement>('.card-pic');
  return { to, mark: mark && pic ? { left: mark.offsetLeft + (at ? 0 : mark.offsetWidth), top: mark.offsetTop + pic.offsetTop, height: pic.offsetHeight } : null };
}
// The shelf is a drawer above the toolbar: out of sight until a fabric is picked up, when it
// pulled out on purpose. Once something is in it, its lip shows at the top edge.
const drawer = $('drawer');
let drawerTimer = 0;
function openDrawer(on: boolean, after = 0) {
  window.clearTimeout(drawerTimer);
  drawerTimer = window.setTimeout(() => drawer.classList.toggle('open', on), after);
}
const overShelf = (clientY: number) => drawer.classList.contains('open') && clientY < drawer.getBoundingClientRect().bottom;
// The drawer and the toolbar are one piece of furniture: scroll up over either to pull the
// drawer out above the toolbar (both stay in view), scroll down to push it back, or press its
// handle. It never moves by itself: picking a fabric up leaves it as it is, in or out.
const setDrawer = (on: boolean) => openDrawer(on);
for (const el of [drawer, $('panel')]) {
  el.addEventListener('wheel', (e) => {
    if (!tableOpen || Math.abs(e.deltaY) < 4 || (e.target as HTMLElement).closest('#knob, #shelf')) return;
    e.preventDefault();
    setDrawer(e.deltaY < 0);
  }, { passive: false });
}
// On a touchscreen: swipe down over the toolbar (or the drawer's edge) to pull the drawer out,
// swipe up to push it back.
{
  let swipe: { id: number; y: number } | null = null, swiped = 0;
  for (const el of [drawer, $('panel')]) {
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !tableOpen || (e.target as HTMLElement).closest('#knob, #shelf')) return;
      swipe = { id: e.pointerId, y: e.clientY };
    });
  }
  window.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id || Math.abs(e.clientY - swipe.y) < 24) return;
    setDrawer(e.clientY > swipe.y);
    swipe = null;
    swiped = performance.now();
  });
  const end = (e: PointerEvent) => { if (swipe?.id === e.pointerId) swipe = null; if (swiped) swiped = performance.now(); };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // A swipe that began on a button is not a press of that button.
  document.addEventListener('click', (e) => {
    if (swiped && performance.now() - swiped < 350) { e.stopPropagation(); e.preventDefault(); }
    swiped = 0;
  }, true);
}
drawer.querySelector<HTMLElement>('.drawer-lip')!.onclick = () => setDrawer(!drawer.classList.contains('open'));

function renderShelf() {
  shelfEl.replaceChildren();
  drawer.classList.toggle('has', shelf.fabrics.length > 0);
  shelf.fabrics.forEach((f, i) => {
    const n = f.pattern.threads.length;
    const w = Math.max(26, Math.min(220, Math.round(n * 5 * (projectBpm / (f.bpm ?? projectBpm)))));
    const el = document.createElement('canvas');
    el.className = i === shelfSel ? 'stored sel' : 'stored';
    el.style.width = `${w}px`;
    el.style.height = `${SHELF_H}px`;
    el.title = `${n} thread${n === 1 ? '' : 's'}${f.bpm !== null ? `, own tempo ${f.bpm} BPM` : ''}. Drag down to the table for a copy; tap to pick`;
    drawCloth(el, f.pattern, w, SHELF_H);
    dragStored(el, i);
    shelfEl.append(el);
  });
}

/** Drag a stored fabric down onto the table: a copy lands where it is dropped. A tap picks it. */
function dragStored(el: HTMLCanvasElement, i: number) {
  let x0 = 0, y0 = 0, moved = false, ghost: HTMLCanvasElement | null = null, to = -1;
  const line = document.createElement('div');
  line.className = 'drop-line';
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); x0 = e.clientX; y0 = e.clientY; moved = false; to = -1; });
  el.addEventListener('pointermove', (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > 6) moved = true;
    if (!moved) return;
    if (!ghost) {
      ghost = document.createElement('canvas');
      ghost.className = 'stored ghost';
      ghost.width = el.width; ghost.height = el.height;
      ghost.style.width = el.style.width; ghost.style.height = el.style.height;
      ghost.getContext('2d')!.drawImage(el, 0, 0);
      document.body.append(ghost);
    }
    ghost.style.transform = `translate(${e.clientX - el.offsetWidth / 2}px, ${e.clientY - SHELF_H / 2}px)`;
    if (overShelf(e.clientY)) { to = -1; line.remove(); return; }
    const place = dropPlace(e.clientX, e.clientY);
    to = place.to;
    if (place.mark) {
      line.style.left = `${place.mark.left}px`;
      line.style.top = `${place.mark.top}px`;
      line.style.height = `${place.mark.height}px`;
      if (!line.isConnected) cards.append(line);
    }
  });
  const end = () => {
    ghost?.remove();
    ghost = null;
    line.remove();
    if (!moved) { shelfSel = shelfSel === i ? -1 : i; tableSel = -1; renderTable(); updateLevel(); return; }
    if (to < 0 || items.length >= MAX_FABRICS) return;
    const f = shelf.fabrics[i], open = items[cur].id;
    items.splice(to, 0, makeItem(structuredClone(f.pattern), f.bpm));
    cur = items.findIndex((x) => x.id === open);
    shelfSel = -1;
    save();
    pickCard(to);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Put fabric i away on the shelf: it leaves the table (one fabric always stays). */
function storeFabric(i: number) {
  if (items.length < 2) return;
  const open = items[cur].id, [it] = items.splice(i, 1);
  shelf.fabrics.unshift({ pattern: it.history.current, bpm: it.bpm });
  if (scheduler.playing && playId === it.id) togglePlay();
  cur = Math.max(0, items.findIndex((x) => x.id === open));
  history = items[cur].history;
  renderer.reset();
  save();
  pickCard(-1);
}

async function deleteStored(i: number) {
  if (!shelf.fabrics[i] || !(await ask("Delete this fabric from the shelf? It can't be brought back.", 'Delete'))) return;
  shelf.fabrics.splice(i, 1);
  shelfSel = -1;
  save();
  renderTable();
  updateLevel();
}

/** The tempo thread: one strand comes down from the tempo knob along the left edge, and from
 * it a thread runs along each line of fabrics, right across to the far edge. */
function drawThread() {
  const els = cardEls().filter((c) => !c.classList.contains('add'));
  if (!els.length) return;
  const ys = [...new Set(els.map((c) => c.offsetTop + c.querySelector<HTMLElement>('.card-pic')!.offsetTop))]; // along the top edge of the cloth
  const box = cards.getBoundingClientRect(), knob = $('knob').getBoundingClientRect();
  const x = 14, right = cards.clientWidth - 14, top = -24; // from under the shelf, below the knob
  const kx = Math.max(x + 24, knob.left + knob.width / 2 - box.left), r = 10, last = ys[ys.length - 1];
  // Straight down from the knob onto the first line's thread; that thread turns down the left
  // edge and round into the last line, and the lines between branch off the edge.
  let d = `M ${kx} ${top} V ${ys[0]} M ${right} ${ys[0]} H ${x + (ys.length > 1 ? r : 0)}`;
  if (ys.length > 1) d += ` q ${-r} 0 ${-r} ${r} V ${last - r} q 0 ${r} ${r} ${r} H ${right}`;
  for (const y of ys.slice(1, -1)) d += ` M ${x} ${y} H ${right}`;
  threadGeo = { x, right, kx, top, ys };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'tempo-thread');
  svg.setAttribute('width', String(cards.scrollWidth));
  svg.setAttribute('height', String(cards.scrollHeight));
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  cards.prepend(svg);
}
let threadGeo: { x: number; right: number; kx: number; top: number; ys: number[] } | null = null;

/** When playing starts, a pulse runs out from the knob along every strand and down each tie
 * into the fabrics' numbers: the tempo reaching them. A fabric whose tie is cut gets none. */
function pulseThread() {
  const svg = cards.querySelector('.tempo-thread');
  if (!svg || !threadGeo || still()) return;
  const { x, right, kx, top, ys } = threadGeo, speed = 1500, dash = 46; // px per second
  const run = (d: string, len: number, delay: number) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'pulse');
    path.setAttribute('d', d);
    path.style.strokeDasharray = `${dash} ${len + 200}`;
    svg.append(path);
    void path.animate([{ strokeDashoffset: dash }, { strokeDashoffset: -len }], { duration: (len / speed) * 1000, delay: delay * 1000, fill: 'both' }).finished.then(() => path.remove());
  };
  const down = ys[0] - top, last = ys[ys.length - 1];
  const reach = (y: number) => down + (y === ys[0] ? 0 : kx - x + (y - ys[0])); // how far the pulse has run when it gets to a line
  run(`M ${kx} ${top} V ${ys[0]}`, down, 0);
  run(`M ${kx} ${ys[0]} H ${right}`, right - kx, down / speed);
  run(`M ${kx} ${ys[0]} H ${x}${ys.length > 1 ? ` V ${last}` : ''}`, kx - x + last - ys[0], down / speed);
  for (const y of ys.slice(1)) run(`M ${x} ${y} H ${right}`, right - x, reach(y) / speed);
  cardEls().forEach((card, i) => {
    const bead = card.querySelector<HTMLElement>('.card-n'), pic = card.querySelector<HTMLElement>('.card-pic');
    if (!bead || !pic || !items[i] || items[i].bpm !== null) return;
    const y = card.offsetTop + pic.offsetTop, tx = card.offsetLeft + clothPad(pic.offsetWidth / items[i].history.current.threads.length);
    const far = reach(y) + (y === ys[0] ? Math.abs(tx - kx) : tx - x);
    bead.animate([{ background: 'var(--bg)', color: 'var(--text)' }, { background: 'var(--accent)', color: 'var(--bg)', offset: 0.25 }, { background: 'var(--bg)', color: 'var(--text)' }],
      { duration: 520, delay: (far / speed) * 1000 });
  });
}
window.addEventListener('resize', () => { if (tableOpen && !tableBusy) renderTable(); });

/** Drag a card by its number to a new place in the order. */
function dragCard(handle: HTMLElement, card: HTMLElement, i: number) {
  let x0 = 0, y0 = 0, moved = false, to = i, ghost: HTMLCanvasElement | null = null, home: DOMRect | null = null;
  const line = document.createElement('div');
  line.className = 'drop-line';
  handle.addEventListener('pointerdown', (e) => { handle.setPointerCapture(e.pointerId); x0 = e.clientX; y0 = e.clientY; moved = false; to = i; });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > 6) moved = true;
    if (!moved) return;
    // Picked up: a copy of its cloth follows the pointer (over everything, the drawer too),
    // and the fabric itself waits, faint, in its place.
    const src = card.querySelector<HTMLCanvasElement>('.card-pic')!;
    if (!ghost) {
      home = src.getBoundingClientRect();
      ghost = document.createElement('canvas');
      ghost.className = 'stored ghost';
      ghost.width = src.width; ghost.height = src.height;
      ghost.style.width = src.style.width; ghost.style.height = src.style.height;
      ghost.getContext('2d')!.drawImage(src, 0, 0);
      document.body.append(ghost);
      card.classList.add('dragging');
    }
    ghost.style.transform = `translate(${home!.left + e.clientX - x0}px, ${e.clientY - 22}px)`; // held near its top edge, so it goes where the pointer goes
    // Over the shelf it would be put away; anywhere else it lands among the other fabrics.
    const away = overShelf(e.clientY) && items.length > 1;
    drawer.classList.toggle('over', away);
    if (away) { to = -1; line.remove(); return; }
    const place = dropPlace(e.clientX, e.clientY, card);
    to = place.to;
    if (place.mark) {
      line.style.left = `${place.mark.left}px`;
      line.style.top = `${place.mark.top}px`;
      line.style.height = `${place.mark.height}px`;
      if (!line.isConnected) cards.append(line);
    }
  });
  const end = () => {
    line.remove();
    ghost?.remove();
    ghost = null;
    card.classList.remove('dragging');
    drawer.classList.remove('over');
    if (!moved) { shelfSel = -1; return pickCard(i); }
    if (to < 0) return storeFabric(i);
    const open = items[cur].id;
    const [it] = items.splice(i, 1);
    items.splice(to, 0, it);
    cur = items.findIndex((x) => x.id === open);
    tableSel = to;
    save();
    renderTable();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** A new fabric starts as a single cell: its groups are yours to grow. */
function addFabric() {
  if (items.length >= MAX_FABRICS) return;
  items.push(makeItem(single()));
  save();
  pickCard(items.length - 1);
  closeTable(items.length - 1); // straight into it: one cell is a small thing to have to tap
}

/** A copy right after the original: this is how a fabric is repeated, or varied. */
function duplicateFabric(i: number) {
  if (items.length >= MAX_FABRICS) return;
  items.splice(i + 1, 0, makeItem(structuredClone(items[i].history.current), items[i].bpm));
  if (cur > i) cur++;
  save();
  pickCard(i + 1);
}

async function deleteFabric(i: number) {
  if (items.length < 2) return;
  if (!(await ask(`Delete fabric ${i + 1}? It can't be brought back.`, 'Delete'))) return;
  const open = items[cur].id, gone = items[i].id;
  items.splice(i, 1);
  if (scheduler.playing && playId === gone) togglePlay();
  cur = Math.max(0, items.findIndex((x) => x.id === open));
  history = items[cur].history;
  renderer.reset();
  save();
  pickCard(Math.min(i, items.length - 1));
}

/** The transform that lays the grid's matrix (first string to the end of the last cell, top row
 * to bottom row) exactly onto a fabric's cloth on the table. */
function ontoCloth(pic: HTMLElement) {
  const a = stage.getBoundingClientRect(), b = pic.getBoundingClientRect(), L = layout, n = L.xs.length;
  const x0 = cellL(L, 0) + L.pad - clothPad(b.width / n) * ((cellR(L, n - 1) - cellL(L, 0)) / b.width), x1 = x0 + (cellR(L, n - 1) - cellL(L, 0));
  const sx = b.width / (x1 - x0), sy = (b.height - CLOTH_BAND) / (L.bottom - L.top);
  return `translate(${b.left - a.left - x0 * sx}px, ${b.top - a.top - L.top * sy}px) scale(${sx}, ${sy})`;
}

/** Zoom out: the grid shrinks into its card on the table (the dive, the other way round). */
function openTable() {
  if (tableOpen || tableBusy || sliding || fibre || diving()) return;
  clearSelection();
  stage.scrollTo(0, 0);
  stage.style.overflow = 'hidden';
  seen = true;
  save();
  tableOpen = tableBusy = true;
  tableSel = cur;
  table.hidden = false;
  renderTable();
  const pic = cardEls()[cur].querySelector<HTMLElement>('.card-pic')!;
  pic.scrollIntoView({ block: 'center' });
  const to = ontoCloth(pic);
  canvas.style.transformOrigin = '0 0';
  canvas.style.position = 'relative';
  canvas.style.zIndex = '3';
  const done = () => {
    canvas.style.visibility = 'hidden';
    tableBusy = false;
    updateLevel();
  };
  // The grid shrinks onto its cloth and melts into it: the tags and numbers fade away.
  if (still()) done();
  else void canvas.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.55 }, { transform: to, opacity: 0 }], DIVE).finished.then(done);
  updateLevel();
}

/** Go into fabric i: its card grows until it is the grid. */
function closeTable(i: number) {
  if (!tableOpen || tableBusy) return;
  tableBusy = true;
  switchTo(i);
  // The drawer belongs to the table: it goes the moment the way in begins, not on arrival.
  // (The table is nudged so the fabrics stay where they were as the room above them opens.)
  const lift = drawer.offsetHeight;
  drawer.style.display = 'none';
  table.scrollTop = Math.max(0, table.scrollTop - lift);
  const pic = cardEls()[cur].querySelector<HTMLElement>('.card-pic')!;
  tick(); // draw the fabric (and lay it out) before it shows
  const from = ontoCloth(pic);
  canvas.style.visibility = '';
  const done = () => {
    drawer.style.display = '';
    table.hidden = true;
    tableOpen = tableBusy = false;
    canvas.style.zIndex = '';
    stage.style.overflow = '';
    updateLevel();
  };
  if (still()) done();
  else void canvas.animate([{ transform: from, opacity: 0 }, { opacity: 1, offset: 0.45 }, { transform: 'none', opacity: 1 }], DIVE).finished.then(done);
}

/** On to the next fabric (after the last comes the first): the grid slides away to the left
 * and the next one slides in. If it is playing, the next fabric starts at once. */
function nextFabric() {
  if (items.length < 2 || tableOpen || tableBusy || sliding || fibre || diving()) return;
  sliding = true;
  const snap = document.createElement('canvas');
  snap.width = canvas.width;
  snap.height = canvas.height;
  snap.getContext('2d')!.drawImage(canvas, 0, 0);
  snap.style.cssText = `position:absolute;left:0;top:0;width:${canvas.style.width};height:${canvas.style.height};z-index:3;pointer-events:none`;
  stage.append(snap);
  stage.style.overflowX = 'hidden';
  switchTo((cur + 1) % items.length);
  markPlaying();
  tick();
  const done = () => { snap.remove(); stage.style.overflowX = ''; sliding = false; };
  if (still()) return done();
  const slide = { duration: 340, easing: 'cubic-bezier(.3,.7,.2,1)' };
  canvas.animate([{ transform: 'translateX(100%)' }, { transform: 'none' }], slide);
  void snap.animate([{ transform: 'none' }, { transform: 'translateX(-100%)' }], slide).finished.then(done);
}

// ---------------------------------------------------------------- pointer gestures

type Gesture =
  | { kind: 'draw'; mode: 'fill' | 'erase'; x0: number; y0: number; last: string; timer: number; ti: number; ri: number; slot: number; before: number | null }
  | { kind: 'pluck'; ti: number; ri: number; slot: number; x0: number; v0: number }
  | { kind: 'rect'; ti: number; ri: number }
  | { kind: 'tap-in'; region: Rect }
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

function paint(ti: number, ri: number, slot: number, mode: 'fill' | 'erase') {
  const row = ROWS[ri];
  if (!fibre && zoomOf(pattern(), ti, row) > 1) return; // a swipe over threads passes over regions
  const has = !!getHit(pattern(), ti, row, slot);
  if (mode === 'fill' && !has) {
    history.apply(setHit(pattern(), ti, row, { v: DEFAULT_VELOCITY, mine: true }, slot));
    preview(row, DEFAULT_VELOCITY);
  } else if (mode === 'erase' && has) {
    history.apply(setHit(pattern(), ti, row, null, slot));
  }
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || diving() || tableOpen || tableBusy || sliding) return;
  engine.resume();
  const { x, y } = point(e);
  const t = hitTest(layout, pattern(), x, y);
  canvas.setPointerCapture(e.pointerId);
  lastPointer = e.pointerType;
  if (!atEndAnchor(x, y)) { endAnchor = null; view.endAdds = null; }

  if (t.kind === 'out') return leaveFibre();

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
      gesture = { kind: 'rect', ti: t.col, ri: t.ri };
      view.rect = { t0: t.col, t1: t.col, r0: t.ri, r1: t.ri };
      showActions();
      return;
    }
    clearSelection();
    if (!fibre && zoomOf(pattern(), t.ti, ROWS[t.ri]) > 1) {
      // A zoomed region isn't drawn on from out here: a press goes inside.
      gesture = { kind: 'tap-in', region: regionAt(pattern(), t.ti, t.ri)! };
      return;
    }
    history.begin();
    const row = ROWS[t.ri];
    const before = getHit(pattern(), t.ti, row, t.slot)?.v ?? null;
    const mode = before === null ? 'fill' : 'erase';
    paint(t.ti, t.ri, t.slot, mode);
    gesture = {
      kind: 'draw', mode, x0: x, y0: y, last: `${t.ti}:${t.ri}:${t.slot}`, ti: t.ti, ri: t.ri, slot: t.slot, before,
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

  if (!fibre && e.pointerType === 'touch' && inNumberLane(layout, y)) {
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

  if (atEndAnchor(x, y)) gesture = { kind: 'strip', target: { kind: endAnchor!.end } }; // the same place again, wherever the "+" has moved to
  else if (t.kind !== 'none') gesture = { kind: 'strip', target: t };
  else clearSelection();
  if (!atEndAnchor(x, y)) { endAnchor = null; view.endAdds = null; }
});

function startPluck() {
  if (!gesture || gesture.kind !== 'draw') return;
  const { ti, ri, slot, before, x0 } = gesture;
  const row = ROWS[ri];
  // Past the threshold the cell is guaranteed to hold a hit, whatever the first press did.
  const v0 = before ?? DEFAULT_VELOCITY;
  history.apply(setHit(pattern(), ti, row, { v: v0, mine: true }, slot));
  gesture = { kind: 'pluck', ti, ri, slot, x0, v0 };
  view.hold = { threadId: pattern().threads[ti].id, ri, slot, dx: 0 }; // a fibre is pulled like a string
}

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = point(e);
  // Up/down between + and – keeps the anchor; moving sideways or leaving the number lane lets go.
  if (stripAnchor && (Math.abs(x - stripAnchor.x) > 4 || !inNumberLane(layout, y))) stripAnchor = null;
  else if (stripAnchor) stripAnchor.y = y;
  if (endAnchor && e.pointerType !== 'touch' && Math.hypot(x - endAnchor.x, y - endAnchor.y) > 4) { endAnchor = null; view.endAdds = null; }
  const t = endAnchor && atEndAnchor(x, y) ? { kind: endAnchor.end } as Target : hitTest(layout, pattern(), x, y);
  if (!gesture) {
    const into = !fibre && !selecting() && t.kind === 'cell' && zoomOf(pattern(), t.ti, ROWS[t.ri]) > 1;
    view.hoverRegion = into && t.kind === 'cell' ? regionAt(pattern(), t.ti, t.ri) : null;
    view.hover = diving() || (selecting() && t.kind === 'cell') ? { kind: 'none' } : t;
    canvas.style.cursor = into ? 'zoom-in' : t.kind === 'out' ? 'zoom-out' : t.kind === 'none' ? 'default' : t.kind === 'label' ? 'pointer' : t.kind === 'band' && selecting() ? 'grab' : t.kind === 'band' ? 'copy' : 'pointer';
    return;
  }
  const g = gesture;
  if (g.kind === 'draw') {
    if (Math.hypot(x - g.x0, y - g.y0) > MOVE_TOLERANCE) window.clearTimeout(g.timer);
    if (t.kind === 'cell') {
      const key = `${t.ti}:${t.ri}:${t.slot}`;
      if (key !== g.last) {
        window.clearTimeout(g.timer);
        g.last = key;
        paint(t.ti, t.ri, t.slot, g.mode);
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
      history.apply(setHit(pattern(), g.ti, ROWS[g.ri], { v, mine: true }, g.slot));
    }
  } else if (g.kind === 'rect') {
    if (t.kind === 'cell') {
      view.rect = {
        t0: Math.min(g.ti, t.col), t1: Math.max(g.ti, t.col), r0: Math.min(g.ri, t.ri), r1: Math.max(g.ri, t.ri),
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
  } else if (g.kind === 'tap-in') {
    const t = hitTest(layout, pattern(), x, y), r = g.region;
    if (t.kind === 'cell' && t.ti >= r.t0 && t.ti <= r.t1 && t.ri >= r.r0 && t.ri <= r.r1) enterFibre(r);
  } else if (g.kind === 'pluck') {
    const hit = getHit(pattern(), g.ti, ROWS[g.ri], g.slot);
    const v = hit?.v ?? g.v0;
    engine.play(ROWS[g.ri], v, undefined, true);
    const id = pattern().threads[g.ti].id;
    const amp = (view.hold?.dx ?? 0) * 0.6;
    if (g.slot === 0) renderer.pluck(id, amp, 0.12 + 0.12 * v, 6);
    else renderer.pluckFibre(id, ROWS[g.ri], g.slot, amp, 0.12 + 0.12 * v, 6);
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
    const again = atEndAnchor(x, y) && (g.target.kind === 'front' || g.target.kind === 'back');
    const t = again ? g.target : e.pointerType === 'touch' && inNumberLane(layout, y) ? touchStripTarget(layout, x) : hitTest(layout, pattern(), x, y);
    if (JSON.stringify(t) !== JSON.stringify(g.target)) return;
    const p = pattern();
    if (again && endAnchor) {
      // The new group grows by a cell: at its end for the back "+", at its start for the front one.
      const end = endAnchor;
      applyStructure(insertAfter(p, end.end === 'back' ? p.threads.length - 1 : 0));
      endAnchor = { ...end, p: pattern() };
      view.endAdds = end.end;
      return;
    }
    if (t.kind === 'add' || t.kind === 'del') {
      if (e.pointerType !== 'touch') stripAnchor = { x, y, colW: layout.colW };
      applyStructure(t.kind === 'add' ? insertAfter(p, t.ti) : deleteCell(p, t.ti));
    }
    else if (t.kind === 'front' || t.kind === 'back') {
      applyStructure(t.kind === 'front' ? insertFront(p) : insertBack(p));
      endAnchor = { x, y, end: t.kind, p: pattern() };
      view.endAdds = t.kind;
    }
    else if (t.kind === 'split') applyStructure(split(p, t.g));
    else if (t.kind === 'merge') applyStructure(merge(p, t.g));
  }
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('pointerleave', () => { stripAnchor = null; view.hoverRegion = null; if (!gesture) view.hover = { kind: 'none' }; });

// ---------------------------------------------------------------- keyboard

window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
  const el = e.target as HTMLInputElement;
  if (el.tagName === 'INPUT' && el.type !== 'range') return; // typing; a fader still lets Space play
  if (el.type === 'range' && e.code !== 'Space') return;
  if ($<HTMLDialogElement>('credits').open || $<HTMLDialogElement>('ask').open) return;
  if (welcoming && e.key === 'Escape') return closeWelcome(false);
  const mod = e.metaKey || e.ctrlKey;
  if (tableOpen) {
    // Out on the table: pick with the arrows, Enter goes in, ⌘D duplicates, Delete deletes.
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Enter') closeTable(tableSel >= 0 ? tableSel : cur);
    else if (e.key === 'Escape') { if (tableSel >= 0) pickCard(-1); else closeTable(cur); }
    else if (e.key.startsWith('Arrow')) { e.preventDefault(); pickCard(Math.max(0, tableSel + (e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1))); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (tableSel >= 0) duplicateFabric(tableSel); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (shelfSel >= 0) void deleteStored(shelfSel); else if (tableSel >= 0) void deleteFabric(tableSel); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? history.redo() : history.undo(); clearSelection(); updateLevel(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); doDuplicate(); }
  else if (mod && e.key.toLowerCase() === 'c') { if (!fibre) doCopy(); }
  else if (mod && e.key.toLowerCase() === 'v') { if (!fibre) doPaste(); }
  else if (mod) return;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    if (view.groupSel) doDeleteGroups();
    else if (selRect()) doClearRect(); // the key never clears everything; the Clear button can
  }
  else if (/^[1-9]$/.test(e.key) && fibre) void setFactor(Number(e.key)); // inside a region: fibres per thread (1 = none)
  else if (e.key === 'Enter' && !fibre && selRect()) enterFibre(selRect()!);
  else if (e.key.toLowerCase() === 'd') setTool('draw');
  else if (e.key.toLowerCase() === 's') { if (!fibre) setTool('select'); }
  else if (e.key.toLowerCase() === 'm') doMergeGroups();
  else if (e.key === 'Escape') { if (fibre) leaveFibre(); else clearSelection(); }
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftHeld = false; });
window.addEventListener('blur', () => (shiftHeld = false));

// ---------------------------------------------------------------- frame loop

// How long a string keeps swinging, in cells: heavier beads swing a little longer (§11.2).
// Measured in cells, so faster tempos give shorter wobbles and the grid never looks all-a-shimmer.
const SWING_CELLS: Partial<Record<RowTag, number>> = { BD: 1.6, FT: 1.4, HT: 1.2, DB: 1.1, CG: 1.1, BG: 1.0, SD: 1.0 };

let lastFrame = performance.now();
function frame() {
  tick();
  requestAnimationFrame(frame);
}
function tick() {
  if (tableOpen && !tableBusy) { moveShuttle(); return; } // the grid is out of sight
  const p = pattern();
  const nowMs = performance.now(), dt = Math.min(100, nowMs - lastFrame);
  lastFrame = nowMs;
  if (fibre) {
    // Undo or redo can take the region away from under the view: then the view is back outside.
    const r = fibre.region;
    const there = fibre.ids.every((id, i) => p.threads[r.t0 + i]?.id === id);
    if (!there || (zoomGoal === 1 && !allZoomed(r))) { fibre = null; zoomU = zoomGoal = 0; updateLevel(); }
  }
  if (zoomU !== zoomGoal) {
    const step = dt / DIVE_MS;
    zoomU = zoomGoal > zoomU ? Math.min(1, zoomU + step) : Math.max(0, zoomU - step);
    if (zoomU === 0) fibre = null;
  }
  layout = computeLayout(p, stage.clientWidth, stage.clientHeight, stripAnchor?.colW ?? touchColW ?? undefined,
    fibre ? { region: fibre.region, u: ease(zoomU) } : undefined);
  if (stripAnchor && !gesture) view.hover = hitTest(layout, p, stripAnchor.x, stripAnchor.y);
  const cell = threadSeconds(scheduler.bpm?.() ?? projectBpm);
  for (const f of playId !== items[cur].id ? [] : scheduler.due()) {
    if (f.start) view.playheadId = f.threadId;
    // A note sets its string swinging: the thread's string for a note on the beat, and the
    // fibre's own fine string for a note between the beats.
    const swing = (row: RowTag) => {
      const cells = SWING_CELLS[row] ?? 0.7;
      return { cells, tau: Math.min(0.35, (cells * cell) / 2.5), freq: Math.max(3, Math.min(16, 1.2 / (cells * cell))) };
    };
    for (const h of f.hits) {
      if (h.slot === 0) continue;
      const w = swing(h.row);
      renderer.pluckFibre(f.threadId, h.row, h.slot, 0.8 + 2.2 * h.v, w.tau, w.freq);
    }
    const onString = f.hits.filter((h) => h.slot === 0);
    if (onString.length) {
      const v = Math.max(...onString.map((h) => h.v));
      const w = onString.map((h) => swing(h.row)).reduce((a, b) => (b.cells > a.cells ? b : a)); // the heaviest bead leads
      renderer.pluck(f.threadId, 0.8 + 2.2 * v, w.tau, w.freq);
    }
  }
  if (playEnded && performance.now() - playEnded > 250) { view.playheadId = null; playEnded = 0; }
  // The zoom diagram hints where you can go: into fibres with a selection, out to fabric without.
  // The zoom button shows where you are (bright) and where a press goes (glowing).
  const hasSel = !!selRect(), inside = !!fibre && zoomGoal === 1;
  const part = (cls: string, here: boolean, go: boolean, breathe = false) => {
    const el = document.querySelector(`#zoom .${cls}`)!;
    el.classList.toggle('here', here);
    el.classList.toggle('go', go);
    el.classList.toggle('breathe', breathe);
  };
  // Only the two levels that matter right now are drawn, stretched to fill the button: fibres
  // and threads with a selection or inside a region, threads and fabric otherwise. (Fabric
  // stays dim until it exists.)
  part('z-fibre', inside, !inside && hasSel, !inside && hasSel);
  part('z-thread', !inside && !tableOpen, inside || tableOpen);
  part('z-fabric', tableOpen, !tableOpen && seen); // dim until the table has been visited once
  const two = !inside && !hasSel && !tableOpen;
  document.querySelector('#zoom .z-fibre')!.classList.toggle('off', !inside && !hasSel);
  document.querySelector('#zoom .z-fabric')!.classList.toggle('off', inside || hasSel);
  document.querySelector('#zoom .z-thread')!.classList.toggle('next', two && items.length > 1);
  $('zoom').classList.toggle('two', two);
  $('zoom').title = tableOpen ? 'Into the picked fabric (Enter)' : inside ? 'Back to the threads (Esc)'
    : hasSel ? 'Go inside the selection: split it into fibres (Enter)'
    : items.length > 1 ? 'Left: on to the next fabric. Right: out to all the fabrics' : 'Out to the table of fabrics';
  const anySolo = ROWS.some((t) => mix[t]?.solo);
  const quiet = ROWS.map((t) => !!mix[t]?.mute || (anySolo && !mix[t]?.solo));
  renderer.draw(p, layout, { ...view, rect: selRect(), quiet, endX: endAnchor?.x });
}

restoreAccent(() => { if (tableOpen && !tableBusy) renderTable(); });
updatePanel();
requestAnimationFrame(frame);

// Development-only handle for automated checks; not present in production builds.
if (import.meta.env.DEV) Object.assign(window, { __rg: { engine, scheduler, get history() { return history; }, get items() { return items; } } });
// For tracking down sound trouble: type orimonoSound() in the browser console.
Object.assign(window, {
  // To see the first launch again (the bloom and the welcome): type orimonoWelcome() in the console.
  // For trying accent colours: orimonoAccent() opens a small picker; orimonoAccent('#8bc0bc') sets one directly.
  orimonoAccent: (hex?: string) => { if (hex) setAccent(hex); else openPicker(); },
  orimonoWelcome: () => { localStorage.removeItem(WELCOME_KEY); location.reload(); },
  orimonoSound: () => ({
    audio: engine.ctx.state, clock: engine.ctx.currentTime, sampleRate: engine.ctx.sampleRate, soundsLoaded: engine.loaded,
    playing: scheduler.playing, tempo: scheduler.bpm?.(), fabrics: items.length,
    quietRows: ROWS.filter((t) => mix[t]?.mute || (ROWS.some((x) => mix[x]?.solo) && !mix[t]?.solo)), levels: mix,
  }),
});
