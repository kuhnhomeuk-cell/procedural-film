/*
 * crt.js : the TV. Owner: crt. Presents the console's 320x180 native frame buffer on a simulated
 * 1980s consumer CRT at any output size (1920x1080, 3840x2160 with render --scale 2, or the
 * player's own device size). See docs/display.md for the whole design and the numbers.
 *
 *   FILM.crt.present(srcCanvas, outCtx, f)  fill outCtx.canvas with the TV image at global frame f
 *                      (f may also be { frame, T, overlays })
 *   FILM.crt.buttonsAt null (default: no input display) or f => button mask at frame f (null = no pad
 *                      that frame); a game overlay sets it
 *   FILM.TIMELINE.retro.crt  { caption: string|'' (lines split on \n), powerOn: [f0,f1]|null,
 *                      powerOff: [f0,f1]|null }: the film's power windows and closing caption
 *   FILM.crt.mode      'crt' (default) | 'clean' (whole-pixel nearest-neighbour, FILM.presentNearest)
 *   FILM.crt.backend   'webgl2' | 'webgl' | 'cpu' | 'nearest' (null until the first present)
 *   FILM.crt.force     set before the first present to test a fallback: 'webgl' | 'cpu' | 'nearest'
 *   FILM.crt.power(f)  the pure power state at global frame f (what the TV is doing)
 *   FILM.crt.marks()   the power sequence's key frames (click, line, open, lock, squeeze, dot ...),
 *                      for the TV foley to land on
 *   FILM.crt.params    tunables (see DEFAULTS); change them before a render, never per frame
 *   FILM.crt.camera(f) the pure camera at global frame f: { t, zoom, cx, cy } (t 1 = the tube fills the
 *                      frame, 0 = the wide shot of the set in its dark room)
 *   FILM.crt.overlays  { input: true, caption: true }: the baked proof layers, drawn crisp after the TV:
 *                      the controller input display (FILM.crt.buttonsAt(f)) where it returns a mask, and the
 *                      closing caption on the dark glass after the power-off
 *   FILM.crt.inputWindows() / captionWindow()  the frames those layers show
 *   FILM.crt.settledFrame()  a frame with the TV on and the tube filling the frame (live play presents
 *                      with it, and { overlays: false }: the input display shows the film's tape)
 *   present(..., { frame, overlays: false })  one present without the proof layers
 *   FILM.crt.recover   false (default: the film's behaviour, a lost GL context falls back to 'cpu' for
 *                      the session). The game page sets true: a lost context presents clean
 *                      (FILM.presentNearest) while FILM.crt.lost is true, and webglcontextrestored
 *                      rebuilds GL through crt.reset(), so the CRT comes back
 *   FILM.crt.glContext()  the live GL context or null (tools lose and restore it through WEBGL_lose_context)
 *
 * The pipeline (webgl2, and the same shaders under webgl):
 *   1 index    every native pixel is an NES colour; it is mapped back to its palette index $00-$3F
 *   2 decode   the NES PPU composite signal of each index (12-phase square-wave chroma, the per-level
 *              voltages, 8 samples a pixel, the 4-sample phase shift each scanline) decoded by a TV:
 *              a luma low-pass with a sharpness peak and I/Q demodulation through a chroma low-pass.
 *              The whole linear chain is folded into a lookup table per (index, phase, offset), so the
 *              shader sums nine neighbouring pixels. Flat areas decode to exactly the lib.NES colour;
 *              edges get the real signal's colour bleed and cross-colour fringes. The frame phase is
 *              fixed (no 60 Hz dot crawl to turn to mush under video compression).
 *   3 glow     a linear-light downsample blurred twice (glow, ~1.3 native px, and halo, ~10 px)
 *   4 tube     a camera: the power-on starts on the whole set (a procedural 1980s TV: woodgrain cabinet,
 *              moulded bezel, knobs, a pilot light, on a sideboard in a dark room lit only by the screen,
 *              whose light follows the picture's average colour) and pushes in until the tube fills the
 *              frame; the power-off pulls back out so the dot dies in the set. Then, on the tube,
 *              one native row = one scanline: a gaussian beam per colour channel whose width grows
 *              with brightness (box-filtered analytically, so it anti-aliases at any output size), a
 *              gentle aperture grille, halation, barrel curvature with rounded dark corners, vignette,
 *              the glass (a faint room reflection and the lit black level), and the power sequences:
 *              snow, vertical roll, degauss wobble, the line opening and the collapse to a dot.
 * The GL result is drawn into outCtx with drawImage in the same call, so every tool keeps reading
 * FILM.ctx. Deterministic: a pure function of (source pixels, frame); noise is hashed from the frame.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const FILM = (root.FILM = root.FILM || {});
  const crt = (FILM.crt = FILM.crt || {});

  const SW = 320; // native width (FILM.NATIVE_W)
  const SH = 180; // native height (FILM.NATIVE_H): one row = one scanline
  const DEC_PER_PX = 4; // decoded samples kept per native pixel (every second composite sample)
  const DW = SW * DEC_PER_PX;
  const NB = 4; // neighbour pixels each side summed by the decoder (covers kernels up to 33 samples)
  const LUT_W = (2 * NB + 1) * DEC_PER_PX;
  const LUT_H = 64 * 3;

  const DEFAULTS = {
    gammaIn: 2.4, // the tube's gamma
    gammaOut: 2.2, // the viewer's display
    sigmaMin: 0.15, // beam sigma of a dark line, in scanline pitches (thin line, deep gap)
    sigmaMax: 0.4, // beam sigma of a full-brightness line (fills the gap: bright rows bloom)
    maskK: 0.2, // aperture grille strength (0 none, 1 pure stripes)
    maskW: 0, // grille stripe width in output px; 0 = auto, one stripe per 1080 lines of output
    brightness: 1.06,
    glow: 0.07, // share of the picture replaced by its 1.3 px glow (softens, fills gaps)
    halo: 0.045, // wide halation added on top
    curv: [0.028, 0.042], // barrel curvature (x bends with y^2, y with x^2)
    fit: [1.014, 1.022], // >1 shrinks the picture inside the glass (a thin dark border, nothing cropped)
    vignette: 0.2,
    refl: 1, // glass reflection strength
    conv: 0.18, // red/blue misconvergence at the screen edges, native px
    sharp: 0.3, // TV sharpness control: luma peaking
    lumaSigma: 2.3, // the band-limited (clean) share of luma: gaussian sigma in composite samples (8 = 1 px)
    chroma: 36, // chroma low-pass length in composite samples (12 = one subcarrier cycle)
    artifacts: 0.35, // composite artifact strength: 1 = the raw NES signal (edge zipper, cross-colour), 0 = bleed only
    phase: 0, // frame phase of the composite signal (0, 4 or 8); fixed, so artifacts do not crawl
    wide: [0.44, 0.4, 0.3], // the wide shot of the set: zoom, centre x, centre y (units: half the tube's height)
    room: 1.8, // exposure of the room lit by the screen
  };
  crt.params = Object.assign({}, DEFAULTS, crt.params || {});
  crt.DEFAULTS = Object.freeze(Object.assign({}, DEFAULTS));
  if (crt.mode !== 'clean') crt.mode = 'crt';
  crt.overlays = Object.assign({ input: true, caption: true }, crt.overlays || {});
  // the closing caption, on the dark glass after the power-off: true of this film, and short
  // the closing caption comes from FILM.TIMELINE.retro.crt.caption, read at present time
  crt.buttonsAt = typeof crt.buttonsAt === 'function' ? crt.buttonsAt : null;
  crt.backend = null;
  crt.renderer = null; // the rasteriser behind the backend (e.g. SwiftShader in the tool browser)
  crt.force = crt.force || null;
  crt.recover = crt.recover === true; // the game page turns context-loss recovery on (src/shell.js)
  crt.lost = false; // recover only: the GL context is lost and the TV presents clean until it is restored

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a, b, x) => {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------------------------------------------------------------------------
  // Power: a pure function of the global frame
  // ---------------------------------------------------------------------------
  // Key frames at 60 fps for a 150-frame power-on and a 120-frame power-off; other window
  // lengths stretch them. Everything the tube does between them is eased from these.
  const ON = { push: 26, click: 20, line: 22, lineFull: 26, open: 27, opened: 40, snowHold: 34, snowThin: 62, snowEnd: 112, sig0: 32, sig1: 66, sat0: 50, sat1: 86, lock: 100, deg: 44, bright0: 40, bright1: 140, black0: 22, black1: 70 };
  const ON_LEN = 150;
  const OFF = { squeeze: 7, line: 15, dot: 19, fade: 84, black: 22, pull: 66, caption: 90 };
  const OFF_LEN = 120;

  function retroCrt() {
    const r = FILM.TIMELINE && FILM.TIMELINE.retro;
    return (r && r.crt) || null;
  }
  function captionLines() {
    const c = retroCrt();
    const t = c && typeof c.caption === 'string' ? c.caption : '';
    return t ? t.split('\n').slice(0, 3) : [];
  }
  function windows() {
    const c = retroCrt();
    const on = c && Array.isArray(c.powerOn) ? c.powerOn : null;
    const off = c && Array.isArray(c.powerOff) ? c.powerOff : null;
    return { on, off };
  }

  crt.marks = function marks() {
    const { on, off } = windows();
    const out = {};
    if (on) {
      const s = (on[1] - on[0]) / ON_LEN;
      const at = (k) => on[0] + Math.round(k * s);
      out.powerOn = { start: on[0], click: at(ON.click), line: at(ON.line), open: at(ON.open), opened: at(ON.opened), locked: at(ON.lock), settled: on[1] };
    }
    if (off) {
      const s = (off[1] - off[0]) / OFF_LEN;
      const at = (k) => off[0] + Math.round(k * s);
      out.powerOff = { start: off[0], line: at(OFF.squeeze), dot: at(OFF.line), afterglow: at(OFF.dot), dark: at(OFF.fade), end: off[1] };
    }
    return out;
  };

  const ROLL_VB = 22; // vertical blanking lines: the black bar that rolls through an unlocked picture
  const WHITE_LINE = [0.9, 0.95, 1.0];

  /** The TV's state at global frame f. */
  crt.power = function power(f) {
    const st = {
      stage: 'on', lit: true, scaleX: 1, scaleY: 1, gain: 1, lift: 0, snow: 0, sat: 1, sig: 1,
      roll: 0, jit: 0, deg: 0, degPhase: 0, wobble: 0,
      line: 0, lineSig: 0.004, lineHalf: 1, lineSigX: 0.004, lineCol: WHITE_LINE, black: 1, led: 1,
    };
    const { on, off } = windows();
    const offState = () => Object.assign(st, { stage: 'off', lit: false, black: 0, gain: 0, sig: 0, led: 0 });
    if (on && f < on[0]) return offState();
    if (off && f >= off[1]) return offState();
    if (on && f < on[1]) {
      const s = (on[1] - on[0]) / ON_LEN;
      const u = (f - on[0]) / s; // frames into the power-on at the 150-frame pace
      st.stage = 'powerOn';
      if (u < ON.line) {
        offState();
        st.stage = 'powerOn';
        st.led = u >= ON.click ? 1 : 0; // the pilot light comes on with the click
        return st;
      }
      st.black = smooth(ON.black0, ON.black1, u);
      // the beam: a line across the glass, then the raster opens vertically (ease-out, slight overshoot)
      const lineIn = smooth(ON.line, ON.lineFull, u);
      const op = clamp01((u - ON.open) / (ON.opened - ON.open));
      const back = 1 + 2.2 * Math.pow(op - 1, 3) + 1.2 * Math.pow(op - 1, 2); // easeOutBack
      st.scaleY = u < ON.open ? 0.004 : Math.max(0.004, back);
      st.scaleX = 1 + 0.035 * (1 - smooth(ON.opened, ON.bright1, u)); // the raster breathes large while the HV settles
      st.line = lineIn * 2.4 * (1 - smooth(ON.open, ON.open + 7, u));
      st.lineSig = 0.0035;
      st.lineHalf = lerp(0.55, 1.0, lineIn) * (16 / 9);
      st.lineSigX = 0.05;
      st.lit = u >= ON.open;
      // snow, then the signal locks in under it; the colour killer lets go last
      st.snow = (1 - 0.65 * smooth(ON.snowHold, ON.snowThin, u)) * (1 - smooth(ON.snowThin - 2, ON.snowEnd, u));
      st.sig = smooth(ON.sig0, ON.sig1, u);
      st.sat = smooth(ON.sat0, ON.sat1, u);
      // vertical hold: rolls fast, decelerates and locks (a pure function of u)
      const rv = clamp01((u - ON.open) / (ON.lock - ON.open));
      st.roll = (SH + ROLL_VB) * 1.35 * Math.pow(1 - rv, 3);
      if (u > ON.lock) st.roll += -3.2 * Math.exp(-(u - ON.lock) / 4) * Math.sin((u - ON.lock) * 0.9);
      st.jit = 1.6 * (1 - smooth(ON.sig0, ON.lock, u));
      // degauss: a damped colour wobble that swims across the glass
      if (u >= ON.deg) {
        const du = u - ON.deg;
        st.deg = 0.26 * smooth(0, 4, du) * Math.exp(-du / 17) * (0.6 + 0.4 * Math.cos(du * 0.55));
        st.degPhase = du * 0.19;
        st.wobble = 0.9 * smooth(0, 4, du) * Math.exp(-du / 12);
      }
      // brightness and contrast settle as the high voltage comes up
      const settle = smooth(ON.bright0, ON.bright1, u);
      const opening = u < ON.opened + 4 ? 1 + 1.6 * (1 - smooth(ON.open, ON.opened + 4, u)) : 1;
      st.gain = lerp(0.62, 1, settle) * opening;
      st.lift = 0.02 * (1 - settle);
      return st;
    }
    if (off && f >= off[0]) {
      const s = (off[1] - off[0]) / OFF_LEN;
      const u = (f - off[0]) / s;
      st.stage = 'powerOff';
      st.led = 0; // the switch is off: the pilot light goes out first
      st.black = 1 - smooth(0, OFF.black, u);
      if (u < OFF.squeeze) {
        // the raster collapses vertically and the energy piles into the shrinking band
        const p = u / OFF.squeeze;
        st.scaleY = Math.max(0.006, 1 - p * p * (1.35 - 0.35 * p));
        st.gain = 1 + 1.6 * p * p;
        st.lift = 0.05 * p;
        st.line = 2.6 * smooth(0.55, 1, p);
        st.lineSig = 0.004;
        st.lineHalf = 16 / 9;
        st.lineSigX = 0.02;
        return st;
      }
      st.lit = false;
      st.gain = 0;
      if (u < OFF.line) {
        // the line shrinks horizontally into the centre
        const p = (u - OFF.squeeze) / (OFF.line - OFF.squeeze);
        st.line = 2.6 + 0.9 * p;
        st.lineSig = lerp(0.004, 0.006, p);
        st.lineHalf = (16 / 9) * Math.pow(1 - p, 2.2);
        st.lineSigX = lerp(0.02, 0.006, p);
        return st;
      }
      // the dot, then its afterglow fading to the dark glass (phosphor persistence warms it)
      const du = u - OFF.line;
      const hold = u < OFF.dot ? 1 : 0.72 * Math.exp(-(u - OFF.dot) / 5) + 0.28 * Math.exp(-(u - OFF.dot) / 19);
      const tail = 1 - smooth(OFF.fade - 18, OFF.fade, u);
      st.line = 4.2 * hold * tail;
      st.lineSig = 0.0075 + 0.0035 * clamp01(du / 40);
      st.lineHalf = 0;
      st.lineSigX = st.lineSig;
      const warm = smooth(OFF.dot, OFF.dot + 30, u);
      st.lineCol = [lerp(0.9, 1.0, warm), lerp(0.95, 0.93, warm), lerp(1.0, 0.72, warm)];
      if (st.line <= 1e-4) return Object.assign(offState(), { stage: 'powerOff' });
      return st;
    }
    return st;
  };

  const ease5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  /** The camera at global frame f: t = 1 the tube fills the frame, t = 0 the wide shot of the set. */
  crt.camera = function camera(f) {
    const w = crt.params.wide || DEFAULTS.wide;
    const { on, off } = windows();
    let t = 1;
    if (on && f < on[0]) t = 0;
    else if (on && f < on[1]) {
      const u = (f - on[0]) / ((on[1] - on[0]) / ON_LEN);
      t = ease5(clamp01((u - ON.push) / (ON_LEN - ON.push)));
    }
    if (off && f >= off[0]) {
      const u = (f - off[0]) / ((off[1] - off[0]) / OFF_LEN);
      t = 1 - ease5(clamp01(u / OFF.pull));
    }
    return { t, zoom: Math.exp(Math.log(w[0]) * (1 - t)), cx: w[1] * (1 - t), cy: w[2] * (1 - t) };
  };

  /** A film frame where the TV is fully on and the tube fills the frame: live play presents with it. */
  crt.settledFrame = function settledFrame() {
    const { on } = windows();
    return on ? on[1] : 0;
  };

  /** The closing caption's frames: after the dot dies, to the film's end (null with no caption text). */
  crt.captionWindow = function captionWindow() {
    if (!captionLines().length) return null;
    const { off } = windows();
    if (!off) return null;
    const start = off[0] + Math.round(OFF.caption * ((off[1] - off[0]) / OFF_LEN));
    const end = Math.round((Number(FILM.TIMELINE && FILM.TIMELINE.duration) || 0) * 60);
    return end - start >= 30 ? [start, end] : null;
  };

  // The input display shows over every stretch where FILM.crt.buttonsAt(f) returns a mask (not null),
  // ending no later than 45 frames after the last pressed button and before the power-off.
  let winCache = null;
  crt.inputWindows = function inputWindows() {
    const fn = crt.buttonsAt;
    if (typeof fn !== 'function') return [];
    const n = Math.round((Number(FILM.TIMELINE && FILM.TIMELINE.duration) || 0) * 60);
    if (winCache && winCache.fn === fn && winCache.n === n) return winCache.w;
    const at = (f) => {
      try {
        const v = fn(f);
        return v == null ? null : v | 0;
      } catch (e) {
        return null;
      }
    };
    const { off } = windows();
    const out = [];
    for (let f = 0; f < n; ) {
      while (f < n && at(f) == null) f++;
      if (f >= n) break;
      const a = f;
      let lastBtn = -1;
      while (f < n) {
        const v = at(f);
        if (v == null) break;
        if (v) lastBtn = f;
        f++;
      }
      if (lastBtn < 0) continue;
      let b = Math.min(f, lastBtn + 45);
      if (off) b = Math.min(b, off[0] - 16); // faded out before the picture collapses
      if (b - a > 30) out.push([a, b]);
    }
    winCache = { fn, n, w: out };
    return out;
  };

  // ---------------------------------------------------------------------------
  // Palette index and the composite lookup table
  // ---------------------------------------------------------------------------
  // NES 2C02 composite levels (NESdev wiki "NTSC video"), relative to sync.
  const LV_LO = [0.35, 0.518, 0.962, 1.55];
  const LV_HI = [1.094, 1.506, 1.962, 1.962];
  const V_BLACK = 0.518;
  const V_WHITE = 1.962;
  function level(i, ph) {
    const c = i & 15;
    let l = (i >> 4) & 3;
    if (c > 13) l = 1;
    let lo = LV_LO[l];
    let hi = LV_HI[l];
    if (c === 0) lo = hi;
    if (c > 12) hi = lo;
    const s = (c + ph) % 12 < 6 ? hi : lo;
    return (s - V_BLACK) / (V_WHITE - V_BLACK);
  }
  const toYIQ = (r, g, b) => [0.299 * r + 0.587 * g + 0.114 * b, 0.595716 * r - 0.274453 * g - 0.321263 * b, 0.211456 * r - 0.522591 * g + 0.311135 * b];

  let pal = null; // { rgb: Int32Array(64), map: Map(rgb24 -> index), yiq: [[y,i,q]] }
  function palette() {
    const N = FILM.retro && FILM.retro.NES;
    if (pal && pal.src === N) return pal;
    const rgb = new Int32Array(64);
    const map = new Map();
    const yiq = [];
    for (let i = 0; i < 64; i++) {
      const v = N && typeof N[i] === 'string' ? parseInt(N[i].slice(1), 16) : 0;
      rgb[i] = v;
      yiq.push(toYIQ(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255));
    }
    // canonical index per colour: the lowest index, except black is $0F (not $0D, blacker than black)
    for (let i = 63; i >= 0; i--) map.set(rgb[i], i);
    map.set(0, 0x0f);
    pal = { src: N, rgb, map, yiq, near: new Map() };
    return pal;
  }
  function nearestIndex(P, v) {
    let j = P.near.get(v);
    if (j !== undefined) return j;
    let best = Infinity;
    j = 0x0f;
    const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    for (let i = 0; i < 64; i++) {
      if (i === 0x0d || ((i & 15) > 13)) continue;
      const w = P.rgb[i];
      const dr = ((w >> 16) & 255) - r, dg = ((w >> 8) & 255) - g, db = (w & 255) - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < best) {
        best = d;
        j = i;
      }
    }
    if (P.near.size > 4096) P.near.clear();
    P.near.set(v, j);
    return j;
  }

  let idxBuf = null;
  let srcScratch = null;
  /** Native pixels -> palette indices (Uint8Array, SW*SH, top row first). */
  function indices(src) {
    const P = palette();
    let g = null;
    const w = SW, h = SH;
    if (src && typeof src.getContext === 'function' && src.width === w && src.height === h) g = src.getContext('2d');
    if (!g) {
      if (!srcScratch) srcScratch = FILM.makeCanvas(w, h);
      g = srcScratch.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, w, h);
      g.drawImage(src, 0, 0, w, h);
    }
    const d = g.getImageData(0, 0, w, h).data;
    if (!idxBuf) idxBuf = new Uint8Array(w * h);
    let last = -1;
    let li = 0x0f;
    for (let p = 0, i = 0; p < idxBuf.length; p++, i += 4) {
      const v = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (v !== last) {
        last = v;
        const e = P.map.get(v);
        li = e !== undefined ? e : nearestIndex(P, v);
      }
      idxBuf[p] = li;
    }
    return idxBuf;
  }

  // Kernels on the composite sample grid; an offset x = s - t is always a half-integer.
  function lumaKernel(sharp) {
    // box of 12 samples (one subcarrier cycle: nulls the chroma and all its harmonics) with a TV
    // sharpness peak: (1+k) box - k (box * gaussian)
    const R = 33;
    const box = (x) => (Math.abs(x) < 6 ? 1 / 12 : 0);
    const g = [];
    let gs = 0;
    for (let n = -9; n <= 9; n++) {
      const w = Math.exp(-0.5 * (n / 3) * (n / 3));
      g.push(w);
      gs += w;
    }
    const out = new Map();
    let sum = 0;
    for (let x = -R + 0.5; x < R; x += 1) {
      let conv = 0;
      for (let n = -9; n <= 9; n++) conv += box(x - n) * (g[n + 9] / gs);
      const v = (1 + sharp) * box(x) - sharp * conv;
      out.set(x, v);
      sum += v;
    }
    for (const [k, v] of out) out.set(k, v / sum);
    return (x) => out.get(x) || 0;
  }
  // the band-limited share of luma (the part `artifacts` does not take from the raw signal): a narrow
  // gaussian with the same sharpness peak, so edges stay crisp at 1:1 without losing the scanlines
  function lumaCleanKernel(sigma, sharp) {
    const R = 33;
    const g = (x, sg) => Math.exp(-0.5 * (x / sg) * (x / sg));
    const out = new Map();
    let sum = 0;
    for (let x = -R + 0.5; x < R; x += 1) {
      const v = (1 + sharp) * g(x, sigma) - sharp * g(x, sigma * 2.2) / 2.2;
      out.set(x, v);
      sum += v;
    }
    for (const [k, v] of out) out.set(k, v / sum);
    return (x) => out.get(x) || 0;
  }
  function chromaKernel(len) {
    const half = len / 2;
    const out = new Map();
    let sum = 0;
    for (let x = -half + 0.5; x < half; x += 1) {
      const v = 0.5 * (1 + Math.cos((2 * Math.PI * x) / len));
      out.set(x, v);
      sum += v;
    }
    for (const [k, v] of out) out.set(k, v / sum);
    return (x) => out.get(x) || 0;
  }

  let lut = null; // { key, data: Float32Array(LUT_W * LUT_H * 4) }
  /**
   * LUT[index][alignment][offset] = the (Y, I, Q) one native pixel of that palette index contributes
   * to a decoded sample `offset` away, when its first composite sample sits at subcarrier phase
   * alignment*4. Built once: signal -> demodulate -> filters, then a least-squares hue/saturation fit
   * and a per-index DC correction so a flat field decodes to exactly the lib.NES colour.
   */
  function buildLut() {
    const p = crt.params;
    const key = [p.sharp, p.chroma, p.artifacts, p.lumaSigma, FILM.retro && FILM.retro.NES ? 1 : 0].join('|');
    if (lut && lut.key === key) return lut;
    const P = palette();
    const hY = lumaKernel(p.sharp);
    const hYc = lumaCleanKernel(p.lumaSigma || 2.3, p.sharp);
    const hC = chromaKernel(Math.max(12, Math.round(p.chroma / 12) * 12));
    const raw = new Float32Array(64 * 3 * LUT_W * 3); // [i][a][col] -> y i q
    const wYs = new Float32Array(LUT_W); // luma DC weight of a pixel at each col (partition of unity)
    const wCs = new Float32Array(LUT_W);
    const wYc = new Float32Array(LUT_W); // the clean luma's DC weight
    const at = (i, a, col) => ((i * 3 + a) * LUT_W + col) * 3;
    for (let col = 0; col < LUT_W; col++) {
      const o = Math.floor(col / DEC_PER_PX) - NB;
      const u = col % DEC_PER_PX;
      const d = 2 * u + 0.5 - 8 * o; // decoded sample position relative to the pixel's first sample
      let sy = 0, sc = 0, syc = 0;
      for (let j = 0; j < 8; j++) {
        sy += hY(d - j);
        sc += hC(d - j);
        syc += hYc(d - j);
      }
      wYs[col] = sy;
      wCs[col] = sc;
      wYc[col] = syc;
      for (let i = 0; i < 64; i++) {
        for (let a = 0; a < 3; a++) {
          let Y = 0, I = 0, Q = 0;
          for (let j = 0; j < 8; j++) {
            const ph = (a * 4 + j) % 12;
            const v = level(i, ph);
            const ang = (2 * Math.PI * ph) / 12;
            Y += hY(d - j) * v;
            I += hC(d - j) * v * 2 * Math.cos(ang);
            Q += hC(d - j) * v * 2 * Math.sin(ang);
          }
          const k = at(i, a, col);
          raw[k] = Y;
          raw[k + 1] = I;
          raw[k + 2] = Q;
        }
      }
    }
    // flat-field decode of every index: the mean over the three pixel alignments and four sub-positions
    const flat = [];
    for (let i = 0; i < 64; i++) {
      const acc = [0, 0, 0];
      for (let am = 0; am < 3; am++) {
        for (let u = 0; u < DEC_PER_PX; u++) {
          for (let o = -NB; o <= NB; o++) {
            const a = (((am * 4 + 8 * o) % 12) + 12) % 12 / 4;
            const k = at(i, a, (o + NB) * DEC_PER_PX + u);
            acc[0] += raw[k];
            acc[1] += raw[k + 1];
            acc[2] += raw[k + 2];
          }
        }
      }
      flat.push(acc.map((v) => v / (3 * DEC_PER_PX)));
    }
    // hue and saturation of the demodulator: one complex gain fitted to the chromatic entries
    let nr = 0, ni = 0, dd = 0;
    for (let i = 0; i < 64; i++) {
      const c = i & 15;
      if (c < 1 || c > 12) continue;
      const D = flat[i], T = P.yiq[i];
      nr += D[1] * T[1] + D[2] * T[2];
      ni += D[1] * T[2] - D[2] * T[1];
      dd += D[1] * D[1] + D[2] * D[2];
    }
    const zr = dd > 0 ? nr / dd : 1, zi = dd > 0 ? ni / dd : 0;
    const data = new Float32Array(LUT_W * LUT_H * 4);
    const art = clamp01(p.artifacts);
    for (let i = 0; i < 64; i++) {
      const D = flat[i], T = P.yiq[i];
      const cY = T[0] - D[0];
      const cI = T[1] - (zr * D[1] - zi * D[2]);
      const cQ = T[2] - (zi * D[1] + zr * D[2]);
      for (let a = 0; a < 3; a++) {
        for (let col = 0; col < LUT_W; col++) {
          const k = at(i, a, col);
          const o = ((i * 3 + a) * LUT_W + col) * 4;
          // luma too: at an edge the 12-sample average sees a cut-off square wave, so edge luma depends on
          // each line's phase (the NES zipper on vertical edges); art scales that against clean luma
          data[o] = art * (raw[k] + wYs[col] * cY) + (1 - art) * wYc[col] * T[0];
          // the signal's own chroma (cross-colour and all) blended with the palette's chroma through the
          // same low-pass: both decode a flat field to the lib.NES colour, only edges differ
          data[o + 1] = art * (zr * raw[k + 1] - zi * raw[k + 2] + wCs[col] * cI) + (1 - art) * wCs[col] * T[1];
          data[o + 2] = art * (zi * raw[k + 1] + zr * raw[k + 2] + wCs[col] * cQ) + (1 - art) * wCs[col] * T[2];
          data[o + 3] = 1;
        }
      }
    }
    lut = { key, data, hue: (Math.atan2(zi, zr) * 180) / Math.PI, sat: Math.hypot(zr, zi) };
    return lut;
  }
  crt.lutInfo = () => {
    const L = buildLut();
    return { hueDeg: L.hue, satGain: L.sat, width: LUT_W, height: LUT_H };
  };

  // ---------------------------------------------------------------------------
  // Shaders (written once in GLSL ES 3.00 style; a header maps them onto 1.00 for webgl)
  // ---------------------------------------------------------------------------
  const VS = `ATTR vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS_DECODE = `uniform sampler2D uIdx;
uniform sampler2D uLut;
uniform vec4 uDim; // native w, h, lut w, lut h
uniform float uPhase;
void main() {
  float X = floor(gl_FragCoord.x);
  float line = floor(gl_FragCoord.y);
  float m = floor(X * 0.25);
  float u = X - m * 4.0;
  float vy = (line + 0.5) / uDim.y;
  float P = mod(4.0 * line + uPhase, 12.0);
  vec3 yiq = vec3(0.0);
  for (int oi = 0; oi < ${2 * NB + 1}; oi++) {
    float k = m + float(oi) - ${NB}.0;
    float idx = 15.0;
    if (k >= 0.0 && k < uDim.x) idx = floor(TEX(uIdx, vec2((k + 0.5) / uDim.x, vy)).r * 255.0 + 0.5);
    float a = mod(8.0 * k + P, 12.0);
    float row = idx * 3.0 + floor(a * 0.25 + 0.5);
    float col = float(oi) * 4.0 + u;
    yiq += TEX(uLut, vec2((col + 0.5) / uDim.z, (row + 0.5) / uDim.w)).rgb;
  }
  vec3 rgb = vec3(yiq.x + 0.9563 * yiq.y + 0.6210 * yiq.z,
                  yiq.x - 0.2721 * yiq.y - 0.6474 * yiq.z,
                  yiq.x - 1.1070 * yiq.y + 1.7046 * yiq.z);
  FRAG = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

  // decoded (gamma) 1280x180 -> linear 320x180
  const FS_DOWN4 = `uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform float uGamma;
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float v = (p.y + 0.5) / uSrcSize.y;
  vec3 a = TEX(uSrc, vec2((4.0 * p.x + 1.0) / uSrcSize.x, v)).rgb;
  vec3 b = TEX(uSrc, vec2((4.0 * p.x + 3.0) / uSrcSize.x, v)).rgb;
  FRAG = vec4(pow(0.5 * (a + b), vec3(uGamma)), 1.0);
}`;

  // 4x4 box downsample (four bilinear taps)
  const FS_DOWNBOX = `uniform sampler2D uSrc;
uniform vec2 uSrcSize;
void main() {
  vec2 c = floor(gl_FragCoord.xy) * 4.0 + 2.0;
  vec3 s = TEX(uSrc, (c + vec2(-1.0, -1.0)) / uSrcSize).rgb + TEX(uSrc, (c + vec2(1.0, -1.0)) / uSrcSize).rgb
         + TEX(uSrc, (c + vec2(-1.0, 1.0)) / uSrcSize).rgb + TEX(uSrc, (c + vec2(1.0, 1.0)) / uSrcSize).rgb;
  FRAG = vec4(0.25 * s, 1.0);
}`;

  const FS_BLUR = `uniform sampler2D uSrc;
uniform vec2 uSize;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 acc = vec3(0.0);
  float ws = 0.0;
  for (int i = -8; i <= 8; i++) {
    float fi = float(i);
    float w = exp(-0.5 * fi * fi / (uSigma * uSigma));
    acc += w * TEX(uSrc, uv + uDir * fi / uSize).rgb;
    ws += w;
  }
  FRAG = vec4(acc / ws, 1.0);
}`;

  const FS_TUBE = `uniform sampler2D uDec;
uniform sampler2D uGlow;
uniform sampler2D uHalo;
uniform vec2 uOut;
uniform vec2 uCurv;
uniform vec2 uFit;
uniform vec2 uScale;     // raster size (power squeeze / breathing)
uniform float uH;        // output pixel height in scanline pitches
uniform vec2 uSigma;     // beam sigma dark, bright (pitches)
uniform vec2 uMask;      // stripe width px, strength
uniform vec2 uGamma;     // gamma in, 1 / gamma out
uniform float uGain;
uniform float uLift;
uniform vec2 uDiff;      // glow share, halo add
uniform vec4 uSync;      // roll lines, blank lines, jitter px, frame
uniform vec3 uSig;       // snow, saturation, signal
uniform vec3 uDeg;       // amplitude, phase, wobble px
uniform vec4 uLine;      // intensity, sigma y, half width x, sigma x (screen half-heights)
uniform vec3 uLineCol;
uniform vec4 uGlass;     // lit, black glow, reflection, vignette
uniform float uConv;
uniform float uFlip;     // 1: rows are written top-down (read back with readPixels), 0: the GL convention
uniform vec3 uCam;       // zoom, centre x, centre y (room units: half the tube's height, y down)
uniform vec3 uEmitL;     // the screen's light (linear): the picture's left half, right half, bottom half
uniform vec3 uEmitR;
uniform vec3 uEmitB;
uniform vec2 uRoom;      // the pilot light (0..1), the room's exposure

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 erfv(vec3 x) {
  vec3 x2 = x * x;
  vec3 ax2 = 0.147 * x2;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + ax2) / (1.0 + ax2)));
}
// a gaussian beam of sigma sg (pitches), averaged over the pixel's height h, at distance d
vec3 beam(float d, vec3 sg, float h) {
  vec3 k = 0.70710678 / sg;
  return 0.5 * (erfv((d + 0.5 * h) * k) - erfv((d - 0.5 * h) * k)) / h;
}
float lineNoise(float n, float seed) {
  float a = floor(n / 6.0);
  float t = n / 6.0 - a;
  t = t * t * (3.0 - 2.0 * t);
  return mix(hash12(vec2(a, seed)), hash12(vec2(a + 1.0, seed)), t) - 0.5;
}
// snow: noise at the video bandwidth, so grains are short horizontal streaks one scanline tall
vec3 snowAt(float n, float x, float fr) {
  vec2 o = vec2(mod(fr, 61.0) * 37.0, mod(fr, 53.0) * 91.0);
  float cx = x * 1.1 + 7.0 * hash12(vec2(n, 3.0) + o); // each line's grain grid starts at random: no column structure
  float c0 = floor(cx);
  float t = cx - c0;
  t = t * t * (3.0 - 2.0 * t);
  float v = mix(hash12(vec2(c0, n) + o), hash12(vec2(c0 + 1.0, n) + o), t);
  v = 0.72 * v + 0.28 * hash12(vec2(floor(x * 2.7 + 5.0 * hash12(vec2(n, 9.0) + o.yx)), n) + o.yx + 17.0);
  float tint = hash12(vec2(floor(x * 0.4), n) + o + 5.0) - 0.5;
  vec3 c = vec3(v) + vec3(tint, -0.4 * tint, 0.2 * tint) * 0.18 * uSig.y;
  return pow(clamp(c, 0.0, 1.0), vec3(2.3)) * 1.35;
}
// ---- the set and the room (smooth, not pixels): signed distances, value noise, a simple light model
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float cover(float d, float px) { return 1.0 - smoothstep(-px, px, d); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm3(vec2 p) { return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 7.1) + 0.125 * vnoise(p * 4.01 + 3.3); }
// walnut veneer: fine grain running along x, warped by slow noise
vec3 walnut(vec2 w) {
  float g = fbm3(vec2(w.x * 1.1, w.y * 5.0));
  float grain = 0.5 + 0.5 * sin(w.y * 140.0 + g * 11.0 + sin(w.x * 2.3) * 1.7);
  return vec3(0.17, 0.09, 0.045) * (0.7 + 0.3 * grain) * (0.8 + 0.4 * g);
}
// a round knob seen from the front: a ridged aluminium skirt, a dark face with a pointer; the screen
// lights it from the left, the room from everywhere
vec3 knob(vec2 d, float r, float ang0, vec3 key, vec3 amb) {
  float rr = length(d) / r;
  float skirt = step(0.78, rr);
  vec3 n = normalize(mix(vec3(0.0, 0.0, 1.0), vec3(d / r * 2.2, 0.6), skirt));
  vec3 L = normalize(vec3(-1.0, -0.15, 0.55));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);
  float a = atan(d.y, d.x);
  vec3 alb = mix(vec3(0.05, 0.05, 0.055), vec3(0.5, 0.5, 0.52) * (0.8 + 0.2 * sin(a * 40.0)), skirt);
  vec3 c = alb * (amb + key * diff * 0.3) + key * spec * mix(0.12, 0.6, skirt);
  vec2 dir = vec2(cos(ang0), sin(ang0));
  float along = dot(d, dir) / r;
  float off = abs(dot(d, vec2(-dir.y, dir.x))) / r;
  float ptr = step(0.15, along) * step(along, 0.7) * (1.0 - smoothstep(0.03, 0.07, off)) * (1.0 - skirt);
  return mix(c, vec3(0.62, 0.6, 0.56) * (amb * 2.0 + key * 0.35), ptr);
}
// the moulded plastic surround; its inner lip bevels toward the glass and catches its light
vec3 moonAt(vec2 w) { return vec3(0.0034, 0.0043, 0.0062) * (0.55 + 0.45 * clamp(0.55 - 0.16 * w.x - 0.22 * w.y, 0.0, 1.0)); }
vec3 bezelPlastic(vec2 w, float A, vec3 moon, vec3 emA) {
  float GX = A * 1.03;
  float GY = 1.03;
  float dBez = sdBox(w, vec2(GX + 0.13, GY + 0.13), 0.24);
  float dGl = sdBox(w, vec2(GX, GY), 0.16);
  vec3 side = mix(uEmitL, uEmitR, clamp(0.5 + 0.5 * w.x / GX, 0.0, 1.0)) * uRoom.y;
  vec3 pl = vec3(0.035, 0.035, 0.038) * (moon * 1.5 + emA * 0.08) + side * exp(-max(dGl, 0.0) / 0.035) * 0.05;
  return pl + vec3(0.035) * moon * 5.0 * smoothstep(-0.05, -0.01, dBez) * (1.0 - smoothstep(-0.9, 0.2, w.y));
}
#if WITH_ROOM
// Everything outside the glass. w: room position (units: half the tube's height, y down), px: room
// units per output pixel. The tube's glass spans |x| < A * 1.03, |y| < 1.03.
vec3 setColor(vec2 w, float px, float A) {
  float GX = A * 1.03;
  float GY = 1.03;
  vec3 emA = 0.5 * (uEmitL + uEmitR) * uRoom.y;
  vec3 emB = uEmitB * uRoom.y;
  // faint cool window light from the upper left, so the set reads before the screen lights the room
  vec3 moon = moonAt(w);
  float L = -GX - 0.32, R = GX + 1.08, T = -GY - 0.3, Bm = GY + 0.44;
  vec2 cc = vec2(0.5 * (L + R), 0.5 * (T + Bm));
  vec2 hb = vec2(0.5 * (R - L), 0.5 * (Bm - T));
  float dCab = sdBox(w - cc, hb, 0.09);
  // the wall: dim striped wallpaper; the room's bounce light gathers around the set
  float stripe = 0.93 + 0.07 * smoothstep(0.35, 0.65, fract(w.x * 2.4));
  float near = exp(-max(dCab, 0.0) / 1.1);
  vec3 col = vec3(0.32, 0.27, 0.21) * stripe * (moon * 1.3 + emA * (0.02 + 0.09 * near));
  // the sideboard: a lacquered top lit by the screen in front of the set, its front, then the floor
  float TT = Bm + 0.46;
  float TF = TT + 0.6;
  if (w.y > Bm - 2.0 * px) {
    float ty = clamp((w.y - Bm) / (TT - Bm), 0.0, 1.0);
    float across = exp(-pow(max(abs(w.x) - GX * 0.75, 0.0) / 0.9, 2.0));
    float pool = across * (0.3 + 2.4 * ty) * exp(-1.7 * ty);
    float shade = 1.0 - 0.7 * (1.0 - smoothstep(0.0, 0.22, ty)) * step(L, w.x) * step(w.x, R);
    vec3 top = walnut(vec2(w.x * 0.6, w.y * 2.2 + 3.0)) * (moon * 0.9 + emB * pool * 0.3) * shade + emA * 0.02 * smoothstep(0.55, 1.0, ty) * across;
    vec3 front = walnut(w * vec2(1.0, 3.0) + 9.0) * 0.55 * (moon * 0.9 + emA * 0.03) + emB * 0.09 * across * exp(-max(w.y - TT, 0.0) / 0.02);
    vec3 flo = vec3(0.0005, 0.0005, 0.0006) + emA * 0.003;
    vec3 tb = mix(top, front, smoothstep(TT - px, TT + px, w.y));
    tb = mix(tb, flo, smoothstep(TF - px, TF + px, w.y));
    col = mix(col, tb, smoothstep(Bm - px, Bm + px, w.y));
  }
  float cab = cover(dCab, px);
  if (cab > 0.0) {
    vec3 amb = moon + emA * 0.13;
    vec3 c = walnut(w) * amb;
    // the top face, seen from a little above, catches the window light
    c += walnut(w * vec2(1.0, 0.3)) * (moon * 2.4 + emA * 0.04) * (1.0 - smoothstep(T + 0.02, T + 0.075, w.y));
    c *= 0.55 + 0.45 * smoothstep(0.0, 0.05, -dCab);
    c = mix(c, bezelPlastic(w, A, moon, emA), cover(sdBox(w, vec2(GX + 0.13, GY + 0.13), 0.24), px));
    // the control panel: a brushed strip with the channel dial, the volume, the power button and its
    // pilot light, and the speaker grille
    vec2 pc = vec2(GX + 0.62, 0.0);
    vec3 pamb = moon * 1.6 + emA * 0.09;
    vec3 pcol = vec3(0.05, 0.05, 0.055) * (0.9 + 0.1 * vnoise(vec2(w.x * 260.0, w.y * 3.0))) * pamb;
    float gr = cover(sdBox(w - vec2(pc.x, 0.74), vec2(0.28, 0.2), 0.03), px);
    float slot = smoothstep(0.3, 0.45, fract(w.y * 24.0)) * (1.0 - smoothstep(0.8, 0.95, fract(w.y * 24.0)));
    pcol = mix(pcol, pcol * 0.2, gr * slot);
    vec2 k1 = w - vec2(pc.x, -0.52);
    float ta = atan(k1.y, k1.x) * 1.9099; // 12 ticks round the channel dial
    float tick = step(0.225, length(k1)) * step(length(k1), 0.265) * (1.0 - smoothstep(0.08, 0.16, abs(fract(ta) - 0.5)));
    pcol += vec3(0.5) * (moon * 3.0 + emA * 0.12) * tick;
    pcol = mix(pcol, knob(k1, 0.2, -2.3, emA, moon * 1.5), cover(length(k1) - 0.2, px));
    vec2 k2 = w - vec2(pc.x, -0.02);
    pcol = mix(pcol, knob(k2, 0.13, -0.8, emA, moon * 1.5), cover(length(k2) - 0.13, px));
    pcol = mix(pcol, vec3(0.34, 0.34, 0.33) * (moon * 1.8 + emA * 0.09), cover(sdBox(w - vec2(pc.x + 0.12, 0.38), vec2(0.12, 0.05), 0.02), px));
    float ld = length(w - vec2(pc.x - 0.2, 0.38));
    vec3 ledc = mix(vec3(0.05, 0.006, 0.006) * moon * 10.0, vec3(1.0, 0.1, 0.05) * 1.6, uRoom.x);
    pcol = mix(pcol, ledc, cover(ld - 0.026, px));
    pcol += vec3(1.0, 0.12, 0.05) * uRoom.x * 0.06 * exp(-ld / 0.05);
    c = mix(c, pcol, cover(sdBox(w - pc, vec2(0.36, GY - 0.02), 0.06), px));
    // the maker's badge under the screen
    vec3 badge = vec3(0.45, 0.45, 0.47) * (moon * 3.0 + emA * 0.07) * (0.85 + 0.15 * vnoise(vec2(w.x * 200.0, 1.0)));
    c = mix(c, badge, cover(sdBox(w - vec2(0.0, GY + 0.27), vec2(0.26, 0.04), 0.012), px));
    col = mix(col, c, cab);
  }
  return col;
}
#endif
vec3 lineColor(float n, float x) {
  if (n < 0.0 || n > ${SH - 1}.0) return vec3(0.0);
  vec3 c = vec3(0.0);
  float L = mod(n + uSync.x, ${SH}.0 + uSync.y);
  if (L < ${SH}.0) {
    float xs = x + uSync.z * (lineNoise(n, mod(uSync.w, 97.0) * 7.3) * 2.0 + 1.6 * exp(-n / 9.0) * sin(uSync.w * 0.9));
    float v = (floor(L) + 0.5) / ${SH}.0;
    float edge = 0.5 + 0.5 * (xs / ${SW / 2}.0 - 1.0);
    float cv = uConv * (edge * 2.0 - 1.0);
    c.r = TEX(uDec, vec2((xs + cv) / ${SW}.0, v)).r;
    c.g = TEX(uDec, vec2(xs / ${SW}.0, v)).g;
    c.b = TEX(uDec, vec2((xs - cv) / ${SW}.0, v)).b;
    c = pow(c, vec3(uGamma.x));
    float ly = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(ly), c, uSig.y) * uSig.z;
    float fx = step(-0.5, xs) * step(xs, ${SW}.5);
    c *= fx;
  }
  if (uSig.x > 0.0) c = mix(c, snowAt(n, x, uSync.w), uSig.x * 0.85) + snowAt(n, x, uSync.w) * uSig.x * 0.15;
  return c;
}
void main() {
  vec2 fc = gl_FragCoord.xy;
  fc.y = mix(fc.y, uOut.y - fc.y, uFlip);
  float A = uOut.x / uOut.y;
  // the camera: screen -> room (units: half the tube's height, y down) -> the tube's face
  vec2 sq = vec2(fc.x / uOut.x * 2.0 - 1.0, 1.0 - fc.y / uOut.y * 2.0);
  vec2 wv = sq * vec2(A, 1.0) / uCam.x + uCam.yz;
  float px = 2.0 / (uOut.y * uCam.x);
  vec2 q = wv / vec2(A, 1.0);
  vec2 cq = q * (1.0 + uCurv * vec2(q.y * q.y, q.x * q.x)) * uFit;
  // the glass: a rounded rectangle on the curved face, a little larger than the raster
  vec2 gp = abs(cq * vec2(A, 1.0)) - vec2(A, 1.0) * 1.03;
  float rad = 0.16;
  float sdf = length(max(gp + rad, 0.0)) + min(max(gp.x + rad, gp.y + rad), 0.0) - rad;
  float glass = 1.0 - smoothstep(-1.25 * px, 1.25 * px, sdf);

  vec3 col = vec3(0.0);
  if (uGlass.x > 0.5 && glass > 0.0) {
    vec2 pq = cq / uScale;
    vec2 s = (pq * 0.5 + 0.5) * vec2(${SW}.0, ${SH}.0);
    if (uDeg.z > 0.0) {
      s.x += uDeg.z * sin(s.y * 0.21 + uDeg.y * 9.0);
      s.y += uDeg.z * 0.4 * sin(s.x * 0.043 + uDeg.y * 11.0);
    }
    float n0 = floor(s.y - 0.5);
    float d0 = s.y - (n0 + 0.5);
    vec3 c0 = lineColor(n0, s.x);
    vec3 c1 = lineColor(n0 + 1.0, s.x);
    vec3 s0 = mix(vec3(uSigma.x), vec3(uSigma.y), sqrt(clamp(c0, 0.0, 1.0)));
    vec3 s1 = mix(vec3(uSigma.x), vec3(uSigma.y), sqrt(clamp(c1, 0.0, 1.0)));
    vec3 pic = c0 * beam(d0, s0, uH) + c1 * beam(d0 - 1.0, s1, uH);
    // glow and halo follow the rolled picture
    float gy = mod(s.y + uSync.x, ${SH}.0 + uSync.y);
    float inPic = step(0.0, s.y) * step(s.y, ${SH}.0) * step(gy, ${SH}.0);
    vec2 guv = vec2(s.x / ${SW}.0, gy / ${SH}.0);
    vec3 glow = TEX(uGlow, guv).rgb * inPic * uSig.z;
    vec3 halo = TEX(uHalo, guv).rgb * inPic * uSig.z;
    glow = mix(glow, vec3(0.3), uSig.x * inPic);
    // a squeezed raster packs many lines into one pixel: fall back to the line average
    pic = mix(pic, glow, smoothstep(0.7, 2.0, uH));
    // aperture grille
    float stripe = mod(floor(fc.x / uMask.x), 3.0);
    vec3 mk = 1.0 - uMask.y * (1.0 - vec3(step(stripe, 0.5), step(0.5, stripe) * step(stripe, 1.5), step(1.5, stripe)));
    pic *= mk;
    pic = pic * (1.0 - uDiff.x) + glow * uDiff.x;
    pic = pic * uGain + halo * uDiff.y * uGain + uLift * inPic;
    if (uDeg.x > 0.0) {
      float r2 = dot(cq, cq);
      vec3 bl = vec3(sin(cq.x * 2.1 + cq.y * 1.3 + uDeg.y * 6.0),
                     sin(-cq.x * 1.7 + cq.y * 2.4 + uDeg.y * 7.9 + 2.1),
                     sin(cq.x * 1.1 - cq.y * 2.9 + uDeg.y * 5.1 + 4.2));
      pic *= max(vec3(0.0), 1.0 + uDeg.x * (0.35 + 0.65 * r2) * bl);
    }
    col = pic;
  }
  // the collapsed beam: a line across the glass, or a dot at its centre
  if (uLine.x > 0.0) {
    vec2 lp = cq * vec2(A, 1.0);
    float ax = max(abs(lp.x) - uLine.z, 0.0);
    float core = exp(-0.5 * (lp.y * lp.y / (uLine.y * uLine.y) + ax * ax / (uLine.w * uLine.w)));
    float wide = exp(-0.5 * (lp.y * lp.y + ax * ax) / (uLine.y * uLine.y * 64.0 + 0.0004));
    float wider = exp(-0.5 * (lp.y * lp.y + ax * ax) / (uLine.y * uLine.y * 900.0 + 0.002));
    col += uLineCol * uLine.x * (core + 0.06 * wide + 0.012 * wider);
  }
  // vignette: the tube is brighter in the middle (about -7% at the edge midpoints, -20% in the corners)
  col *= 1.0 - uGlass.w * pow(0.5 * dot(cq, cq), 1.6);
  // the glass itself: unlit phosphor under room light, the lit black level, a soft window reflection
  vec3 base = vec3(0.0012, 0.0014, 0.0015) + uGlass.y * vec3(0.0022, 0.0026, 0.0029);
  vec2 rp = (cq - vec2(-0.5, -0.56)) * vec2(A * 0.72, 1.0);
  rp = vec2(rp.x * 0.94 + rp.y * 0.34, -rp.x * 0.34 + rp.y * 0.94);
  vec2 rb = abs(rp) - vec2(0.42, 0.17);
  float rs = length(max(rb, 0.0)) + min(max(rb.x, rb.y), 0.0);
  float win = 1.0 - smoothstep(-0.3, 0.75, rs);
  float sheen = exp(-1.4 * dot(cq - vec2(-0.45, -1.0), cq - vec2(-0.45, -1.0)));
  float lip = smoothstep(0.55, 1.0, -cq.y) * (1.0 - smoothstep(0.0, 1.2, abs(cq.x + 0.2)));
  vec3 refl = uGlass.z * (win * win * 0.0042 + sheen * 0.0032 + lip * 0.0014) * vec3(0.92, 0.96, 1.0);
  col += base + refl;
  if (glass < 1.0) {
    // two compiled variants: with the tube filling the frame only the bezel's corners show, so the room
    // (whose code alone costs SwiftShader a third of the frame, even untaken) is not in that program;
    // the two agree exactly at zoom 1, so the push-in lands without a pop
#if WITH_ROOM
    vec3 outside = setColor(wv, px, A);
#else
    vec3 outside = bezelPlastic(wv, A, moonAt(wv), 0.5 * (uEmitL + uEmitR) * uRoom.y);
#endif
    col = mix(outside, col, glass);
  }
  // the lens falls off toward the frame's corners in the wide shot
  float wideShot = clamp((1.0 - uCam.x) / 0.56, 0.0, 1.0);
  col *= 1.0 - 0.45 * wideShot * pow(0.5 * dot(sq, sq), 1.4);
  vec3 outc = pow(clamp(col, 0.0, 1.0), vec3(uGamma.y));
  // a static dither only where 8-bit steps would band (the dark glass gradients); leaving the lit picture
  // clean keeps every frame's PNG small and fast to encode
  outc += (hash12(fc) - 0.5) / 255.0 * (1.0 - smoothstep(0.06, 0.16, max(outc.r, max(outc.g, outc.b))));
  FRAG = vec4(outc, 1.0);
}`;

  // ---------------------------------------------------------------------------
  // WebGL backend
  // ---------------------------------------------------------------------------
  let G = null; // { gl, kind, canvas, progs, tex, fbs, vbo }

  function headerFS(v2) {
    return v2 ? '#version 300 es\nprecision highp float;\n#define TEX texture\nout vec4 fragOut;\n#define FRAG fragOut\n' : 'precision highp float;\n#define TEX texture2D\n#define FRAG gl_FragColor\n';
  }
  function headerVS(v2) {
    return v2 ? '#version 300 es\n#define ATTR in\n' : '#define ATTR attribute\n';
  }

  function compile(gl, v2, fsBody, name) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`crt: ${name} shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, headerVS(v2) + VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, headerFS(v2) + fsBody));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`crt: ${name} link: ${gl.getProgramInfoLog(p)}`);
    const loc = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const u = gl.getActiveUniform(p, i);
      loc[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, u.name);
    }
    return { p, loc };
  }

  function makeTex(gl, w, h, filter, internal, format, type, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
    return t;
  }
  function makeTarget(gl, w, h) {
    const tex = makeTex(gl, w, h, gl.LINEAR, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('crt: render target incomplete');
    return { tex, fb, w, h };
  }

  // Context loss (recover only; the film leaves crt.recover false and keeps its cpu fallback). The lost
  // event's default is prevented so the browser may restore the context; the restore rebuilds every GL
  // object from scratch through crt.reset(), on a fresh canvas, the next time the TV presents.
  function watchLoss(canvas) {
    if (!canvas || typeof canvas.addEventListener !== 'function') return;
    canvas.addEventListener('webglcontextlost', (e) => {
      if (!crt.recover) return;
      e.preventDefault();
      if (G && G.canvas === canvas) crt.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      if (!crt.recover || !G || G.canvas !== canvas) return;
      G = null; // the old context's objects are gone: never call into it again
      crt.lost = false;
      crt.reset();
    });
  }

  function initGL(kind) {
    if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') return null;
    const canvas = FILM.makeCanvas ? FILM.makeCanvas(16, 16) : document.createElement('canvas');
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    let gl = null;
    try {
      gl = canvas.getContext(kind, attrs);
    } catch (e) {
      gl = null;
    }
    if (!gl) return null;
    watchLoss(canvas);
    const v2 = kind === 'webgl2';
    if (!v2 && !gl.getExtension('OES_texture_float')) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    crt.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const progs = {
      decode: compile(gl, v2, FS_DECODE, 'decode'),
      down4: compile(gl, v2, FS_DOWN4, 'down4'),
      downbox: compile(gl, v2, FS_DOWNBOX, 'downbox'),
      blur: compile(gl, v2, FS_BLUR, 'blur'),
      tube: compile(gl, v2, '#define WITH_ROOM 0\n' + FS_TUBE, 'tube'),
      tubeRoom: compile(gl, v2, '#define WITH_ROOM 1\n' + FS_TUBE, 'tube (room)'),
    };
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const L = buildLut();
    const tIdx = makeTex(gl, SW, SH, gl.NEAREST, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
    const tLut = makeTex(gl, LUT_W, LUT_H, gl.NEAREST, v2 ? gl.RGBA32F : gl.RGBA, gl.RGBA, gl.FLOAT, L.data);
    const fbs = {
      dec: makeTarget(gl, DW, SH),
      g0: makeTarget(gl, SW, SH),
      g1: makeTarget(gl, SW, SH),
      h0: makeTarget(gl, SW / 4, SH / 4),
      h1: makeTarget(gl, SW / 4, SH / 4),
    };
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`crt: GL error 0x${err.toString(16)} during setup`);
    return { gl, kind, v2, canvas, progs, vbo, tIdx, tLut, lutKey: L.key, fbs };
  }

  function bindTex(gl, unit, tex) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }
  function pass(gl, prog, target, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
  }
  function draw(gl) {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function presentGL(idx, out, f, st, cam) {
    const g = G;
    const gl = g.gl;
    const p = crt.params;
    const W = out.canvas.width;
    const H = out.canvas.height;
    const L = buildLut();
    if (g.lutKey !== L.key) {
      gl.bindTexture(gl.TEXTURE_2D, g.tLut);
      gl.texImage2D(gl.TEXTURE_2D, 0, g.v2 ? gl.RGBA32F : gl.RGBA, LUT_W, LUT_H, 0, gl.RGBA, gl.FLOAT, L.data);
      g.lutKey = L.key;
    }
    if (g.canvas.width !== W || g.canvas.height !== H) {
      g.canvas.width = W;
      g.canvas.height = H;
    }
    const fb = g.fbs;
    if (st.lit) {
      // 1 index
      gl.bindTexture(gl.TEXTURE_2D, g.tIdx);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SW, SH, gl.LUMINANCE, gl.UNSIGNED_BYTE, idx);
      // 2 decode
      const d = g.progs.decode;
      pass(gl, d, fb.dec, DW, SH);
      bindTex(gl, 0, g.tIdx);
      bindTex(gl, 1, g.tLut);
      gl.uniform1i(d.loc.uIdx, 0);
      gl.uniform1i(d.loc.uLut, 1);
      gl.uniform4f(d.loc.uDim, SW, SH, LUT_W, LUT_H);
      gl.uniform1f(d.loc.uPhase, ((p.phase | 0) % 12 + 12) % 12);
      draw(gl);
      // 3 glow and halo
      const dn = g.progs.down4;
      pass(gl, dn, fb.g0, SW, SH);
      bindTex(gl, 0, fb.dec.tex);
      gl.uniform1i(dn.loc.uSrc, 0);
      gl.uniform2f(dn.loc.uSrcSize, DW, SH);
      gl.uniform1f(dn.loc.uGamma, p.gammaIn);
      draw(gl);
      const bl = g.progs.blur;
      const blur = (src, dst, w, h, dx, dy, sigma) => {
        pass(gl, bl, dst, w, h);
        bindTex(gl, 0, src.tex);
        gl.uniform1i(bl.loc.uSrc, 0);
        gl.uniform2f(bl.loc.uSize, w, h);
        gl.uniform2f(bl.loc.uDir, dx, dy);
        gl.uniform1f(bl.loc.uSigma, sigma);
        draw(gl);
      };
      blur(fb.g0, fb.g1, SW, SH, 1, 0, 1.3);
      blur(fb.g1, fb.g0, SW, SH, 0, 1, 1.3);
      const db = g.progs.downbox;
      pass(gl, db, fb.h0, SW / 4, SH / 4);
      bindTex(gl, 0, fb.g0.tex);
      gl.uniform1i(db.loc.uSrc, 0);
      gl.uniform2f(db.loc.uSrcSize, SW, SH);
      draw(gl);
      blur(fb.h0, fb.h1, SW / 4, SH / 4, 1, 0, 2.6);
      blur(fb.h1, fb.h0, SW / 4, SH / 4, 0, 1, 2.6);
    }
    // 4 tube. A CPU-backed output (the tools mount FILM.ctx with willReadFrequently) takes the pixels
    // straight from readPixels of an offscreen target: under SwiftShader, Chrome's drawImage of a
    // WebGL canvas into a CPU canvas costs several times more. A GPU-backed output (the player) takes
    // drawImage of the GL canvas, a GPU copy.
    const attrs = typeof out.getContextAttributes === 'function' ? out.getContextAttributes() : null;
    const readback = !!(attrs && attrs.willReadFrequently);
    if (readback && (!g.outFb || g.outFb.w !== W || g.outFb.h !== H)) {
      if (g.outFb) {
        gl.deleteFramebuffer(g.outFb.fb);
        gl.deleteTexture(g.outFb.tex);
      }
      g.outFb = makeTarget(gl, W, H);
      g.pxBuf = new Uint8Array(W * H * 4);
      g.px = new ImageData(new Uint8ClampedArray(g.pxBuf.buffer), W, H);
    }
    const t = cam.zoom < 0.9999 ? g.progs.tubeRoom : g.progs.tube;
    const U = t.loc;
    pass(gl, t, readback ? g.outFb : null, W, H);
    bindTex(gl, 0, fb.dec.tex);
    bindTex(gl, 1, fb.g0.tex);
    bindTex(gl, 2, fb.h0.tex);
    gl.uniform1i(U.uDec, 0);
    gl.uniform1i(U.uGlow, 1);
    gl.uniform1i(U.uHalo, 2);
    gl.uniform2f(U.uOut, W, H);
    gl.uniform2f(U.uCurv, p.curv[0], p.curv[1]);
    gl.uniform2f(U.uFit, p.fit[0], p.fit[1]);
    gl.uniform2f(U.uScale, st.scaleX, st.scaleY);
    gl.uniform1f(U.uH, (SH * p.fit[1]) / (H * st.scaleY * cam.zoom));
    gl.uniform2f(U.uSigma, p.sigmaMin, p.sigmaMax);
    const mw = p.maskW > 0 ? p.maskW : Math.max(1, Math.round(H / 1080));
    // the grille fades out when its stripes would fall below one output pixel's worth of detail
    // pulled back, the grille is far below a pixel: it fades out with the camera
    const mk = (H >= 720 ? p.maskK : p.maskK * clamp01((H - 360) / 360)) * smooth(0.75, 0.98, cam.zoom);
    gl.uniform2f(U.uMask, mw, mk);
    gl.uniform2f(U.uGamma, p.gammaIn, 1 / p.gammaOut);
    gl.uniform1f(U.uGain, p.brightness * st.gain / (1 - (mk * 2) / 3));
    gl.uniform1f(U.uLift, st.lift);
    gl.uniform2f(U.uDiff, p.glow, p.halo);
    gl.uniform4f(U.uSync, st.roll, ROLL_VB, st.jit, f);
    gl.uniform3f(U.uSig, st.snow, st.sat, st.sig);
    gl.uniform3f(U.uDeg, st.deg, st.degPhase, st.wobble);
    gl.uniform4f(U.uLine, st.line, st.lineSig, st.lineHalf, st.lineSigX);
    gl.uniform3f(U.uLineCol, st.lineCol[0], st.lineCol[1], st.lineCol[2]);
    gl.uniform4f(U.uGlass, st.lit ? 1 : 0, st.black, p.refl, p.vignette);
    gl.uniform1f(U.uConv, p.conv);
    gl.uniform3f(U.uCam, cam.zoom, cam.cx, cam.cy);
    const em = emitLight(idx, st, f);
    gl.uniform3f(U.uEmitL, em.L[0], em.L[1], em.L[2]);
    gl.uniform3f(U.uEmitR, em.R[0], em.R[1], em.R[2]);
    gl.uniform3f(U.uEmitB, em.B[0], em.B[1], em.B[2]);
    gl.uniform2f(U.uRoom, st.led, p.room);
    gl.uniform1f(U.uFlip, readback ? 1 : 0);
    draw(gl);
    if (readback) {
      if (!g.px || g.px.width !== W || g.px.height !== H) {
        g.pxBuf = new Uint8Array(W * H * 4);
        g.px = new ImageData(new Uint8ClampedArray(g.pxBuf.buffer), W, H);
      }
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, g.pxBuf);
      out.putImageData(g.px, 0, 0);
      return;
    }
    // into the 2D output in the same task, before the GL buffer is presented or cleared
    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'copy';
    out.imageSmoothingEnabled = false;
    out.filter = 'none';
    out.drawImage(g.canvas, 0, 0, W, H);
    out.restore();
  }

  // ---------------------------------------------------------------------------
  // The screen's light on the room: the picture's average colour (linear), left half, right half and
  // bottom half, through what the tube is doing (snow, the squeeze, the line and the dot)
  // ---------------------------------------------------------------------------
  const hL = new Float64Array(64), hR = new Float64Array(64), hB = new Float64Array(64);
  function emitLight(idx, st, f) {
    const P = palette();
    const gIn = crt.params.gammaIn;
    if (!P.lin || P.linG !== gIn) {
      P.lin = [];
      for (let i = 0; i < 64; i++) {
        const v = P.rgb[i];
        P.lin.push([((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((c) => Math.pow(c, gIn)));
      }
      P.linG = gIn;
    }
    const out = { L: [0, 0, 0], R: [0, 0, 0], B: [0, 0, 0] };
    const pic = st.lit ? st.sig * st.gain * crt.params.brightness * st.scaleY : 0;
    const snow = st.lit ? st.snow * st.scaleY : 0; // the snow lights the room only as far as the raster is open
    const lineE = st.line * Math.min(1, (st.lineHalf + 0.05) * st.lineSig * 10);
    if (pic <= 0 && snow <= 0 && lineE <= 0) return out;
    hL.fill(0);
    hR.fill(0);
    hB.fill(0);
    for (let y = 0; y < SH; y++) {
      const row = y * SW;
      const bot = y >= SH / 2;
      for (let x = 0; x < SW; x++) {
        const i = idx[row + x];
        if (x < SW / 2) hL[i]++;
        else hR[i]++;
        if (bot) hB[i]++;
      }
    }
    const flick = 1 + 0.12 * snow * (((Math.imul(f | 0, 0x9e3779b1) >>> 0) / 4294967296) - 0.5);
    const n = (SW * SH) / 2;
    for (const [h, o] of [[hL, out.L], [hR, out.R], [hB, out.B]]) {
      for (let i = 0; i < 64; i++) {
        if (!h[i]) continue;
        const l = P.lin[i];
        for (let k = 0; k < 3; k++) o[k] += (h[i] / n) * l[k];
      }
      for (let k = 0; k < 3; k++) o[k] = (o[k] * pic * (1 - 0.85 * snow) + 0.27 * snow * flick + lineE * st.lineCol[k]) + 0.003 * st.black;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The proof layers, drawn crisp over the TV: the controller input display and the closing caption
  // ---------------------------------------------------------------------------
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
  function inputAlpha(f) {
    let a = 0;
    for (const [s0, s1] of crt.inputWindows()) {
      if (f < s0 || f >= s1 + 16) continue;
      a = Math.max(a, Math.min(clamp01((f - s0 + 1) / 12), 1 - clamp01((f - s1) / 16)));
    }
    return a;
  }
  function captionAlpha(f) {
    const w = crt.captionWindow();
    if (!w) return 0;
    const len = w[1] - w[0];
    const fin = Math.min(24, len / 4), fout = Math.min(30, len / 4);
    const end = w[1] - 6; // gone before the loop
    return clamp01((f - w[0]) / fin) * clamp01((end - f) / fout);
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  // A small game pad on a translucent dark plate, bottom right: every button the tape holds this frame
  // lights, and the frame counter runs (the TAS-video input display).
  function drawPad(g, W, H, btn, a, f) {
    const u = (H / 1080) * 1.15;
    const B = (FILM.crt && FILM.crt.BUTTONS) || { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 };
    const pw = Math.round(236 * u), ph = Math.round(96 * u);
    const x0 = Math.round(W - pw - 52 * u), y0 = Math.round(H - ph - 80 * u);
    const lit = `rgba(246,241,232,${a})`, dim = `rgba(255,255,255,${0.2 * a})`, coral = `rgba(236,124,92,${a})`;
    const on = (m) => (btn & m) !== 0;
    g.fillStyle = `rgba(8,8,10,${0.8 * a})`;
    roundRect(g, x0, y0, pw, ph, 14 * u);
    g.fill();
    g.strokeStyle = `rgba(255,255,255,${0.1 * a})`;
    g.lineWidth = Math.max(1, 1.5 * u);
    g.stroke();
    // the D-pad
    const cx = x0 + 52 * u, cy = y0 + 56 * u, s = 13 * u, arm = 16 * u;
    g.fillStyle = dim;
    g.fillRect(cx - s / 2, cy - s / 2, s, s);
    const arms = [[B.UP, cx - s / 2, cy - s / 2 - arm, s, arm], [B.DOWN, cx - s / 2, cy + s / 2, s, arm], [B.LEFT, cx - s / 2 - arm, cy - s / 2, arm, s], [B.RIGHT, cx + s / 2, cy - s / 2, arm, s]];
    for (const [m, x, y, w, h] of arms) {
      g.fillStyle = on(m) ? lit : dim;
      roundRect(g, x, y, w, h, 2.5 * u);
      g.fill();
    }
    // SELECT and START
    g.font = `600 ${Math.round(8.5 * u)}px ${MONO}`;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (const [m, x, label] of [[B.SELECT, x0 + 108 * u, 'SELECT'], [B.START, x0 + 146 * u, 'START']]) {
      g.fillStyle = on(m) ? lit : dim;
      roundRect(g, x - 13 * u, y0 + 58 * u, 26 * u, 9 * u, 4.5 * u);
      g.fill();
      g.fillStyle = `rgba(255,255,255,${0.4 * a})`;
      g.fillText(label, x, y0 + 53 * u);
    }
    // B and A
    g.font = `700 ${Math.round(11 * u)}px ${MONO}`;
    for (const [m, x, label] of [[B.B, x0 + 186 * u, 'B'], [B.A, x0 + 216 * u, 'A']]) {
      g.fillStyle = on(m) ? coral : dim;
      g.beginPath();
      g.arc(x, y0 + 56 * u, 12 * u, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = on(m) ? lit : `rgba(255,255,255,${0.4 * a})`;
      g.fillText(label, x, y0 + 85 * u);
    }
    // the frame counter
    g.textAlign = 'left';
    g.font = `500 ${Math.round(9.5 * u)}px ${MONO}`;
    g.fillStyle = `rgba(255,255,255,${0.45 * a})`;
    g.fillText('FRAME ' + String(f).padStart(5, '0'), x0 + 14 * u, y0 + 19 * u);
    g.textAlign = 'right';
    g.fillText('PAD 1', x0 + pw - 14 * u, y0 + 19 * u);
  }
  // The caption, centred on the dark glass wherever the camera has the set.
  function drawCaption(g, W, H, cam, a) {
    const lines = captionLines();
    if (!lines.length) return;
    const A = W / H;
    const cx = ((-cam.cx * cam.zoom) / A + 1) * 0.5 * W;
    const cy = (-cam.cy * cam.zoom + 1) * 0.5 * H;
    const gh = 1.03 * cam.zoom * H; // the glass's height on screen
    const big = Math.round(0.102 * gh), small = Math.round(0.05 * gh);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = `rgba(255,236,210,${0.45 * a})`;
    g.shadowBlur = 0.35 * big;
    g.fillStyle = `rgba(238,232,220,${a})`;
    g.font = `600 ${big}px ${MONO}`;
    g.fillText(lines[0] || '', cx, cy - 0.12 * gh);
    if (lines[1]) g.fillText(lines[1], cx, cy + 0.0 * gh);
    if (lines[2]) {
      g.shadowBlur = 0.3 * small;
      g.fillStyle = `rgba(238,232,220,${0.72 * a})`;
      g.font = `500 ${small}px ${MONO}`;
      g.fillText(lines[2], cx, cy + 0.155 * gh);
    }
  }
  function btnAt(f) {
    if (typeof crt.buttonsAt !== 'function') return 0;
    try {
      const v = crt.buttonsAt(f);
      return v == null ? 0 : v | 0;
    } catch (e) {
      return 0;
    }
  }
  // Determinism: vector drawing (paths, text, shadows) is never done on the output context. Chrome
  // rasterises a canvas differently once another canvas has been drawn into it (a clean-mode present
  // does that), so the same pad drawn on FILM.ctx before and after hashed differently. Each layer is
  // drawn on a private scratch canvas that only ever receives vector drawing, then blended into the
  // output's pixels in integer arithmetic (a CPU-backed output: the tools), or drawn with drawImage
  // (a GPU-backed output: the player, where speed matters and hashes do not).
  let scratch = null;
  function layer(out, readback, x, y, w, h, draw) {
    const W = out.canvas.width, H = out.canvas.height;
    x = Math.max(0, Math.floor(x));
    y = Math.max(0, Math.floor(y));
    w = Math.min(W - x, Math.ceil(w));
    h = Math.min(H - y, Math.ceil(h));
    if (w <= 0 || h <= 0) return;
    if (!scratch) scratch = FILM.makeCanvas(w, h);
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    const g = scratch.getContext('2d', { willReadFrequently: true });
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.shadowBlur = 0;
    g.shadowColor = 'rgba(0,0,0,0)';
    g.clearRect(0, 0, w, h);
    g.translate(-x, -y);
    draw(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (!readback) {
      out.save();
      out.setTransform(1, 0, 0, 1, 0, 0);
      out.globalAlpha = 1;
      out.globalCompositeOperation = 'source-over';
      out.drawImage(scratch, x, y);
      out.restore();
      return;
    }
    const src = g.getImageData(0, 0, w, h).data;
    const img = out.getImageData(x, y, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = src[i + 3];
      if (a === 0) continue;
      const b = 255 - a;
      d[i] = ((src[i] * a + d[i] * b + 127) / 255) | 0;
      d[i + 1] = ((src[i + 1] * a + d[i + 1] * b + 127) / 255) | 0;
      d[i + 2] = ((src[i + 2] * a + d[i + 2] * b + 127) / 255) | 0;
      d[i + 3] = 255;
    }
    out.putImageData(img, x, y);
  }
  function drawOverlays(out, f, cam) {
    const ov = crt.overlays || {};
    const W = out.canvas.width, H = out.canvas.height;
    const ca = ov.caption !== false ? captionAlpha(f) : 0;
    const ia = ov.input !== false ? inputAlpha(f) : 0;
    if (!(ca > 0) && !(ia > 0)) return;
    const attrs = typeof out.getContextAttributes === 'function' ? out.getContextAttributes() : null;
    const readback = !!(attrs && attrs.willReadFrequently);
    if (ca > 0) {
      // the caption's box: the glass on screen, wherever the camera has it
      const A = W / H;
      const cx = ((-cam.cx * cam.zoom) / A + 1) * 0.5 * W;
      const cy = (-cam.cy * cam.zoom + 1) * 0.5 * H;
      const gw = 1.03 * cam.zoom * W, gh = 1.03 * cam.zoom * H;
      layer(out, readback, cx - gw / 2, cy - gh / 2, gw, gh, (g) => drawCaption(g, W, H, cam, ca));
    }
    if (ia > 0) {
      const u = (H / 1080) * 1.15;
      const pw = Math.round(236 * u), ph = Math.round(96 * u);
      const x0 = Math.round(W - pw - 52 * u), y0 = Math.round(H - ph - 80 * u);
      layer(out, readback, x0 - 4, y0 - 4, pw + 8, ph + 8, (g) => drawPad(g, W, H, btnAt(f), ia, f));
    }
  }
  crt.inputAlpha = inputAlpha;
  crt.captionAlpha = captionAlpha;

  // ---------------------------------------------------------------------------
  // CPU fallback: the same composite decode, then a canvas approximation of the tube
  // ---------------------------------------------------------------------------
  let cpu = null;
  function presentCPU(idx, out, f, st) {
    const p = crt.params;
    const W = out.canvas.width;
    const H = out.canvas.height;
    if (!cpu) {
      const dec = FILM.makeCanvas(DW, SH);
      cpu = { dec, dctx: dec.getContext('2d'), img: null, lines: null, linesH: 0 };
      cpu.img = cpu.dctx.createImageData(DW, SH);
    }
    const Lt = buildLut().data;
    out.save();
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
    out.fillStyle = '#070808';
    out.fillRect(0, 0, W, H);
    if (st.lit) {
      const d = cpu.img.data;
      for (let y = 0; y < SH; y++) {
        const P = (4 * y + (p.phase | 0)) % 12;
        for (let X = 0; X < DW; X++) {
          const m = X >> 2, u = X & 3;
          let Y = 0, I = 0, Q = 0;
          for (let oi = 0; oi <= 2 * NB; oi++) {
            const k = m + oi - NB;
            const id = k >= 0 && k < SW ? idx[y * SW + k] : 15;
            const a = (((8 * k + P) % 12) + 12) % 12 >> 2;
            const o = ((id * 3 + a) * LUT_W + oi * 4 + u) * 4;
            Y += Lt[o];
            I += Lt[o + 1];
            Q += Lt[o + 2];
          }
          const i4 = (y * DW + X) * 4;
          // x1.22: the scanline overlay below darkens the average by about 18%
          const g = (v) => 255 * Math.pow(clamp01(v), p.gammaIn / p.gammaOut) * Math.min(1.5, 1.22 * p.brightness * st.gain * st.sig);
          d[i4] = g(Y + 0.9563 * I + 0.621 * Q);
          d[i4 + 1] = g(Y - 0.2721 * I - 0.6474 * Q);
          d[i4 + 2] = g(Y - 1.107 * I + 1.7046 * Q);
          d[i4 + 3] = 255;
        }
      }
      cpu.dctx.putImageData(cpu.img, 0, 0);
      const pw = (W / p.fit[0]) * st.scaleX;
      const ph = (H / p.fit[1]) * st.scaleY;
      out.imageSmoothingEnabled = true;
      out.imageSmoothingQuality = 'high';
      out.drawImage(cpu.dec, (W - pw) / 2, (H - ph) / 2, pw, ph);
      // scanline gaps
      if (!cpu.lines || cpu.linesH !== H) {
        const pitch = H / SH;
        const c = FILM.makeCanvas(1, Math.max(2, Math.round(pitch * 2)));
        const g2 = c.getContext('2d');
        for (let y = 0; y < c.height; y++) {
          const t = ((y + 0.5) / pitch) % 1;
          const a = 0.55 * Math.pow(Math.abs(t - 0.5) * 2, 2);
          g2.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
          g2.fillRect(0, y, 1, 1);
        }
        cpu.lines = c;
        cpu.linesH = H;
      }
      out.fillStyle = out.createPattern(cpu.lines, 'repeat');
      out.fillRect((W - pw) / 2, (H - ph) / 2, pw, ph);
    }
    if (st.line > 0) {
      const cx = W / 2, cy = H / 2;
      const half = (st.lineHalf * H) / 2;
      const r = Math.max(2, st.lineSig * H * 3);
      out.globalCompositeOperation = 'lighter';
      const c = st.lineCol;
      out.fillStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${Math.min(1, st.line / 2).toFixed(3)})`;
      out.beginPath();
      out.ellipse(cx, cy, half + r, r, 0, 0, Math.PI * 2);
      out.fill();
    }
    // vignette and rounded corners
    out.globalCompositeOperation = 'source-over';
    const vg = out.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    out.fillStyle = vg;
    out.fillRect(0, 0, W, H);
    out.restore();
  }

  // ---------------------------------------------------------------------------
  // present
  // ---------------------------------------------------------------------------
  function ensureBackend() {
    if (crt.backend) return crt.backend;
    const order = { webgl2: ['webgl2', 'webgl', 'cpu', 'nearest'], webgl: ['webgl', 'cpu', 'nearest'], cpu: ['cpu', 'nearest'], nearest: ['nearest'] }[crt.force] || ['webgl2', 'webgl', 'cpu', 'nearest'];
    for (const k of order) {
      if (k === 'webgl2' || k === 'webgl') {
        try {
          G = initGL(k);
        } catch (e) {
          G = null;
          FILM.errors && FILM.errors.push({ T: null, message: String((e && e.message) || e) });
        }
        if (G) return (crt.backend = k);
      } else if (k === 'cpu') {
        if (FILM.makeCanvas) {
          crt.renderer = 'canvas 2d';
          return (crt.backend = 'cpu');
        }
      } else {
        crt.renderer = 'canvas 2d';
        return (crt.backend = 'nearest');
      }
    }
    return (crt.backend = 'nearest');
  }

  crt.present = function present(src, outCtx, o) {
    o = typeof o === 'number' ? { frame: o } : o || {};
    const f = o.frame != null ? Math.floor(o.frame) : Math.floor((Number(o.T) || 0) * 60 + 1e-6);
    if (crt.mode === 'clean') {
      FILM.presentNearest(src, outCtx);
      return;
    }
    const be = ensureBackend();
    if (be === 'nearest') {
      FILM.presentNearest(src, outCtx);
      if (o.overlays !== false) drawOverlays(outCtx, f, { zoom: 1, cx: 0, cy: 0 });
      return;
    }
    const idx = indices(src);
    const st = crt.power(f);
    const cam = crt.camera(f);
    if (be === 'webgl2' || be === 'webgl') {
      if (G.gl.isContextLost && G.gl.isContextLost()) {
        if (crt.recover) {
          // clean until webglcontextrestored rebuilds GL (watchLoss)
          crt.lost = true;
          FILM.presentNearest(src, outCtx);
          return;
        }
        G = null;
        crt.backend = null;
        crt.force = 'cpu';
        return present(src, outCtx, o);
      }
      presentGL(idx, outCtx, f, st, cam);
    } else {
      presentCPU(idx, outCtx, f, st);
    }
    if (o.overlays !== false) drawOverlays(outCtx, f, be === 'cpu' ? { zoom: 1, cx: 0, cy: 0 } : cam);
  };

  /** The live GL context, or null (tools lose and restore it through its WEBGL_lose_context extension). */
  crt.glContext = function glContext() {
    return G && G.gl ? G.gl : null;
  };

  /** Drop the GL state (tools call this to test a cold start or another backend). */
  crt.reset = function reset() {
    if (G && G.gl) {
      const ext = G.gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    G = null;
    cpu = null;
    crt.backend = null;
  };
})();
