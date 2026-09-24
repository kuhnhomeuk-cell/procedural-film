#!/usr/bin/env node
// tools/proof/determinism.cjs : T4 determinism (docs/game-spec.md 13.4). Owner: P7.
//
//   node tools/proof/determinism.cjs [--only <tape-name-substring>] [--every 120] [--span 240]
//
// For every tape in tools/proof/tapes ({ opts, rle, frames, fp }):
//   replay   FILM.game.create(tape.opts) fed the tape three times: twice in one engine context and once in
//            a freshly loaded one. The snapshot-stream hash (the 2.2 serialisation, one line per frame, over
//            the live snapshots) and the fingerprint must be identical on all three and the fingerprint must
//            equal the tape's own fp.
//   clones   every 120th frame of the tape, GAME.cloneWorld the console's world, then step the original and the
//            clone 240 frames with the same buttons (0 past the tape's end): the snapshot line of every one of
//            those frames and the final stateHash (every field except f, prev, btn, ev) must be equal.
// Exits 1 on any difference and prints the first diverging frame.
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');

const TAPES = path.join(__dirname, 'tapes');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const EVERY = Number(arg('every', 120));
const SPAN = Number(arg('span', 240));
const ONLY = arg('only', null);

function fnv(h, s) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h;
}
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

// one replay: the snapshot-stream hash and the fingerprint
function replay(G, tape, bytes) {
  const c = G.game.create(tape.opts || {});
  let h = 0x811c9dc5 | 0;
  const events = [];
  for (let i = 0; i < bytes.length; i++) {
    for (const e of c.step(bytes[i])) events.push(e);
    h = fnv(h, G.frameStr(c.snapshot()) + '\n');
  }
  return { snap: hex(h), fp: G.fingerprint(events, c.state().score), mode: c.mode, score: c.state().score };
}

// clone parity along one replay
function clones(G, tape, bytes) {
  const GAME = G.GAME;
  const c = G.game.create(tape.opts || {});
  const W = c.state();
  const active = [];
  const fails = [];
  let made = 0;
  const btn = (i) => (i < bytes.length ? bytes[i] : 0);
  const lastStart = bytes.length - 1;
  for (let i = 0; i <= lastStart + SPAN; i++) {
    if (i <= lastStart && i % EVERY === 0) {
      active.push({ W: GAME.cloneWorld(W), at: i, n: 0, bad: null });
      made++;
    }
    if (!active.length && i > lastStart) break;
    const b = btn(i);
    GAME.step(W, b);
    const line = active.length ? G.frameStr(GAME.snapshot(W)) : null;
    for (const k of active) {
      GAME.step(k.W, b);
      k.n++;
      if (!k.bad) {
        const cl = G.frameStr(GAME.snapshot(k.W));
        if (cl !== line) k.bad = { frame: i, orig: line.slice(0, 160), clone: cl.slice(0, 160) };
      }
    }
    for (let j = active.length - 1; j >= 0; j--) {
      const k = active[j];
      if (k.n < SPAN) continue;
      const a = G.stateHash(W), b2 = G.stateHash(k.W);
      if (k.bad || a !== b2) fails.push({ at: k.at, bad: k.bad, hashes: [a, b2] });
      active.splice(j, 1);
    }
  }
  return { made, fails };
}

const t0 = process.hrtime.bigint();
const secs = () => (Number((process.hrtime.bigint() - t0) / 1000000n) / 1000).toFixed(1);
const files = fs.readdirSync(TAPES).filter((f) => f.endsWith('.json') && (!ONLY || f.includes(ONLY))).sort();
if (!files.length) {
  console.log(`[FAIL] no tapes in ${path.relative(H.ROOT, TAPES)}${ONLY ? ` matching '${ONLY}'` : ''}`);
  process.exit(1);
}
const A = H.load();
const B = H.load(); // a second, freshly loaded engine context
let failed = 0;
// the tapes CONFIG asks for: every level of CONFIG.order and the full run, in both feels
if (!ONLY) {
  for (const id of A.GAME.CONFIG.order.concat(['full'])) {
    for (const feel of ['nes', 'modern']) {
      if (!files.includes(`${id}.${feel}.json`)) {
        console.log(`[FAIL] no tape ${id}.${feel}.json (CONFIG.order: ${A.GAME.CONFIG.order.join(', ')})`);
        failed++;
      }
    }
  }
}
let frames = 0;
let cloneCount = 0;
for (const f of files) {
  const tape = JSON.parse(fs.readFileSync(path.join(TAPES, f), 'utf8'));
  const bytes = A.decode(tape.rle);
  if (!bytes || (tape.frames != null && bytes.length !== tape.frames)) {
    console.log(`[FAIL] ${f}: the rle decodes to ${bytes ? bytes.length : 'nothing'} frames, the tape says ${tape.frames}`);
    failed++;
    continue;
  }
  frames += bytes.length;
  const r1 = replay(A, tape, bytes);
  const r2 = replay(A, tape, bytes);
  const r3 = replay(B, tape, bytes);
  const same = r1.snap === r2.snap && r1.snap === r3.snap && r1.fp === r2.fp && r1.fp === r3.fp;
  const fpOk = !tape.fp || r1.fp === tape.fp;
  const cl = clones(A, tape, bytes);
  cloneCount += cl.made;
  const ok = same && fpOk && cl.fails.length === 0;
  if (!ok) failed++;
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${f.padEnd(24)} ${String(bytes.length).padStart(6)} frames  snap ${r1.snap}${same ? ' x3' : ` / ${r2.snap} / ${r3.snap}`}` +
      `  fp ${r1.fp}${fpOk ? '' : ` (tape ${tape.fp})`}  clones ${cl.made - cl.fails.length}/${cl.made}  ends ${r1.mode}`
  );
  for (const x of cl.fails.slice(0, 3)) {
    console.log(`       clone at frame ${x.at}: stateHash ${x.hashes[0]} vs ${x.hashes[1]}` + (x.bad ? `; first differing frame ${x.bad.frame}\n         orig  ${x.bad.orig}\n         clone ${x.bad.clone}` : ''));
  }
}
console.log(`${failed ? 'FAIL' : 'PASS'} determinism.cjs: ${files.length} tapes, ${frames} frames, ${cloneCount} clones of ${SPAN} frames, ${failed} failure(s) in ${secs()}s`);
process.exit(failed ? 1 : 0);
