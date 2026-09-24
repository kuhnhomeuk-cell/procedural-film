#!/usr/bin/env node
// render.cjs : deterministic frame-by-frame render to MP4 with the synthesised soundtrack.
//
//   node tools/render.cjs                                  whole film -> exports/<slug>.mp4 (slug = project folder name)
//   node tools/render.cjs --from 4 --to 9 --scale 0.5 --out exports/test.mp4
//   node tools/render.cjs --workers 4                      parallel pages -> numbered PNGs in .tmp/, one ffmpeg pass
//
// Options:
//   --from s, --to s   global seconds (default 0 .. duration)
//   --scale s          render scale (default 1 = 1080x1920)
//   --out path         output file (relative paths are from the project root)
//   --workers N        pages rendering frame ranges in parallel (default 1 = pipe straight into ffmpeg)
//   --silent           no music.js needed; writes a silent stereo track
//   --keep             keep the .tmp/ work folder (PNGs and WAV)
//   --crf N            x264 quality (default 16)   --preset p   x264 preset (default medium)
//   --fixtures         use tools/fixtures instead of src
//
// Video: libx264, yuv420p (BT.709), crf 16, at the timeline's fps (C.fps, default 24), +faststart. Audio: OfflineAudioContext rendered in the
// page at 48 kHz stereo, written as WAV, muxed as AAC 192k.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.cjs');

const FFMPEG = process.env.FFMPEG || 'ffmpeg'; // ffmpeg on PATH, or set FFMPEG to a binary
const SR = 48000;

function runFfmpeg(args, { stdin = false } = {}) {
  const proc = spawn(FFMPEG, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => (err += d.toString()));
  const done = new Promise((resolve, reject) => {
    proc.on('error', (e) => reject(new Error(`could not start ffmpeg (${FFMPEG}): ${e.message}`)));
    proc.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${signal || code}\n${err.trim()}`))));
  });
  // mark handled now: ffmpeg can fail while frames are still rendering, before anyone awaits `done`
  done.catch(() => {});
  return { proc, done };
}

function encodeArgs({ input, wav, out, frames, crf, preset, fps }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...input,
    '-i', wav,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2',
    '-t', (frames / fps).toFixed(6),
    '-movflags', '+faststart',
    out,
  ];
}

async function main() {
  const args = C.parseArgs(process.argv.slice(2), ['fixtures', 'silent', 'keep']);
  const fixtures = typeof args.fixtures === 'string' ? args.fixtures : !!args.fixtures;
  const silent = !!args.silent;
  const scale = args.scale ? Number(args.scale) : 1;
  const workers = Math.max(1, Math.floor(Number(args.workers || 1)));
  const crf = args.crf != null ? Number(args.crf) : 16;
  const preset = typeof args.preset === 'string' ? args.preset : 'medium';
  const tStart = Date.now();
  const lap = () => ((Date.now() - tStart) / 1000).toFixed(1) + 's';

  const src = C.sources({ fixtures, player: true, needMusic: !silent });
  for (const w of src.warnings) console.log(`[warn] ${w}`);
  const TL = src.timeline;
  const FPS = C.fps(TL);
  const from = args.from != null ? Number(args.from) : 0;
  const to = args.to != null ? Number(args.to) : TL.duration;
  const f0 = Math.max(0, Math.round(from * FPS));
  const f1 = Math.min(Math.round(TL.duration * FPS), Math.round(to * FPS));
  const frames = f1 - f0;
  if (!(frames > 0)) C.die(`nothing to render: --from ${from} --to ${to} (duration ${TL.duration}s)`);
  const out = C.resolveOut(typeof args.out === 'string' ? args.out : fixtures ? 'exports/fixtures.mp4' : `exports/${C.SLUG}.mp4`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const work = path.join(C.TMP, C.uniqueName('render'));
  fs.mkdirSync(work, { recursive: true });
  const forgetWork = args.keep ? () => {} : C.cleanupOnExit(work);
  const wav = path.join(work, 'audio.wav');
  // ffmpeg writes here; only a complete encode (ffmpeg exit 0, every frame delivered) is moved to --out,
  // so a failed render never replaces a previous good export.
  const partial = path.join(work, 'encode' + (path.extname(out) || '.mp4'));

  console.log(`render ${fixtures ? '(fixtures)' : '(src)'}: frames ${f0}..${f1 - 1} (${frames} frames at ${FPS} fps, ${(frames / FPS).toFixed(3)}s) scale ${scale}, ${workers} worker(s)`);
  console.log(`work folder ${work}`);

  const launches = [];
  let pages = [];
  let enc = null;
  let ok = false;
  try {
    // one browser process per worker so pages really render in parallel
    for (let i = 0; i < workers; i++) launches.push(C.launch());
    const bs = await Promise.all(launches);
    pages = await Promise.all(bs.map((b, i) => C.openPage(b, src.files, { scale, prefix: `render-w${i}` })));
    for (const pg of pages) {
      const problems = [...pg.loadErrors.map((e) => `${e.file}:${e.line}:${e.col} ${e.message}`), ...pg.state.regErrors, ...pg.pageErrors];
      if (problems.length || !pg.info) throw new Error(`scripts failed to load:\n  ${problems.join('\n  ') || 'FILM did not initialise'}`);
    }
    const { w, h } = pages[0].info;
    console.log(`canvas ${w}x${h}`);

    // ---- audio first: fast, and a broken score fails before minutes of frames
    const tA = Date.now();
    if (silent) {
      const n = Math.round((frames / FPS) * SR);
      C.writeWavFloat(wav, Buffer.alloc(n * 8).toString('base64'), 2, SR);
      console.log(`audio: silent track (${(n / SR).toFixed(3)}s)`);
    } else {
      if (!pages[0].state.hasAudio) throw new Error(`${src.label}/music.js loaded but FILM.audio.render is not a function`);
      let a;
      try {
        a = await pages[0].page.evaluate(([s, e, sr]) => window.__h.audio(s, e, sr), [f0 / FPS, f1 / FPS, SR]);
      } catch (e) {
        throw new Error(`FILM.audio.render failed: ${e.message}`);
      }
      C.writeWavFloat(wav, a.b64, 2, SR);
      console.log(`audio: ${(a.frames / SR).toFixed(3)}s 48 kHz stereo, peak ${a.peak.toFixed(3)}${a.peak > 1 ? ' (CLIPS above 1.0)' : ''}, ${((Date.now() - tA) / 1000).toFixed(1)}s -> ${wav}`);
    }

    // ---- frames
    let done = 0;
    let lastPrint = 0;
    const tV = Date.now();
    const progress = (force) => {
      const now = Date.now();
      if (!force && now - lastPrint < 2000) return;
      lastPrint = now;
      const el = (now - tV) / 1000;
      const fps = done / Math.max(1e-3, el);
      console.log(`frames ${done}/${frames} (${((100 * done) / frames).toFixed(0)}%)  ${fps.toFixed(1)} fps  eta ${((frames - done) / Math.max(1e-3, fps)).toFixed(0)}s`);
    };
    const renderOne = async (pg, f) => {
      const r = await pg.page.evaluate((T) => window.__h.render(T), f / FPS);
      if (r.errors.length) throw new Error(`frame ${f} (T=${(f / FPS).toFixed(3)}, ${r.shot}): ${r.errors.map((e) => e.message).join('; ')}`);
      return Buffer.from(await pg.page.evaluate(() => window.__h.png()), 'base64');
    };

    if (workers === 1) {
      enc = runFfmpeg(encodeArgs({ input: ['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-'], wav, out: partial, frames, crf, preset, fps: FPS }), { stdin: true });
      const stdin = enc.proc.stdin;
      let pipeErr = null;
      let exited = false;
      stdin.on('error', (e) => (pipeErr = e));
      const closed = new Promise((res) => enc.proc.once('close', () => res((exited = true))));
      const encoderGone = async () => {
        if (!pipeErr && !exited) return;
        const why = await enc.done.then(() => (pipeErr ? pipeErr.message : 'exited early'), (e) => e.message);
        throw new Error(`ffmpeg stopped reading frames after ${done} of ${frames}: ${why}`);
      };
      for (let f = f0; f < f1; f++) {
        const png = await renderOne(pages[0], f);
        await encoderGone();
        if (!stdin.write(png)) {
          await Promise.race([new Promise((res) => stdin.once('drain', res)), closed]);
          await encoderGone();
        }
        done++;
        progress(false);
      }
      stdin.end();
      progress(true);
      console.log(`frames rendered in ${((Date.now() - tV) / 1000).toFixed(1)}s, encoding...`);
      await enc.done;
    } else {
      const per = Math.ceil(frames / workers);
      await Promise.all(
        pages.map(async (pg, i) => {
          const a = f0 + i * per;
          const b = Math.min(f1, a + per);
          for (let f = a; f < b; f++) {
            const png = await renderOne(pg, f);
            fs.writeFileSync(path.join(work, `f${String(f - f0).padStart(6, '0')}.png`), png);
            done++;
            progress(false);
          }
        })
      );
      progress(true);
      console.log(`frames rendered in ${((Date.now() - tV) / 1000).toFixed(1)}s, encoding...`);
      const tE = Date.now();
      enc = runFfmpeg(encodeArgs({ input: ['-framerate', String(FPS), '-start_number', '0', '-i', path.join(work, 'f%06d.png')], wav, out: partial, frames, crf, preset, fps: FPS }));
      await enc.done;
      console.log(`encoded in ${((Date.now() - tE) / 1000).toFixed(1)}s`);
    }
    if (done !== frames) throw new Error(`only ${done} of ${frames} frames were rendered`);
    if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) throw new Error(`ffmpeg exited 0 but wrote no output at ${partial}`);
    try {
      fs.renameSync(partial, out);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(partial, out + '.partial');
      fs.renameSync(out + '.partial', out);
      fs.rmSync(partial, { force: true });
    }
    ok = true;
  } finally {
    if (enc && enc.proc.exitCode === null && enc.proc.signalCode === null) {
      enc.proc.kill('SIGKILL');
      await enc.done.catch(() => {});
    }
    await Promise.all(pages.map((pg) => pg.close()));
    await Promise.all(launches.map((p) => p.then((b) => b.close()).catch(() => {})));
    fs.rmSync(partial, { force: true });
    if (!args.keep) {
      fs.rmSync(work, { recursive: true, force: true });
      forgetWork();
    } else if (!ok) {
      console.log(`kept work folder ${work} (no partial video)`);
    }
  }
  const size = fs.statSync(out).size;
  console.log(`wrote ${out} (${(size / 1024 / 1024).toFixed(2)} MB, ${frames} frames, ${(frames / FPS).toFixed(3)}s) total ${lap()}`);
}

main().catch((e) => {
  console.error(`\n[error] ${e && e.message ? e.message : e}`);
  process.exit(2);
});
