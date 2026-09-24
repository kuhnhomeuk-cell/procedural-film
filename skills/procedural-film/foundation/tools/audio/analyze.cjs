// analyze.cjs : measure a rendered score WAV.
//   node tools/audio/analyze.cjs <wav> [--cues] [--bars] [--seam] [--onsets] [--ref full.wav --offset S]
// cues:   energy-flux onsets matched to every FILM.TIMELINE cue (pass within 10 ms)
// bars:   RMS per bar and per beat pair, with a text bar graph
// seam:   last 0.25 s into first 0.25 s: level, boundary step, click energy at the joint
// ref:    this file was rendered with start = S; compare its onsets and waveform with the full render
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../common.cjs');

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12;
  let fmt = null;
  let data = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  if (!fmt || fmt.format !== 3 || fmt.bits !== 32) throw new Error('expects 32-bit float WAV');
  const n = Math.floor(data.length / 4 / fmt.ch);
  const f = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + n * 4 * fmt.ch));
  const chans = [];
  for (let c = 0; c < fmt.ch; c++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = f[i * fmt.ch + c];
    chans.push(a);
  }
  return { sr: fmt.sr, n, chans };
}

function biquadHP(x, sr, f0, q = 0.707) {
  const w = (2 * Math.PI * f0) / sr;
  const al = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const b0 = (1 + cw) / 2, b1 = -(1 + cw), b2 = (1 + cw) / 2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

const db = (p) => 10 * Math.log10(p + 1e-12);

// Onsets from a high-passed energy envelope: 2.7 ms windows every 0.5 ms, rise over the last 12 ms.
// The onset time is where the log energy first climbs halfway (in dB) from the foot to the peak,
// measured at the newest sample of that window. preroll: seconds of the file's end placed before
// its start, which is how a looping player hears t = 0.
function onsets(w, { hp = 500, thr = 6, from = 0, preroll = 0 } = {}) {
  const { sr, chans } = w;
  const pre = Math.floor(preroll * sr);
  const n = w.n + pre;
  const mono = new Float32Array(n);
  for (let i = 0; i < pre; i++) mono[i] = (chans[0][w.n - pre + i] + chans[1][w.n - pre + i]) * 0.5;
  for (let i = 0; i < w.n; i++) mono[pre + i] = (chans[0][i] + chans[1][i]) * 0.5;
  const x = biquadHP(mono, sr, hp);
  const N = 128, H = 24;
  const frames = Math.floor((n - N) / H);
  const L = new Float32Array(frames);
  let acc = 0;
  for (let i = 0; i < N; i++) acc += x[i] * x[i];
  for (let k = 0; k < frames; k++) {
    if (k > 0) for (let i = (k - 1) * H; i < k * H; i++) { acc -= x[i] * x[i]; acc += x[i + N] * x[i + N]; }
    L[k] = db(Math.max(acc, 0) / N);
  }
  const lag = Math.round((0.012 * sr) / H);
  const D = new Float32Array(frames);
  for (let k = lag; k < frames; k++) {
    let mn = Infinity;
    for (let j = k - lag; j < k; j++) if (L[j] < mn) mn = L[j];
    D[k] = Math.max(0, L[k] - mn);
  }
  const edge = (k) => (k * H + N) / sr - preroll;
  const out = [];
  const guard = Math.round((0.03 * sr) / H);
  for (let k = lag; k < frames - 1; k++) {
    if (D[k] < thr || L[k] < -75) continue;
    let isMax = true;
    for (let j = Math.max(lag, k - guard); j <= Math.min(frames - 1, k + guard); j++) if (D[j] > D[k] || (D[j] === D[k] && j < k)) { isMax = false; break; }
    if (!isMax) continue;
    let foot = k - lag;
    for (let j = k - lag; j <= k; j++) if (L[j] < L[foot]) foot = j;
    const half = L[foot] + (L[k] - L[foot]) * 0.5;
    let s = foot;
    while (s < k && L[s] < half) s++;
    const t = edge(s);
    if (t >= from) out.push({ t, rise: D[k], level: L[k] });
  }
  return out;
}

function rms(w, a, b) {
  const i0 = Math.max(0, Math.floor(a * w.sr)), i1 = Math.min(w.n, Math.floor(b * w.sr));
  let s = 0;
  for (let i = i0; i < i1; i++) s += (w.chans[0][i] ** 2 + w.chans[1][i] ** 2) / 2;
  return db(s / Math.max(1, i1 - i0));
}

(async () => {
  const args = C.parseArgs(process.argv.slice(2), ['cues', 'bars', 'seam', 'onsets', 'fixtures']);
  const fx = typeof args.fixtures === 'string' ? C.resolveOut(args.fixtures) : args.fixtures ? C.FIX : path.join(C.ROOT, 'src');
  const file = C.resolveOut(args._[0] || '.tmp/audio/score.wav');
  const w = readWav(file);
  const tl = C.loadTimeline(path.join(fx, 'timeline.js'));
  const offset = args.offset ? Number(args.offset) : 0;
  console.log(`${path.basename(file)}: ${(w.n / w.sr).toFixed(3)} s, ${w.sr} Hz, ${w.chans.length} ch`);

  if (args.bars) {
    console.log('\nper-bar RMS (dBFS) and per-beat-pair RMS:');
    for (let b = 0; b < 16; b++) {
      const a = b * 2;
      const r = rms(w, a, a + 2);
      const h1 = rms(w, a, a + 1), h2 = rms(w, a + 1, a + 2);
      const bar = '#'.repeat(Math.max(0, Math.round((r + 40) * 1.2)));
      console.log(`bar ${String(b + 1).padStart(2)} ${String(a).padStart(2)}-${String(a + 2).padStart(2)} s  ${r.toFixed(1).padStart(6)}  [${h1.toFixed(1).padStart(6)} ${h2.toFixed(1).padStart(6)}]  ${bar}`);
    }
  }

  if (args.cues || args.onsets) {
    // two bands: 500 Hz up for tonal attacks, 2 kHz up where transients stand clear of pads
    const os = [...onsets(w, { preroll: 0.5 }), ...onsets(w, { preroll: 0.5, hp: 2000 })].sort((p, q) => p.t - q.t);
    if (args.onsets) for (const o of os) console.log(`onset ${o.t.toFixed(4)}  rise ${o.rise.toFixed(1)} dB  level ${o.level.toFixed(1)}`);
    if (args.cues) {
      console.log(`\n${os.length} onsets detected; cue matching (window 10 ms):`);
      let worst = 0, fails = 0;
      const seen = new Set();
      for (const cue of tl.cues) {
        if (seen.has(cue.t)) continue;
        seen.add(cue.t);
        let best = null;
        for (const o of os) if (!best || Math.abs(o.t - cue.t) < Math.abs(best.t - cue.t)) best = o;
        const err = best ? best.t - cue.t : Infinity;
        const ok = Math.abs(err) <= 0.010;
        if (!ok) fails++;
        worst = Math.max(worst, Math.abs(err));
        console.log(`${ok ? 'ok  ' : 'MISS'} cue ${cue.t.toFixed(3).padStart(6)} ${cue.kind.padEnd(5)} onset ${best ? best.t.toFixed(4) : '-'}  err ${(err * 1000).toFixed(1).padStart(6)} ms  rise ${best ? best.rise.toFixed(1) : '-'} dB`);
      }
      console.log(`cue times: ${seen.size}, misses: ${fails}, worst error ${(worst * 1000).toFixed(1)} ms`);
    }
  }

  if (args.seam) {
    const sr = w.sr;
    const last = rms(w, w.n / sr - 0.25, w.n / sr), first = rms(w, 0, 0.25);
    const last50 = rms(w, w.n / sr - 0.05, w.n / sr - 0.004), first50 = rms(w, 0.008, 0.05);
    console.log(`\nseam: last 0.25 s ${last.toFixed(1)} dBFS, first 0.25 s ${first.toFixed(1)} dBFS (step ${(first - last).toFixed(1)} dB)`);
    console.log(`      last 50 ms ${last50.toFixed(1)} dBFS, first 50 ms ${first50.toFixed(1)} dBFS (step ${(first50 - last50).toFixed(1)} dB)`);
    for (let c = 0; c < 2; c++) {
      const x = w.chans[c];
      let md = 0;
      const i0 = w.n - Math.floor(0.25 * sr);
      const d = [];
      for (let i = i0 + 1; i < w.n; i++) d.push(Math.abs(x[i] - x[i - 1]));
      d.sort((a, b) => a - b);
      md = d[Math.floor(d.length * 0.99)];
      console.log(`      ch${c}: last sample ${x[w.n - 1].toFixed(5)}, first sample ${x[0].toFixed(5)}, step ${Math.abs(x[w.n - 1] - x[0]).toFixed(5)} vs 99th pct step ${md.toFixed(5)}`);
    }
    // loop the joint: last 0.25 s then first 0.25 s, high-passed at 3 kHz, energy in 2.7 ms windows
    const m = Math.floor(0.25 * sr);
    const joint = new Float32Array(2 * m);
    for (let i = 0; i < m; i++) joint[i] = (w.chans[0][w.n - m + i] + w.chans[1][w.n - m + i]) / 2;
    for (let i = 0; i < m; i++) joint[m + i] = (w.chans[0][i] + w.chans[1][i]) / 2;
    const h = biquadHP(joint, sr, 3000);
    const N = 128;
    const e = [];
    for (let k = 0; k + N <= h.length; k += 32) {
      let s = 0;
      for (let i = k; i < k + N; i++) s += h[i] * h[i];
      e.push({ t: (k + N / 2) / sr - 0.25, v: db(s / N) });
    }
    const atJoint = e.filter((q) => Math.abs(q.t) < 0.004).reduce((a, q) => Math.max(a, q.v), -200);
    const sorted = e.map((q) => q.v).sort((a, b) => a - b);
    console.log(`      HF (>3 kHz) energy at the joint ${atJoint.toFixed(1)} dB, median over the 0.5 s ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} dB, max ${sorted[sorted.length - 1].toFixed(1)} dB`);
  }

  if (args.ref) {
    const ref = readWav(C.resolveOut(args.ref));
    const S = offset;
    const a = onsets(w, { from: 0.012 }).map((o) => ({ ...o, t: o.t + S }));
    const b = onsets(ref, { from: S + 0.012 });
    let matched = 0, worst = 0, sum = 0;
    const unmatched = [];
    for (const o of a) {
      let best = null;
      for (const q of b) if (!best || Math.abs(q.t - o.t) < Math.abs(best.t - o.t)) best = q;
      if (best && Math.abs(best.t - o.t) < 0.02) {
        matched++;
        worst = Math.max(worst, Math.abs(best.t - o.t));
        sum += Math.abs(best.t - o.t);
      } else unmatched.push(o.t.toFixed(3));
    }
    console.log(`\nseek compare (start ${S}): ${a.length} onsets in the seek render, ${b.length} in the full render after ${S}`);
    {
      const both = [...a, ...onsets(w, { from: 0.012, hp: 2000 }).map((o) => ({ ...o, t: o.t + S }))];
      let worstCue = 0, n = 0, miss = [];
      for (const t of [...new Set(tl.cues.map((c) => c.t))].filter((t) => t >= S + 0.012)) {
        let best = null;
        for (const o of both) if (!best || Math.abs(o.t - t) < Math.abs(best.t - t)) best = o;
        const e = best ? Math.abs(best.t - t) : Infinity;
        n++;
        worstCue = Math.max(worstCue, e);
        if (e > 0.01) miss.push(t);
      }
      console.log(`  cues after the seek point: ${n}, worst error ${(worstCue * 1000).toFixed(1)} ms, misses: ${miss.join(' ') || 'none'}`);
    }
    console.log(`  matched ${matched}, mean |dt| ${((sum / Math.max(1, matched)) * 1000).toFixed(2)} ms, worst ${(worst * 1000).toFixed(2)} ms, unmatched: ${unmatched.slice(0, 20).join(' ') || 'none'}`);
    // waveform lag by cross-correlation on 0.5 s windows
    for (const tt of [S + 0.5, S + 2, S + 5, S + 9].filter((q) => q + 0.5 < ref.n / ref.sr && q - S + 0.5 < w.n / w.sr)) {
      const m = Math.floor(0.5 * w.sr);
      const ia = Math.floor((tt - S) * w.sr), ib = Math.floor(tt * ref.sr);
      let bestLag = 0, bestC = -Infinity;
      for (let lag = -480; lag <= 480; lag++) {
        let c = 0, ea = 0, eb = 0;
        for (let i = 0; i < m; i += 2) {
          const x = w.chans[0][ia + i], y = ref.chans[0][ib + i + lag] || 0;
          c += x * y; ea += x * x; eb += y * y;
        }
        const nc = c / Math.sqrt(ea * eb + 1e-20);
        if (nc > bestC) { bestC = nc; bestLag = lag; }
      }
      let diff = 0, en = 0;
      for (let i = 0; i < m; i++) {
        const x = w.chans[0][ia + i], y = ref.chans[0][ib + i];
        diff += (x - y) ** 2; en += y * y;
      }
      console.log(`  window ${tt.toFixed(1)} s: best lag ${bestLag} samples (${((bestLag / w.sr) * 1000).toFixed(2)} ms), correlation ${bestC.toFixed(4)}, residual ${db(diff / (en + 1e-20)).toFixed(1)} dB`);
    }
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
