# Orimono

*織物, woven cloth.* A drum machine whose grid is made of rubber: a familiar 16-step grid of coloured threads
that you stretch, cut and regroup into any length, so you can wander from 4+4+4+4 to something like
62 = 18+15+14+15 one cell at a time. Hits are beads on vibrating threads.

## Run it

```sh
npm install
npm run dev        # then open the address it prints (usually http://localhost:5173)
```

Other commands:

- `npm test` — model, colour and Random tests (Vitest)
- `npm run build` — type-check and build to `dist/`
- `npm run kit` — rebuild the sample kit in `public/kit/` from the libraries in the project folder
  (needs `sox` and `ffmpeg`; the row picks live at the top of `tools/build_kit.py`)

## Using it

- **Draw (D):** tap a cell to add or remove a hit. Swipe to paint: the first cell decides fill or erase.
  Hold still ~0.4 s, then pull sideways to pluck: the further you pull, the louder the hit.
- **Group bars in Draw:** click a group's coloured bar to nudge it to a nearby colour (each click, the next nearest).
- **Select (S, or hold Shift):** drag a rectangle in the grid (Clear, Copy, Paste, Random),
  or click/drag the coloured bars under the numbers to pick groups (Merge, Duplicate, Delete, drag to move).
- **Number strip:** hover a number for "+" (add an empty cell after it, top half) and "–" (delete it, bottom half).
  Hover between two numbers: ✂ splits a group there, ⋈ merges two groups. The "+" at either end adds a new group;
  press it again in the same place to add cells to that group.
- **Row names:** with Select, click a row's name for its level fader, mute and solo.
- **Random:** fills your groups (or the selection) with a beat in one of six styles. Notes you drew yourself stay.
- **Tempo knob:** drag up/down (Shift for fine), scroll, or double-click to type.
- Space: Play/Stop · ⌘Z / ⇧⌘Z: undo/redo · Delete: clear selection · M: merge · ⌘D: duplicate · Esc: deselect.
- Everything autosaves in the browser. Click the length readout to start a fabric from scratch.

### Three levels: fibres, threads, fabrics

The button at the top right shows where you are and where a press takes you.

- **Fibres:** select some cells and press the button (or Enter) to go inside them. Each thread there is split into
  finer steps (×2 to ×7, chosen with the stepper), for rolls, triplets and polyrhythms. Draw on the fibres, press
  Play to hear just that region once, and use the tempo knob to listen slower. Press outside, or Esc, to come back.
  Out among the threads a region shows as a soft patch: press it to go in.
- **Fabrics:** one whole screen of threads is a fabric. Press the right half of the button to zoom out to the table,
  where fabrics lie side by side in playing order, each as wide as it is long in time. Click a fabric to go in; click
  its number to pick it (Duplicate, Delete) or drag the number to move it; the dashed "+" adds a new one-cell fabric.
  Play runs a shuttle through all of them, round and round, from wherever the shuttle rests (drag it to choose).
  Among the threads, the left half of the button slides on to the next fabric.
- **Tempo on the table:** the thread along the top carries the table's tempo to every fabric through a tie with a
  bow. Pick a fabric's number, then press its bow to cut it: that fabric keeps a tempo of its own, set inside it
  with the tempo knob. Press again to tie it back. (Unpicked, the bow is just there to be plucked.)
- **The drawer:** drag a fabric by its number up to the top to put it away in the drawer; drag a stored fabric back
  down for a copy. Scroll up over the toolbar, or press the drawer's handle, to pull it out.

## Code map

| File | What it does |
|---|---|
| `src/model.ts` | The pattern and every edit (pure functions), dye shelf colour rules |
| `src/colour.ts` | OKLab colour distance, for nudging colours |
| `src/history.ts` | Undo/redo, one gesture per step |
| `src/random.ts` | Random fill into the user's groups |
| `src/audio.ts` | Sample playback: velocity → strength, random takes, spill-over, choke |
| `src/scheduler.ts` | Lookahead scheduler on the audio clock |
| `src/layout.ts` | Geometry and hit-testing |
| `src/render.ts` | Canvas drawing: strings, beads, string physics, number strip |
| `src/main.ts` | Wiring: controls, gestures, keyboard, autosave |
| `tools/build_kit.py` | Builds `public/kit/` (trimmed FLAC + manifest) from the source libraries |

## Sounds

Drums (mixed from their per-microphone recordings to stereo, EQ'd towards a sound picked by ear,
some shortened; see `tools/drums.py`):

- Kick, crash, high tom: [MuldjordKit](https://www.drumgizmo.org/wiki/doku.php?id=kits:muldjordkit)
  by Lars Muldjord and the DrumGizmo team — [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Hi-hats, floor tom: [DRSKit](https://www.drumgizmo.org/wiki/doku.php?id=kits:drskit)
  by the DrumGizmo team (Lars Muldjord, Bent Bisballe Nyeng) and Jes Eiler of DRSDrums —
  [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/)
  (both from the [SFZ Instruments](https://sfzinstruments.github.io/drums) conversions)
- Ride: [Big Rusty Drums](https://sfzinstruments.github.io/drums/big_rusty_drums) by Karoryfer Samples — CC0
- Snare: [Virtuosity Drums](https://github.com/sfzinstruments/virtuosity_drums)
  by Versilian Studios and Karoryfer Samples — CC0

Percussion, all CC0: [VCSL](https://github.com/sgossner/VCSL) by Versilian Studios, and
[FreePats World Percussion](https://freepats.zenvoid.org/Percussion/world-and-rare-percussion.html) (egg shaker).

Changes made to all of them: hits trimmed, mixed to stereo, EQ'd, some shortened, levels set.
The processed sounds in `public/kit/` are under the same licences as their sources.

`tools/build_kit.py` builds `public/kit/` (trimmed FLAC + `manifest.json`) from those libraries, which live
outside this repo (`npm run kit`).

## Deploying

Every push to `main` runs the tests, builds, and publishes to GitHub Pages via
`.github/workflows/deploy.yml` (repo Settings → Pages → Source: GitHub Actions).
