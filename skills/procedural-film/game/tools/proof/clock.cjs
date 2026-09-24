#!/usr/bin/env node
// tools/proof/clock.cjs : T5 clock proof (docs/game-spec.md 11.2 and 13.5). Owner: P6.
//
//   node tools/proof/clock.cjs     exits 1 on any failure
//
// Feeds GAME.clock synthetic requestAnimationFrame stamp streams at 50, 59.94, 60, 75, 90, 120, 144, 165
// and 240 Hz with +-0.5 ms jitter (a seeded generator, so every run is the same), 60 s each, and asserts:
//   - 3600 +- 2 steps in the 60 s;
//   - no animation frame runs more than ceil(60 / hz) + 1 steps;
//   - a 1 s gap (a hidden tab) produces exactly 1 step, wherever in the stream it falls;
//   - the first animation frame runs exactly 1 step;
//   - a plain 60 Hz stream never runs 0 or 2 steps on a frame (no skipped or doubled frame);
//   - a 250 ms stall is caught up by at most MAX_CATCHUP steps and the rest dropped.
// The clock is loaded alone in a vm, as the page loads it: no browser, no real time.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.resolve(__dirname, '..', '..', 'src', 'game', '45-clock.js');
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), ctx, { filename: FILE });
const clock = ctx.window.FILM.__game.clock;

let fails = 0;
function check(name, ok, got) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${got !== undefined ? ': ' + got : ''}`);
  if (!ok) fails++;
}

// a seeded LCG in [0, 1)
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

// stamps of a display at hz for `seconds`, starting at t0, each jittered by up to +-jitter ms
function stream(hz, seconds, seed, t0 = 1000, jitter = 0.5) {
  const r = rng(seed);
  const period = 1000 / hz;
  const n = Math.floor((seconds * 1000) / period);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(t0 + i * period + (r() * 2 - 1) * jitter);
  return out;
}

check('constants', clock.STEP_MS === 1000 / 60 && clock.TOL_MS === 2 && clock.MAX_CATCHUP === 5 && clock.MAX_GAP_MS === 250,
  `STEP_MS ${clock.STEP_MS.toFixed(4)} TOL_MS ${clock.TOL_MS} MAX_CATCHUP ${clock.MAX_CATCHUP} MAX_GAP_MS ${clock.MAX_GAP_MS}`);
check('clock is frozen', Object.isFrozen(clock));

const RATES = [50, 59.94, 60, 75, 90, 120, 144, 165, 240];
for (const hz of RATES) {
  for (const seed of [1, 7, 42]) {
    const c = clock.make();
    const stamps = stream(hz, 60, seed * 1000 + Math.round(hz * 100));
    let total = 0;
    let maxN = 0;
    let first = -1;
    for (const s of stamps) {
      const n = clock.advance(c, s);
      if (first < 0) first = n;
      total += n;
      if (n > maxN) maxN = n;
    }
    const cap = Math.ceil(60 / hz) + 1;
    const ok = Math.abs(total - 3600) <= 2 && maxN <= cap && first === 1;
    check(`${hz} Hz seed ${seed}: 60 s`, ok, `${total} steps (want 3600 +- 2), max ${maxN}/frame (cap ${cap}), first frame ${first}`);
  }
}

// a 60 Hz stream: exactly one step on every frame (no skipped or doubled frame under jitter)
{
  const c = clock.make();
  let bad = 0;
  for (const s of stream(60, 60, 99)) if (clock.advance(c, s) !== 1) bad++;
  check('60 Hz with jitter: one step on every frame', bad === 0, `${bad} frames with 0 or 2 steps`);
}

// a 1 s gap in the middle of every rate's stream, at many phases: exactly 1 step on the frame after it
{
  let worst = [];
  let tried = 0;
  for (const hz of RATES) {
    for (let k = 0; k < 40; k++) {
      const c = clock.make();
      const before = stream(hz, 2 + k * 0.013, 500 + k, 1000);
      for (const s of before) clock.advance(c, s);
      const at = before[before.length - 1] + 1000;
      const n = clock.advance(c, at);
      tried++;
      if (n !== 1) worst.push(`${hz} Hz phase ${k}: ${n}`);
      // and the stream carries on at its rate afterwards
      const after = stream(hz, 1, 900 + k, at + 1000 / hz);
      let t = 0;
      for (const s of after) t += clock.advance(c, s);
      if (Math.abs(t - 60) > 2) worst.push(`${hz} Hz phase ${k}: ${t} steps in the second after the gap`);
    }
  }
  check('1 s gap gives exactly 1 step', worst.length === 0, worst.length ? worst.slice(0, 5).join('; ') : `${tried} gaps across ${RATES.length} rates`);
}

// a 250 ms stall (not over MAX_GAP_MS): at most MAX_CATCHUP steps, backlog dropped, then back to 60/s
{
  const c = clock.make();
  const s0 = stream(60, 1, 5);
  for (const s of s0) clock.advance(c, s);
  const at = s0[s0.length - 1] + 250;
  const n = clock.advance(c, at);
  let next = 0;
  for (const s of stream(60, 1, 6, at + 1000 / 60)) next += clock.advance(c, s);
  check('250 ms stall: catch-up capped and backlog dropped', n === clock.MAX_CATCHUP && Math.abs(next - 60) <= 1, `${n} steps on the stall frame, ${next} in the next second`);
}

// reset: the next advance is a first frame again
{
  const c = clock.make();
  clock.advance(c, 100);
  clock.advance(c, 116.7);
  clock.reset(c);
  const n = clock.advance(c, 5000);
  check('reset: next advance returns 1', n === 1 && c.last === 5000, n);
}

// the source reads no clock of its own (check 3 applies to src/game too)
{
  const text = fs.readFileSync(FILE, 'utf8').replace(/\/\/.*$/gm, '');
  const banned = [/Math\s*\.\s*random/, /\bDate\b/, /performance\s*\.\s*now/, /crypto/].filter((re) => re.test(text));
  check('no Math.random, Date, performance.now or crypto in 45-clock.js', banned.length === 0, banned.map(String).join(' ') || 'clean');
}

console.log(fails ? `clock: ${fails} failure(s)` : 'clock: all checks pass');
process.exit(fails ? 1 : 0);
