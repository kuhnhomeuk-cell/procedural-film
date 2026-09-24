// tools/proof/harness.cjs : the shared Node loader every proof uses (docs/game-spec.md 14). Owner: P1.
//
//   const H = require('./harness.cjs');
//   const G = H.load({ defs });            // a fresh vm with the assembled project's sources (the order below)
//   G.GAME, G.FILM, G.game                   // the engine's namespace, the FILM object, FILM.game
//   G.world(opts)                          // GAME.newWorld(opts) (every world is live)
//   G.startAt(id, opts)                    // a live world in play at level `id` (one START press, then wait)
//   G.run(W, input, frames, o)             // step `frames` times; returns every event
//   G.step(W, b), G.snapshot(W), G.clone(W)
//   G.stateHash(W), G.snapHash(states), G.frameStr(s), G.fingerprint(S | events, score)
//   G.encode(tape), G.decode(rle, length)
//
// load(o):
//   o.defs     fixture level defs merged into GAME.GAME_DEFS (a plain object keyed by id, or a function
//              (GAME) -> object, evaluated after the sources load, so a fixture can reuse a level's rows)
//   o.exclude  file names or RegExps under src/game to skip (o.bare: true skips the 1x modules, 11-19)
//   o.files    extra source files (absolute paths) run after src/game
//
// The harness runs inside an assembled project (the foundation, retro and game overlays copied together):
// ROOT is the project root two folders up from tools/proof. Sources load in the page's order: the
// foundation (src/core.js, src/lib.js), the retro kit (src/pixel.js, src/sprites.js, src/chip.js),
// src/manifest.js, src/timeline.js, every src/game/*.js sorted, then src/music.js. A file that is absent
// is skipped, except src/manifest.js and src/game/*.js.
//
// The module-level world/startAt/run/... use the most recently loaded context (a plain load() on first use).
// input for run(): a number (held every frame), an array or typed array (one entry per frame, 0 past its end)
// or a function (W, i) -> buttons. o.until(W, ev, i) stops the run early (after that frame);
// o.onFrame(W, ev, i) sees every frame.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const GAME = path.join(SRC, 'game');

// ------------------------------------------------------------------------------------------------
// pure helpers (no context needed)
// ------------------------------------------------------------------------------------------------
function fnv(h, s) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

// FILM.game's run-length tape: "bb:n" pairs (buttons in hex, count in base 36), comma separated
function encode(tape) {
  const out = [];
  for (let i = 0; i < tape.length; ) {
    let j = i;
    while (j < tape.length && tape[j] === tape[i]) j++;
    out.push((tape[i] & 255).toString(16).padStart(2, '0') + ':' + (j - i).toString(36));
    i = j;
  }
  return out.join(',');
}
// length omitted: the tape's own length (sum of the runs)
function decode(rle, length) {
  const runs = String(rle || '').split(',').filter((r) => r.length);
  const parsed = runs.map((r) => {
    const [b, n] = r.split(':');
    return [parseInt(b, 16), parseInt(n, 36)];
  });
  const total = parsed.reduce((a, r) => a + r[1], 0);
  const len = length == null ? total : length;
  const tape = new Uint8Array(len);
  let f = 0;
  for (const [v, n] of parsed) for (let k = n; k > 0 && f < len; k--) tape[f++] = v;
  return f === len ? tape : null;
}

// the attract fingerprint (40-api.js): every event's frame and type, then the final score
function fingerprint(S, score) {
  const events = Array.isArray(S) ? S : S.events;
  const sc = Array.isArray(S) ? score : S.score;
  let h = 0x811c9dc5 | 0;
  for (const e of events) h = fnv(h, e.f + e.type + ';');
  h = fnv(h, 'score' + sc);
  return hex(h);
}

// ------------------------------------------------------------------------------------------------
// stateHash: every field of a world except f, prev, btn, ev, levels by
// reference so a level shared by W.lv and W.areas is written once; keys sorted so a clone that adds
// fields in another order still compares equal. Draw caches (hist, histLen), the static original grid,
// the build serial (uid) and the level definition (written as its id) are left out.
// ------------------------------------------------------------------------------------------------
const SKIP_W = new Set(['f', 'prev', 'btn', 'ev']);
const SKIP_LV = new Set(['def', 'orig', 'hist', 'histLen', 'uid']);
function stateStr(W, skip = SKIP_W) {
  const lvIds = new Map();
  const isLevel = (v) => v && typeof v === 'object' && v.grid && v.def && typeof v.w === 'number';
  const tag = (v) => Object.prototype.toString.call(v); // realm-safe (the engine's objects live in a vm)
  const path = new Set(); // objects on the current path: a cycle is written as '@cycle', never followed
  const parts = [];
  function ser(v, top) {
    if (v === null) return void parts.push('n');
    const t = typeof v;
    if (t === 'undefined') return void parts.push('u');
    if (t === 'number') return void parts.push(Object.is(v, -0) ? '0' : String(v));
    if (t === 'boolean') return void parts.push(v ? 'T' : 'F');
    if (t === 'string') return void parts.push(JSON.stringify(v));
    if (t === 'function') return void parts.push('fn');
    if (ArrayBuffer.isView(v)) return void parts.push('[' + Array.prototype.join.call(v, ',') + ']');
    if (path.has(v)) return void parts.push('@cycle');
    path.add(v);
    if (Array.isArray(v)) {
      parts.push('[');
      for (let i = 0; i < v.length; i++) {
        if (i) parts.push(',');
        ser(v[i], false);
      }
      parts.push(']');
    } else if (tag(v) === '[object Map]' || tag(v) === '[object Set]') {
      parts.push(tag(v) === '[object Map]' ? 'M' : 'S');
      ser(Array.from(v), false);
    } else if (isLevel(v)) {
      if (lvIds.has(v)) parts.push('@L' + lvIds.get(v));
      else {
        lvIds.set(v, lvIds.size);
        parts.push('L' + lvIds.get(v) + '{def:' + JSON.stringify(v.def.id));
        for (const k of Object.keys(v).sort()) {
          if (SKIP_LV.has(k)) continue;
          parts.push(',' + k + ':');
          ser(v[k], false);
        }
        parts.push('}');
      }
    } else {
      parts.push('{');
      let first = true;
      for (const k of Object.keys(v).sort()) {
        if (top && skip.has(k)) continue;
        if (!first) parts.push(',');
        first = false;
        parts.push(k + ':');
        ser(v[k], false);
      }
      parts.push('}');
    }
    path.delete(v);
  }
  ser(W, true);
  return parts.join('');
}
function stateHash(W) {
  return hex(fnv(0x811c9dc5 | 0, stateStr(W)));
}

// ------------------------------------------------------------------------------------------------
// a context
// ------------------------------------------------------------------------------------------------
function gameFiles(o) {
  const exclude = (o.exclude || []).slice();
  if (o.bare) exclude.push(/^1[1-9]-/);
  const skip = (f) => exclude.some((x) => (x instanceof RegExp ? x.test(f) : x === f));
  return fs
    .readdirSync(GAME)
    .filter((f) => f.endsWith('.js') && !skip(f))
    .sort()
    .map((f) => path.join(GAME, f));
}

const BEFORE = ['core.js', 'lib.js', 'pixel.js', 'sprites.js', 'chip.js'];
const AFTER = ['music.js'];
function load(o = {}) {
  const opt = (names) => names.map((f) => path.join(SRC, f)).filter((f) => fs.existsSync(f));
  const timeline = opt(['timeline.js']);
  const files = [...opt(BEFORE), path.join(SRC, 'manifest.js'), ...timeline, ...gameFiles(o), ...opt(AFTER), ...(o.files || [])];
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: file });
    } catch (e) {
      e.message = `harness: loading ${path.relative(ROOT, file)} failed: ${e.message}`;
      throw e;
    }
  }
  const FILM = sandbox.FILM;
  const GAME = FILM && FILM.__game;
  if (!GAME || typeof GAME.newWorld !== 'function') throw new Error('harness: the engine (src/game/10-engine.js) did not load');
  if (o.defs) {
    const defs = typeof o.defs === 'function' ? o.defs(GAME, FILM) : o.defs;
    // a fresh object, so a frozen table from 01-levels.js still takes the fixtures
    GAME.GAME_DEFS = Object.assign({}, GAME.GAME_DEFS || {}, defs);
  }
  const G = makeContext(FILM, GAME, files);
  current = G;
  return G;
}

function makeContext(FILM, GAME, files) {
  const B = GAME.BUTTONS;
  function world(opts = {}) {
    return GAME.newWorld(Object.assign({}, opts));
  }
  const step = (W, b) => GAME.step(W, b | 0);
  function inputOf(input) {
    if (typeof input === 'function') return input;
    if (input && typeof input.length === 'number') return (W, i) => (i < input.length ? input[i] | 0 : 0);
    const b = input | 0;
    return () => b;
  }
  function run(W, input, frames, o = {}) {
    const inp = inputOf(input);
    const events = [];
    for (let i = 0; i < frames; i++) {
      const ev = GAME.step(W, inp(W, i) | 0);
      for (const e of ev) events.push(e);
      if (o.onFrame) o.onFrame(W, ev, i);
      if (o.until && o.until(W, ev, i)) break;
    }
    return events;
  }
  // a live world standing in play at the start of level id (or its checkpoint, if W.mid says so)
  function startAt(id, opts = {}) {
    const W = world(Object.assign({}, opts, { start: id }));
    GAME.step(W, B.START);
    for (let i = 0; i < 400 && W.mode !== 'play'; i++) GAME.step(W, 0);
    if (W.mode !== 'play') throw new Error(`harness.startAt('${id}'): not in play after 400 frames (mode ${W.mode})`);
    return W;
  }
  function sprStr(spr) {
    const out = [];
    for (let k = 0; k < spr.length; k += 5) {
      const n = spr[k];
      const name = n >= 1000 ? 'pop:' + GAME.POPS[n - 1000] : GAME.NAMES[n];
      out.push(name + ',' + spr[k + 1] + ',' + spr[k + 2] + ',' + spr[k + 3] + ',' + spr[k + 4]);
    }
    return out.join(';');
  }
  // docs/game-spec.md 2.2 (the ending text field is gone with the ending)
  function frameStr(s) {
    return [s.m, s.f, s.btn, s.score, s.coins, s.lives, s.top, s.world, s.time, s.lv ? s.lv.def.id : '-', s.chg, s.cam,
      s.lt, s.cflag, s.flagY, s.flash, s.door, (s.hide || []).join('.'), sprStr(s.spr || []),
      s.title ? s.title.started + ':' + s.title.mt : '-'].join('|');
  }
  function snapHash(states) {
    const list = Array.isArray(states) ? states : states.states;
    let h = 0x811c9dc5 | 0;
    for (let f = 0; f < list.length; f++) h = fnv(h, frameStr(list[f]) + '\n');
    return hex(h);
  }
  return {
    FILM, GAME, game: FILM.game, files, BUTTONS: B,
    world, step, run, startAt,
    snapshot: (W) => GAME.snapshot(W),
    clone: (W) => GAME.cloneWorld(W),
    stateStr, stateHash, snapHash, frameStr, sprStr, fingerprint, encode, decode,
  };
}

let current = null;
const cur = () => current || load();

module.exports = {
  ROOT, SRC, load, encode, decode, fingerprint, stateHash, stateStr,
  context: cur,
  world: (opts) => cur().world(opts),
  startAt: (id, opts) => cur().startAt(id, opts),
  run: (W, input, frames, o) => cur().run(W, input, frames, o),
  step: (W, b) => cur().step(W, b),
  snapshot: (W) => cur().snapshot(W),
  clone: (W) => cur().clone(W),
  snapHash: (states) => cur().snapHash(states),
  frameStr: (s) => cur().frameStr(s),
};
