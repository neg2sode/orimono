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
  Hover a gap: ✂ splits a group there, ⋈ merges two groups. The gap before cell 1 adds a new group.
- **Tempo knob:** drag up/down (Shift for fine), scroll, or double-click to type.
- Space: Play/Stop · ⌘Z / ⇧⌘Z: undo/redo · Delete: delete selection · M: merge · ⌘D: duplicate · Esc: deselect.
- Everything autosaves in the browser. **New** starts again from 4+4+4+4 (undoable).

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
