// Random: fills hits musically into whatever groups the user has built (§10.3).
// It never changes lengths, groups, colours or zooms. Starting rules, to be tuned by ear.

import { ROWS, type RowTag } from './constants';
import { runs, setHits, type Hit, type Pattern, type Rect } from './model';

type Rng = () => number;

export function randomFill(p: Pattern, area: Rect | null, rng: Rng = Math.random): Pattern {
  const rect: Rect = area ?? { t0: 0, t1: p.threads.length - 1, r0: 0, r1: ROWS.length - 1 };
  const inRows = (row: RowTag) => {
    const ri = ROWS.indexOf(row);
    return ri >= rect.r0 && ri <= rect.r1;
  };
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const chance = (x: number) => rng() < x;
  const vel = (base: number) => ({ v: Math.max(0.1, Math.min(1, base + (rng() - 0.5) * 0.16)) });

  // Each press chooses one backbeat voice, one steady voice, and a couple of sparse colours,
  // preferring rows inside the selection so a selection always gets something to play.
  const prefer = (pool: RowTag[]) => {
    const inside = pool.filter(inRows);
    return inside.length ? inside : pool;
  };
  const back = pick(prefer(['SD', 'SD', 'XS', 'CP']));
  const steady = pick(prefer(['CH', 'CH', 'RD', 'SH']));
  const sparsePool = prefer(['HT', 'FT', 'BG', 'CG', 'DB', 'CB', 'CL', 'TB']);
  const sparse = new Set<RowTag>([pick(sparsePool), pick(sparsePool)]);

  const hits = new Map<string, Hit | null>();
  const put = (ti: number, row: RowTag, hit: Hit | null) => hits.set(`${ti}:${row}`, hit);

  const rs = runs(p);
  rs.forEach((r, gi) => {
    const len = r.end - r.start;
    for (let ti = r.start; ti < r.end; ti++) {
      const pos = ti - r.start; // position inside the group
      const start = pos === 0;
      for (const row of ROWS) put(ti, row, null);

      // Kick: mostly on group starts, with occasional extras.
      if ((start && chance(0.92)) || (!start && chance(0.08))) put(ti, 'BD', vel(start ? 0.9 : 0.6));

      // Backbeat: away from group starts, around the middle of the group; rare ghost notes.
      const middle = pos === Math.floor(len / 2) && len >= 2;
      if (middle && chance(0.85)) put(ti, back, vel(0.82));
      else if (!start && back === 'SD' && chance(0.07)) put(ti, 'SD', vel(0.25));

      // Steady: dense with a few gaps; ride sits on every other thread. Group starts a little louder.
      const steadyHere = steady === 'RD' ? pos % 2 === 0 : chance(0.88);
      if (steadyHere) put(ti, steady, vel(start ? 0.8 : 0.55));
      if (steady === 'CH' && pos === len - 1 && len >= 3 && chance(0.25)) {
        put(ti, 'CH', null);
        put(ti, 'OH', vel(0.65));
      }

      // Crash: sometimes on the very first group start.
      if (gi === 0 && start && chance(0.4)) put(ti, 'CR', vel(0.8));

      // Sparse colours: rare, for surprise.
      for (const row of sparse) if (chance(0.09)) put(ti, row, vel(0.65));
    }
  });

  const cells: { ti: number; row: RowTag; hit: Hit | null }[] = [];
  for (const [key, hit] of hits) {
    const [tis, row] = key.split(':');
    const ti = Number(tis);
    if (ti < rect.t0 || ti > rect.t1 || !inRows(row as RowTag)) continue;
    cells.push({ ti, row: row as RowTag, hit });
  }
  return setHits(p, cells);
}
