// A small panel for trying accent colours while the colour scheme is being decided. It is not
// part of the machine: it opens from the browser console with orimonoAccent().

import { PALETTE, UI } from './constants';
import { oklab } from './colour';

const KEY = 'orimono.accent';
const DEFAULT = '#DBA868';
// Starting points: the current one, then colours from outside the thread palette.
const IDEAS: [string, string][] = [
  ['Caramel (now)', '#DBA868'], ['Amber', '#F2B441'], ['Orange', '#FF7A1A'], ['Coral', '#F0714F'], ['Pink', '#F27DB0'],
  ['Violet', '#A98BFF'], ['Blue', '#5B9DFF'], ['Sky', '#4CC3F0'], ['Mint', '#5FD4C0'], ['Green', '#6FD36B'], ['Lime', '#C3E04A'], ['White', '#E8E8E8'],
];

const valid = (hex: string) => /^#[0-9a-f]{6}$/i.test(hex);
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let onChange = () => {};
export function setAccent(hex: string, keep = true) {
  if (!valid(hex)) return;
  UI.play = hex;
  document.documentElement.style.setProperty('--accent', hex);
  if (keep) { if (hex.toUpperCase() === DEFAULT) localStorage.removeItem(KEY); else localStorage.setItem(KEY, hex); }
  onChange();
}
/** An accent being tried stays through reloads (in this browser only) until it is reset. */
export function restoreAccent(changed: () => void) {
  onChange = changed;
  const kept = localStorage.getItem(KEY);
  if (kept && valid(kept)) setAccent(kept, false);
}

export function openPicker() {
  document.getElementById('picker')?.remove();
  const el = document.createElement('div');
  el.id = 'picker';
  el.innerHTML = `
    <div class="picker-head"><b>Accent colour</b><button data-x title="Close">×</button></div>
    <div class="picker-row"><input type="color" /><input type="text" maxlength="7" spellcheck="false" /><button data-reset>Reset</button></div>
    <div class="picker-ideas"></div>
    <p class="picker-facts"></p>`;
  const colour = el.querySelector<HTMLInputElement>('input[type=color]')!, text = el.querySelector<HTMLInputElement>('input[type=text]')!;
  const facts = el.querySelector<HTMLElement>('.picker-facts')!, ideas = el.querySelector<HTMLElement>('.picker-ideas')!;
  const show = () => {
    const hex = UI.play.toUpperCase();
    colour.value = hex.toLowerCase();
    if (document.activeElement !== text) text.value = hex;
    const lab = oklab(hex);
    const near = PALETTE.map((c) => ({ name: c.name, d: Math.hypot(...oklab(c.hex).map((v, i) => v - lab[i])) })).sort((a, b) => a.d - b.d)[0];
    const c = contrast(hex, UI.bg); // the same number both ways round: the accent on the background, and dark words on the accent
    facts.innerHTML = [
      `Against the background, and dark words on it (Play, Random): ${c.toFixed(1)} to 1${c < 4.5 ? ' — <i>hard to read</i>' : ''}`,
      `Nearest thread colour: ${near.name}${near.d < 0.02 ? ' — <i>the same</i>' : near.d < 0.08 ? ' — <i>close enough to be mistaken for it</i>' : near.d < 0.14 ? ' — a neighbour' : ' — clearly apart'}`,
    ].join('<br>');
    ideas.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.hex === hex));
  };
  for (const [name, hex] of IDEAS) {
    const b = document.createElement('button');
    b.dataset.hex = hex;
    b.title = `${name} ${hex}`;
    b.style.background = hex;
    b.onclick = () => { setAccent(hex); show(); };
    ideas.append(b);
  }
  colour.oninput = () => { setAccent(colour.value); show(); };
  text.oninput = () => { const v = text.value.startsWith('#') ? text.value : `#${text.value}`; if (valid(v)) { setAccent(v); show(); } };
  text.onkeydown = (e) => e.stopPropagation(); // typing a colour is not a shortcut
  el.querySelector<HTMLElement>('[data-reset]')!.onclick = () => { setAccent(DEFAULT); show(); };
  el.querySelector<HTMLElement>('[data-x]')!.onclick = () => el.remove();
  document.body.append(el);
  show();
}
