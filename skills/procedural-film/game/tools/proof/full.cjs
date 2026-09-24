#!/usr/bin/env node
// tools/proof/full.cjs : one whole game per feel mode, the title to the final card (docs/game-spec.md 13.2).
//
//   node tools/proof/full.cjs                 replay tapes/full.nes.json and tapes/full.modern.json: the
//                                             fingerprint, the final card reached, no death
//   node tools/proof/full.cjs --replan        plan both runs again and save the tapes
//   node tools/proof/full.cjs --feel modern   one feel only
//
// The run walks GAME.CONFIG.order: each level by its route (programs/routes.cjs ROUTES, tokens taken where
// the line of play allows), the clear card between levels, and the tape ends on the frame the final card
// (mode 'credits') begins. Level and token counts come from CONFIG and GAME_DEFS. It starts at the title of
// create({ start: firstLevel, feel }) with one START press, as NEW GAME does (tapes/full.<feel>.json:
// { opts, rle, frames, fp, meta }).
//
// No perfect run: the camera only scrolls forward, so a level's tokens can sit on lines of play that one
// run cannot both take (1-1: the cellar returns him past the deck and stair-gap tokens). Every token is
// proven by a level program instead (levels.data.cjs routes).
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./harness.cjs');
const { plan, replay } = require('./levels.cjs');
const routes = require('./programs/routes.cjs');

const TAPE_DIR = path.join(__dirname, 'tapes');

function makeFull(GAME) {
  const order = GAME.CONFIG.order;
  return {
    name: 'full',
    what: `title to the final card: ${order.join(', ')}, then the clear card and the final card`,
    opts: { start: GAME.CONFIG.firstLevel },
    exit: order.map(() => 'clear').concat(['credits']),
    cap: (G) => order.reduce((n, id) => n + G.GAME_DEFS[id].time * 24 + 900, 600),
    build: (k) => {
      const out = [];
      order.forEach((id, i) => {
        const route = routes.ROUTES[id];
        if (!route) throw new Error(`no route for level ${id} in programs/routes.cjs ROUTES`);
        out.push(k.wait(i ? `the lives screen, then ${id}` : `play in ${id}`, (W) => W.mode === 'play' && W.lv && W.lv.def.id === id && W.p.st === 'play'));
        out.push(...route(k, { tokens: true }));
        out.push(k.wait(`the clear card of ${id}`, (W) => W.mode !== 'play'));
      });
      out.push(k.wait('the final card', (W) => W.mode === 'credits'));
      return out;
    },
    check: (W, events, G) => {
      const clears = events.filter((e) => e.type === 'clear').map((e) => e.id);
      return [
        [W.mode === 'credits', `on the final card (mode ${W.mode})`],
        [JSON.stringify(clears) === JSON.stringify(order), `cleared ${JSON.stringify(order)} in order (${JSON.stringify(clears)})`],
        [!!W.credits && W.credits.max === G.tokensMax() && W.credits.tokens === G.tokenCount(W), `the final card counts ${G.tokenCount(W)} of ${G.tokensMax()} tokens`],
        [(W.retries | 0) === 0, `no retries (${W.retries | 0})`],
      ];
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--feel');
  const feels = fi >= 0 ? [argv[fi + 1]] : ['nes', 'modern'];
  const replan = argv.includes('--replan');
  const trace = argv.includes('--trace');
  const G = H.load();
  const full = makeFull(G.GAME);
  fs.mkdirSync(TAPE_DIR, { recursive: true });
  let fails = 0;
  const t0 = Date.now();
  for (const feel of feels) {
    const file = path.join(TAPE_DIR, `full.${feel}.json`);
    const tag = `full.${feel}`.padEnd(14);
    if (replan) {
      const r = plan(G, full, feel, { trace });
      if (!r.ok) {
        fails++;
        console.log(`[FAIL] ${tag} ${r.why}`);
        continue;
      }
      const obj = {
        opts: Object.assign({}, full.opts, { feel }), rle: G.encode(r.tape), frames: r.frames, fp: r.fp,
        meta: { program: 'full', what: full.what, score: r.score, tokens: G.GAME.tokenCount(r.W), lives: r.W.lives, planned: 'tools/proof/full.cjs --replan' },
      };
      fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
      const rr = replay(G, full, obj);
      if (!rr.ok) {
        fails++;
        console.log(`[FAIL] ${tag} planned, but the saved tape does not replay: ${rr.why}`);
        continue;
      }
      console.log(`[PASS] ${tag} planned ${r.frames} frames to the final card, fp ${r.fp}, score ${r.score}, tokens ${G.GAME.tokenCount(r.W)}`);
    } else {
      if (!fs.existsSync(file)) {
        fails++;
        console.log(`[FAIL] ${tag} no tape (${path.relative(H.ROOT, file)}): run with --replan`);
        continue;
      }
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      const r = replay(G, full, obj);
      if (!r.ok) {
        fails++;
        console.log(`[FAIL] ${tag} ${r.why}`);
        continue;
      }
      console.log(`[PASS] ${tag} replayed ${r.frames} frames to the final card, fp ${r.fp}, score ${r.score}, tokens ${G.GAME.tokenCount(r.W)}`);
    }
  }
  console.log(`${fails ? 'FAIL' : 'PASS'} full.cjs: ${feels.length} run(s), ${fails} failure(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  process.exit(fails ? 1 : 0);
}

module.exports = { makeFull };
if (require.main === module) main();
