// game/45-clock.js : the game page's fixed-step clock (docs/game-spec.md 11.2). Owner: P6.
//
//   GAME.clock.make()              -> { acc, last }  a fresh clock (nothing seen yet)
//   GAME.clock.advance(c, stamp)   -> steps          how many 60 Hz console steps this animation frame runs
//   GAME.clock.reset(c)                              forget the last stamp (the next advance returns 1)
//
// The logic is play.js's accumulator, moved here unchanged so it can be proven without a browser
// (tools/proof/clock.cjs): the first call returns 1 (the first animation frame shows the first console
// frame); a gap longer than MAX_GAP_MS (a hidden tab, a debugger stop) counts as exactly one step, so
// the game never races to catch up; an animation frame runs at most MAX_CATCHUP steps and a backlog
// beyond that is dropped. TOL_MS absorbs animation-frame jitter, so a 60 Hz display never skips or
// doubles a step, and the remainder carries over, so 120, 144 or 240 Hz displays average exactly 60.
// Timing comes only from the stamp passed in (the requestAnimationFrame stamp); nothing here reads a clock.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});

  const STEP_MS = 1000 / 60; // one console frame
  const TOL_MS = 2; // animation-frame jitter absorbed without a skipped or doubled step
  const MAX_CATCHUP = 5; // most steps one animation frame may run
  const MAX_GAP_MS = 250; // a longer gap is not caught up at all

  function advance(c, stamp) {
    if (c.last == null) {
      c.last = stamp;
      c.acc = STEP_MS; // the first animation frame shows the first console frame
    } else {
      const dt = stamp - c.last;
      c.last = stamp;
      c.acc += dt > MAX_GAP_MS ? STEP_MS : dt;
    }
    let n = 0;
    while (c.acc >= STEP_MS - TOL_MS && n < MAX_CATCHUP) {
      c.acc -= STEP_MS;
      n++;
    }
    if (c.acc >= STEP_MS) c.acc = 0; // too far behind: drop the backlog rather than run fast later
    return n;
  }

  GAME.clock = Object.freeze({
    STEP_MS,
    TOL_MS,
    MAX_CATCHUP,
    MAX_GAP_MS,
    make: () => ({ acc: 0, last: null }),
    advance,
    reset(c) {
      c.acc = 0;
      c.last = null;
    },
  });
})();
