#!/usr/bin/env node
// motion.cjs : measure how much the picture moves, frame by frame, and flag the dull stretches.
//
//   node tools/motion.cjs                       every shot of the film
//   node tools/motion.cjs --shot egg-hatch      one shot
//   node tools/motion.cjs --fixtures            the fixture film
//
// Each frame is rendered, shrunk to a 45 px wide thumbnail and compared with the previous frame. The
// raw energy is the mean absolute difference, 0..255, of the 2% of thumbnail pixels that changed most:
// line boil and grain shift everything a little, a moving thing shifts a few pixels a lot, so the top
// 2% separates them even when the moving thing is small. Objects on twos and the 12 fps boil both
// change every other frame, so a frame's motion energy is the larger of its own and the previous
// frame's raw energy. On the example film boil alone measures 2 to 9 and a visible move 11 and up.
// Per shot it prints a sparkline and:
//   still  spans longer than one beat where energy stays under --still (default 10): only boil and
//          grain move, which on a phone reads as a frozen frame
//   flat   the shot's busiest frame is under 2x its median: motion with no accents, one speed throughout
//   cues   for each timeline cue inside the shot, whether energy jumps to 1.5x the half beat before it,
//          or halves from a moving half beat (a landing), from one frame early to two late: a sound
//          with no visible accent under it
// The sparkline marks the cut and transition frames with '|' and scales to the rest of the shot.
// A still span, a flat shot or a missed cue is a critic's lead, not a verdict: a deliberate hold is a choice, a
// forgotten one is the commonest reason a procedural film feels lifeless. Exit code is always 0
// unless rendering fails.
//
// Options:
//   --shot id      restrict to one shot
//   --still x      energy under which a frame counts as still (default 10)
//   --scale s      render scale (default 0.25)
//   --fixtures     use tools/fixtures instead of src
'use strict';

const C = require('./common.cjs');

const BARS = ' ▁▂▃▄▅▆▇█';

async function main() {
  const args = C.parseArgs(process.argv.slice(2), ['fixtures']);
  const fixtures = typeof args.fixtures === 'string' ? args.fixtures : !!args.fixtures;
  const scale = args.scale ? Number(args.scale) : 0.25;
  const deadAt = args.still ? Number(args.still) : 10;
  const shotId = typeof args.shot === 'string' ? args.shot : null;

  const src = C.sources({ fixtures, player: true });
  for (const w of src.warnings) console.log(`[warn] ${w}`);
  const TL = src.timeline;
  const FPS = C.fps(TL);
  const beatFrames = Math.round((60 / (TL.bpm || 120)) * FPS);
  const shots = shotId ? TL.shots.filter((s) => s.id === shotId) : TL.shots;
  if (!shots.length) C.die(`no shot '${shotId}'. Ids: ${TL.shots.map((s) => s.id).join(', ')}`);

  const browser = await C.launch();
  let failed = false;
  try {
    const pg = await C.openPage(browser, src.files, { scale, prefix: 'motion' });
    if (!pg.info) {
      await pg.close();
      C.die('FILM or FILM.TIMELINE did not initialise in the page');
    }
    await pg.page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 45;
      c.height = Math.max(1, Math.round((45 * FILM.canvas.height) / FILM.canvas.width));
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high';
      const px = new Float32Array(c.width * c.height);
      window.__m = {
        prev: null,
        energy(T) {
          const r = window.__h.render(T);
          g.clearRect(0, 0, c.width, c.height);
          g.drawImage(FILM.canvas, 0, 0, c.width, c.height);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let e = 0;
          if (this.prev) {
            const n = d.length / 4;
            for (let i = 0, j = 0; i < d.length; i += 4, j++) {
              px[j] = (Math.abs(d[i] - this.prev[i]) + Math.abs(d[i + 1] - this.prev[i + 1]) + Math.abs(d[i + 2] - this.prev[i + 2])) / 3;
            }
            px.sort();
            const k = Math.max(1, Math.round(n * 0.02));
            for (let j = n - k; j < n; j++) e += px[j];
            e /= k;
          }
          this.prev = d.slice();
          return { e, errors: r.errors.length };
        },
      };
    });

    const report = [];
    for (const shot of shots) {
      const f0 = Math.round(shot.start * FPS), f1 = Math.round(shot.end * FPS);
      // prime with the frame before the shot so its first frame measures the cut into it
      await pg.page.evaluate((T) => { window.__m.prev = null; window.__m.energy(T); }, Math.max(0, f0 - 1) / FPS);
      const raw = [];
      for (let f = f0; f < f1; f++) {
        const r = await pg.page.evaluate((T) => window.__m.energy(T), f / FPS);
        if (r.errors) failed = true;
        raw.push(r.e);
      }
      const E = raw.map((e, i) => (i < 2 ? e : Math.max(e, raw[i - 1])));
      // the cut frame and any transition into the shot are big by construction: leave them out of the statistics
      const skip = Math.max(1, shot.transitionIn && shot.transitionIn.kind !== 'cut' ? Math.ceil(shot.transitionIn.dur * FPS) + 1 : 1);
      const body = E.slice(skip);
      const sorted = [...body].sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      const max = sorted.length ? sorted[sorted.length - 1] : 0;

      const dead = [];
      let run = 0;
      for (let i = skip; i <= E.length; i++) {
        if (i < E.length && E[i] < deadAt) run++;
        else {
          if (run > beatFrames) dead.push([i - run, i - 1]);
          run = 0;
        }
      }
      const flat = max < 2 * Math.max(median, 0.05);

      const cues = (TL.cues || []).filter((c) => c.t > shot.start + 1e-6 && c.t < shot.end - 1e-6);
      const cueHits = cues.map((c) => {
        const i = Math.round(c.t * FPS) - f0;
        // an accent is a jump against the half beat before the cue, landing from one frame early to two late
        const win = E.slice(Math.max(skip, i - 1), i + 3);
        const before = E.slice(Math.max(skip, i - Math.round(beatFrames / 2) - 1), Math.max(skip, i - 1)).sort((x, y) => x - y);
        const base = before.length ? before[Math.floor(before.length / 2)] : median;
        const peak = win.length ? Math.max(...win) : 0;
        const low = win.length ? Math.min(...win) : 0;
        // a jump in motion, or a moving thing stopping dead (a landing, a slam) both read as the accent
        return { t: c.t, kind: c.kind, hit: peak >= Math.max(1.5 * base, deadAt) || (base >= 2 * deadAt && low <= base / 2) };
      });

      const top = Math.max(max, 1e-6);
      const spark = E.map((e, i) => (i < skip ? '|' : BARS[Math.min(8, Math.round((Math.min(e, top) / top) * 8))])).join('');
      report.push({ shot, E, median, max, dead, flat, cueHits, spark });
    }
    await pg.close();

    for (const r of report) {
      const s = r.shot;
      const tags = [];
      if (r.dead.length) tags.push(`STILL ${r.dead.map(([a, b]) => `t ${(a / FPS).toFixed(2)}-${((b + 1) / FPS).toFixed(2)}`).join(', ')}`);
      if (r.flat) tags.push('FLAT');
      const missed = r.cueHits.filter((c) => !c.hit);
      if (missed.length) tags.push(`MISSED CUE ${missed.map((c) => `${c.kind}@${c.t}`).join(', ')}`);
      console.log(`${s.id}  T ${s.start}-${s.end}  median ${r.median.toFixed(2)}  peak ${r.max.toFixed(2)}${tags.length ? '  ' + tags.join('  ') : '  ok'}`);
      console.log(`  ${r.spark}`);
    }
    const nDead = report.filter((r) => r.dead.length).length;
    const nFlat = report.filter((r) => r.flat).length;
    const nMiss = report.reduce((a, r) => a + r.cueHits.filter((c) => !c.hit).length, 0);
    console.log(`\n${report.length} shot(s): ${nDead} with still spans, ${nFlat} flat, ${nMiss} cue(s) with no visible accent`);
  } finally {
    await browser.close();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
