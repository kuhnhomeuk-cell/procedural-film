#!/usr/bin/env node
// tools/levels-lint.cjs : the level rules (docs/game-spec.md 4.1, 4.2, 4.10 and 13.6). Owner: the level author.
//
//   node tools/levels-lint.cjs            every check on every level in GAME.GAME_DEFS; exits 1 on any failure
//   node tools/levels-lint.cjs --verbose  also prints every passing check (and every jump's takeoff window)
//   node tools/levels-lint.cjs --only 1-2  the jump physics for the named levels only (a quicker edit loop)
//
// The maps come from GAME.GAME_DEFS, loaded through tools/proof/harness.cjs (the game's own sources).
// The per-level data (jumps, map changes, definition changes, token and block routes) lives in
// tools/proof/levels.data.cjs, keyed by level id. A level with no entry there gets every generic rule.
//
// Static rules: 12 equal-width rows; rows 0 to 2 empty; only legal characters; F1 (no pit, a run of columns
// with nothing to stand on and no lift over it, wider than the walk-speed maximum minus 1); F3 (no standing
// surface or lift top above y 68); F4 (every lift top at least 32 px below any solid tile over its path); F6
// (no ceiling opening within 6 columns of a standing surface in row 7 or above); F7 (a horizontal lift
// travels at most 112 px); F8 (a held spring launch peaks with his feet at y >= 56, with open air above it);
// the goal house (def.castle) at most width - 5 and on solid floor; checkpoint posts on solid floor with room above; token
// bits unique per main level; pipes, poles and routing
// that resolve; GAME_ORDER matches GAME.CONFIG.order.
//
// Jumps (F1, F2): every jump listed in levels.data.cjs is checked twice:
//   1. the rule as written: the gap against the spec's envelope table (4.1): a required jump at most the
//      walk-speed maximum minus 1, an optional or finale jump at most the run-speed maximum minus 2; a
//      required climb at most 3 tiles, an optional one at most 4.
//   2. the physics: the engine itself (NES-accurate feel, enemies and hazards removed, lifts frozen as solid
//      rows where listed) jumps it at walk speed, small and big hero, under the level's real ceilings, from
//      every takeoff point from the perfect last-frame edge back to 64 px behind it (A held 1 to 40 frames,
//      the direction held, let go or reversed in the air). The widest run of takeoff points that land is
//      the jump's takeoff window: at least 16 px (one tile of forgiveness) for a required jump; an
//      optional jump needs 16 px walking or 32 px at run speed.
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./proof/harness.cjs');
const DATA = require('./proof/levels.data.cjs');

const ROOT = path.resolve(__dirname, '..');
const verbose = process.argv.includes('--verbose');
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? String(process.argv[onlyArg + 1] || '').split(',') : null; // jump physics for these levels only

// ------------------------------------------------------------------------------------------------
// the spec's rules
// ------------------------------------------------------------------------------------------------
// 4.1: max gap (tiles) by landing height change -5..+5; null: not reachable
const WALK = { '-5': 7, '-4': 7, '-3': 6, '-2': 6, '-1': 6, 0: 5, 1: 5, 2: 4, 3: 4, 4: 3, 5: null };
const RUN = { '-5': 12, '-4': 11, '-3': 10, '-2': 10, '-1': 9, 0: 8, 1: 8, 2: 7, 3: 7, 4: 6, 5: null };
const LEGAL = new Set('.#BX?M*oWGw[]{}!|hH-_jJLl=%Afgkp' + 'NCSTR+mnst');
const TOP_MIN = 68; // F3: the highest standing surface (row 5)
const LIFT_ROOM = 32; // F4
const CEIL_REACH = 6; // F6
const LIFT_TRAVEL = 112; // F7
const SPRING_RISE = 86.4, SPRING_FEET_MIN = 56; // F8 (MC3: a held launch rises 86.4 px)
const PIT_MAX = WALK[0] - 1; // F1 on the map alone: the widest flat gap a required walking jump may cross
const rowTop = (r) => r * 16 - 12;
const dataOf = (id) => DATA[id] || {};

// ------------------------------------------------------------------------------------------------
let fails = 0, warns = 0;
const failed = [];
function check(ok, what) {
  if (!ok) {
    fails++;
    failed.push(what);
    console.log(`[FAIL] ${what}`);
  } else if (verbose) console.log(`[ok]   ${what}`);
  return ok;
}
function note(what) {
  console.log(`[info] ${what}`);
}

const G = H.load();
const GAME = G.GAME;
const DEFS = GAME.GAME_DEFS || {};
const ORDER = GAME.GAME_ORDER || (GAME.CONFIG && GAME.CONFIG.order) || [];
const SOLID = GAME.SOLID;
const isSolid = (ch) => SOLID[ch.charCodeAt(0)] === 1;
// a cell that is (or becomes, once bumped) something to stand on
const standable = (ch) => isSolid(ch) || ch === '*' || ch === '+';
const mainOf = (d) => d.main || d.id;

check(Object.keys(DEFS).length > 0, 'GAME.GAME_DEFS has at least one level (src/game/01-levels.js)');
const CONF_ORDER = (GAME.CONFIG && GAME.CONFIG.order) || null;
check(Array.isArray(ORDER) && ORDER.length > 0 && ORDER.every((id) => !!DEFS[id]), `every level in the play order is in GAME_DEFS (${[].concat(ORDER).join(', ')})`);
if (CONF_ORDER) check([].concat(ORDER).join() === [].concat(CONF_ORDER).join(), `GAME_ORDER equals GAME.CONFIG.order (${[].concat(CONF_ORDER).join(', ')})`);
for (const id of Object.keys(DATA)) check(!!DEFS[id], `levels.data.cjs: '${id}' is a level in GAME_DEFS`);

// ------------------------------------------------------------------------------------------------
// listed changes: each map change is in the map, each definition change passes its test
// ------------------------------------------------------------------------------------------------
for (const id of Object.keys(DATA)) {
  const d = DEFS[id];
  if (!d) continue;
  for (const c of dataOf(id).changes || []) {
    const row = (d.rows || [])[c.row] || '';
    check(row.substr(c.col, c.to.length) === c.to, `${id}: the listed change at row ${c.row} col ${c.col} ('${c.from}' -> '${c.to}') is in the map`);
    note(`${id} row ${c.row} col ${c.col}: '${c.from}' -> '${c.to}' (${c.rule}) ${c.why}`);
  }
  for (const c of dataOf(id).defChanges || []) {
    let ok = false;
    try {
      ok = !!c.test(DEFS);
    } catch (e) {
      ok = false;
    }
    check(ok, `${id}: the listed definition change is in the defs: ${c.what}`);
    note(`${id} definition: ${c.what} (${c.rule}) ${c.why}`);
  }
}

// ------------------------------------------------------------------------------------------------
// per level
// ------------------------------------------------------------------------------------------------
const tokenBits = {}; // main -> [[id, bit, where]]
for (const id of Object.keys(DEFS)) {
  const d = DEFS[id];
  const rows = d.rows || [];
  const L = `${id}`;
  if (!check(rows.length === 12, `${L}: 12 rows (${rows.length})`)) continue;
  const w = rows[0].length;
  check(rows.every((r) => r.length === w), `${L}: every row is ${w} wide`);
  check(w >= 20, `${L}: at least one screen wide (${w})`);
  const at = (c, r) => (r < 0 || r > 11 ? '.' : c < 0 || c >= w ? '#' : rows[r][c]);
  check([0, 1, 2].every((r) => /^\.*$/.test(rows[r])), `${L}: rows 0 to 2 are empty (the HUD band)`);
  const bad = new Set();
  for (const r of rows) for (const ch of r) if (!LEGAL.has(ch)) bad.add(ch);
  check(!bad.size, `${L}: only legal characters${bad.size ? ' (found ' + [...bad].join(' ') + ')' : ''}`);
  check(typeof d.name === 'string' && d.name.length > 0, `${L}: has a name`);
  check(d.start && typeof d.start.x === 'number' && typeof d.start.y === 'number', `${L}: has a start`);

  // standing surfaces: a standable cell with no solid cell above it (row 3 cells are the ceiling: F6)
  const surfaces = [];
  for (let r = 4; r < 12; r++) for (let c = 0; c < w; c++) if (standable(at(c, r)) && !isSolid(at(c, r - 1))) surfaces.push([c, r]);
  // F3
  const high = surfaces.filter(([, r]) => rowTop(r) < TOP_MIN);
  check(!high.length, `${L}: F3 no standing surface above y ${TOP_MIN}${high.length ? ' (' + high.slice(0, 6).map(([c, r]) => `col ${c} row ${r}`).join(', ') + ')' : ''}`);
  const lifts = d.lifts || [];
  lifts.forEach((lf, i) => {
    const w3 = lf.w || 3;
    const topMin = lf.k === 'v' ? lf.y0 : lf.y;
    const topMax = lf.k === 'v' ? lf.y1 : lf.y;
    check(topMin >= TOP_MIN, `${L}: F3 lift ${i} (${lf.k} at ${lf.tx}) top at its highest y ${topMin} >= ${TOP_MIN}`);
    // F7
    if (lf.k === 'h') check(lf.x1 - lf.tx * 16 <= LIFT_TRAVEL && lf.x1 > lf.tx * 16, `${L}: F7 lift ${i} travels ${lf.x1 - lf.tx * 16} px (at most ${LIFT_TRAVEL})`);
    // F4: the swept box of the lift top and the room above it
    const x0 = lf.tx * 16, x1 = (lf.k === 'h' ? lf.x1 : lf.tx * 16) + w3 * 16 - 1;
    let worst = Infinity, hit = null;
    for (let r = 0; r < 12; r++) {
      for (let c = Math.floor(x0 / 16); c <= Math.floor(x1 / 16); c++) {
        if (!standable(at(c, r))) continue;
        const top = rowTop(r), bottom = top + 16;
        if (bottom <= topMin) {
          if (topMin - bottom < worst) (worst = topMin - bottom), (hit = [c, r]);
        } else if (top < topMax + 8) {
          worst = -1;
          hit = [c, r];
        }
      }
    }
    check(worst >= LIFT_ROOM, `${L}: F4 lift ${i} (${lf.k} at ${lf.tx}) keeps ${worst === Infinity ? 'open sky' : worst + ' px'} over its path${hit ? ` (col ${hit[0]} row ${hit[1]})` : ''}`);
  });
  // F1 on the map alone: a pit is a run of columns with nothing to stand on in any row and no lift over it
  {
    const lifted = new Set();
    for (const lf of lifts) {
      const c1 = (lf.k === 'h' ? Math.floor(lf.x1 / 16) : lf.tx) + (lf.w || 3) - 1;
      for (let c = lf.tx; c <= c1; c++) lifted.add(c);
    }
    const open = (c) => !lifted.has(c) && ![...Array(9).keys()].some((k) => standable(at(c, k + 3)));
    const pits = [];
    for (let c = 0; c < w; ) {
      if (!open(c)) {
        c++;
        continue;
      }
      let e = c;
      while (e + 1 < w && open(e + 1)) e++;
      if (e - c + 1 > PIT_MAX) pits.push(`cols ${c}-${e} (${e - c + 1} wide)`);
      c = e + 1;
    }
    check(!pits.length, `${L}: F1 no pit wider than ${PIT_MAX} columns without a lift over it${pits.length ? ' (' + pits.join(', ') + ')' : ''}`);
  }
  // F6
  const ceiling = [...Array(w).keys()].some((c) => isSolid(at(c, 3)));
  if (ceiling) {
    const liftTops = lifts.map((lf) => ({ c0: lf.tx, c1: (lf.k === 'h' ? Math.floor(lf.x1 / 16) : lf.tx) + (lf.w || 3) - 1, top: lf.k === 'v' ? lf.y0 : lf.y }));
    const openings = [...Array(w).keys()].filter((c) => !isSolid(at(c, 3)));
    const near = [];
    for (const c of openings) {
      for (const [sc, sr] of surfaces) if (sr <= 7 && Math.abs(sc - c) <= CEIL_REACH) near.push(`opening col ${c} near surface col ${sc} row ${sr}`);
      for (const t of liftTops) if (t.top <= rowTop(7) && c >= t.c0 - CEIL_REACH && c <= t.c1 + CEIL_REACH) near.push(`opening col ${c} near a lift at y ${t.top}`);
    }
    check(!near.length, `${L}: F6 no ceiling opening within ${CEIL_REACH} columns of a surface in row 7 or above${near.length ? ' (' + near.slice(0, 4).join('; ') + ')' : ''}`);
  }
  // F8 and the spring's open air
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < w; c++) {
      if (at(c, r) !== 'S') continue;
      const apex = rowTop(r) - SPRING_RISE;
      check(apex >= SPRING_FEET_MIN, `${L}: F8 the spring at col ${c} row ${r} peaks with his feet at y ${apex.toFixed(1)} (>= ${SPRING_FEET_MIN})`);
      const topRow = Math.max(3, Math.floor((apex - 24 + 12) / 16));
      let clear = true;
      for (let rr = topRow; rr < r; rr++) if (isSolid(at(c, rr))) clear = false;
      check(clear, `${L}: the spring at col ${c} has open air up to its apex (rows ${topRow}..${r - 1})`);
      check(isSolid(at(c, r + 1)) || r === 11, `${L}: the spring at col ${c} stands on something`);
    }
  }
  // the goal house (def.castle is its column)
  if (d.castle != null) {
    check(d.castle <= w - 5, `${L}: the goal house at col ${d.castle} is at most width - 5 (${w - 5})`);
    let floor = true;
    for (let c = d.castle; c < d.castle + 5; c++) if (!isSolid(at(c, 10))) floor = false;
    check(floor, `${L}: the goal house stands on solid floor`);
  }
  // the pole
  if (d.pole != null) {
    let ball = -1;
    for (let r = 0; r < 12; r++) if (at(d.pole, r) === '!') ball = r;
    check(ball >= 3, `${L}: the pole at col ${d.pole} has its ball`);
    let mast = ball >= 0;
    for (let r = ball + 1; r < 9 && mast; r++) if (at(d.pole, r) !== '|') mast = false;
    check(mast && isSolid(at(d.pole, 9)), `${L}: the pole's mast runs to a block at row 9`);
  }
  // the checkpoint
  if (d.mid) {
    const m = d.mid;
    check(mainOf(d) === d.id, `${L}: the checkpoint is in a main level`);
    check(isSolid(at(m.tx, m.row)), `${L}: the checkpoint post at col ${m.tx} stands on solid floor (row ${m.row})`);
    check(!isSolid(at(m.tx, m.row - 1)) && !isSolid(at(m.tx, m.row - 2)), `${L}: the checkpoint post has room (rows ${m.row - 2}, ${m.row - 1})`);
  }
  // pipes
  const rim = (tx) => [...Array(12).keys()].some((r) => at(tx, r) === '[' && at(tx + 1, r) === ']');
  if (d.pipeDown) check(rim(d.pipeDown.tx), `${L}: the down pipe at col ${d.pipeDown.tx} has a rim`);
  if (d.pipeUp) check(rim(d.pipeUp.tx), `${L}: the up pipe at col ${d.pipeUp.tx} has a rim`);
  if (d.pipeSide) check(at(d.pipeSide.tx, d.pipeSide.row) === 'h' && at(d.pipeSide.tx, d.pipeSide.row + 1) === 'H', `${L}: the side pipe's mouth is at col ${d.pipeSide.tx}, rows ${d.pipeSide.row}-${d.pipeSide.row + 1}`);
  // routing
  for (const [k, v] of [['next', d.next], ['main', d.main], ['respawn', d.respawn], ['pipeDown.to', d.pipeDown && d.pipeDown.to], ['pipeSide.to', d.pipeSide && d.pipeSide.to]]) {
    if (v !== undefined) check(typeof v === 'string' && !!DEFS[v], `${L}: ${k} '${v}' is a level in GAME_DEFS`);
  }
  if (d.pipeSide && d.pipeSide.at === 'pipeUp' && DEFS[d.pipeSide.to]) check(!!DEFS[d.pipeSide.to].pipeUp, `${L}: the side pipe rises from ${d.pipeSide.to}'s pipeUp`);
  // tokens
  const spots = [];
  for (let r = 0; r < 12; r++) for (let c = 0; c < w; c++) if (at(c, r) === 't') spots.push([c, r]);
  spots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const base = d.tokenBase | 0;
  const list = spots.map(([c, r], i) => [c, r, base + i]).concat((d.tokens || []).map((t) => [t[0], t[1], t[2] | 0]));
  for (const [c, r, bit] of list) {
    (tokenBits[mainOf(d)] || (tokenBits[mainOf(d)] = [])).push([id, bit, `(${c}, ${r})`]);
    check(!isSolid(at(c, r)) && rowTop(r) >= 36, `${L}: the token at (${c}, ${r}) sits in open air below the HUD band`);
  }
}
// F5: every token and every N + C block has a listed route in levels.data.cjs, and the program that proves
// it has saved tapes in both feel modes (tools/proof/levels.cjs replays them)
{
  const tapes = path.join(ROOT, 'tools', 'proof', 'tapes');
  const proven = (prog) => ['nes', 'modern'].every((f) => fs.existsSync(path.join(tapes, `${prog}.${f}.json`)));
  for (const main of Object.keys(tokenBits)) {
    for (const [, bit, where] of tokenBits[main]) {
      const r = ((dataOf(main).routes || {}).token || {})[bit];
      check(!!r, `${main}: F5 token bit ${bit} ${where} has a listed route (levels.data.cjs)`);
      if (r) check(proven(r[1]), `${main}: F5 token bit ${bit}: '${r[0]}' is proven by the saved '${r[1]}' tapes`);
    }
  }
  for (const id of Object.keys(DEFS)) {
    const rows = DEFS[id].rows || [];
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (!'N+C'.includes(rows[r][c])) continue;
        const rt = ((dataOf(id).routes || {}).block || {})[`${c}:${r}`];
        check(!!rt, `${id}: F5 the ${rows[r][c]} block at (${c}, ${r}) has a listed route (levels.data.cjs)`);
        if (rt) check(proven(rt[1]), `${id}: F5 ${rt[0]} is proven by the saved '${rt[1]}' tapes`);
      }
    }
  }
}
// tokens: bits 0..n-1 each once per main level; the total within GAME.tokensMax()
{
  let total = 0;
  for (const main of Object.keys(tokenBits)) {
    const bits = tokenBits[main].map((t) => t[1]).sort((a, b) => a - b);
    total += bits.length;
    check(bits.every((b, i) => b === i), `${main}: token bits 0..${bits.length - 1} each exactly once (${tokenBits[main].map((t) => t[0] + ':' + t[1] + t[2]).join(' ')})`);
  }
  if (typeof GAME.tokensMax === 'function') {
    const max = GAME.tokensMax();
    check(total <= max, `${total} tokens in all, within GAME.tokensMax() ${max}`);
  }
}

// ------------------------------------------------------------------------------------------------
// jumps: the table (the rule as written) and the physics (the engine, with the real ceilings)
// ------------------------------------------------------------------------------------------------
const { A, B, LEFT, RIGHT } = GAME.BUTTONS;
const PH = GAME.PH;

// a live NES-feel world standing in level id with the hazards gone, lifts frozen as solid rows where the
// jump lists them, and the takeoff surface extended `ext` tiles back (air cells only) for the slack test
function jumpWorld(id, jmp, big, ext) {
  const W = G.startAt(id, { feel: 'nes', form: big ? 'big' : 'small' });
  const lv = W.lv;
  lv.ents = [];
  if (lv.lifts) lv.lifts = [];
  if (lv.springs) lv.springs = [];
  if (lv.tokens) lv.tokens = [];
  lv.camCap = null;
  const put = (c, r) => {
    if (c >= 0 && c < lv.w && lv.grid[r * lv.w + c] === 46) lv.grid[r * lv.w + c] = 35; // '.' -> '#'
  };
  for (const end of [jmp.from, jmp.to]) if (end[3] === 'lift') for (let c = end[0]; c <= end[1]; c++) put(c, end[2]);
  const dir = jmp.to[0] > jmp.from[1] ? 1 : -1;
  for (let k = 1; k <= ext; k++) put(dir > 0 ? jmp.from[0] - k : jmp.from[1] + k, jmp.from[2]);
  return W;
}
// does a jump at the given speed land on `to` from the takeoff edge moved `back` px behind the perfect one?
const NS = Array.from({ length: 40 }, (_, i) => i + 1);
const MS = [[999, false]];
for (const m of [48, 36, 28, 22, 16, 12, 8, 4]) MS.push([m, false], [m, true]);
const W0S = new Map();
function lands(id, jmp, big, run, back) {
  const key = id + '|' + jmp.name + '|' + big;
  if (!W0S.has(key)) W0S.set(key, jumpWorld(id, jmp, big, 4));
  const W0 = W0S.get(key);
  const dir = jmp.to[0] > jmp.from[1] ? 1 : -1;
  const hw = big ? 10 : 5;
  // perfect last frame: the trailing foot probe on the takeoff's last pixel, the body clear of any wall
  // ahead (a climb with no gap starts with his body against the step, not inside it)
  let edgeX = dir > 0 ? (jmp.from[1] + 1) * 16 - 1 - (9 - hw) : jmp.from[0] * 16 - (6 + hw);
  const y0 = rowTop(jmp.from[2]);
  const bodyHits = (x) => {
    const L = x + 8 - hw, R = x + 7 + hw, h = big ? 22 : 16;
    for (let xx = L; ; xx = Math.min(R, xx + 8)) {
      for (let yy = y0 - 1; yy > y0 - h; yy -= 4) if (GAME.K.solidAt(W0.lv, xx, yy)) return true;
      if (GAME.K.solidAt(W0.lv, xx, y0 - h + 1)) return true;
      if (xx === R) return false;
    }
  };
  while (bodyHits(edgeX)) edgeX -= dir;
  const x = edgeX - dir * back;
  const top = rowTop(jmp.to[2]);
  const D = dir > 0 ? RIGHT : LEFT;
  const bb = D | (run ? B : 0);
  for (const n of NS) {
    // m: the frame he lets go of the direction (rev: or pushes the other way), so a short target is not overshot
    for (const [m, rev] of MS) {
      const W = G.clone(W0);
      const p = W.p;
      p.x = x;
      p.y = rowTop(jmp.from[2]);
      p.vx = dir * (run ? PH.maxRun : PH.maxWalk);
      p.ground = true;
      p.face = dir;
      W.cam = Math.max(0, Math.min(W.lv.maxCam, Math.floor(x + 8 - 160)));
      let ok = false;
      for (let k = 0; k < 240; k++) {
        const b = (k < m ? bb : rev ? (dir > 0 ? LEFT : RIGHT) : 0) | (k < n ? A : 0);
        G.step(W, b);
        if (W.p.st !== 'play' || W.p.y > 200) break;
        if (k > 1 && W.p.ground) {
          const lx = W.p.x + 9 - hw, rx = W.p.x + 6 + hw;
          ok = W.p.y === top && rx >= jmp.to[0] * 16 && lx <= jmp.to[1] * 16 + 15;
          break;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}
// the takeoff window: the widest run of takeoff points (every 2 px, up to 64 px behind the perfect edge)
// from which the jump lands
// (the scan stops once the window reaches WINDOW_CAP px: enough for every rule)
const WINDOW_CAP = 40;
function slack(id, jmp, big, run) {
  let best = -1, from = -1;
  for (let back = 0; back <= 64; back += 2) {
    if (lands(id, jmp, big, run, back)) {
      if (from < 0) from = back;
      best = Math.max(best, back - from);
      if (best >= WINDOW_CAP) break;
    } else if (from >= 0) break; // the window closed (they do not reopen further back)
    else from = -1;
  }
  return best;
}
for (const id of Object.keys(DATA)) {
  if (ONLY && !ONLY.includes(id)) continue;
  if (!DEFS[id]) continue;
  for (const jmp of dataOf(id).jumps || []) {
    const dir = jmp.to[0] > jmp.from[1] ? 1 : -1;
    const gap = dir > 0 ? jmp.to[0] - jmp.from[1] - 1 : jmp.from[0] - jmp.to[1] - 1;
    const dh = jmp.from[2] - jmp.to[2];
    const req = jmp.kind === 'req';
    const table = req ? WALK : RUN;
    const max = table[String(Math.max(-5, Math.min(5, dh)))];
    const lim = max == null ? -1 : max - (req ? 1 : 2);
    const tag = `${id}: ${jmp.name} (gap ${gap}, ${dh >= 0 ? '+' : ''}${dh}, ${req ? 'required' : 'optional'})`;
    check(gap <= lim, `${tag}: F1 gap ${gap} <= ${req ? 'walk' : 'run'} max ${max} - ${req ? 1 : 2}`);
    if (dh > 0) check(dh <= (req ? 3 : 4), `${tag}: F2 climb ${dh} <= ${req ? 3 : 4}`);
    for (const big of [false, true]) {
      if (jmp.small && big) continue;
      if (jmp.big && !big) continue;
      const who = big ? 'big' : 'small';
      const sw = slack(id, jmp, big, false);
      if (req) {
        check(sw >= 16, `${tag}: physics, ${who} at walk speed has a ${sw < 0 ? 'no' : sw + ' px'} takeoff window (>= 16)`);
      } else {
        // optional: a 16 px window at walk speed, or a 32 px one at run speed
        const sr = sw >= 16 ? -2 : slack(id, jmp, big, true);
        check(sw >= 16 || sr >= 32, `${tag}: physics, ${who} has a takeoff window of ${sw < 0 ? 'none' : sw + ' px'} walking${sr === -2 ? '' : ', ' + (sr < 0 ? 'none' : sr + ' px') + ' running'} (>= 16 walking or 32 running)`);
      }
    }
  }
}

console.log(`${fails ? 'FAIL' : 'PASS'} levels-lint: ${Object.keys(DEFS).length} levels, ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
