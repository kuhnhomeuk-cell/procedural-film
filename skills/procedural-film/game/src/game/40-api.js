// game/40-api.js : FILM.game, the public face of the engine (docs/v2-architecture.md 4.1). Owner: game.
//
//   FILM.game.BUTTONS            { A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 }
//   FILM.game.create(opts)       a console (the game): { step(buttons) -> events[], state(), snapshot(),
//                                draw(nativeCtx, view), frame, mode, pausable } (docs/game-spec.md 2.5)
//   FILM.game.demo()             the attract demo: { step() -> events[], snapshot(), draw(ctx, view), done, frame }
//   FILM.game.sim()              the attract film: the console at GAME.CONFIG.firstLevel fed GAME.ATTRACT
//                                (src/game/21-attract.js), run once from frame 0 and cached:
//                                { length, states[], events[], tape, score, source, stale }
//   FILM.game.filmLength()       the attract film's length in frames
//   FILM.game.draw(ctx, f)       paint film frame f (clamped to 0..length-1) into the 320x180 native buffer
//   FILM.game.events()           sim().events, sorted by f
//   FILM.game.tape()             sim().tape
//   FILM.game.record(input, n)   a recording for 21-attract.js: { length, fp, rle, feel }
//   FILM.game.fingerprint(S), encode(tape), decode(rle, length)
//
// Every console runs the same step function (game/10-engine.js). A film state keeps the buttons held
// on that frame (states[f].btn) for an input-display overlay.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = FILM.__game;

  let SIM = null;
  const CONFIG = () => GAME.CONFIG || {};

  // the attract tape (src/game/21-attract.js): { length, fp, rle, feel? } or a bare RLE string; null
  // (or absent) when none is recorded yet
  function attract() {
    const A = GAME.ATTRACT;
    if (!A) return null;
    const rle = typeof A === 'string' ? A : A.rle;
    const tape = rle ? decode(rle, typeof A === 'object' && A.length > 0 ? A.length : undefined) : null;
    if (!tape) return null;
    return { tape, fp: typeof A === 'object' ? A.fp || null : null, feel: (typeof A === 'object' && A.feel) || 'modern' };
  }

  // the attract film's length in frames: the timeline's duration, else the tape's own length
  function filmLength() {
    const TL = FILM.TIMELINE;
    if (TL && TL.duration > 0) return Math.round(TL.duration * (TL.fps || 60));
    const A = attract();
    if (A) return A.tape.length;
    return GAME.DEFAULT_LENGTH || 3840;
  }

  // a console at the first level, as NEW GAME makes it (the title comes first; the tape presses START)
  const attractWorld = (feel) => GAME.newWorld({ start: CONFIG().firstLevel, feel: feel || 'modern' });

  // One pass of the console over `length` frames; input(W, f) gives each frame's buttons.
  function run(length, input, feel) {
    const W = attractWorld(feel);
    const states = new Array(length);
    const events = [];
    const tape = new Uint8Array(length);
    for (let f = 0; f < length; f++) {
      const b = input(W, f) & 255;
      tape[f] = b;
      const ev = GAME.step(W, b);
      for (let i = 0; i < ev.length; i++) events.push(ev[i]);
      states[f] = GAME.snapshot(W);
    }
    return { length, states, events, tape, score: W.score };
  }

  // The fingerprint of a run: every event's frame and type, and the final score (FNV-1a).
  function fingerprint(S) {
    let h = 0x811c9dc5 | 0;
    const mix = (str) => {
      for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
    };
    for (const e of S.events) mix(e.f + e.type + ';');
    mix('score' + S.score);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // run-length tape: "bb:n" pairs (buttons in hex, count in base 36), comma separated
  function encode(tape) {
    const out = [];
    for (let i = 0; i < tape.length; ) {
      let j = i;
      while (j < tape.length && tape[j] === tape[i]) j++;
      out.push(tape[i].toString(16).padStart(2, '0') + ':' + (j - i).toString(36));
      i = j;
    }
    return out.join(',');
  }
  // length omitted: the tape's own length (the sum of its runs); a mismatch returns null
  function decode(rle, length) {
    const runs = String(rle || '').split(',').filter((r) => r.length).map((r) => {
      const [b, n] = r.split(':');
      return [parseInt(b, 16), parseInt(n, 36)];
    });
    const total = runs.reduce((a, r) => a + r[1], 0);
    const len = length == null ? total : length;
    const tape = new Uint8Array(len);
    let f = 0;
    for (const [v, n] of runs) for (let k = n; k > 0 && f < len; k--) tape[f++] = v;
    return f === len ? tape : null;
  }

  // The attract film: the console at CONFIG.firstLevel fed GAME.ATTRACT, run once from frame 0 and
  // cached; past the tape's end (or with no tape) no button is held, so with no tape it idles on the
  // title. S.source is 'attract' or 'idle'; S.stale is true when the tape's fingerprint no longer
  // matches the engine (re-record it with tools/attract.cjs).
  function sim() {
    if (SIM) return SIM;
    const length = filmLength();
    const A = attract();
    const tape = A ? A.tape : new Uint8Array(0);
    const S = run(length, (W, f) => (f < tape.length ? tape[f] : 0), A && A.feel);
    S.source = A ? 'attract' : 'idle';
    S.stale = !!(A && A.fp && A.tape.length === length && fingerprint(S) !== A.fp);
    SIM = S;
    return SIM;
  }

  // A recording for src/game/21-attract.js: input is an array or typed array of buttons (one a frame)
  // or a function (W, f) -> buttons (a GAME.makeBot program); length defaults to the array's length.
  // Returns { length, fp, rle, feel }.
  function record(input, length, feel) {
    const fn = typeof input === 'function' ? input : (W, f) => (f < input.length ? input[f] | 0 : 0);
    const n = length != null ? length : input.length;
    const S = run(n, fn, feel);
    return { length: S.length, fp: fingerprint(S), rle: encode(S.tape), feel: feel || 'modern' };
  }

  let warmed = false;
  function draw(ctx, f) {
    const S = sim();
    if (!warmed) {
      warmed = true;
      GAME.warm(S.states);
    }
    f = Math.max(0, Math.min(S.length - 1, Math.floor(Number(f) || 0)));
    GAME.drawSnap(ctx, S.states[f], f, true); // film frames go dark after the power-off
  }

  // A console (docs/game-spec.md 2.5). opts: start (level id, default GAME.CONFIG.firstLevel), feel
  // ('modern' | 'nes', default 'modern'), top (the saved hi-score), shellMenu (the shell draws the title
  // menu and the pause panel); for proofs only form ('small' | 'big') and lives.
  function create(opts) {
    const o = {};
    if (opts) for (const k of ['start', 'feel', 'top', 'shellMenu', 'form', 'lives']) if (opts[k] !== undefined) o[k] = opts[k];
    const W = GAME.newWorld(o);
    return {
      step(buttons) {
        return GAME.step(W, buttons | 0);
      },
      state() {
        return W;
      },
      snapshot() {
        return GAME.snapshot(W);
      },
      // view: { reducedFlash } (the shell's options); a live console draws the grid it just stepped
      draw(ctx, view) {
        const s = GAME.snapshot(W);
        GAME.drawSnap(ctx, s, s.f, false, Object.assign({ now: true }, view)); // never dark on the film's clock
      },
      get frame() {
        return W.f;
      },
      get mode() {
        return W.mode;
      },
      get pausable() {
        return GAME.pausable(W);
      },
    };
  }

  // The attract demo (U5): the console at GAME.CONFIG.firstLevel fed GAME.ATTRACT, stepped headless to
  // the first frame in play, then one tape frame per step(). frame is the tape frame last stepped; done
  // turns true DEMO_AFTER_FLAG frames after the tape's first flagpole event or DEMO_CAP frames after play
  // began, whichever comes first. With no tape it idles on the title for DEMO_CAP frames. It emits no
  // audio of its own: the shell sends no demo events to the sound driver.
  const DEMO_AFTER_FLAG = 180, DEMO_CAP = 2400;
  function demo() {
    const A = attract();
    const tape = A ? A.tape : new Uint8Array(0);
    const W = attractWorld(A && A.feel);
    const input = (f) => (f < tape.length ? tape[f] : 0);
    if (A) while (W.mode !== 'play' && W.f < 1200) GAME.step(W, input(W.f));
    const playF = W.f - 1;
    let flagF = -1;
    let done = false;
    const api = {
      step() {
        if (done) return [];
        const ev = GAME.step(W, input(W.f));
        for (const e of ev) if (e.type === 'flagpole' && flagF < 0) flagF = e.f;
        const f = W.f - 1;
        if ((flagF >= 0 && f >= flagF + DEMO_AFTER_FLAG) || f >= playF + DEMO_CAP) done = true;
        return ev;
      },
      snapshot() {
        return GAME.snapshot(W);
      },
      draw(ctx, view) {
        const s = GAME.snapshot(W);
        GAME.drawSnap(ctx, s, s.f, false, Object.assign({ now: true }, view));
      },
      get done() {
        return done;
      },
      get frame() {
        return W.f - 1;
      },
    };
    return api;
  }

  FILM.game = Object.freeze({
    BUTTONS: GAME.BUTTONS,
    create,
    demo,
    sim,
    draw,
    filmLength,
    events: () => sim().events,
    tape: () => sim().tape,
    record,
    fingerprint,
    encode,
    decode,
  });
})();
