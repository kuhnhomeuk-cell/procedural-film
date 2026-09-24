// game/20-tape.js : the tape kit: a controller tape authored as a player's intentions. Owner: game.
//
// A tape is not typed frame by frame. It is a short program of moves ("run to x = 330",
// "jump holding A for 14 frames", "wait on the pipe until the walkers come") that a bot plays against
// the engine, reading the same state a player sees. Each move holds some buttons until its condition
// is met; the buttons of every frame are the tape. The engine and a program are both deterministic, so
// a tape is a pure function of its program and game/10-engine.js. The level proofs
// (tools/proof/programs) and the attract recorder (tools/attract.cjs, which writes GAME.ATTRACT) build
// their programs from GAME.makeBot, GAME.lookahead, GAME.moves and GAME.goals.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});
  const { A, B, LEFT, RIGHT } = GAME.BUTTONS;

  // A move: { until(W, t) -> done?, btn(W, t) -> buttons } with t = frames since the move began.
  function makeBot(program) {
    let pc = 0;
    let t = 0;
    return function bot(W) {
      while (pc < program.length) {
        const m = program[pc];
        if (m.until(W, t)) {
          pc++;
          t = 0;
          continue;
        }
        const b = m.btn(W, t);
        t++;
        return b;
      }
      return 0;
    };
  }
  GAME.makeBot = makeBot;

  const mv = (until, btn) => ({ until, btn: typeof btn === 'function' ? btn : () => btn });

  // The planner's eye: copy the world and play a button sequence forward on the copy, collecting
  // events. The real world is untouched (the copy shares nothing with it).
  // goal(copy, events, k) returns true (reached), false (this try failed) or null (keep playing).
  // Style rules every plan obeys: the hero's drawing stays below the HUD band (its top at y >= 32), and
  // an airborne hero never scrapes a wall (a jump that loses its speed against a pipe side looks clumsy).
  const HEAD_MIN = 32;
  function lookahead(W, seq, horizon, goal, o) {
    const c = GAME.cloneWorld(W);
    for (let k = 0; k < horizon; k++) {
      const b = k < seq.length ? seq[k] : seq[seq.length - 1];
      const vx0 = c.p.vx;
      const air0 = !c.p.ground;
      const ev = GAME.step(c, b);
      const p = c.p;
      if (p.st === 'play' && !(o && o.free)) {
        if (GAME.drawTop(p) < HEAD_MIN) return false;
        if ((air0 || !p.ground) && vx0 !== 0 && p.vx === 0) return false;
      }
      const r = goal(c, ev, k);
      if (r === true) return true;
      if (r === false) return false;
    }
    return false;
  }
  GAME.lookahead = lookahead;
  const RB = RIGHT | B, L = LEFT;
  const M = {
    /** hold b for n frames */
    hold: (b, n) => mv((W, t) => t >= n, b),
    /** nothing until global frame f */
    at: (f) => mv((W) => W.f >= f, 0),
    /** nothing until the console is in mode m */
    mode: (m) => mv((W) => W.mode === m, 0),
    /** hold b until the player's x reaches x (moving right) */
    to: (x, b = RB) => mv((W) => W.p.x >= x, b),
    /** hold b until the player's x falls to x (moving left) */
    back: (x, b = L) => mv((W) => W.p.x <= x, b),
    /** hold b until pred(W) */
    until: (pred, b = 0) => mv((W, t) => pred(W, t), b),
    /** a fresh A press held n frames together with b (releases A for a frame first if it was down) */
    jump(b, n) {
      let start = -1;
      return mv(
        (W, t) => start >= 0 && t - start >= n,
        (W, t) => {
          if (start < 0) {
            if (W.prev & A) return b;
            start = t;
          }
          return b | A;
        }
      );
    },
    /** hold b until the player stands on something */
    land: (b = RB) => mv((W, t) => t > 0 && W.p.ground, b),
    /** hold b until the nearest live enemy ahead is within dx px of the player's front */
    near: (dx, b = RB) => mv((W) => gapAhead(W) <= dx, b),
    /** walk (or run, with B) to stand still at x: brake early enough to stop there, like a player lining up a jump */
    goto: (x, run = false) =>
      mv(
        (W, t) => (Math.abs(W.p.x - x) < 2 && W.p.vx === 0 && W.p.ground) || t > 240,
        (W) => {
          const p = W.p;
          const PH = GAME.PH;
          const dx = x - p.x;
          const v = p.vx;
          const dir = Math.sign(dx);
          if (Math.abs(dx) < 2) return 0;
          if (v * dir > 0) {
            const coast = (v * v) / (2 * PH.relDec);
            const skid = (v * v) / (2 * PH.skidDec);
            if (coast >= Math.abs(dx) - 1) {
              // friction alone would overshoot: skid when a skid stops just in time, coast until then
              if (skid >= Math.abs(dx) - 3 && Math.abs(v) > PH.skidTurn) return dir > 0 ? LEFT : RIGHT;
              return 0;
            }
          }
          return (dir > 0 ? RIGHT : LEFT) | (run ? B : 0);
        }
      ),
    /**
     * the planner's jump: hold b, and on the first frame where "press A now, hold it n frames, then
     * keep b" reaches goal(world, events) within the horizon, press A for real
     */
    // o.after: buttons once A is released (default b); o.mids: frames of b between releasing A and
    // switching to o.after (tried in order; default [0]); o.wait: buttons while no plan works yet
    planJump(b, ns, goal, o = {}) {
      ns = Array.isArray(ns) ? ns : [ns];
      const horizon = o.horizon || 90;
      const bAfter = o.after != null ? o.after : b;
      const bWait = o.wait != null ? o.wait : b;
      const mids = o.mids || [0];
      let start = -1;
      let plan = null;
      // the plan's buttons run to the end, then its last buttons are held until the hero lands (or
      // leaves play: the goal pole), exactly as the lookahead played them
      return mv(
        (W, t) => start >= 0 && t - start >= plan.length - 1 && (W.p.ground || W.p.st !== 'play'),
        (W, t) => {
          if (start >= 0) return plan[Math.min(t - start, plan.length - 1)];
          if (W.prev & A) return bWait;
          for (const tryN of ns) {
            for (const mid of mids) {
              const seq = [];
              for (let k = 0; k < tryN; k++) seq.push(b | A);
              for (let k = 0; k < mid; k++) seq.push(b);
              seq.push(bAfter);
              if (lookahead(W, seq, horizon, goal, o)) {
                // o.late: a showman's timing, jump only when waiting one more frame would fail
                if (o.late && lookahead(W, [bWait].concat(seq), horizon + 1, goal, o)) return bWait;
                start = t;
                plan = seq;
                return seq[0];
              }
            }
          }
          return bWait;
        }
      );
    },
    /**
     * a run-up and a jump: while waiting (o.wait), try "hold b until x >= xJump, then b|A for n frames,
     * then b" for each n; commit to the first that reaches goal, and play it through to the landing
     */
    planRunJump(b, xJump, ns, goal, o = {}) {
      const horizon = o.horizon || 120;
      const bWait = o.wait != null ? o.wait : 0;
      let start = -1;
      let plan = null;
      const runUp = (W) => {
        const c = GAME.cloneWorld(W);
        const pre = [];
        while (c.p.x < xJump && pre.length < 120) {
          pre.push(b);
          GAME.step(c, b);
          if (c.p.st !== 'play') return null;
        }
        return pre.length < 120 ? pre : null;
      };
      return mv(
        (W, t) => start >= 0 && t - start >= plan.length - 1 && (W.p.ground || W.p.st !== 'play'),
        (W, t) => {
          if (start >= 0) return plan[Math.min(t - start, plan.length - 1)];
          const pre = runUp(W);
          if (pre) {
            for (const n of ns) {
              const seq = pre.slice();
              for (let k = 0; k < n; k++) seq.push(b | A);
              seq.push(b);
              // the goal counts frames from the jump (negative during the run-up)
              const g = (c, ev, k) => goal(c, ev, k - pre.length);
              if (lookahead(W, seq, horizon + pre.length, g, o)) {
                start = t;
                plan = seq;
                return seq[0];
              }
            }
          }
          return bWait;
        }
      );
    },
    /** wait (holding bWait) until holding b from now reaches goal within the horizon, then hold b until it does */
    planGo(b, goal, o = {}) {
      const horizon = o.horizon || 120;
      const bWait = o.wait != null ? o.wait : 0;
      let go = false;
      return mv(
        (W, t) => go && goal(W, [], 99) === true,
        (W) => {
          if (!go && lookahead(W, [b], horizon, goal, o)) go = true;
          return go ? b : bWait;
        }
      );
    },
    /** skip move m when pred(W) already holds as it begins (the goal was reached some other way) */
    skipIf(pred, m) {
      let skip = null;
      return mv(
        (W, t) => {
          if (t === 0 && skip === null) skip = !!pred(W);
          return skip || m.until(W, t);
        },
        (W, t) => m.btn(W, t)
      );
    },
    /** skid or coast to a standstill */
    brake: () => mv((W, t) => W.p.vx === 0 && W.p.ground, (W) => (W.p.vx > 0 ? LEFT : W.p.vx < 0 ? RIGHT : 0)),
    /** hold b until the player's state is st */
    state: (st, b = 0) => mv((W) => W.p.st === st, b),
  };
  GAME.moves = M;

  function gapAhead(W) {
    let best = Infinity;
    for (const e of W.lv.ents) {
      if (e.st !== 'walk') continue;
      const g = e.x - (W.p.x + 16);
      if (g > -8 && g < best) best = g;
    }
    return best;
  }
  GAME.gapAhead = gapAhead;

  // goals for the planner: an event (optionally tested) before the player is back on the ground
  const onEvent = (type, test) => (c, ev, k) => {
    for (const e of ev) if (e.type === type && (!test || test(e, c))) return true;
    if (c.p.st !== 'play') return false;
    return k > 2 && c.p.ground ? false : null;
  };
  const stomps = (n) => onEvent('stomp', (e) => e.combo >= n);
  // lands on its feet where test(copy) holds
  const lands = (test) => (c, ev, k) => (c.p.st !== 'play' ? false : k > 2 && c.p.ground ? !!test(c) : null);
  const songIs = (id) => onEvent('song', (e) => e.id === id);
  // g1, then g2 (state lives on the copy, so every lookahead starts fresh)
  const then = (g1, g2) => (c, ev, k) => {
    if (!c.__then) {
      const r = g1(c, ev, k);
      if (r === true) {
        c.__then = true;
        return null;
      }
      return r;
    }
    return g2(c, ev, k);
  };
  const landsPast = (x) => lands((c) => c.p.x > x);
  // lands where test(copy) holds having collected at least n coins on the way
  const collects = (n, test) => (c, ev, k) => {
    for (const e of ev) if (e.type === 'coin') c.__coins = (c.__coins || 0) + 1;
    if (c.p.st !== 'play') return false;
    return k > 2 && c.p.ground ? (c.__coins || 0) >= n && (!test || !!test(c)) : null;
  };
  // the planner's goals, for the game's level proofs (tools/proof/programs, docs/game-spec.md 2.5)
  GAME.goals = { onEvent, stomps, lands, landsPast, collects, then, songIs };
})();
