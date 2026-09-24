// chip.js : the retro kit's sound, a sound driver and an emulated NES 2A03 APU. Load it before src/music.js.
// Lifted from examples/claude-quest-game/src/music.js (chip 1-724, effect helpers 1125-1175, driver and
// rendering 1352-1624). The score and the effects live in the film's own src/music.js, which registers them:
//
//   FILM.chip.define({ songs: { id: { speed, sections?, loop?, p1?, p2?, t?, n?, d? } },
//                      sfx:   { kind: (ev, K) => ({ pri, p1?, p2?, t?, n? }) } })
//
// K is FILM.chip itself (mhz, pt, psw, trill, nz, tthud, gap, cat, SIL, INST, NDRUM, DDRUM). define merges,
// so a game may call it more than once.
//
// FILM.audio.render(ctx, { start = 0, dest = ctx.destination }) plays the whole film from global time `start`
// into any BaseAudioContext. Events come from FILM.game.events() when a game is loaded, otherwise from
// FILM.TIMELINE.cues: { t, kind:'song', id, section } switches the song, any other kind fires sfx[kind],
// at frame round(t * 60). FILM.audio.live(audioCtx, { dest }) runs the same driver and chip in real time.
//
// The driver runs once per 60 Hz frame, advances the song one tick, lets an effect take over its channel
// for its length, and writes APU register writes ($4000-$4017). The APU emulates two pulses, the triangle,
// the noise LFSR and the DMC, mixed by the console's non-linear DAC and filtered like the console output.
// No reverb, delay, compressor or panning: the buffer is the chip times one flat gain, mono in both
// channels. Deterministic: the only randomness is FILM.lib.rng with fixed seeds.
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  const FILM = root.FILM;
  const lib = FILM.lib;
  const TAU = Math.PI * 2;

  // ---------------------------------------------------------------- hardware constants
  const CPU = 1789773; // NTSC 2A03 clock, Hz
  const FPS = 60; // driver frames per second (the film's frame rate)
  const SUB = 4; // integration sub-samples per output sample
  const HALF = 23; // decimation filter half length, in sub-samples
  const GAIN = 2.87; // flat master gain, set by measurement (tools/audio/loudness.cjs): -14 LUFS
  const DUTY = [
    [0, 1, 0, 0, 0, 0, 0, 0], // 12.5 %
    [0, 1, 1, 0, 0, 0, 0, 0], // 25 %
    [0, 1, 1, 1, 1, 0, 0, 0], // 50 %
    [1, 0, 0, 1, 1, 1, 1, 1], // 25 % negated
  ];
  const TRI = [];
  for (let i = 15; i >= 0; i--) TRI.push(i);
  for (let i = 0; i <= 15; i++) TRI.push(i);
  const NOISE = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  const DMC_RATE = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
  const LENGTH = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
  const DMC_LEVEL0 = 40; // $4011 as the game's reset code left it, long before the TV came on

  // ---------------------------------------------------------------- pitch
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-G])(#|b)?(-?\d)$/.exec(n);
    if (!m) throw new Error('music.js: bad note ' + n);
    return 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  const mhz = (m) => 440 * Math.pow(2, (midi(m) - 69) / 12);
  const clampT = (t) => Math.max(0, Math.min(2047, t));
  const ptimer = (hz) => clampT(Math.round(CPU / (16 * hz) - 1)); // pulse: f = CPU / (16 (t + 1))
  const ttimer = (hz) => clampT(Math.round(CPU / (32 * hz) - 1)); // triangle: f = CPU / (32 (t + 1))

  // ---------------------------------------------------------------- DMC samples (the ROM at $C000)
  // Each drum is synthesised at its playback rate and delta-encoded greedily (a 1 bit steps the 7-bit DAC
  // up by 2, a 0 steps it down by 2). Every sample holds as many 1s as 0s, so it returns the DAC to the
  // level it started from and the drums never drift the channel's DC level.
  const DMC_MEM = new Uint8Array(0x4000);
  const DMC = {}; // name -> { a: $4012 value, l: $4013 value, bytes }
  const dmcHz = (rate) => CPU / DMC_RATE[rate];
  function dmcEncode(wave) {
    const L0 = DMC_LEVEL0;
    const need = wave.length + 64; // the wave, then at least 64 bits to settle home
    const nBytes = Math.ceil((need / 8 - 1) / 16) * 16 + 1; // lengths are 16 n + 1 bytes
    const bits = nBytes * 8;
    const out = new Uint8Array(nBytes);
    let level = L0;
    for (let i = 0; i < bits; i++) {
      let bit;
      if (i < wave.length) {
        const target = L0 + wave[i];
        bit = level < target ? 1 : level > target ? 0 : i & 1;
      } else {
        const off = level - L0; // settle: walk home, then hover up-down so the last bit lands on L0
        bit = off < 0 ? 1 : off > 0 ? 0 : 1;
      }
      if (!bit && level < 2) bit = 1; // never ask for a step the DAC would clamp: the 1s and 0s stay paired
      else if (bit && level > 125) bit = 0;
      if (bit) {
        if (level <= 125) level += 2;
        out[i >> 3] |= 1 << (i & 7); // bits play LSB first
      } else if (level >= 2) level -= 2;
    }
    if (level !== L0) throw new Error('music.js: DMC sample does not return to its level');
    return out;
  }
  function dmcSynth(rate, seconds, fn) {
    const sr = dmcHz(rate);
    const n = Math.round(seconds * sr);
    const w = new Float64Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const r = fn(t, ph);
      w[i] = r.x;
      ph += (TAU * (r.hz || 0)) / sr;
    }
    return w;
  }
  (function buildDmc() {
    const noise = lib.rng('claude-quest-dmc');
    const kick = dmcSynth(15, 0.11, (t, ph) => {
      const env = t < 0.0008 ? t / 0.0008 : Math.exp(-(t - 0.0008) / 0.042);
      const click = t < 0.002 ? (noise() * 2 - 1) * 12 * (1 - t / 0.002) : 0;
      return { x: 28 * env * Math.sin(ph) + click, hz: 46 + 170 * Math.exp(-t / 0.016) };
    });
    const snare = dmcSynth(15, 0.13, (t, ph) => {
      const tone = 9 * Math.exp(-t / 0.028) * (Math.sin(ph) + 0.6 * Math.sin(ph * 1.78));
      const hiss = 17 * Math.exp(-t / 0.045) * (noise() * 2 - 1);
      return { x: tone + hiss, hz: 188 };
    });
    // Timpani: a membrane's inharmonic partials under a felt mallet. Tuned so rate 15 plays the root and
    // rate 14 (0.75x) the fifth below it: a tonic-dominant pair from one sample, as real carts did.
    const timp = (root) =>
      dmcSynth(15, 0.36, (t, ph) => {
        const env = t < 0.004 ? t / 0.004 : 1;
        const x = Math.sin(ph) * Math.exp(-t / 0.3) + 0.45 * Math.sin(ph * 1.5 + 0.3) * Math.exp(-t / 0.16) + 0.22 * Math.sin(ph * 1.98 + 1.1) * Math.exp(-t / 0.09);
        const mallet = t < 0.005 ? (noise() * 2 - 1) * 8 * (1 - t / 0.005) : 0;
        return { x: 24 * env * x + mallet, hz: root };
      });
    let addr = 0;
    for (const [name, wave] of [['kick', kick], ['snare', snare], ['timpD', timp(mhz('D3'))], ['timpC', timp(mhz('C3'))]]) {
      const bytes = dmcEncode(wave);
      DMC_MEM.set(bytes, addr);
      DMC[name] = { a: addr >> 6, l: (bytes.length - 1) >> 4, bytes: bytes.length };
      addr = Math.ceil((addr + bytes.length) / 64) * 64;
    }
    DMC.romBytes = addr;
  })();

  // ---------------------------------------------------------------- the APU
  // A register-level 2A03 sound unit. write(addr, value) as the CPU would; quarter(q) is the frame
  // counter's quarter-frame clock (4-step mode); fill(ring, s0, n) integrates n sub-samples.
  function makeApu(sr) {
    const RS = sr * SUB;
    const cps = CPU / RS; // CPU cycles per sub-sample
    const pulse = (i) => ({ i, duty: 0, halt: false, cv: true, vol: 0, envStart: false, envDiv: 0, decay: 0, swEn: false, swP: 0, swN: false, swS: 0, swDiv: 0, swReload: false, t: 0, per: 2, cnt: 2, pos: 0, len: 0, on: false, mute: true });
    const P = [pulse(0), pulse(1)];
    const T = { ctrl: false, linR: 0, lin: 0, linFlag: false, t: 0, cnt: 1, pos: 0, len: 0, on: false };
    const N = { halt: false, cv: true, vol: 0, envStart: false, envDiv: 0, decay: 0, mode: 0, per: 4, cnt: 4, lfsr: 1, len: 0, on: false };
    const D = { loop: false, rate: DMC_RATE[0], cnt: DMC_RATE[0], level: DMC_LEVEL0, addr: 0xc000, length: 1, cur: 0xc000, left: 0, buf: -1, shift: 0, bits: 8, silent: true, on: false };

    const target = (c) => {
      const ch = c.t >> c.swS;
      return c.swN ? c.t - ch - (c.i === 0 ? 1 : 0) : c.t + ch;
    };
    const remute = (c) => {
      c.mute = c.t < 8 || (!c.swN && target(c) > 0x7ff);
      c.per = 2 * (c.t + 1);
    };
    function dmcFetch() {
      if (D.buf < 0 && D.left > 0) {
        D.buf = DMC_MEM[D.cur - 0xc000];
        D.cur = D.cur === 0xffff ? 0x8000 : D.cur + 1;
        D.left--;
        if (D.left === 0 && D.loop) {
          D.cur = D.addr;
          D.left = D.length;
        }
      }
    }
    function write(a, v) {
      if (a < 0x4008) {
        const c = P[(a - 0x4000) >> 2];
        switch (a & 3) {
          case 0:
            c.duty = v >> 6;
            c.halt = !!(v & 0x20);
            c.cv = !!(v & 0x10);
            c.vol = v & 15;
            break;
          case 1:
            c.swEn = !!(v & 0x80);
            c.swP = (v >> 4) & 7;
            c.swN = !!(v & 8);
            c.swS = v & 7;
            c.swReload = true;
            remute(c);
            break;
          case 2:
            c.t = (c.t & 0x700) | v;
            remute(c);
            break;
          default:
            c.t = (c.t & 0xff) | ((v & 7) << 8);
            if (c.on) c.len = LENGTH[v >> 3];
            c.pos = 0; // $4003 restarts the duty sequencer: the phase reset drivers avoid mid-note
            c.envStart = true;
            remute(c);
        }
        return;
      }
      switch (a) {
        case 0x4008:
          T.ctrl = !!(v & 0x80);
          T.linR = v & 0x7f;
          break;
        case 0x400a:
          T.t = (T.t & 0x700) | v;
          break;
        case 0x400b:
          T.t = (T.t & 0xff) | ((v & 7) << 8);
          if (T.on) T.len = LENGTH[v >> 3];
          T.linFlag = true;
          break;
        case 0x400c:
          N.halt = !!(v & 0x20);
          N.cv = !!(v & 0x10);
          N.vol = v & 15;
          break;
        case 0x400e:
          N.mode = v >> 7;
          N.per = NOISE[v & 15];
          break;
        case 0x400f:
          if (N.on) N.len = LENGTH[v >> 3];
          N.envStart = true;
          break;
        case 0x4010:
          D.loop = !!(v & 0x40);
          D.rate = DMC_RATE[v & 15];
          break;
        case 0x4011:
          D.level = v & 0x7f;
          break;
        case 0x4012:
          D.addr = 0xc000 + v * 64;
          break;
        case 0x4013:
          D.length = v * 16 + 1;
          break;
        case 0x4015:
          P[0].on = !!(v & 1);
          P[1].on = !!(v & 2);
          T.on = !!(v & 4);
          N.on = !!(v & 8);
          if (!P[0].on) P[0].len = 0;
          if (!P[1].on) P[1].len = 0;
          if (!T.on) T.len = 0;
          if (!N.on) N.len = 0;
          if (v & 0x10) {
            if (D.left === 0) {
              D.cur = D.addr;
              D.left = D.length;
            }
            dmcFetch();
          } else D.left = 0;
          break;
        default:
      }
    }
    function env(c) {
      if (c.envStart) {
        c.envStart = false;
        c.decay = 15;
        c.envDiv = c.vol;
      } else if (c.envDiv === 0) {
        c.envDiv = c.vol;
        if (c.decay > 0) c.decay--;
        else if (c.halt) c.decay = 15;
      } else c.envDiv--;
    }
    function quarter(q) {
      env(P[0]);
      env(P[1]);
      env(N);
      if (T.linFlag) T.lin = T.linR;
      else if (T.lin > 0) T.lin--;
      if (!T.ctrl) T.linFlag = false;
      if (q & 1) {
        for (const c of P) {
          if (c.len > 0 && !c.halt) c.len--;
          if (c.swDiv === 0 && c.swEn && c.swS > 0 && !c.mute) {
            c.t = Math.max(0, target(c));
            remute(c);
          }
          if (c.swDiv === 0 || c.swReload) {
            c.swDiv = c.swP;
            c.swReload = false;
          } else c.swDiv--;
        }
        if (T.len > 0 && !T.ctrl) T.len--;
        if (N.len > 0 && !N.halt) N.len--;
      }
    }

    // Between two boundaries (a driver frame's register writes, a frame-counter clock) every channel's
    // parameters are constant, so each channel runs as its own tight loop over the stretch, then one loop
    // mixes and filters. Each channel's output is integrated exactly over every sub-sample.
    const QMAX = Math.ceil(RS / (FPS * 4)) + 2; // the longest stretch: one quarter frame
    const sp = new Float64Array(QMAX); // pulse 1 + pulse 2
    const stn = new Float64Array(QMAX); // triangle / 8227 + noise / 12241 + DMC / 22638
    function runPulse(c, n) {
      if (c.mute) return; // silenced by the sweep unit's muting: the timer's phase is not modelled
      const lvl = c.len > 0 ? (c.cv ? c.vol : c.decay) : 0;
      const seq = DUTY[c.duty];
      const per = c.per;
      const scale = lvl / cps;
      let cnt = c.cnt;
      let pos = c.pos;
      for (let i = 0; i < n; i++) {
        let rem = cps;
        let acc = 0;
        let o = seq[pos];
        while (cnt <= rem) {
          acc += o * cnt;
          rem -= cnt;
          pos = (pos + 1) & 7;
          o = seq[pos];
          cnt = per;
        }
        acc += o * rem;
        cnt -= rem;
        sp[i] += acc * scale;
      }
      c.cnt = cnt;
      c.pos = pos;
    }
    function runTri(n) {
      if (T.lin === 0 || T.len === 0 || T.t < 2) {
        const v = TRI[T.pos] / 8227; // halted: the sequencer holds its step
        for (let i = 0; i < n; i++) stn[i] += v;
        return;
      }
      const per = T.t + 1;
      const scale = 1 / (cps * 8227);
      let cnt = T.cnt;
      let pos = T.pos;
      for (let i = 0; i < n; i++) {
        let rem = cps;
        let acc = 0;
        let o = TRI[pos];
        while (cnt <= rem) {
          acc += o * cnt;
          rem -= cnt;
          pos = (pos + 1) & 31;
          o = TRI[pos];
          cnt = per;
        }
        acc += o * rem;
        cnt -= rem;
        stn[i] += acc * scale;
      }
      T.cnt = cnt;
      T.pos = pos;
    }
    function runNoise(n) {
      const lvl = N.len > 0 ? (N.cv ? N.vol : N.decay) : 0;
      if (lvl === 0) return; // silent: the shift register is not clocked
      const per = N.per;
      const tap = N.mode ? 6 : 1;
      const scale = lvl / (cps * 12241);
      let cnt = N.cnt;
      let lfsr = N.lfsr;
      for (let i = 0; i < n; i++) {
        let rem = cps;
        let acc = 0;
        let o = lfsr & 1 ? 0 : 1;
        while (cnt <= rem) {
          acc += o * cnt;
          rem -= cnt;
          lfsr = (lfsr >> 1) | (((lfsr ^ (lfsr >> tap)) & 1) << 14);
          o = lfsr & 1 ? 0 : 1;
          cnt = per;
        }
        acc += o * rem;
        cnt -= rem;
        stn[i] += acc * scale;
      }
      N.cnt = cnt;
      N.lfsr = lfsr;
    }
    function runDmc(n) {
      const scale = 1 / (cps * 22638);
      for (let i = 0; i < n; i++) {
        let rem = cps;
        let acc = 0;
        while (D.cnt <= rem) {
          acc += D.level * D.cnt;
          rem -= D.cnt;
          if (!D.silent) {
            if (D.shift & 1) {
              if (D.level <= 125) D.level += 2;
            } else if (D.level >= 2) D.level -= 2;
          }
          D.shift >>= 1;
          if (--D.bits === 0) {
            D.bits = 8;
            if (D.buf < 0) D.silent = true;
            else {
              D.silent = false;
              D.shift = D.buf;
              D.buf = -1;
              dmcFetch();
            }
          }
          D.cnt = D.rate;
        }
        acc += D.level * rem;
        D.cnt -= rem;
        stn[i] += acc * scale;
      }
    }

    // console output filters, first order, at the integration rate
    const dt = 1 / RS;
    const hpA = (fc) => {
      const rc = 1 / (TAU * fc);
      return rc / (rc + dt);
    };
    const a1 = hpA(90);
    const a2 = hpA(440);
    const lrc = 1 / (TAU * 14000);
    const b3 = dt / (lrc + dt);
    const F = { x1: 0, y1: 0, x2: 0, y2: 0, y3: 0, primed: false };
    function fill(ring, s0, n) {
      sp.fill(0, 0, n);
      stn.fill(0, 0, n);
      runPulse(P[0], n);
      runPulse(P[1], n);
      runTri(n);
      runNoise(n);
      runDmc(n);
      let { x1, y1, x2, y2, y3 } = F;
      if (!F.primed) {
        const ps = sp[0];
        const tn = stn[0];
        x1 = (ps > 0 ? 95.88 / (8128 / ps + 100) : 0) + (tn > 0 ? 159.79 / (1 / tn + 100) : 0); // the console has been on for a while: no step into the first sample
        F.primed = true;
      }
      for (let i = 0; i < n; i++) {
        const ps = sp[i];
        const tn = stn[i];
        const x = (ps > 0 ? 95.88 / (8128 / ps + 100) : 0) + (tn > 0 ? 159.79 / (1 / tn + 100) : 0);
        y1 = a1 * (y1 + x - x1);
        x1 = x;
        y2 = a2 * (y2 + y1 - x2);
        x2 = y1;
        y3 += b3 * (y2 - y3);
        ring[(s0 + i) & 2047] = y3;
      }
      Object.assign(F, { x1, y1, x2, y2, y3 });
    }
    return { write, quarter, fill, RS };
  }

  // The decimation filter: a Blackman-windowed sinc, zero phase, unity gain at DC.
  const firCache = {};
  function fir(sr) {
    if (firCache[sr]) return firCache[sr];
    const RS = sr * SUB;
    const fc = Math.min(20000, 0.45 * sr) / RS;
    const h = new Float64Array(2 * HALF + 1);
    let hs = 0;
    for (let k = -HALF; k <= HALF; k++) {
      const x = k === 0 ? 2 * fc : Math.sin(TAU * fc * k) / (Math.PI * k);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * k) / (HALF + 1)) + 0.08 * Math.cos((TAU * k) / (HALF + 1));
      h[k + HALF] = x * w;
      hs += x * w;
    }
    for (let k = 0; k < h.length; k++) h[k] /= hs;
    return (firCache[sr] = h);
  }

  // The engine: the driver (feed) and the APU on one sample clock. feed(f) returns frame f's register
  // writes as a flat [addr, value, addr, value, ...] list; out(j) returns output sample j. Output j is
  // centred on sub-sample 4 j, so it waits for 23 sub-samples past it: a live stream lags 6 samples.
  // The ring holds 2048 sub-samples: the 47-tap span plus up to 1047 generated ahead.
  function makeEngine(sr, feed) {
    const apu = makeApu(sr);
    const RS = apu.RS;
    const h = fir(sr);
    const RING = 2048; // sub-samples kept: the filter's span plus the chunk generated ahead
    const ring = new Float32Array(RING);
    let s = 0;
    let f = 0;
    let fAt = 0;
    let q = 0;
    let qAt = 0;
    function genTo(end) {
      while (s < end) {
        if (s === fAt) {
          const w = feed(f);
          for (let i = 0; i < w.length; i += 2) apu.write(w[i], w[i + 1]);
          f++;
          fAt = Math.round((f * RS) / FPS);
        }
        if (s === qAt) {
          apu.quarter(q);
          q++;
          qAt = Math.round((q * RS) / (FPS * 4));
        }
        const stop = Math.min(end, fAt, qAt);
        apu.fill(ring, s, stop - s);
        s = stop;
      }
    }
    // chunks of 1024 sub-samples: the register writes still land on their exact sub-sample
    function out(j) {
      const c = j * SUB;
      if (s < c + HALF + 1) genTo(c + HALF + 1 + 1024);
      let acc = h[HALF] * ring[c & 2047];
      for (let k = 1; k <= HALF; k++) acc += h[HALF + k] * (ring[(c + k) & 2047] + ring[(c - k) & 2047]);
      return acc;
    }
    return { out, frame: () => f };
  }

  // ---------------------------------------------------------------- instruments (music voices)
  // A pulse instrument maps (frame k of a note, note length in frames, midi) to a voice state { v, d, t }
  // or null (silent). env: the first frames' volumes; then `sus`, falling by 1 every `fall` frames to
  // `floor` (fall 0 holds). duty: a per-frame duty list whose last entry holds. vib: [delay frames,
  // depth cents, period frames]. gate(len): frames sounded; by default a note of 3+ frames drops its
  // last frame so repeated notes articulate, the way the drivers of the day did.
  function pulseInst(o) {
    return {
      frame(k, len, m) {
        const gate = o.gate ? o.gate(len) : len >= 3 ? len - 1 : len;
        if (k >= gate) return null;
        let v;
        if (k < o.env.length) v = o.env[k];
        else if (o.fall) v = Math.max(o.floor || 0, o.sus - Math.floor((k - o.env.length) / o.fall));
        else v = o.sus;
        let hz = mhz(m);
        if (o.vib && k >= o.vib[0]) hz *= Math.pow(2, (o.vib[1] / 1200) * Math.sin((TAU * (k - o.vib[0])) / o.vib[2]));
        return { v, d: o.duty[Math.min(k, o.duty.length - 1)], t: ptimer(hz) };
      },
    };
  }
  function triInst(gateOf, vib) {
    return {
      frame(k, len, m) {
        if (k >= Math.max(1, Math.min(len, gateOf(len)))) return null;
        let hz = mhz(m);
        if (vib && k >= vib[0]) hz *= Math.pow(2, (vib[1] / 1200) * Math.sin((TAU * (k - vib[0])) / vib[2]));
        return { t: ttimer(hz) };
      },
    };
  }
  const INST = {
    lead: pulseInst({ duty: [1, 2], env: [13, 12, 11, 10], sus: 9, fall: 10, floor: 6, vib: [20, 9, 6] }),
    leadHi: pulseInst({ duty: [1], env: [11, 11, 10, 9], sus: 8, fall: 8, floor: 5, vib: [16, 8, 5] }),
    star: pulseInst({ duty: [2, 1], env: [13, 12, 11], sus: 10, fall: 6, floor: 6 }),
    harm: pulseInst({ duty: [1], env: [9, 8, 8, 7], sus: 6, fall: 10, floor: 4 }),
    stab: pulseInst({ duty: [1], env: [9, 8, 6, 4, 3, 2, 1], sus: 0 }),
    shim: pulseInst({ duty: [0], env: [8, 7, 5, 4], sus: 3 }),
    cave: pulseInst({ duty: [2], env: [14, 13, 11, 9, 7, 5, 3, 2], sus: 1 }),
    echo: pulseInst({ duty: [0], env: [7, 7, 6, 5, 4, 3, 2, 1], sus: 0 }),
    brass: pulseInst({ duty: [2], env: [12, 11, 10, 10, 9], sus: 8, fall: 12, floor: 6, vib: [14, 12, 6] }),
    brass2: pulseInst({ duty: [1], env: [8, 8, 7, 7, 6], sus: 6, fall: 12, floor: 4 }),
    // the fanfare's last chord: it dies away inside its own note, so the fanfare ends complete
    brassEnd: pulseInst({ duty: [2], env: [12, 11, 10, 10, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1], sus: 0, vib: [10, 10, 6], gate: (len) => len }),
    brass2End: pulseInst({ duty: [1], env: [8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1], sus: 0, gate: (len) => len }),
    pedal: pulseInst({ duty: [1], env: [3, 4, 5, 5], sus: 5, fall: 0, vib: [8, 10, 11], gate: (len) => len }),
    dim: pulseInst({ duty: [0], env: [7, 6, 4, 3, 2], sus: 1 }),
    sing: pulseInst({ duty: [2], env: [7, 9, 10, 11, 11, 10], sus: 10, fall: 18, floor: 6, vib: [18, 14, 7], gate: (len) => len - 1 }),
    soft: pulseInst({ duty: [0], env: [7, 6, 6, 5], sus: 5, fall: 14, floor: 3 }),
    // the ending's last chord: it sings, then sinks slowly to a whisper and holds there
    singEnd: pulseInst({ duty: [2], env: [9, 10, 11, 11, 10], sus: 10, fall: 40, floor: 3, vib: [18, 14, 7], gate: (len) => len }),
    softEnd: pulseInst({ duty: [0], env: [7, 6, 6, 5], sus: 5, fall: 60, floor: 2, gate: (len) => len }),
    bass: triInst((len) => Math.max(3, Math.round(len * 0.7))),
    hold: triInst((len) => len - 1),
    ring: triInst((len) => len),
    // the game's songs (live only)
    air: pulseInst({ duty: [1, 2], env: [8, 10, 11, 10, 9], sus: 9, fall: 12, floor: 6, vib: [12, 11, 6] }), // sky lead: a soft attack, then vibrato
    arp: pulseInst({ duty: [1], env: [6, 5, 4, 3], sus: 3 }), // sky arpeggios, under the lead
    fade: pulseInst({ duty: [2], env: Array.from({ length: 54 }, (_, k) => Math.max(1, Math.round(12 * Math.pow(0.955, k)))), sus: 0, vib: [12, 12, 6], gate: (len) => len }),
    fadeSoft: pulseInst({ duty: [1], env: Array.from({ length: 54 }, (_, k) => Math.max(1, Math.round(8 * Math.pow(0.96, k)))), sus: 0, gate: (len) => len }),
    hit: pulseInst({ duty: [2], env: [14, 13, 11, 9, 7, 5, 4, 3, 2], sus: 0 }), // the hurry stabs
    alarm: pulseInst({ duty: [2, 2, 1], env: [14, 13, 12], sus: 11, fall: 5, floor: 3, vib: [0, 22, 4], gate: (len) => len }),
    alarm2: pulseInst({ duty: [1], env: [10, 9, 9], sus: 8, fall: 6, floor: 2, gate: (len) => len }),
  };
  // Noise drums: [period index, volume, short mode] per frame. DMC drums: a sample at a rate.
  const NDRUM = {
    h: [[1, 6], [1, 3], [1, 1]],
    o: [[1, 7], [1, 6], [1, 5], [1, 4], [1, 3], [1, 2], [1, 2], [1, 1]],
    c: [[4, 6, 1], [4, 2, 1]],
    x: Array.from({ length: 30 }, (_, k) => [3, Math.max(1, Math.round(11 - k / 3))]),
    s: [[6, 12], [7, 10], [7, 8], [8, 6], [8, 4], [9, 3], [9, 2], [10, 1]], // a noise snare (the boss's backbeat: its DMC is all kick)
  };
  const DDRUM = {
    K: { dmc: 'kick', rate: 15 },
    S: { dmc: 'snare', rate: 15 },
    L: { dmc: 'kick', rate: 13 }, // the kick slowed down: a deep boom
    D: { dmc: 'timpD', rate: 15 }, // D3
    A: { dmc: 'timpD', rate: 14 }, // A2, the fifth below
    C: { dmc: 'timpC', rate: 15 }, // C3
    G: { dmc: 'timpC', rate: 14 }, // G2
  };

  // ---------------------------------------------------------------- the notation
  // One string per channel, one token per event, lengths in rows (16ths): `F#5:3` a note, `r:2` a rest,
  // `-:2` ties onto the note before, `@lead` picks the instrument, `T+12` transposes, `[ ... ]4` repeats,
  // `|` marks where the song loops back to. Noise tokens are NDRUM keys, DMC tokens DDRUM keys.
  function tokens(str) {
    let s = str;
    const re = /\[([^[\]]*)\](\d+)/;
    while (re.test(s)) s = s.replace(re, (_, body, n) => Array(Number(n)).fill(body).join(' '));
    return s.trim().split(/\s+/).filter(Boolean);
  }
  function channel(str, kind, name) {
    let inst = kind === 't' ? INST.bass : INST.lead;
    let tr = 0;
    let row = 0;
    let loop = null;
    const notes = [];
    for (const tok of tokens(str)) {
      if (tok === '|') {
        loop = row;
        continue;
      }
      if (tok[0] === '@') {
        inst = INST[tok.slice(1)];
        if (!inst) throw new Error(`music.js: ${name}: no instrument ${tok}`);
        continue;
      }
      if (/^T[+-]?\d+$/.test(tok)) {
        tr = Number(tok.slice(1));
        continue;
      }
      const [a, b] = tok.split(':');
      const n = b ? Number(b) : 1;
      if (!(n > 0)) throw new Error(`music.js: ${name}: bad length in ${tok}`);
      if (a === 'r') {
        row += n;
        continue;
      }
      if (a === '-') {
        const last = notes[notes.length - 1];
        if (!last || last.r1 !== row) throw new Error(`music.js: ${name}: tie with no note before it`);
        last.r1 += n;
        row += n;
        continue;
      }
      let ins = inst;
      let m = 0;
      if (kind === 'n') ins = NDRUM[a] && { rows: NDRUM[a] };
      else if (kind === 'd') ins = DDRUM[a];
      else m = midi(a) + tr;
      if (!ins) throw new Error(`music.js: ${name}: unknown token ${tok}`);
      notes.push({ r0: row, r1: row + n, m, inst: ins });
      row += n;
    }
    return { notes, rows: row, loop };
  }
  const CHANS = ['p1', 'p2', 't', 'n', 'd'];
  function compile(id, def) {
    const out = { id, speed: def.speed, ch: {} };
    let rows = null;
    let loop;
    for (const ch of CHANS) {
      if (def[ch] == null) continue;
      const c = channel(def[ch], ch === 'p1' || ch === 'p2' ? 'p' : ch, `${id}.${ch}`);
      if (rows === null) {
        rows = c.rows;
        loop = c.loop;
      } else if (c.rows !== rows || c.loop !== loop) {
        throw new Error(`music.js: ${id}.${ch} is ${c.rows} rows looping at ${c.loop}; the song is ${rows} rows looping at ${loop}`);
      }
      out.ch[ch] = c.notes.map((nt) => ({ f0: nt.r0 * def.speed, f1: nt.r1 * def.speed, m: nt.m, inst: nt.inst }));
    }
    for (const ch of CHANS) out.ch[ch] = out.ch[ch] || [];
    out.rows = rows;
    out.sections = {};
    for (const k of Object.keys(def.sections || {})) out.sections[k] = def.sections[k] * def.speed;
    out.L = rows * def.speed;
    out.LF = def.loop === false ? null : (loop || 0) * def.speed;
    return out;
  }
  // The song's voice on each channel at song frame sf: a pulse { v, d, t }, a triangle { t }, a noise
  // { v, i, m }, a DMC trigger { dmc, rate }, or null; `trig` on a note's first frame.
  function voiceAt(song, ch, sf) {
    if (sf >= song.L) {
      if (song.LF == null) return null;
      sf = song.LF + ((sf - song.LF) % (song.L - song.LF));
    }
    const list = song.ch[ch];
    let lo = 0;
    let hi = list.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].f0 <= sf) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (at < 0) return null;
    const nt = list[at];
    if (sf >= nt.f1) return null;
    const k = sf - nt.f0;
    if (ch === 'd') return k === 0 ? nt.inst : null;
    let st;
    if (ch === 'n') {
      const r = nt.inst.rows[k];
      st = r ? { v: r[1], i: r[0], m: r[2] || 0 } : null;
    } else st = nt.inst.frame(k, nt.f1 - nt.f0, nt.m);
    if (st && k === 0) st.trig = true;
    return st;
  }


  // ---------------------------------------------------------------- effect helpers (for the film's sfx)
  const SIL = () => ({ v: 0, d: 2 });
  const gap = (n) => Array.from({ length: Math.max(0, n) }, SIL);
  const cat = (...a) => [].concat(...a);
  const lerp = (a, b, f) => a + (b - a) * f;
  // A pulse tone: hz for n frames. o.d duty, o.v [from, to] volume, o.bend pitch ratio per frame,
  // o.vib [depth ratio, period frames], o.wob alternating +/- ratio each frame, o.trig false to glide on.
  function pt(hz, n, o) {
    const out = [];
    let f = hz;
    const v = o.v || [12, 12];
    for (let k = 0; k < n; k++) {
      let ff = f;
      if (o.vib) ff *= 1 + o.vib[0] * Math.sin((TAU * k) / o.vib[1]);
      if (o.wob) ff *= k & 1 ? 1 - o.wob : 1 + o.wob;
      out.push({ v: Math.round(lerp(v[0], v[1], n > 1 ? k / (n - 1) : 0)), d: o.d == null ? 2 : o.d, t: ptimer(ff), trig: k === 0 && o.trig !== false });
      f *= o.bend || 1;
    }
    return out;
  }
  // A tone driven by the hardware sweep unit: the timer is written once, then the sweep shifts it by
  // t >> s every half frame, up in period (falling pitch) or, with neg, down (rising pitch). o.hold:
  // frames at the first volume before the fade.
  function psw(hz, n, o) {
    const out = [];
    const v = o.v || [12, 12];
    const sw = { p: o.p || 0, n: !!o.neg, s: o.s };
    const hold = o.hold || 0; // frames at full volume before the fade
    for (let k = 0; k < n; k++) {
      const u = k < hold ? 0 : n - 1 > hold ? (k - hold) / (n - 1 - hold) : 1;
      const st = { v: Math.round(lerp(v[0], v[1], u)), d: o.d == null ? 2 : o.d, sw };
      if (k === 0) Object.assign(st, { t: ptimer(hz), trig: true });
      out.push(st);
    }
    return out;
  }
  // Two notes alternating every frame: the driver's arpeggio trick for a shimmering interval.
  function trill(a, b, n, o) {
    const out = [];
    const v = o.v || [12, 0];
    for (let k = 0; k < n; k++) out.push({ v: Math.round(lerp(v[0], v[1], k / Math.max(1, n - 1))), d: o.d == null ? 1 : o.d, t: ptimer(mhz(k & 1 ? b : a)), trig: k === 0 });
    return out;
  }
  const nz = (rows) => rows.map((r, k) => ({ i: r[0], v: Math.max(0, Math.min(15, Math.round(r[1]))), m: r[2] || 0, trig: k === 0 }));
  // A triangle knock: a pitch falling by `ratio` each frame.
  function tthud(hz, n, ratio) {
    const out = [];
    for (let k = 0; k < n; k++) out.push({ t: ttimer(hz * Math.pow(ratio, k)), trig: k === 0 });
    return out;
  }

  // ---------------------------------------------------------------- the registry (filled by src/music.js)
  const SONGS = {};
  const SFX = {};
  let defined = false;
  const cache = {};
  function define(o) {
    const d = o || {};
    for (const id of Object.keys(d.songs || {})) SONGS[id] = compile(id, d.songs[id]);
    for (const k of Object.keys(d.sfx || {})) {
      const make = d.sfx[k];
      if (typeof make !== 'function') throw new Error(`chip.js: sfx.${k} must be a function (ev, K) => ({ pri, p1?, p2?, t?, n? })`);
      SFX[k] = (ev) => make(ev, FILM.chip);
    }
    defined = true;
    for (const k of Object.keys(cache)) delete cache[k];
  }
  FILM.chip = { define, defined: () => defined, compile, midi, mhz, ptimer, ttimer, pt, psw, trill, nz, tthud, gap, cat, SIL, lerp, INST, NDRUM, DDRUM, FPS };
  // ---------------------------------------------------------------- the driver
  // One call per 60 Hz frame: frame(f, events) -> that frame's APU register writes, flat [addr, value, ...].
  function makeDriver(mute) {
    const mu = mute || {};
    let song = null;
    let sf = 0;
    let paused = false; // the game's pause (S3): the song holds sf and is silent; effects play on
    let started = false;
    const fx = { p1: null, p2: null, t: null, n: null };
    const wasFx = { p1: false, p2: false, t: false, n: false };
    const hiShadow = [-1, -1];
    const swOn = [false, false];
    let triOn = false;
    let triHi = -1;
    function pulse(w, c, st) {
      const b = 0x4000 + 4 * c;
      if (!st || !(st.v > 0)) {
        w.push(b, 0x30); // constant volume 0, length halted
        if (swOn[c] && !(st && st.sw)) {
          w.push(b + 1, 0x08);
          swOn[c] = false;
        }
        return;
      }
      w.push(b, (st.d << 6) | 0x30 | st.v);
      if (st.sw) {
        if (st.trig) {
          w.push(b + 1, 0x80 | (st.sw.p << 4) | (st.sw.n ? 8 : 0) | st.sw.s);
          swOn[c] = true;
        }
      } else if (swOn[c]) {
        w.push(b + 1, 0x08); // sweep off, negate on: low notes are never muted by the sweep unit
        swOn[c] = false;
      }
      if (st.t !== undefined) {
        const hi = st.t >> 8;
        w.push(b + 2, st.t & 0xff);
        if (st.trig || hi !== hiShadow[c]) {
          w.push(b + 3, 0xf8 | hi); // restarts the phase: only on a new note or a new high byte
          hiShadow[c] = hi;
        }
      } else if (st.trig) hiShadow[c] = -1;
    }
    function tri(w, st) {
      if (!st) {
        if (triOn) w.push(0x4008, 0x80); // reload 0: the linear counter stops the triangle next quarter frame
        triOn = false;
        return;
      }
      if (!triOn) w.push(0x4008, 0xff);
      const hi = st.t >> 8;
      w.push(0x400a, st.t & 0xff);
      if (st.trig || hi !== triHi || !triOn) {
        w.push(0x400b, 0xf8 | hi);
        triHi = hi;
      }
      triOn = true;
    }
    function noise(w, st) {
      if (!st || !(st.v > 0)) {
        w.push(0x400c, 0x30);
        return;
      }
      w.push(0x400c, 0x30 | st.v, 0x400e, (st.m ? 0x80 : 0) | st.i);
      if (st.trig) w.push(0x400f, 0xf8);
    }
    function frame(f, evs) {
      const w = [];
      if (!started) {
        w.push(0x4015, 0x0f, 0x4001, 0x08, 0x4005, 0x08, 0x4000, 0x30, 0x4004, 0x30, 0x4008, 0x80, 0x400c, 0x30, 0x4010, 0x0f);
        started = true;
      }
      let dmcStop = false;
      let fresh = false;
      let resume = false;
      for (const ev of evs) {
        if (ev.type === 'song') {
          if (mu.music) continue;
          song = SONGS[ev.id] || null;
          // a section starts the song at that row (overworld: 'intro', 'A' the hook, 'B'); unknown: the top
          sf = song && ev.section && song.sections[ev.section] != null ? song.sections[ev.section] : 0;
          dmcStop = true;
          fresh = true;
          paused = false; // a song event always clears the pause
          resume = false;
          continue;
        }
        // The game's pause (live only): the song holds its frame and its voices go silent (the DMC
        // stops at once); effects keep running, so the pause jingle and the menu ticks sound. Unpause
        // brings every voice back on the same song frame with a fresh trigger: the same bar, in time.
        if (ev.type === 'pause' && !paused) {
          paused = true;
          resume = false;
          dmcStop = true;
        } else if (ev.type === 'unpause' && paused) {
          paused = false;
          resume = true;
        }
        if (mu.sfx) continue;
        const make = SFX[ev.type];
        if (!make) continue;
        const prog = make(ev);
        for (const ch of ['p1', 'p2', 't', 'n']) {
          if (!prog[ch] || !prog[ch].length) continue;
          // a higher priority holds the channel; so does an equal one that started on this same frame
          // (a jump and a kick together: the jump keeps pulse 2, the kick sounds on its other channels)
          const cur = fx[ch];
          if (cur && (cur.pri > prog.pri || (cur.pri === prog.pri && cur.f === f))) continue;
          fx[ch] = { prog: prog[ch], k: 0, pri: prog.pri, f };
        }
      }
      for (const ch of ['p1', 'p2', 't', 'n']) {
        const a = fx[ch];
        let st;
        if (a) {
          st = a.prog[a.k];
          a.k++;
          if (a.k >= a.prog.length) fx[ch] = null;
        } else {
          st = song && !paused ? voiceAt(song, ch, sf) : null;
          // the song's voice comes back in time, with a fresh trigger so its registers are all rewritten;
          // a song started at a section may begin inside a note, which is triggered the same way, and so
          // does every voice on the frame the pause ends
          if ((wasFx[ch] || fresh || resume) && st) st = Object.assign({}, st, { trig: true });
        }
        wasFx[ch] = !!a;
        if (ch === 'p1') pulse(w, 0, st);
        else if (ch === 'p2') pulse(w, 1, st);
        else if (ch === 't') tri(w, st);
        else noise(w, st);
      }
      // a song change stops the DMC and puts its DAC back at the rest level, so a drum cut mid-sample
      // never leaves the channel's DC (and the triangle and noise volumes it sets) off for the next song
      if (dmcStop) w.push(0x4015, 0x0f, 0x4011, DMC_LEVEL0);
      const dv = song && !paused ? voiceAt(song, 'd', sf) : null;
      if (dv) {
        const smp = DMC[dv.dmc];
        w.push(0x4010, dv.rate, 0x4012, smp.a, 0x4013, smp.l, 0x4015, 0x0f, 0x4015, 0x1f);
      }
      if (song && !paused) sf++;
      return w;
    }
    // tools: where the song is (tools/audio/game-audio.cjs proves the pause holds it)
    const state = () => ({ song: song ? song.id : null, sf, paused });
    return { frame, state };
  }

  // ---------------------------------------------------------------- rendering
  const NONE = [];
  // A game's sim events when a game is loaded (FILM.game.events()), else the film's cues: a `song` cue
  // switches the song at its section, any other kind fires sfx[kind]; t seconds -> frame round(t * 60).
  function gameEvents() {
    const g = FILM.game;
    if (g && typeof g.events === 'function') return g.events() || NONE;
    const cues = (FILM.TIMELINE && FILM.TIMELINE.cues) || NONE;
    return cues.map((c) => Object.assign({}, c, { f: Math.round((Number(c.t) || 0) * FPS), type: c.kind }));
  }
  function filmFrames() {
    const d = (FILM.TIMELINE && FILM.TIMELINE.duration) || FILM.DURATION || 0;
    return Math.round(d * FPS);
  }
  // The whole soundtrack as one mono buffer from global time 0.
  //   o.events   the event list (default FILM.game.events()); tools pass the mock here, the film never does
  //   o.samples  length (default the film's duration)
  //   o.foley    false to leave out the TV (FILM.foley)
  //   o.mute     { music: true } or { sfx: true }: drop song or effect events (tools)
  //   o.log      true: attach out.log = [[frame, [addr, value, ...]], ...], every register write
  function synth(sr, opts) {
    if (!defined) throw new Error('retro film has no score: src/music.js must call FILM.chip.define');
    const o = opts || {};
    const events = o.events || gameEvents();
    const byF = new Map();
    for (const e of events) {
      const f = Math.max(0, Math.round(Number(e.f) || 0));
      if (!byF.has(f)) byF.set(f, []);
      byF.get(f).push(e);
    }
    const driver = makeDriver(o.mute);
    const log = o.log ? [] : null;
    const eng = makeEngine(sr, (f) => {
      const w = driver.frame(f, byF.get(f) || NONE);
      if (log && w.length) log.push([f, w]);
      return w;
    });
    const n = o.samples != null ? o.samples : Math.round((filmFrames() / FPS) * sr);
    const out = new Float32Array(n);
    for (let j = 0; j < n; j++) out[j] = eng.out(j) * GAIN;
    if (o.foley !== false && FILM.foley && typeof FILM.foley.apply === 'function') FILM.foley.apply(out, sr);
    if (log) out.log = log;
    return out;
  }

  FILM.audio = {
    render(ctx, opts) {
      const o = opts || {};
      const start = Math.max(0, Number(o.start) || 0);
      const dest = o.dest || ctx.destination;
      const base = ctx.currentTime;
      const sr = ctx.sampleRate;
      // o.events: tools only (a mock list while the game is built); the film always hears its game
      const data = o.events ? synth(sr, { events: o.events }) : cache[sr] || (cache[sr] = synth(sr));
      if (start >= data.length / sr) return;
      const buf = ctx.createBuffer(2, data.length, sr);
      buf.getChannelData(0).set(data);
      buf.getChannelData(1).set(data);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(dest);
      // A live context keeps running while the chip is emulated: start late by that much, on time.
      const late = Math.max(0, ctx.currentTime - base);
      src.start(base + late, start + late);
    },
    // The playable mode: the same driver and chip, generated as it plays. Feed it what the game engine's
    // step() returns each frame; they sound on the next driver frame.
    live(actx, opts) {
      const o = opts || {};
      const queue = [];
      const driver = makeDriver();
      const eng = makeEngine(actx.sampleRate, (f) => driver.frame(f, queue.splice(0, queue.length)));
      let vol = o.volume == null ? 1 : Number(o.volume);
      let j = 0;
      const node = actx.createScriptProcessor(o.bufferSize || 1024, 1, 1);
      node.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < out.length; i++) out[i] = eng.out(j++) * GAIN * vol;
      };
      node.connect(o.dest || actx.destination);
      if (o.song) queue.push({ type: 'song', id: o.song });
      return {
        node,
        song(id) {
          queue.push({ type: 'song', id });
        },
        event(ev) {
          if (ev) queue.push(ev);
        },
        events(list) {
          for (const ev of list || NONE) queue.push(ev);
        },
        get frame() {
          return eng.frame();
        },
        get volume() {
          return vol;
        },
        set volume(v) {
          vol = Number(v);
        },
        stop() {
          node.onaudioprocess = null;
          node.disconnect();
        },
      };
    },
    synth,
    // tools: an effect's program for an event, { pri, frames per channel }
    effect: (ev) => {
      const make = SFX[ev.type];
      if (!make) return null;
      const pr = make(ev);
      const out = { pri: pr.pri };
      for (const ch of ['p1', 'p2', 't', 'n']) if (pr[ch]) out[ch] = pr[ch].length;
      return out;
    },
    // tools: a bare driver, frame(f, events) -> register writes, state() -> { song, sf, paused }
    driver: (mute) => makeDriver(mute),
    get songs() {
      return Object.keys(SONGS);
    },
    get sfx() {
      return Object.keys(SFX);
    },
    info: () => ({
      gain: GAIN,
      dmcRomBytes: DMC.romBytes,
      dmc: Object.fromEntries(['kick', 'snare', 'timpD', 'timpC'].map((k) => [k, DMC[k].bytes])),
      songs: Object.fromEntries(Object.keys(SONGS).map((k) => [k, { speed: SONGS[k].speed, rows: SONGS[k].rows, frames: SONGS[k].L, loopFrame: SONGS[k].LF, sections: Object.assign({}, SONGS[k].sections) }])),
    }),
  };
})();
