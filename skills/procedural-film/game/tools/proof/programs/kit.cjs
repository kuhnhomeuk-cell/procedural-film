// tools/proof/programs/kit.cjs : the level bots' vocabulary (docs/game-spec.md 13.2).
//
// A level program is a list of moves a player means ("onto the down pipe", "up onto the deck and its token"), each a { until(W, t), btn(W, t) } move in the shape of GAME.moves
// (src/game/20-tape.js), built from the engine's own planner: GAME.moves and GAME.goals, with o.free: true on
// every planner move (docs/game-spec.md D13: the film's style rules do not bind the game's proofs), and
// the planner's eye, GAME.lookahead (a copy of the world played forward with GAME.step). A move holds closure
// state, so a program is built fresh for every run: kit(GAME) is called once per run.
//
//   k.hop(name, test)            planJump: a jump that lands where test holds, unhurt
//   k.runHop / k.runHops         planRunJump from one or several takeoff points
//   k.advance(name, done)        press on to the right past whatever comes (run, the shortest safe jump,
//                                a short search, stand or back off), until done(W)
//   k.search(name, goal, x)      a beam search over a player's gestures (stand, walk, run, jump, run-ups)
//                                for a line that reaches goal unhurt; plays it, or the first gesture of the
//                                best line so far and looks again
//   k.dodge(name, done)          stand, step aside or hop clear, whichever stays unhurt
//   k.goto, k.wait, k.hold, k.mode, k.skipIf, k.move ...   GAME.moves' plain moves
// Every move carries a label for the runner's failure report (the stuck move). KIT_DEBUG=1 logs every
// search decision.
'use strict';

module.exports = function kit(GAME) {
  const M = GAME.moves, g = GAME.goals;
  const BT = GAME.BUTTONS;
  const { A, B, START, DOWN, LEFT, RIGHT, UP } = BT;
  const R = RIGHT, RB = RIGHT | B, L = LEFT, LB = LEFT | B;
  const rowTop = GAME.rowTop;
  const free = (o) => Object.assign({}, o, { free: true });
  const label = (name, m) => {
    m.label = name;
    return m;
  };
  const NS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];

  // a goal that also fails the moment he is hurt or leaves play (a plan that costs a hit is no plan)
  const safe = (goal) => (c, ev, k) => {
    for (const e of ev) if (e.type === 'hurt' || e.type === 'die') return false;
    return goal(c, ev, k);
  };
  // his left edge in [x0, x1] (world px, the player's x) and, if given, his feet at y
  const on = (x0, x1, y) => (c) => c.p.x >= x0 && c.p.x <= x1 && (y == null || c.p.y === y);
  // standing on columns c0..c1 at row r (his feet probes over them)
  const onCols = (c0, c1, r) => (c) => {
    const hw = c.p.big ? 10 : 5;
    const lx = c.p.x + 9 - hw, rx = c.p.x + 6 + hw;
    return c.p.y === rowTop(r) && rx >= c0 * 16 && lx <= c1 * 16 + 15;
  };
  // his feet on the lift i (index into lv.lifts)
  const onLift = (i) => (c) => c.p.ride === i;
  const any = (...ts) => (c) => ts.some((t) => t(c));
  const all = (...ts) => (c) => ts.every((t) => t(c));
  // lands where test holds, unhurt; then stays unhurt for `after` more frames holding the plan's last buttons
  const landsSafe = (test, after = 0) => {
    const land = g.lands(test);
    return safe((c, ev, k) => {
      if (c.__landK === undefined) {
        const r = land(c, ev, k);
        if (r !== true) return r;
        if (!after) return true;
        c.__landK = k;
        return null;
      }
      if (c.p.st !== 'play') return false;
      return k - c.__landK >= after ? true : null;
    });
  };
  // test holds on his feet at some point (not only at the first landing), unhurt, and stays unhurt for
  // `after` more frames
  const reaches = (test, after = 0) =>
    safe((c, ev, k) => {
      if (c.p.st !== 'play' || c.p.y > 176) return false;
      if (c.__hitK === undefined) {
        if (c.p.ground && test(c)) c.__hitK = k;
        else return null;
      }
      return k - c.__hitK >= after ? true : null;
    });
  // the event happens (tested) before he lands, then he lands where test holds; all unhurt
  const eventThenLands = (type, etest, test) => safe(g.then(g.onEvent(type, etest), g.lands(test || (() => true))));

  const K = {
    GAME, M, g, BT, A, B, START, DOWN, LEFT, RIGHT, UP, R, RB, L, LB, rowTop, NS,
    safe, on, onCols, onLift, any, all, landsSafe, reaches, eventThenLands, label, free,
    /** plan a jump holding b (default RB) that lands where test holds, unhurt (x: ns, horizon, wait, after, mids, late, stay) */
    hop(name, test, x = {}) {
      const goal = x.goal || landsSafe(test, x.stay || 0);
      return label(name, M.planJump(x.b != null ? x.b : RB, x.ns || NS, goal, free({ horizon: x.horizon || 120, wait: x.wait, after: x.after, mids: x.mids, late: x.late })));
    },
    /** plan a run-up to xJump then a jump (planRunJump) landing where test holds */
    runHop(name, xJump, test, x = {}) {
      const goal = x.goal || landsSafe(test, x.stay || 0);
      return label(name, M.planRunJump(x.b != null ? x.b : RB, xJump, x.ns || NS, goal, free({ horizon: x.horizon || 120, wait: x.wait })));
    },
    /** plan a jump that stomps an enemy (combo >= n), then lands anywhere safe (or where test holds) */
    stomp(name, x = {}) {
      const goal = safe(g.then(g.stomps(x.n || 1), g.lands(x.test || (() => true))));
      return label(name, M.planJump(x.b != null ? x.b : RB, x.ns || NS, goal, free({ horizon: x.horizon || 120, wait: x.wait, after: x.after, mids: x.mids })));
    },
    /** plan a jump whose way up (or down) raises event type (tested), then lands unhurt where test holds */
    bump(name, type, etest, test, x = {}) {
      return label(name, M.planJump(x.b != null ? x.b : RB, x.ns || NS, eventThenLands(type, etest, test), free({ horizon: x.horizon || 120, wait: x.wait, after: x.after, mids: x.mids })));
    },
    /** wait (holding x.wait) until holding b reaches the goal unhurt, then hold b until it does (planGo) */
    go(name, b, goal, x = {}) {
      return label(name, M.planGo(b, safe(goal), free({ horizon: x.horizon || 120, wait: x.wait })));
    },
    /** hold b until his x reaches x (moving right) */
    run: (x, b = RB) => label(`run to x ${x}`, M.to(x, b)),
    walk: (x) => label(`walk to x ${x}`, M.to(x, R)),
    /** hold b until his x falls to x (moving left) */
    back: (x, b = L) => label(`back to x ${x}`, M.back(x, b)),
    /** brake and stand still at x */
    goto: (x, run = false) => label(`stand at x ${x}`, M.goto(x, run)),
    /** hold b until pred(W) */
    wait: (name, pred, b = 0) => label(name, M.until(pred, b)),
    /** hold b for n frames */
    hold: (b, n) => label(`hold ${b} for ${n}`, M.hold(b, n)),
    /** hold b until he stands on something */
    land: (b = RB) => label('land', M.land(b)),
    brake: () => label('brake', M.brake()),
    mode: (m) => label(`mode ${m}`, M.mode(m)),
    state: (st, b = 0) => label(`state ${st}`, M.state(st, b)),
    skipIf: (pred, m) => label(m.label || 'skipIf', M.skipIf(pred, m)),
    /** a plain function move: until(W, t) -> done, btn(W, t) -> buttons */
    move: (name, until, btn) => label(name, { until, btn: typeof btn === 'function' ? btn : () => btn }),
    advance,
    dodge,
    search,
    runHops,
  };

  // runHops(name, xs, goal, x): planRunJump over several takeoff points: each frame (while waiting, holding
  // x.wait, default 0), for each xJump in xs and each A-hold n in x.ns, "hold b until x >= xJump, then b|A
  // for n frames, then x.after" is looked at with the planner's eye; the first that reaches goal (k counted
  // from the jump) is played through to its landing. x.b: the run buttons (default RB).
  function runHops(name, xs, goal, x = {}) {
    const b = x.b != null ? x.b : RB;
    const after = x.after != null ? x.after : b;
    const ns = x.ns || NS;
    const horizon = x.horizon || 150;
    let plan = null, i = 0;
    return label(name, {
      until: (W) => !!plan && i >= plan.length && (W.p.ground || W.p.st !== 'play'),
      btn(W) {
        if (plan) return plan[Math.min(i++, plan.length - 1)];
        if (W.p.ground && W.p.st === 'play' && !(W.prev & A)) {
          for (const xj of xs) {
            const c = GAME.cloneWorld(W);
            const pre = [];
            while (c.p.x < xj && pre.length < 150 && c.p.st === 'play') {
              pre.push(b);
              GAME.step(c, b);
            }
            if (pre.length >= 150 || c.p.st !== 'play') continue;
            for (const n of ns) {
              const seq = pre.slice();
              for (let q = 0; q < n; q++) seq.push(b | A);
              seq.push(after);
              if (GAME.lookahead(W, seq, horizon + pre.length, (cc, ev, k) => goal(cc, ev, k - pre.length), O)) {
                plan = seq;
                i = 1;
                return seq[0];
              }
            }
          }
        }
        return x.wait || 0;
      },
    });
  }

  // search(name, goal, x): a short beam search over a player's gestures (stand, walk, run, jump with any
  // hold, left or right) for a sequence that reaches goal(copy, events) unhurt and stays unhurt for x.after
  // frames holding x.hold (default 0); then plays it. Each gesture is played on a copy of the world with
  // the engine's own step (the planner's eye). x.depth gestures deep (default 6), x.width kept per depth
  // (default 24), ranked by x.score(copy) (default: how far right). While no sequence is found he dodges
  // (the dodging rules below, x.keep) and searches again x.every frames later. x.gestures replaces the set;
  // x.runUps adds run-ups (back off, turn, run, leap).
  function gestures(o = {}) {
    const out = [];
    for (const n of o.stand || [4, 10, 20, 40]) out.push({ btns: Array(n).fill(0) });
    for (const d of o.dirs || [R, L, RB, LB]) for (const n of o.walk || [4, 10, 20, 40]) out.push({ btns: Array(n).fill(d) });
    for (const d of o.jumpDirs || [0, R, L, RB, LB]) for (const n of o.jump || [2, 5, 9, 14, 20, 28]) out.push({ btns: Array(n).fill(d | A), land: d });
    // a run-up: back off, turn, run and leap (for the jumps that need speed)
    if (o.runUps) {
      for (const d of [RB, LB]) {
        const away = d === RB ? L : R;
        for (const m of [10, 20, 30]) for (const r of [6, 14, 24]) for (const n of [12, 20, 28]) out.push({ btns: Array(m).fill(away).concat(Array(r).fill(d), Array(n).fill(d | A)), land: d });
      }
    }
    return out;
  }
  // the beam search itself: the first gesture sequence from W that reaches goal unhurt and survives
  // `after` frames of `hold`, or null
  function beamSearch(W, goal, x = {}) {
    const G = x.gestures || gestures(x);
    const depth = x.depth || 6, width = x.width || 24, after = x.after != null ? x.after : 20, hold = x.hold || 0;
    const score = x.score || ((c) => c.p.x);
    const lost = (c, ev) => hazardOf(ev) || c.p.st === 'dead' || (c.p.st === 'play' && c.p.y > 176) || (x.avoid && x.avoid(c));
    const survives = (c) => {
      const q = GAME.cloneWorld(c);
      for (let k = 0; k < after; k++) if (lost(q, GAME.step(q, hold))) return false;
      return true;
    };
    const steady = (c) => {
      if (!c.p.ground) return true; // (only a pipe or the pole leaves him off his feet here)
      const q = GAME.cloneWorld(c);
      for (let k = 0; k < 8; k++) if (lost(q, GAME.step(q, 0))) return false;
      return q.p.ground || q.p.st !== 'play';
    };
    let frontier = [{ c: GAME.cloneWorld(W), seq: [], cut: 0 }];
    let budget = x.budget || 600000;
    let bestPartial = null;
    for (let d = 0; d < depth && frontier.length && budget > 0; d++) {
      const next = [];
      for (const node of frontier) {
        for (const gst of G) {
          if (gst.btns[0] & A && (node.c.prev & A || !node.c.p.ground)) continue;
          const c = GAME.cloneWorld(node.c);
          const seq = node.seq.slice();
          let dead = false, hit = false;
          const n = gst.btns.length;
          for (let j = 0; j < n + 120; j++) {
            let b;
            if (j < n) b = gst.btns[j];
            else if (!c.p.ground && c.p.st === 'play') b = gst.land != null ? gst.land : 0; // walked off an edge: the fall plays out
            else break;
            seq.push(b);
            budget--;
            const ev = GAME.step(c, b);
            if (lost(c, ev)) {
              dead = true;
              break;
            }
            if (goal(c, ev)) {
              hit = true;
              break;
            }
          }
          if (dead) continue;
          if (hit) {
            if (survives(c)) return seq;
            continue;
          }
          // a line may only rest where he can stand still a moment (not sliding off an edge, not in harm's way)
          if (!steady(c)) continue;
          next.push({ c, seq, s: score(c), cut: node.cut || seq.length });
        }
      }
      next.sort((a, b) => b.s - a.s);
      // the best line that ends on his feet (a line that ends in mid-air may be falling to its death)
      for (const q of next) {
        if (!q.c.p.ground || q.c.p.st !== 'play') continue;
        if (!bestPartial || q.s > bestPartial.s) bestPartial = q;
        break;
      }
      const seen = new Set();
      frontier = [];
      for (const q of next) {
        const key = Math.round(q.c.p.x / 3) + ':' + Math.round(q.c.p.y) + ':' + q.c.p.ride + ':' + (q.c.p.ground ? 1 : 0) + ':' + (q.seq.length >> 3);
        if (seen.has(key)) continue;
        seen.add(key);
        frontier.push(q);
        if (frontier.length >= width) break;
      }
    }
    // not reached: with x.partial, the first gesture of the best line found (he acts, then looks again)
    if (x.partial && bestPartial && bestPartial.cut) return { partial: true, seq: bestPartial.seq.slice(0, bestPartial.cut) };
    return null;
  }
  function search(name, goal, x = {}) {
    const beam = (W) => beamSearch(W, goal, Object.assign({ partial: true }, x));
    let plan = null, i = 0, waitT = 0, hop = null, hi = 0;
    // between searches he dodges: a step is re-planned every frame, a hop played to its landing
    const wait = (W) => {
      if (hop) {
        if (hi < hop.length || (!W.p.ground && W.p.st === 'play')) return hop[Math.min(hi++, hop.length - 1)];
        hop = null;
      }
      const d = dodgeSeq(W, x.look || 60, x.keep, x.only);
      if (d[0] & A) {
        hop = d;
        hi = 1;
      }
      return d[0];
    };
    return label(name, {
      until: () => !!plan && i >= plan.length,
      btn(W) {
        if (plan) return plan[Math.min(i++, plan.length - 1)];
        if (hop) {
          // a partial line's gesture, or a dodge's hop, still playing
          if (hi < hop.length || (!W.p.ground && W.p.st === 'play')) return hop[Math.min(hi++, hop.length - 1)];
          hop = null;
        }
        if (waitT > 0) {
          waitT--;
          return wait(W);
        }
        const s = beam(W);
        if (process.env.KIT_DEBUG) console.log(`      [search ${name}] f ${W.f} x ${W.p.x.toFixed(1)} -> ${s ? (s.partial ? 'partial ' + s.seq.length + ' [' + s.seq.slice(0, 6) + ']' : 'plan ' + s.length + ' [' + s.slice(0, 6) + ']') : 'none'}`);
        if (s && !s.partial) {
          plan = s;
          i = 1;
          return s[0];
        }
        if (s && s.partial) {
          // the best line so far: play its first gesture, then search again
          hop = s.seq;
          hi = 1;
          return s.seq[0];
        }
        waitT = x.every || 10;
        return wait(W);
      },
    });
  }

  const O = free({});
  const hazardOf = (ev) => ev.some((e) => e.type === 'hurt' || e.type === 'die');
  // Dodging: from where he stands, the first of these that stays unhurt for `look` frames (and keep(copy)
  // on every frame he is on his feet: still on the lift, say): stand; step left or right 4 to 24 frames
  // and stand; wait, then step; step one way, then back; hop in place, or hop left or right, and stand.
  // Else the one that lasts longest. A step is re-planned every frame; a hop is played through to its
  // landing.
  const DODGES = (() => {
    const out = [[0]];
    for (const n of [4, 8, 12, 16, 24]) for (const d of [L, R]) out.push(Array(n).fill(d).concat([0]));
    // wait, then step (the far side of something that rises and falls, crossed while it is high)
    for (const w of [6, 12, 18, 24, 32, 40]) for (const n of [8, 16, 24, 32]) for (const d of [L, R]) out.push(Array(w).fill(0).concat(Array(n).fill(d), [0]));
    // step one way, then the other
    for (const n of [8, 16]) for (const m of [8, 16, 24, 32]) for (const d of [L, R]) out.push(Array(n).fill(d).concat(Array(m).fill(d === L ? R : L), [0]));
    for (const n of [2, 4, 8, 12, 16]) for (const d of [0, L, R]) out.push(Array(n).fill(d | A).concat([0]));
    return out;
  })();
  function dodgeSeq(W, look, keep, only) {
    let best = null, bestLife = -1;
    for (const seq of DODGES) {
      if (only && !only.includes(seq[0] & ~A)) continue;
      if (seq[0] & A && (W.prev & A || !W.p.ground)) continue;
      let life = 0;
      const ok = GAME.lookahead(W, seq, look, (c, ev, k) => {
        if (hazardOf(ev) || c.p.st === 'dead' || c.p.y > 176 || (keep && c.p.ground && !keep(c))) return false;
        life = k + 1;
        return k >= look - 1 ? true : null;
      }, O);
      if (ok) return seq;
      if (life > bestLife) (bestLife = life), (best = seq);
    }
    return best || [0];
  }
  // dodge(name, done, x): stand, step aside or hop clear (the dodging rules above; x.only limits the
  // directions, x.keep the footing, x.look the frames) until done(W)
  function dodge(name, done, x = {}) {
    let hop = null, i = 0;
    return label(name, {
      until: (W) => !hop && done(W),
      btn(W) {
        if (hop) {
          if (i < hop.length || !W.p.ground) return hop[Math.min(i++, hop.length - 1)];
          hop = null;
        }
        const seq = dodgeSeq(W, x.look || 60, x.keep, x.only);
        if (seq[0] & A) {
          hop = seq;
          i = 1;
        }
        return seq[0];
      },
    });
  }
  // advance(name, done, x): press on to the right past whatever comes, the way a player reads the next
  // second of play. On the ground: keep running while running stays unhurt and gets on for x.look frames;
  // otherwise the shortest jump (A held n frames, x.ns) that lands unhurt further on and stays unhurt for
  // x.after frames; otherwise whatever (running, standing, backing off, any jump) stays unhurt longest.
  // In the air (a stomp's bounce, a walk off a ledge): the steering that lands unhurt. Every look is the
  // planner's own (GAME.lookahead with o.free). done(W) is tested whenever no plan is running. x.b: the
  // running buttons (default RB); x.jb: the buttons while jumping (default x.b); x.gain: how much further
  // on a jump must land (px, default 4); x.avoid(copy): a place or state the plan must never reach.
  function advance(name, done, x = {}) {
    const b = x.b != null ? x.b : RB;
    const jb = x.jb != null ? x.jb : b;
    const look = x.look || 40;
    const after = x.after != null ? x.after : 12;
    const gain = x.gain != null ? x.gain : 4;
    const ns = x.ns || NS;
    const O = free({});
    const END = { flagpole: 1, axe: 1, pipe: 1 };
    const hazard = (ev) => ev.some((e) => e.type === 'hurt' || e.type === 'die');
    const ended = (ev) => ev.some((e) => END[e.type]);
    const lost = (c, ev) => hazard(ev) || c.p.st === 'dead' || (c.p.st === 'play' && c.p.y > 176) || (x.avoid && x.avoid(c));
    // play seq (its last buttons held on) and judge each frame; life: the frames it stayed unhurt
    function tryOut(W, seq, horizon, judge) {
      let life = 0;
      const ok = GAME.lookahead(W, seq, horizon, (c, ev, k) => {
        const r = judge(c, ev, k);
        if (r !== false) life = k + 1;
        return r;
      }, O);
      return { ok, life, seq };
    }
    // unhurt for n frames and then on his feet (a run that ends in mid-air is judged when he lands);
    // with x0: at least n / 4 px further right, so a wall ahead makes him jump rather than push
    const holds = (n, x0) => (c, ev, k) => {
      if (lost(c, ev)) return false;
      if (ended(ev)) return true;
      if (k < n - 1 || !c.p.ground) return null;
      return x0 == null || c.p.x >= x0 + n / 4;
    };
    // lands (at least minX), then stays unhurt for `after` frames
    const landsOn = (minX) => {
      let landK = -1;
      return (c, ev, k) => {
        if (lost(c, ev)) return false;
        if (ended(ev)) return true;
        if (landK < 0) {
          if (k > 2 && c.p.ground) {
            if (minX != null && c.p.x < minX) return false;
            landK = k;
          }
          return null;
        }
        return k - landK >= after ? true : null;
      };
    };
    const jumpSeq = (n, bb) => {
      const s = [];
      for (let q = 0; q < n; q++) s.push(bb | A);
      s.push(bb);
      return s;
    };
    let seq = null, i = 0, air = false, cool = 0;
    const running = (W) => {
      if (!seq) return false;
      if (i < seq.length) return true;
      if (air && !W.p.ground && W.p.st === 'play') return true;
      seq = null;
      return false;
    };
    const commit = (s, isAir) => {
      seq = s;
      i = 1;
      air = isAir;
      return s[0];
    };
    return label(name, {
      until: (W) => !running(W) && done(W),
      btn(W) {
        if (running(W)) return i < seq.length ? seq[i++] : seq[seq.length - 1];
        const p = W.p;
        if (p.st !== 'play') return 0;
        if (!p.ground) {
          // steer the rest of this flight onto something safe
          const opts = [b, R, 0, L, LB, RB];
          let best = null;
          for (const hb of opts) {
            const r = tryOut(W, [hb], 150, landsOn(null));
            if (r.ok) return commit([hb], true);
            if (!best || r.life > best.life) best = r;
          }
          return commit(best.seq, false);
        }
        // 1. run on
        const x0 = p.x;
        const run = tryOut(W, [b], look + 90, holds(look, x0));
        if (run.ok) return commit([b, b, b, b], false);
        // 2. the shortest jump that lands further on
        if (W.prev & A) return 0; // let go of A first
        const cands = [run];
        for (const n of ns) {
          const r = tryOut(W, jumpSeq(n, jb), 150, landsOn(x0 + gain));
          if (r.ok) return commit(r.seq, true);
          cands.push(r);
        }
        // 3. a short search for any way on (stand, step, jump: gestures), then stand still or back off
        if (cool > 0) cool--;
        else {
          const found = beamSearch(W, (c) => c.p.ground && c.p.st === 'play' && c.p.x >= x0 + 24, { depth: 4, width: 12, after, avoid: x.avoid, jumpDirs: [0, R, RB, L], jump: [3, 8, 14, 22], stand: [4, 12, 24], walk: [4, 10, 20], dirs: [R, L, RB] });
          if (found) return commit(found, true);
          cool = 8;
        }
        for (const hb of [0, L, LB]) {
          const r = tryOut(W, [hb], look + 90, holds(look));
          if (r.ok) return commit([hb], false);
          cands.push(r);
        }
        let best = cands[0];
        for (const r of cands) if (r.life > best.life) best = r;
        return commit(best.seq.length > 1 ? best.seq : [best.seq[0]], best.seq.length > 1);
      },
    });
  }
  return K;
};
