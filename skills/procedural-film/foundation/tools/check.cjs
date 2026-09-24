#!/usr/bin/env node
// check.cjs : automated checks. Exits non-zero on any failure.
//
//   node tools/check.cjs              the real film (src)
//   node tools/check.cjs --fixtures   the tool fixtures
//
//   1 media        the built HTML contains no forbidden media patterns
//   2 determinism  the first, middle and last frame of every shot, plus one frame inside each non-cut transition,
//                  hash identically warm forward, warm reversed, in a fresh page shuffled with decoys, cold (the first
//                  draw in a fresh page) and sequential (drawn straight after the frame before it)
//   3 sources      no Math.random, Date, performance.now or crypto randomness in src drawing/audio code;
//                  no must-read text below the safe area (a literal y argument past it; an expression is not read):
//                  a vertical film reserves the bottom 380 px for the Shorts UI, a square film an 80 px bottom
//                  margin, a landscape film (wider than tall) an 80 px margin on all four sides,
//                  and a timeline can set safeBottom to say so itself;
//                  warns on a literal colour outside lib.js (colours come from lib.pal)
//   4 timeline     coverage, ids, transitions; warns on off-grid hits and cuts, a bpm whose 16ths
//                  miss the frame grid, and a duration that is not whole bars
//   5 draw         every checked frame draws without throwing, is not one flat colour, and paints no
//                  text below the safe area (measured where it lands, so computed positions count)
//   4 timeline     shots cover 0..duration with no gaps or overlaps; every shot's file registers its id
//   5 draw         first, middle and last frame of every shot draw without throwing
//   6 cost         frame times from a sweep across the film; slowest frames listed
//   Retro gates, only when the timeline sets retro (the kit lives on FILM.retro, never FILM.lib):
//   7 palette      FILM.retro.NES is the 64-entry console palette ($22 #5C94FC, $0F #000000); every
//                  FILM.retro.RETRO_PAL value and every SPAL slot colour is one of its colours
//   8 pixels       every console frame buffer pixel (FILM.native) of the draw and sweep frames is an NES
//                  colour (without FILM.crt: every 8th output pixel, phased per row; needs --scale 1)
//   9 sprites      every SPRITES_DEF sprite (each legend variant) uses at most 3 colours
//  10 audio        music.js calls FILM.chip.define; music.js and chip.js build no convolver, compressor,
//                  delay or panner nodes
//  11 display      (retro.present 'crt') the webgl2 backend ran; dark glass before the power-on and after
//                  the power-off, the line and the dot, the lit tube with scanlines; the input display
//                  only inside its windows (only when FILM.crt.buttonsAt is set); the closing caption;
//                  clean mode paints only console colours
//   A retro film also needs fps 60, and retro.native [320, 180] when it presents through the CRT. Its safe
//   margin is 8 native px on every side, scaled to canvas px (48 px at 1920x1080); safeBottom still overrides.
//   In a retro project the drawn fixtures are not expected to hash deterministically under the SwiftShader pin.
//
// Options: --scale s (default 1), --sweep N (every Nth frame, default 4), --det N (add N evenly spaced determinism
//          frames on top of the per-shot ones, default 0; never fewer than every shot),
//          --budget ms (fail if the slowest swept frame exceeds this; default: warn above 150 ms, or above one
//          frame period, 1000/fps ms, at 50 fps and up); --sweep defaults to every round(fps/6)th frame (4 at 24 fps)
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./common.cjs');
const { build } = require('./build.cjs');

const results = [];
function report(n, name, ok, summary, details = []) {
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : ok;
  results.push({ n, name, ok, tag, summary, details });
  console.log(`[${tag}] ${n} ${name}: ${summary}`);
  for (const d of details.slice(0, 40)) console.log(`       ${d}`);
  if (details.length > 40) console.log(`       ... ${details.length - 40} more`);
}

// Widest channel spread over the bare frame (grain post off, every 4th pixel): <= 6 means one flat
// colour. Sampling at full resolution keeps a small bright element, a spark or a glint, above the bar.
function flatness(pg, T) {
  return pg.page.evaluate((t) => {
    window.__h.render(t, { post: false }); // the grain post hides a blank frame behind its own noise
    const c = window.FILM.canvas;
    const d = window.FILM.ctx.getImageData(0, 0, c.width, c.height).data;
    const mn = [255, 255, 255];
    const mx = [0, 0, 0];
    for (let i = 0; i < d.length; i += 16) {
      for (let k = 0; k < 3; k++) {
        const v = d[i + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    return Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  }, T);
}

// Remove comments, keep strings (so a banned call hidden in a string still counts).
function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') {
          out += code[i] + (code[i + 1] || '');
          i += 2;
          continue;
        }
        if (q !== '`' && code[i] === '\n') break;
        out += code[i];
        i++;
      }
      if (i < n) out += code[i];
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const BANNED = [
  { name: 'Math.random', re: /Math\s*\.\s*random/g },
  { name: 'Date', re: /\bDate\b/g },
  { name: 'performance.now', re: /performance\s*\.\s*now/g },
  { name: 'crypto randomness', re: /crypto\s*\.\s*(getRandomValues|randomUUID)/g },
];

function seededShuffle(arr, seed) {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return { a, rand };
}

async function main() {
  const args = C.parseArgs(process.argv.slice(2), ['fixtures']);
  const fixtures = typeof args.fixtures === 'string' ? args.fixtures : !!args.fixtures;
  const scale = args.scale ? Number(args.scale) : 1;
  const detExtra = Math.max(0, Math.floor(Number(args.det || 0)));
  const budget = args.budget ? Number(args.budget) : null;
  const t0 = Date.now();

  const src = C.sources({ fixtures, player: true, lenient: true });
  const TL = src.timeline;
  const FPS = C.fps(TL);
  const sweepStep = Math.max(1, Number(args.sweep || Math.max(1, Math.round(FPS / 6))));
  const warnMs = FPS >= 50 ? 1000 / FPS : 150; // at 50 fps and up the live player must draw each frame in one period
  // the safe area both the static scan and the rendered text check measure against (art bible 1.1):
  // a vertical film keeps clear of the Shorts UI, a square film only needs a margin
  const H = TL.height || 1920;
  const W = TL.width || 1080;
  const landscape = W > H; // a landscape film keeps an 80 px margin on all four sides
  const retro = TL.raw && TL.raw.retro ? TL.raw.retro : null;
  // a retro film keeps 8 native px clear on every side, scaled to canvas px (320x180 -> 1920x1080: 48 px)
  const rNat = retro && Array.isArray(retro.native) ? retro.native : [320, 180];
  const rMx = retro ? Math.round((8 * W) / (Number(rNat[0]) || 320)) : 0;
  const rMy = retro ? Math.round((8 * H) / (Number(rNat[1]) || 180)) : 0;
  const safeBottom = TL.raw && TL.raw.safeBottom != null ? Number(TL.raw.safeBottom) : retro ? H - rMy : H >= W * 1.5 ? H - 380 : H - 80;
  const edges = landscape || !!retro; // the checks on all four sides
  const safeTop = retro ? rMy : landscape ? 80 : -Infinity;
  const safeLeft = retro ? rMx : landscape ? 80 : -Infinity;
  const safeRight = retro ? W - rMx : landscape ? W - 80 : Infinity;
  const crtFilm = !!(retro && retro.present === 'crt');
  console.log(`check ${fixtures ? '(fixtures)' : '(src)'}: ${TL.shots.length} shots, ${TL.duration}s at ${FPS} fps, scale ${scale}`);
  for (const w of src.warnings) console.log(`[warn] ${w}`);

  // ---------------------------------------------------------------- 3 sources (static)
  {
    const files = [path.join(C.SRC, 'core.js'), path.join(C.SRC, 'lib.js'), path.join(src.base, 'timeline.js'), ...src.sceneFiles];
    if (src.musicFile) files.push(src.musicFile);
    files.push(path.join(C.SRC, 'player.js'));
    // the retro kit and a game's engine draw and sound too (absent files are skipped)
    for (const f of C.preludeFiles(src.base)) if (!['photos.js', 'props.js', 'cast.js'].includes(path.basename(f))) files.push(f);
    const hits = [];
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      const lines = stripComments(fs.readFileSync(f, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const b of BANNED) {
          b.re.lastIndex = 0;
          if (b.re.test(line)) hits.push(`${C.rel(f)}:${i + 1}  ${b.name}  | ${line.trim().slice(0, 100)}`);
        }
      });
    }
    // must-read text stays inside the safe area (art bible 1.1): flag .text() with a literal y past it.
    // A vertical film keeps clear of the Shorts UI; a square film only needs a margin.
    const unsafeText = /\b(?:lib|L|LIB)\.text\s*\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*(\d{3,4})/;
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        const m = line.match(unsafeText);
        if (m && Number(m[1]) > safeBottom) hits.push(`${C.rel(f)}:${i + 1}  text y ${m[1]} below the safe area (y must be <= ${safeBottom})  | ${line.trim().slice(0, 100)}`);
        if (m && Number(m[1]) < safeTop) hits.push(`${C.rel(f)}:${i + 1}  text y ${m[1]} above the safe area (y must be >= ${safeTop})  | ${line.trim().slice(0, 100)}`);
      });
    }
    // colours come from lib.pal (art bible 2.2): a literal hex in a scene or timeline file drifts from the palette
    const hexWarns = [];
    const literalColour = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|['"`]\s*(?:rgba?|hsla?)\(/gi;
    for (const f of [...src.sceneFiles, path.join(src.base, 'timeline.js')]) {
      if (!fs.existsSync(f)) continue;
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(literalColour)) {
          hexWarns.push(`warn: ${C.rel(f)}:${i + 1}  literal colour ${m[0].trim()} outside lib.js (name it in lib.pal)  | ${line.trim().slice(0, 80)}`);
        }
      });
    }
    report(
      3,
      'sources',
      hits.length ? false : hexWarns.length ? 'WARN' : true,
      hits.length
        ? `${hits.length} banned call(s)`
        : `no Math.random / Date / performance.now / crypto randomness or unsafe-area text in ${files.length} files${hexWarns.length ? `; ${hexWarns.length} literal colour(s) outside lib.js` : ''}`,
      [...hits, ...hexWarns]
    );
  }

  // ---------------------------------------------------------------- 10 audio (static scan + runtime, retro)
  let audioHits = null;
  // The console's sound chip has two pulses, a triangle, noise and DPCM, and nothing after them:
  // no reverb, no compressor, no echo line, no stereo field.
  if (retro) {
    const AUDIO_BANNED = [
      { name: 'createConvolver', re: /\bcreateConvolver\b/g },
      { name: 'createDynamicsCompressor', re: /\bcreateDynamicsCompressor\b/g },
      { name: 'createDelay', re: /\bcreateDelay\b/g },
      { name: 'createStereoPanner', re: /\bcreateStereoPanner\b/g },
      { name: 'createPanner', re: /\bcreatePanner\b/g },
      { name: 'new ConvolverNode/DynamicsCompressorNode/DelayNode/StereoPannerNode/PannerNode', re: /\bnew\s+(?:ConvolverNode|DynamicsCompressorNode|DelayNode|StereoPannerNode|PannerNode)\b/g },
    ];
    const mf = src.musicFile;
    const chipFile = path.join(C.SRC, 'chip.js');
    const hits = [];
    if (!mf) hits.push(`${src.label}/music.js is missing: write it and have it call FILM.chip.define({ songs, sfx }).`);
    if (!fs.existsSync(chipFile)) hits.push(`${C.rel(chipFile)} is missing: copy the retro kit's src/chip.js into src.`);
    for (const f of [mf, chipFile]) {
      if (!f || !fs.existsSync(f)) continue;
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        for (const b of AUDIO_BANNED) {
          b.re.lastIndex = 0;
          if (b.re.test(line)) hits.push(`${C.rel(f)}:${i + 1}  ${b.name}  | ${line.trim().slice(0, 100)}`);
        }
      });
    }
    audioHits = hits;
  }
  // gate 10 reports after the page loads: the score must be registered at runtime (FILM.chip.defined()),
  // however music.js reaches FILM.chip.define.
  const reportAudio = (definedNow) => {
    if (!audioHits) return;
    const hits = audioHits.slice();
    const mfRel = src.musicFile ? C.rel(src.musicFile) : `${src.label}/music.js`;
    if (src.musicFile && definedNow !== true) hits.push(`${mfRel} did not register a score in the page (FILM.chip.defined() is not true): call FILM.chip.define({ songs, sfx }).`);
    report(
      10,
      'audio',
      hits.length === 0,
      hits.length ? `${hits.length} problem(s) holding the score to the console sound chip (no reverb, compressor, delay or panner)` : `${mfRel} registers a score (FILM.chip.defined() is true); it and src/chip.js build no convolver, compressor, delay or panner nodes`,
      hits
    );
    audioHits = null;
  };

  // ---------------------------------------------------------------- 4 timeline (static part)
  const tlProblems = [...src.problems];
  const tlWarnings = [];
  const sixteenth = TL.bpm > 0 ? 15 / TL.bpm : 0; // 60/bpm is a beat; a 16th is a quarter of it
  const offGrid = (t) => sixteenth > 0 && Math.abs(t / sixteenth - Math.round(t / sixteenth)) > 1e-3;
  {
    const shots = TL.shots;
    const EPS = 1e-6;
    if (!shots.length) tlProblems.push('timeline has no shots');
    if (!TL.hasDuration) tlProblems.push('timeline has no "duration"');
    if (!(TL.duration > 0)) tlProblems.push(`duration is not positive (${TL.duration})`);
    const ids = new Set();
    shots.forEach((s, i) => {
      if (typeof s.id !== 'string' || !s.id) tlProblems.push(`shot #${i} has no id`);
      else if (ids.has(s.id)) tlProblems.push(`duplicate shot id '${s.id}'`);
      ids.add(s.id);
      if (!(s.dur > 0)) tlProblems.push(`shot '${s.id}' has non-positive length (${s.start}..${s.end})`);
      if (i === 0 && Math.abs(s.start) > EPS) tlProblems.push(`first shot '${s.id}' starts at ${s.start}, not 0`);
      if (i > 0) {
        const prev = shots[i - 1];
        const d = s.start - prev.end;
        if (d > EPS) tlProblems.push(`gap of ${d.toFixed(4)}s between '${prev.id}' (ends ${prev.end}) and '${s.id}' (starts ${s.start})`);
        if (d < -EPS) tlProblems.push(`overlap of ${(-d).toFixed(4)}s between '${prev.id}' (ends ${prev.end}) and '${s.id}' (starts ${s.start})`);
      }
      if (Math.abs(s.start * FPS - Math.round(s.start * FPS)) > 1e-4) tlWarnings.push(`shot '${s.id}' starts between frames (${s.start}s)`);
      if (offGrid(s.start)) tlWarnings.push(`shot '${s.id}' starts at ${s.start}s, off the 16th-note grid at ${TL.bpm} bpm`);
      const tr = s.transitionIn;
      if (tr) {
        const kinds = ['cut', 'fade', 'flash', 'iris', 'wipe'];
        if (!kinds.includes(tr.kind)) tlProblems.push(`shot '${s.id}' transitionIn kind '${tr.kind}' is not one of ${kinds.join(', ')}`);
        if (!(tr.dur >= 0) || tr.dur > s.dur) tlProblems.push(`shot '${s.id}' transitionIn dur ${tr.dur} must be between 0 and the shot length ${s.dur}`);
        if (i === 0 && tr.kind !== 'cut') tlWarnings.push(`shot '${s.id}' is first; its transitionIn is ignored`);
      }
      const m = String(s.mode || '').toLowerCase();
      if (!/illus|schem|blue|none|raw/.test(m)) tlWarnings.push(`shot '${s.id}' mode '${s.mode}' is neither illustrated nor schematic (treated as illustrated)`);
    });
    // every event sits on the beat grid (16ths at the film's bpm), so cuts and hits land together
    const betweenFrames = (t) => Math.abs(t * FPS - Math.round(t * FPS)) > 1e-4;
    for (const c of TL.cues || []) {
      // the art bible binds pops, cuts and hits to the grid; a swell or ambience may lead into one
      const onGridKind = /^(hit|cut|pop)$/i.test(String(c.kind || ''));
      if (onGridKind && typeof c.t === 'number' && offGrid(c.t)) tlWarnings.push(`cue at ${c.t}s (kind ${c.kind}) is off the 16th-note grid at ${TL.bpm} bpm${c.note ? ` (${String(c.note).slice(0, 40)})` : ''}`);
      // a hit that lands between two frames is drawn a frame early or late against the sound
      if (onGridKind && typeof c.t === 'number' && betweenFrames(c.t)) tlWarnings.push(`cue at ${c.t}s (kind ${c.kind}) falls between ${FPS} fps frames (frame ${(c.t * FPS).toFixed(2)})`);
    }
    // 16ths land on frames when FPS * 15 / bpm is whole (24 fps: 360 / bpm, 60 fps: 900 / bpm)
    if (TL.bpm > 0 && (FPS * 15) % TL.bpm !== 0) {
      tlWarnings.push(FPS === 24 ? `bpm ${TL.bpm}: 16ths do not land on 24 fps frames (360 / bpm must be whole: 72, 90, 120, 180)` : `bpm ${TL.bpm}: 16ths do not land on ${FPS} fps frames (${FPS * 15} / bpm must be whole)`);
    }
    const bar = TL.bpm > 0 ? 240 / TL.bpm : 0;
    if (bar > 0 && Math.abs(TL.duration / bar - Math.round(TL.duration / bar)) > 1e-3) {
      tlWarnings.push(`duration ${TL.duration}s is ${(TL.duration / bar).toFixed(2)} bars at ${TL.bpm} bpm, not a whole number of bars`);
    }
    if (shots.length && Math.abs(shots[shots.length - 1].end - TL.duration) > EPS) {
      tlProblems.push(`last shot '${shots[shots.length - 1].id}' ends at ${shots[shots.length - 1].end}, duration is ${TL.duration}`);
    }
  }

  // a retro film runs at the console's 60 fps, and a CRT film on the kit's fixed 320x180 buffer
  if (retro) {
    if (FPS !== 60) tlProblems.push(`a retro film runs at 60 fps but the timeline says ${FPS}: set fps: 60 in ${src.label}/timeline.js.`);
    if (crtFilm) {
      const nat = retro.native;
      if (!Array.isArray(nat) || Number(nat[0]) !== 320 || Number(nat[1]) !== 180) {
        tlProblems.push(`retro.present is 'crt' but retro.native is ${JSON.stringify(nat)}: set retro.native: [320, 180], the only size the CRT shaders take.`);
      }
    }
  }

  // ---------------------------------------------------------------- 1 media
  {
    const tmpOut = path.join(C.TMP, C.uniqueName('check-build') + '.html');
    let html = '';
    let hits = [];
    try {
      const b = build({ fixtures, out: tmpOut, quiet: true, lenient: true });
      html = b.html;
      hits = b.hits;
    } catch (e) {
      hits = [{ pattern: 'build failed', line: 0, text: e.message }];
    } finally {
      fs.rmSync(tmpOut, { force: true });
    }
    report(1, 'media', hits.length === 0, hits.length ? `${hits.length} forbidden pattern(s) in the built HTML` : `no forbidden media patterns in the built HTML (${(html.length / 1024).toFixed(1)} KB)`, hits.map((h) => `line ${h.line}  ${h.pattern}  | ${h.text}`));
  }

  // ---------------------------------------------------------------- browser checks
  const loadable = src.files.filter((f) => fs.existsSync(f));
  const browser = await C.launch();
  try {
    browserChecks: {
      const pg = await C.openPage(browser, loadable, { scale, prefix: 'check' });
      const loadErr = pg.loadErrors.map((e) => `script error ${e.file}:${e.line}:${e.col} ${e.message}`);
      // 4 registration
      const reg = pg.state.registered;
      for (const shot of TL.shots) {
        if (!shot.file) continue;
        const want = path.basename(String(shot.file));
        const byId = reg.filter((r) => r.id === shot.id);
        if (!byId.length) {
          const inFile = reg.filter((r) => r.file === want).map((r) => r.id);
          tlProblems.push(`shot '${shot.id}': ${want} does not register it${inFile.length ? ` (it registers: ${inFile.join(', ')})` : ''}`);
        } else if (!byId.some((r) => r.file === want)) {
          tlProblems.push(`shot '${shot.id}' is registered by ${byId.map((r) => r.file).join(', ')}, not by its timeline file ${want}`);
        }
      }
      for (const r of reg) if (!TL.shots.some((s) => s.id === r.id)) tlWarnings.push(`${r.file} registers '${r.id}', which is not in the timeline`);
      tlProblems.push(...pg.state.regErrors, ...loadErr);
      report(
        4,
        'timeline',
        tlProblems.length ? false : tlWarnings.length ? 'WARN' : true,
        tlProblems.length
          ? `${tlProblems.length} problem(s)`
          : `${TL.shots.length} shots cover 0..${TL.duration}s with no gaps or overlaps; every shot's file registers its id`,
        [...tlProblems, ...tlWarnings.map((w) => `warn: ${w}`)]
      );
      if (retro) reportAudio(await pg.page.evaluate(() => !!(window.FILM && FILM.chip && typeof FILM.chip.defined === 'function' && FILM.chip.defined())).catch(() => false));
      if (!pg.info) {
        report(5, 'draw', false, 'FILM did not initialise in the page', [...loadErr, ...pg.pageErrors]);
        await pg.close();
        break browserChecks;
      }

      // ---------------------------------------------------------------- 7 palette, 9 sprites (retro)
      // Read from FILM.retro, never FILM.lib: lib.pal is the drawn palette and FILM.lib is frozen.
      let nesColours = null; // the 64 table colours as #RRGGBB, when the table exists
      const pixelFails = [];
      let pixelSamples = 0;
      let pixelFrames = 0;
      const kit = retro
        ? await pg.page.evaluate(() => {
            const F = window.FILM;
            const R = F.retro;
            if (!R) return { missing: true };
            const N = R.NES;
            const clone = (o) => (o && typeof o === 'object' ? JSON.parse(JSON.stringify(o)) : null);
            return {
              nes: Array.isArray(N) ? N.slice() : null,
              pal: clone(R.RETRO_PAL) || {},
              spal: clone(R.SPAL) || {},
              sprites: clone(R.SPRITES_DEF),
              native: !!(F.native && F.crt),
              crt: !!(F.crt && typeof F.crt.present === 'function'),
              marks: F.crt && typeof F.crt.marks === 'function' ? F.crt.marks() : null,
              buttons: !!(F.crt && typeof F.crt.buttonsAt === 'function'),
            };
          })
        : null;
      const nativeAudit = !!(kit && kit.native);
      const audit = !!retro && (nativeAudit || scale === 1);
      if (retro) {
        const problems = [];
        const norm = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v);
        const hex = /^#[0-9A-F]{6}$/;
        if (kit.missing || !kit.nes) {
          problems.push('FILM.retro.NES does not exist: copy the retro kit\'s src/pixel.js into src.');
        } else {
          if (kit.nes.length !== 64) problems.push(`FILM.retro.NES has ${kit.nes.length} entries, not 64: restore it from the retro kit's src/pixel.js.`);
          const bad = [];
          kit.nes.forEach((v, i) => {
            if (!hex.test(norm(v))) bad.push(`$${i.toString(16).toUpperCase().padStart(2, '0')}=${v}`);
          });
          if (bad.length) problems.push(`FILM.retro.NES entries that are not #RRGGBB: ${bad.slice(0, 12).join(', ')}${bad.length > 12 ? ` (+${bad.length - 12})` : ''}`);
          if (norm(kit.nes[0x22]) !== '#5C94FC') problems.push(`FILM.retro.NES $22 is ${kit.nes[0x22]}, the console sky blue is #5C94FC`);
          if (norm(kit.nes[0x0f]) !== '#000000') problems.push(`FILM.retro.NES $0F is ${kit.nes[0x0f]}, the console black is #000000`);
          nesColours = [...new Set(kit.nes.map(norm).filter((v) => hex.test(v)))];
          const set = new Set(nesColours);
          for (const [k, v] of Object.entries(kit.pal)) if (!set.has(norm(v))) problems.push(`RETRO_PAL.${k} = ${v} is not an NES colour: pick one with FILM.retro.C($xx).`);
          // SPAL[name] is [c1, c2, c3] or a cycle of such
          for (const [k, v] of Object.entries(kit.spal)) {
            const pals = Array.isArray(v) && Array.isArray(v[0]) ? v : [v];
            pals.forEach((p, pi) => (Array.isArray(p) ? p : []).forEach((c, si) => {
              if (c != null && !set.has(norm(c))) problems.push(`SPAL.${k}${pals.length > 1 ? `[${pi}]` : ''} slot ${si + 1} = ${c} is not an NES colour: pick one with FILM.retro.C($xx).`);
            }));
          }
        }
        report(
          7,
          'palette',
          problems.length === 0,
          problems.length ? `${problems.length} problem(s) with the console palette` : `FILM.retro.NES is the 64-entry console palette ($22 #5C94FC, $0F #000000); all ${Object.keys(kit.pal).length} RETRO_PAL values and ${Object.keys(kit.spal).length} SPAL palettes are in it`,
          problems
        );
        if (nesColours) await pg.page.evaluate((list) => window.__h.nesInit(list), nesColours);

        const SP = kit.sprites;
        if (!SP || typeof SP !== 'object') report(9, 'sprites', false, 'FILM.retro.SPRITES_DEF does not exist: copy the retro kit\'s src/pixel.js into src.');
        else {
          const over = [];
          let variants = 0;
          for (const name of Object.keys(SP)) {
            const def = SP[name];
            const used = new Set((def.r || []).join(''));
            const legends = def.legends && def.legends.length ? def.legends : [def.l];
            legends.forEach((lg, li) => {
              variants++;
              const cols = new Set();
              for (const ch of used) {
                const c = lg && lg[ch];
                if (c) cols.add(String(c).trim().toUpperCase());
              }
              if (cols.size > 3) over.push(`${name}${legends.length > 1 ? `[${li}]` : ''}: ${cols.size} colours (${[...cols].join(' ')}): cut it to 3 colours plus transparent.`);
            });
          }
          report(9, 'sprites', over.length === 0, over.length ? `${over.length} sprite(s) use more than 3 colours (a console sprite palette is 3 colours + transparent)` : `${Object.keys(SP).length} sprites (${variants} legend variants) use at most 3 colours each`, over);
        }
      }
      // 8 pixels: audit the frame just drawn; every sampled colour must be in the console table
      const auditFrame = async (f, label) => {
        if (!audit || !nesColours) return;
        const a = await pg.page.evaluate(() => window.__h.nesAudit());
        pixelFrames++;
        pixelSamples += a.n;
        if (a.bad) pixelFails.push(`${label} f${f} (T=${(f / FPS).toFixed(3)}) ${a.source}: ${a.bad} of ${a.n} samples are not NES colours, e.g. ${a.colours.join(', ')}`);
      };

      // ---------------------------------------------------------------- 5 draw
      const drawFails = [];
      const timings = new Map(); // frame -> ms (warm)
      const firstTouch = [];
      let drawn = 0;
      for (const shot of TL.shots) {
        const f0 = Math.round(shot.start * FPS);
        const f1 = Math.round(shot.end * FPS) - 1;
        if (f1 < f0) continue;
        const fm = Math.floor((f0 + f1) / 2);
        for (const [label, f] of [['first', f0], ['middle', fm], ['last', f1]]) {
          const r = await pg.page.evaluate((T) => window.__h.render(T, { text: true }), f / FPS);
          drawn++;
          for (const t of r.text || []) {
            if (t.bottom > safeBottom + 1) {
              drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)}): text "${t.str}" reaches y ${Math.round(t.bottom)} (baseline ${Math.round(t.y)}), below the safe area (the ink must end by ${safeBottom})`);
            }
            if (edges) {
              const top = t.top != null ? t.top : t.y - (t.size || 0); // no measured top: the em box above the baseline
              if (top < safeTop - 1) drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)}): text "${t.str}" starts at y ${Math.round(top)}, above the safe area (the ink must start at ${safeTop} or below)`);
              if (t.left != null && t.left < safeLeft - 1) drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)}): text "${t.str}" starts at x ${Math.round(t.left)}, left of the safe area (x must be >= ${safeLeft})`);
              if (t.right != null && t.right > safeRight + 1) drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)}): text "${t.str}" ends at x ${Math.round(t.right)}, right of the safe area (x must be <= ${safeRight})`);
            }
          }
          const softened = label === 'first' && shot.transitionIn && shot.transitionIn.kind !== 'cut';
          if (!softened && (await flatness(pg, f / FPS)) <= 6) {
            drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)}) is one flat colour: a blank frame reads as a bug`);
          }
          if (label === 'first') firstTouch.push(`${shot.id} f${f} ${r.ms.toFixed(0)}ms`);
          if (audit) {
            await pg.page.evaluate((T) => window.__h.render(T), f / FPS); // flatness drew it bare; redraw as shipped
            await auditFrame(f, `${shot.id} ${label}`);
          }
          if (r.shot !== shot.id) drawFails.push(`${shot.id} ${label} frame f${f}: active shot was '${r.shot}'`);
          for (const e of r.errors) {
            drawFails.push(`${shot.id} ${label} frame f${f} (T=${(f / FPS).toFixed(3)})${e.shot && e.shot !== shot.id ? ` [thrown by '${e.shot}' drawing into the transition]` : ''}: ${e.message}`);
            if (e.stack) drawFails.push('  ' + e.stack.split('\n').slice(1, 3).map((s) => s.trim()).join(' | '));
          }
        }
      }
      for (const e of pg.pageErrors) drawFails.push(`page error: ${e}`);
      report(5, 'draw', drawFails.length === 0, drawFails.length ? `${drawFails.length} error(s)` : `${drawn} frames (first, middle, last of ${TL.shots.length} shots) drew without errors`, drawFails);

      // ---------------------------------------------------------------- 6 cost
      const total = Math.round(TL.duration * FPS);
      const sweep = [];
      for (let f = 0; f < total; f += sweepStep) sweep.push(f);
      if (sweep[sweep.length - 1] !== total - 1) sweep.push(total - 1);
      const sweepErr = [];
      for (const f of sweep) {
        const r = await pg.page.evaluate((T) => window.__h.render(T), f / FPS);
        timings.set(f, { ms: r.ms, shot: r.shot });
        for (const e of r.errors) sweepErr.push(`f${f} ${r.shot}: ${e.message}`);
        await auditFrame(f, `${r.shot} sweep`);
      }
      if (retro) {
        if (!audit) report(8, 'pixels', 'WARN', `skipped: the pixel palette check samples exact colours and needs --scale 1 (got ${scale})`);
        else if (!nesColours) report(8, 'pixels', false, 'no FILM.retro.NES table to check the rendered pixels against (see 7 palette)');
        else
          report(
            8,
            'pixels',
            pixelFails.length === 0,
            pixelFails.length
              ? `${pixelFails.length} of ${pixelFrames} frames paint colours outside FILM.retro.NES`
              : `${pixelFrames} frames (draw frames + sweep), ${pixelSamples} ${nativeAudit ? 'console frame buffer pixels (FILM.native, every pixel)' : 'samples'}: every pixel is an NES colour`,
            pixelFails
          );
      }
      const arr = [...timings.entries()].map(([f, v]) => ({ f, ...v })).sort((a, b) => b.ms - a.ms);
      const ms = arr.map((a) => a.ms).sort((a, b) => a - b);
      const median = ms[Math.floor(ms.length / 2)];
      const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
      const max = arr[0].ms;
      const perShot = TL.shots.map((s) => {
        const xs = arr.filter((a) => a.shot === s.id).map((a) => a.ms);
        return xs.length ? `${s.id}: max ${Math.max(...xs).toFixed(0)}ms, mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(0)}ms` : `${s.id}: not swept`;
      });
      const costDetails = [
        'slowest: ' + arr.slice(0, 6).map((a) => `f${a.f} (${(a.f / FPS).toFixed(2)}s ${a.shot}) ${a.ms.toFixed(0)}ms`).join(', '),
        ...perShot,
        'first touch per shot (includes cache builds): ' + firstTouch.join(', '),
        ...sweepErr,
      ];
      const over = budget != null ? max > budget : false;
      report(
        6,
        'cost',
        sweepErr.length ? false : over ? false : max > warnMs ? 'WARN' : true,
        `${sweep.length} frames swept (every ${sweepStep}): median ${median.toFixed(0)}ms, mean ${mean.toFixed(0)}ms, max ${max.toFixed(0)}ms${budget != null ? ` (budget ${budget}ms)` : ''}${max > warnMs ? ` - above ${warnMs.toFixed(warnMs === 150 ? 0 : 1)}ms` : ''}`,
        costDetails
      );

      // ---------------------------------------------------------------- 11 display (retro, CRT)
      // The TV: the real GL path ran, the power states read as they should, the picture has scanlines,
      // and clean mode is a pure nearest-neighbour upscale of console colours.
      if (crtFilm) {
        const fails = [];
        const notes = [];
        const Hh = pg.info.h;
        const pitch = Hh % 180 === 0 ? Hh / 180 : 0;
        const pct = (v) => (100 * v).toFixed(1) + '%';
        const stats = async (f, what) => {
          const r = await pg.page.evaluate((T) => window.__h.render(T), f / FPS);
          for (const e of r.errors) fails.push(`f${f} ${what}: ${e.message}`);
          const st = await pg.page.evaluate(([b, pp]) => window.__h.lumaStats(b, pp), [Math.round(Hh * 0.02), pitch || 6]);
          notes.push(`f${f} ${what}: mean ${pct(st.mean)}, max ${pct(st.max)}, centre ${pct(st.centre)}`);
          return st;
        };
        if (!kit || !kit.crt) fails.push("retro.present is 'crt' but FILM.crt.present does not exist: copy the retro kit's src/crt.js into src.");
        else {
          const info = await pg.page.evaluate(() => window.__h.crtInfo());
          if (!info || info.backend !== 'webgl2') fails.push(`FILM.crt.backend is '${info && info.backend}' in the tool browser, not 'webgl2' (renderer: ${info && info.renderer}): the CRT fell back`);
          const M = kit.marks || {};
          // a lit frame: between the power-on settling and the power-off (the film's middle without either)
          const litFrom = M.powerOn ? M.powerOn.settled : 0;
          const litTo = M.powerOff ? M.powerOff.start : total;
          const mid = litTo > litFrom ? Math.floor((litFrom + litTo) / 2) : Math.floor(total / 2);
          if (!(litTo > litFrom)) fails.push(`the TV is never on and settled: leave frames between retro.crt.powerOn's end (${litFrom}) and powerOff's start (${litTo}).`);
          const ov0 = await pg.page.evaluate(() => window.__h.crtOverlays());
          const setOv = (o) => pg.page.evaluate((x) => window.__h.crtOverlays(x), o);
          const cams = await pg.page.evaluate(([a, b]) => [a == null ? null : FILM.crt.camera(a), FILM.crt.camera(b)], [M.powerOn ? M.powerOn.start : null, mid]);
          if (cams[0] && !(cams[0].zoom < 0.7)) fails.push(`f${M.powerOn.start}: the power-on should open on the wide shot of the set (camera zoom ${cams[0].zoom.toFixed(2)})`);
          if (!(Math.abs(cams[1].zoom - 1) < 1e-9)) fails.push(`f${mid}: the lit picture should fill the frame with the tube (camera zoom ${cams[1].zoom.toFixed(3)})`);
          notes.push(`camera: zoom ${cams[0] ? cams[0].zoom.toFixed(2) : '-'} at the power-on start, ${cams[1].zoom.toFixed(2)} at f${mid}`);
          await setOv({ caption: false });
          const lit = await stats(mid, 'lit');
          if (!(lit.mean > 0.12)) fails.push(`f${mid} lit: the TV output is dark (mean luma ${pct(lit.mean)})`);
          if (pitch) {
            const sc = lit.scan;
            notes.push(`scanlines at f${mid}: luma modulation ${pct(sc.amp)} of the mean at a ${sc.period.toFixed(2)}-px period (nominal pitch ${pitch} px)`);
            if (!(sc.amp > 0.03)) fails.push(`f${mid}: no scanline structure (luma modulation ${pct(sc.amp)} near a ${pitch}-px period)`);
          }
          if (M.powerOn) {
            const o = M.powerOn;
            const off0 = await stats(o.start, 'power-on start (set off)');
            if (!(off0.mean < 0.1 && off0.max < 0.4)) fails.push(`f${o.start}: the set should be dark glass before the power-on (mean ${pct(off0.mean)}, max ${pct(off0.max)})`);
            // 3 frames into the line at the 150-frame pace; a shorter window reaches the open sooner
            const fl = Math.max(o.line, Math.min(o.line + 3, o.open - 1));
            const ln = await stats(fl, 'power-on line');
            if (!(ln.max > 0.85 && ln.mean < 0.15)) fails.push(`f${fl}: expected the bright horizontal line on dark glass (max ${pct(ln.max)}, mean ${pct(ln.mean)})`);
          }
          if (M.powerOff) {
            const o = M.powerOff;
            const fd = Math.max(o.dot, Math.min(o.dot + 2, o.afterglow - 1));
            const dot = await stats(fd, 'power-off dot');
            if (!(dot.max > 0.85 && dot.mean < 0.1)) fails.push(`f${fd}: expected the collapse dot on dark glass (max ${pct(dot.max)}, mean ${pct(dot.mean)})`);
            if (o.end + 5 < total) {
              const aft = await stats(o.end + 5, 'after power-off');
              if (!(aft.mean < 0.1 && aft.max < 0.4)) fails.push(`f${o.end + 5}: the set should be dark glass after the power-off (mean ${pct(aft.mean)}, max ${pct(aft.max)})`);
            }
          }
          await setOv({ caption: ov0.overlays.caption });
          // the input display: only a film that sets FILM.crt.buttonsAt has one
          if (kit.buttons) {
            if (ov0.input && ov0.input.length) {
              const [w0, w1] = ov0.input[0];
              const box = [Math.round(pg.info.w * 0.72), Math.round(Hh * 0.72), Math.round(pg.info.w * 0.28), Math.round(Hh * 0.28)];
              const regionAt = async (f, on) => {
                await setOv({ input: on });
                await pg.page.evaluate((T) => window.__h.render(T), f / FPS);
                return pg.page.evaluate((b) => window.__h.regionHash(b[0], b[1], b[2], b[3]), box);
              };
              const fIn = Math.floor((w0 + w1) / 2);
              const fOut = Math.max(0, w0 - 40);
              const inOn = await regionAt(fIn, true), inOff = await regionAt(fIn, false);
              const outOn = await regionAt(fOut, true), outOff = await regionAt(fOut, false);
              await setOv({ input: ov0.overlays.input });
              if (inOn === inOff) fails.push(`f${fIn}: the input display is not drawn inside its window ${w0}..${w1}`);
              if (outOn !== outOff) fails.push(`f${fOut}: the input display is drawn outside its windows`);
              notes.push(`input display windows (frames): ${ov0.input.map((w) => w.join('..')).join(', ')}`);
            } else fails.push('FILM.crt.buttonsAt is set but FILM.crt.inputWindows() found no stretch of input: return a mask from buttonsAt where the pad should show.');
          }
          // the closing caption on the dark glass
          if (ov0.caption) {
            const fc = Math.floor((ov0.caption[0] + ov0.caption[1]) / 2);
            await setOv({ caption: true });
            const cs = await stats(fc, 'closing caption');
            await setOv({ caption: ov0.overlays.caption });
            if (!(cs.max > 0.6)) fails.push(`f${fc}: the closing caption is not on the glass (max luma ${pct(cs.max)})`);
            notes.push(`closing caption frames ${ov0.caption.join('..')}`);
          } else {
            notes.push('closing caption: none (no retro.crt.caption, or fewer than 30 frames after the power-off caption point)');
          }
          await pg.page.evaluate(() => window.__h.crtMode('clean'));
          await pg.page.evaluate((T) => window.__h.render(T), mid / FPS);
          const ca = nesColours ? await pg.page.evaluate(() => window.__h.nesAudit(true)) : null;
          await pg.page.evaluate(() => window.__h.crtMode('crt'));
          if (ca && ca.bad) fails.push(`clean mode f${mid}: ${ca.bad} of ${ca.n} output samples are not console colours (${ca.colours.join(', ')}): clean must be a whole-pixel nearest-neighbour upscale`);
          if (!fails.length) {
            notes.unshift(`backend ${info.backend} (${info.renderer}); ${ov0.input && ov0.input.length ? `input display in ${ov0.input.length} window(s); ` : ''}${ov0.caption ? 'closing caption; ' : ''}clean mode paints only console colours`);
          }
        }
        report(11, 'display', fails.length === 0, fails.length ? `${fails.length} problem(s) with the TV` : `the TV: dark glass, the power line and dot, the lit tube with scanlines; median frame ${median.toFixed(0)}ms at ${pg.info.w}x${Hh}`, [...fails, ...notes]);
      }

      // ---------------------------------------------------------------- 2 determinism
      // Every shot is always covered: first, middle and last frame, plus one frame inside each non-cut
      // transition. --det adds evenly spaced frames on top and can never drop a shot.
      const tDet = Date.now();
      const candidates = [];
      let transitions = 0;
      for (const s of TL.shots) {
        const f0 = Math.round(s.start * FPS);
        const f1 = Math.round(s.end * FPS) - 1;
        if (f1 < f0) continue;
        candidates.push(f0, Math.floor((f0 + f1) / 2), f1);
        if (s.index > 0 && s.transitionIn && s.transitionIn.kind !== 'cut' && s.transitionIn.dur > 0) {
          candidates.push(Math.min(f1, f0 + Math.floor((s.transitionIn.dur * FPS) / 2)));
          transitions++;
        }
      }
      for (let i = 0; i < detExtra; i++) candidates.push(Math.floor(((i + 0.5) * total) / detExtra));
      const frames = [...new Set(candidates)].filter((f) => f >= 0 && f < total).sort((a, b) => a - b);
      const render = (p, f) => p.page.evaluate((T) => window.__h.render(T), f / FPS);
      const hashOf = (p) => p.page.evaluate(() => window.__h.hash());
      const hashA = new Map(), hashB = new Map(), hashC = new Map(), hashCold = new Map(), hashSeq = new Map();
      const detErrors = [];
      // A: warm, forward (this page has already drawn every shot)
      for (const f of frames) {
        await render(pg, f);
        hashA.set(f, await hashOf(pg));
      }
      // B: warm, reversed
      for (const f of [...frames].reverse()) {
        await render(pg, f);
        hashB.set(f, await hashOf(pg));
      }
      await pg.close();
      // C: fresh page, shuffled, each frame drawn straight after a random decoy frame
      const pg2 = await C.openPage(browser, loadable, { scale, prefix: 'check2' });
      try {
        const { a: order, rand } = seededShuffle(frames, 0xb077e7f1);
        for (const f of order) {
          await render(pg2, Math.floor(rand() * total));
          await render(pg2, f);
          hashC.set(f, await hashOf(pg2));
        }
      } finally {
        await pg2.close();
      }
      // D cold: each frame is the first draw in a freshly loaded page (no caches, no earlier shots).
      // E sequential: in that page, the frame before it and then the frame again, as playback draws them.
      const K = Math.min(4, frames.length);
      const pool = [];
      try {
        for (let i = 0; i < K; i++) pool.push(await C.openPage(browser, loadable, { scale, prefix: `check-cold${i}` }));
        let next = 0;
        await Promise.all(
          pool.map(async (p) => {
            let first = true;
            while (next < frames.length) {
              const f = frames[next++];
              if (!first) await p.reopen();
              first = false;
              if (!p.info) {
                detErrors.push(`f${f}: FILM did not initialise in a fresh page`);
                continue;
              }
              const r = await render(p, f);
              hashCold.set(f, await hashOf(p));
              for (const e of r.errors) detErrors.push(`f${f} cold draw (${e.shot || r.shot}): ${e.message}`);
              if (f > 0) {
                await render(p, f - 1);
                const r2 = await render(p, f);
                hashSeq.set(f, await hashOf(p));
                for (const e of r2.errors) detErrors.push(`f${f} sequential draw (${e.shot || r2.shot}): ${e.message}`);
              } else {
                hashSeq.set(f, hashCold.get(f));
              }
            }
          })
        );
      } finally {
        await Promise.all(pool.map((p) => p.close()));
      }
      const mism = [];
      const shotAt = (f) => {
        const T = f / FPS;
        const s = TL.shots.find((x) => T < x.end - 1e-6) || TL.shots[TL.shots.length - 1];
        return s ? s.id : '?';
      };
      for (const f of frames) {
        const ref = hashCold.get(f);
        const passes = { 'warm forward': hashA.get(f), 'warm reverse': hashB.get(f), 'fresh shuffled': hashC.get(f), sequential: hashSeq.get(f) };
        const bad = Object.entries(passes).filter(([, h]) => h !== ref).map(([k]) => k);
        if (bad.length) mism.push(`f${f} (T=${(f / FPS).toFixed(3)} ${shotAt(f)}): differs from the cold draw in ${bad.join(', ')} | cold ${ref}, ${Object.entries(passes).map(([k, h]) => `${k} ${h}`).join(', ')}`);
      }
      const detOk = mism.length === 0 && detErrors.length === 0;
      report(
        2,
        'determinism',
        detOk,
        mism.length
          ? `${mism.length} of ${frames.length} frames differ between passes`
          : detErrors.length
            ? `${detErrors.length} error(s) while drawing determinism frames`
            : `${frames.length} frames (first, middle, last of all ${TL.shots.length} shots${transitions ? `, ${transitions} transition(s)` : ''}${detExtra ? `, +${detExtra}` : ''}) hash identically: cold, sequential, warm forward, warm reverse, fresh shuffled with decoys (${((Date.now() - tDet) / 1000).toFixed(1)}s)`,
        [`frames: ${frames.join(', ')}`, ...mism, ...detErrors]
      );
    }
  } finally {
    await browser.close();
  }

  results.sort((a, b) => a.n - b.n);
  reportAudio(false); // the page never loaded: gate 10 still reports, as a failure
  const failed = results.filter((r) => r.ok === false);
  console.log('\nsummary');
  for (const r of results) console.log(`  [${r.tag}] ${r.n} ${r.name}: ${r.summary}`);
  console.log(`${failed.length ? 'FAILED' : 'OK'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
