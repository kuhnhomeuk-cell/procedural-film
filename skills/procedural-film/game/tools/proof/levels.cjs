#!/usr/bin/env node
// tools/proof/levels.cjs : T2 level proofs (docs/game-spec.md 13.2). Owner: P3.
//
//   node tools/proof/levels.cjs                     replay every saved tape: the fingerprint, the exit, no death
//   node tools/proof/levels.cjs --replan [names]    re-plan the named programs (default: all) and save their tapes
//   node tools/proof/levels.cjs --feel nes          one feel only (default: both)
//   node tools/proof/levels.cjs --replan 1-2 --trace   print every move as it completes
//
// A program (tools/proof/programs/*.cjs, one per file or an array of them) is a list of planner moves built from GAME.moves and GAME.goals
// with o.free: true (see programs/kit.cjs), built fresh for every run. A run is create(opts) with the
// feel, one START press, then the program's buttons, frame by frame, until its exit events have all
// happened in order: the flagpole (1-1, 1-2 by way of 1-2x, 1-3), the axe then complete (1-4), a secret's
// own event. It fails on any die event, on the frame cap (def.time * 24 + 600 for a level; a program may
// set its own), or on a failed check of its own; the report names the frame, where he was and the stuck
// move. A passing run saves tools/proof/tapes/<name>.<feel>.json:
//   { opts, rle, frames, fp, meta }   rle from the console's first step (the START press included), fp the
//                                     film's fingerprint (every event's frame and type, then the score)
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');
const kit = require('./programs/kit.cjs');

const PROG_DIR = path.join(__dirname, 'programs');
const TAPE_DIR = path.join(__dirname, 'tapes');
const FEELS = ['nes', 'modern'];

function programs() {
  const out = [];
  for (const f of fs.readdirSync(PROG_DIR).sort()) {
    if (!f.endsWith('.cjs')) continue;
    const m = require(path.join(PROG_DIR, f));
    for (const q of Array.isArray(m) ? m : [m]) if (q && typeof q === 'object' && typeof q.build === 'function' && q.name) out.push(q);
  }
  const order = (p) => (p.order != null ? p.order : 50);
  return out.sort((a, b) => order(a) - order(b) || (a.name < b.name ? -1 : 1));
}

const describe = (W) => {
  const p = W.p;
  return `mode ${W.mode}, area ${W.lv ? W.lv.def.id : '-'}, x ${p ? p.x.toFixed(1) : '-'}, y ${p ? p.y.toFixed(1) : '-'}, st ${p ? p.st : '-'}, big ${p ? p.big : '-'}`;
};

function capOf(G, prog) {
  if (prog.cap) return typeof prog.cap === 'function' ? prog.cap(G.GAME) : prog.cap;
  const def = G.GAME.GAME_DEFS[prog.opts.start];
  return def.time * 24 + 600;
}

// the exit: event types (or predicates (event, W) -> bool) that must happen in this order
const exitMatch = (x, e, W) => (typeof x === 'function' ? x(e, W) : e.type === x);

function plan(G, prog, feel, o = {}) {
  const GAME = G.GAME;
  const opts = Object.assign({}, prog.opts, { feel });
  const con = G.game.create(opts);
  const W = con.state();
  const k = kit(GAME);
  const moves = prog.build(k, { feel, W, opts });
  const cap = capOf(G, prog);
  const tape = [];
  const events = [];
  let pc = 0, t = 0, ex = 0, tm = Date.now();
  const bot = () => {
    while (pc < moves.length) {
      const m = moves[pc];
      if (m.until(W, t)) {
        if (o.trace) console.log(`      f ${String(W.f).padStart(5)}  done ${m.label || '#' + pc}  (${describe(W)}) ${Date.now() - tm} ms`);
        tm = Date.now();
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
  const stuck = () => (pc < moves.length ? `move ${pc} '${moves[pc].label || '?'}'` : 'past the last move');
  for (let f = 0; f < cap; f++) {
    const b = f === 0 ? GAME.BUTTONS.START : bot() & 255;
    tape.push(b);
    const ev = con.step(b);
    for (const e of ev) {
      events.push(e);
      if (o.events) console.log(`      f ${e.f} ${e.type} ${JSON.stringify(e)}`);
      if (e.type === 'die') return { ok: false, why: `died (${e.cause}) at frame ${e.f} (${describe(W)}); ${stuck()}`, tape, events, W };
      if (ex < prog.exit.length && exitMatch(prog.exit[ex], e, W)) ex++;
    }
    if (ex === prog.exit.length) {
      const res = { ok: true, tape, events, W, frames: tape.length, score: W.score, fp: G.fingerprint(events, W.score) };
      const bad = prog.check ? prog.check(W, events, GAME).filter((c) => !c[0]) : [];
      if (bad.length) return Object.assign(res, { ok: false, why: bad.map((c) => c[1]).join('; ') });
      return res;
    }
  }
  return { ok: false, why: `frame cap ${cap} reached (${describe(W)}); exit ${ex}/${prog.exit.length}; ${stuck()}`, tape, events, W };
}

function replay(G, prog, tapeObj) {
  const GAME = G.GAME;
  const con = G.game.create(tapeObj.opts);
  const W = con.state();
  const tape = G.decode(tapeObj.rle);
  if (!tape || tape.length !== tapeObj.frames) return { ok: false, why: `the tape decodes to ${tape ? tape.length : 'nothing'} frames, not ${tapeObj.frames}` };
  const events = [];
  let ex = 0, exitF = -1;
  for (let f = 0; f < tape.length; f++) {
    for (const e of con.step(tape[f])) {
      events.push(e);
      if (e.type === 'die') return { ok: false, why: `died (${e.cause}) at frame ${e.f} (${describe(W)})` };
      if (ex < prog.exit.length && exitMatch(prog.exit[ex], e, W) && ++ex === prog.exit.length) exitF = f;
    }
  }
  const fp = G.fingerprint(events, W.score);
  if (ex < prog.exit.length) return { ok: false, why: `the exit (${ex}/${prog.exit.length}) never happened` };
  if (exitF !== tape.length - 1) return { ok: false, why: `the exit came at frame ${exitF}, the tape runs to ${tape.length - 1}` };
  if (fp !== tapeObj.fp) return { ok: false, why: `fingerprint ${fp}, the tape says ${tapeObj.fp}` };
  const bad = prog.check ? prog.check(W, events, GAME).filter((c) => !c[0]) : [];
  if (bad.length) return { ok: false, why: bad.map((c) => c[1]).join('; ') };
  return { ok: true, fp, frames: tape.length, score: W.score, W, events };
}

function summary(W, GAME) {
  return `score ${W.score}, lives ${W.lives}, tokens ${GAME.tokenCount(W)}, retries ${W.retries | 0}`;
}

function main() {
  const argv = process.argv.slice(2);
  const replan = argv.includes('--replan');
  const trace = argv.includes('--trace');
  const evs = argv.includes('--events');
  const fi = argv.indexOf('--feel');
  const feels = fi >= 0 ? [argv[fi + 1]] : FEELS;
  const names = argv.filter((a, i) => !a.startsWith('--') && !(fi >= 0 && i === fi + 1));
  const G = H.load();
  const all = programs();
  const chosen = names.length ? all.filter((p) => names.includes(p.name)) : all;
  if (names.length && chosen.length !== names.length) {
    console.log(`unknown program(s): ${names.filter((n) => !all.some((p) => p.name === n)).join(', ')} (have ${all.map((p) => p.name).join(', ')})`);
    process.exit(1);
  }
  fs.mkdirSync(TAPE_DIR, { recursive: true });
  let fails = 0;
  const t0 = Date.now();
  // every level of CONFIG.order (and every sub-area's main level) needs a program that starts there
  if (!names.length) {
    for (const id of G.GAME.CONFIG.order) {
      if (!G.GAME.GAME_DEFS[id]) {
        fails++;
        console.log(`[FAIL] CONFIG.order names ${id}, which GAME_DEFS lacks`);
      } else if (!all.some((p) => p.opts && p.opts.start === id)) {
        fails++;
        console.log(`[FAIL] level ${id} has no program in tools/proof/programs (opts.start '${id}')`);
      }
    }
  }
  for (const prog of chosen) {
    for (const feel of feels) {
      const file = path.join(TAPE_DIR, `${prog.name}.${feel}.json`);
      const tag = `${prog.name}.${feel}`.padEnd(20);
      const s0 = Date.now();
      if (replan) {
        const r = plan(G, prog, feel, { trace, events: evs });
        if (!r.ok) {
          fails++;
          console.log(`[FAIL] ${tag} ${r.why}`);
          continue;
        }
        const obj = {
          opts: Object.assign({}, prog.opts, { feel }), rle: G.encode(r.tape), frames: r.frames, fp: r.fp,
          meta: { program: prog.name, what: prog.what || '', score: r.score, tokens: G.GAME.tokenCount(r.W), lives: r.W.lives, planned: 'tools/proof/levels.cjs --replan' },
        };
        fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
        // the saved tape must replay to the same fingerprint
        const rr = replay(G, prog, obj);
        if (!rr.ok) {
          fails++;
          console.log(`[FAIL] ${tag} planned, but the saved tape does not replay: ${rr.why}`);
          continue;
        }
        console.log(`[PASS] ${tag} planned ${r.frames} frames, fp ${r.fp}, ${summary(r.W, G.GAME)} (${((Date.now() - s0) / 1000).toFixed(1)} s)`);
      } else {
        if (!fs.existsSync(file)) {
          fails++;
          console.log(`[FAIL] ${tag} no tape (${path.relative(H.ROOT, file)}): run with --replan`);
          continue;
        }
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
        const r = replay(G, prog, obj);
        if (!r.ok) {
          fails++;
          console.log(`[FAIL] ${tag} ${r.why}`);
          continue;
        }
        console.log(`[PASS] ${tag} replayed ${r.frames} frames, fp ${r.fp}, ${summary(r.W, G.GAME)}`);
      }
    }
  }
  console.log(`${fails ? 'FAIL' : 'PASS'} levels.cjs: ${chosen.length} program(s) x ${feels.length} feel(s), ${fails} failure(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(fails ? 1 : 0);
}

module.exports = { programs, plan, replay, capOf };
if (require.main === module) main();
