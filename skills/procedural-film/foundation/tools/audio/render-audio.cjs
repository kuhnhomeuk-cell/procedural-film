// render-audio.cjs : render FILM.audio offline in headless Chromium to a 48 kHz stereo float WAV.
//   node tools/audio/render-audio.cjs [--start 0] [--end 32] [--out .tmp/audio/score.wav] [--fixtures[=<dir>]]
//   The prelude files (a retro film's chip.js among them) load between the timeline and music.js.
'use strict';
const path = require('path');
const fs = require('fs');
const C = require('../common.cjs');

(async () => {
  const args = C.parseArgs(process.argv.slice(2), ['fixtures']);
  const start = args.start != null ? Number(args.start) : 0;
  const SR = 48000;
  const src = path.join(C.ROOT, 'src');
  const fixtures = typeof args.fixtures === 'string' ? args.fixtures : !!args.fixtures;
  const base = fixtures ? (typeof fixtures === 'string' ? C.resolveOut(fixtures) : C.FIX) : src;
  const files = [path.join(src, 'core.js'), path.join(src, 'lib.js'), ...C.preludeFiles(base), path.join(base, 'timeline.js'), path.join(base, 'music.js')];
  const tl = C.loadTimeline(path.join(base, 'timeline.js'));
  const chip = files.some((f) => path.basename(f) === 'chip.js');
  if (chip && (args.mix != null || args.solo != null || args.mute != null)) {
    console.log('note: --mix, --solo and --mute act on the drawn score buses; a chip score renders whole, so they are ignored');
  }
  const end = args.end != null ? Number(args.end) : tl.duration;
  const out = C.resolveOut(typeof args.out === 'string' ? args.out : '.tmp/audio/score.wav');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const browser = await C.launch();
  let pg;
  try {
    pg = await C.openPage(browser, files, { scale: 0.1, prefix: 'audio' });
    const problems = [...pg.loadErrors.map((e) => `${e.file}:${e.line}:${e.col} ${e.message}`), ...pg.pageErrors];
    if (problems.length) throw new Error('load errors:\n  ' + problems.join('\n  '));
    const t0 = Date.now();
    const BUSES = ['drums', 'bass', 'pad', 'keys', 'bells', 'lead', 'sfx', 'amb'];
    let mix = null;
    if (chip) {
      /* a chip score has no buses: render it whole */
    } else if (typeof args.solo === 'string' || typeof args.mute === 'string') {
      const pick = String(args.solo || args.mute).split(',');
      mix = { bus: {} };
      for (const b of BUSES) if (args.solo ? !pick.includes(b) : pick.includes(b)) mix.bus[b] = 0;
    }
    if (!chip && typeof args.mix === 'string') mix = Object.assign(mix || {}, JSON.parse(args.mix));
    const a = mix
      ? await pg.page.evaluate(
          async ([s, e, sr, m]) => {
            const len = Math.max(1, Math.round((e - s) * sr));
            const ctx = new OfflineAudioContext(2, len, sr);
            FILM.audio.render(ctx, { start: s, dest: ctx.destination, mix: m });
            const buf = await ctx.startRendering();
            const L = buf.getChannelData(0), R = buf.getChannelData(1);
            const inter = new Float32Array(len * 2);
            let peak = 0;
            for (let i = 0; i < len; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }
            const bytes = new Uint8Array(inter.buffer);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            return { b64: btoa(bin), frames: len, peak };
          },
          [start, end, SR, mix]
        )
      : await pg.page.evaluate(([s, e, sr]) => window.__h.audio(s, e, sr), [start, end, SR]);
    if (a.missing) throw new Error('FILM.audio.render missing');
    C.writeWavFloat(out, a.b64, 2, SR);
    console.log(`rendered ${start}..${end} s in ${((Date.now() - t0) / 1000).toFixed(2)} s, sample peak ${a.peak.toFixed(4)} (${(20 * Math.log10(a.peak)).toFixed(2)} dBFS) -> ${out}`);
    if (pg.pageErrors.length || pg.consoleErrors.length) console.log('page errors:', pg.pageErrors, pg.consoleErrors);
  } finally {
    if (pg) await pg.close();
    await browser.close();
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
