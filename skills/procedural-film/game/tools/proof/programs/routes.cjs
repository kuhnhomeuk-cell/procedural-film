// tools/proof/programs/routes.cjs : the route through each level, as planner moves (programs/kit.cjs).
// Each route(k, o) returns the moves from the first play frame of its level to its goal.
//
// The camera only scrolls forward (src/game/10-engine.js), so a level's tokens split into lines of play
// that cannot all be taken in one run: in 1-1 the cellar (down at 46) sends him back up at 150, past the
// deck token (76) and the stair-gap token (108). r11 takes the overland line (tokens 0 and 1), r11b the
// cellar line (token 2). Together they prove all three.
'use strict';

// token bit n of level main on a copy of the world
const tokenOf = (c, main, n) => ((c.tokens && c.tokens[main]) | 0) & (1 << n);
// a search score: closer to the point (px, feet y) is better
const toward = (x, y) => (c) => -Math.abs(c.p.x + 8 - x) - 2 * Math.abs(c.p.y - y);
const standing = (c) => c.p.ground && c.p.st === 'play';
// the searches' gesture set on open ground
const OPEN = { depth: 8, width: 24, stand: [6, 16, 32], walk: [6, 12, 24], dirs: [128, 64, 130], jumpDirs: [0, 128, 130, 64], jump: [3, 8, 14, 20, 28] };

// 1-1 FIRST SIGNAL, overland: the deck token (76, 4) from the brick deck, the stair-gap token (108, 4)
// from the top step, then on to the beacon.
function r11(k, o = {}) {
  if (!o.tokens) return [k.advance('to the beacon', (W) => W.p.st !== 'play')];
  const rowTop = k.rowTop;
  return [
    k.advance('on to the brick deck', (W) => W.p.x >= 67 * 16 && W.p.ground),
    k.search('up onto the deck and its token', (c) => tokenOf(c, '1-1', 0) && standing(c), Object.assign({}, OPEN, { runUps: true, score: toward(76 * 16 + 8, rowTop(6)) })),
    k.advance('on to the twin stairs', (W) => W.p.x >= 100 * 16 && W.p.ground),
    k.search('up the stair and over the gap by its token', (c) => tokenOf(c, '1-1', 1) && standing(c), Object.assign({}, OPEN, { runUps: true, score: toward(108 * 16 + 8, rowTop(6)) })),
    k.advance('to the beacon', (W) => W.p.st !== 'play'),
  ];
}

// 1-1 by way of the cellar 1-1b: onto the pipe at 46, down, the cellar token (12, 4) over the pillars, out
// by the side pipe, up at 150, on to the beacon.
function r11b(k) {
  const pipe = 46, top = k.rowTop(7);
  return [
    k.advance('on to the down pipe', (W) => W.p.x >= 40 * 16 && W.p.ground),
    k.search('onto the down pipe', (c) => standing(c) && c.p.y === top && c.p.x + 8 >= pipe * 16 + 4 && c.p.x + 8 <= pipe * 16 + 28, Object.assign({}, OPEN, { score: toward(pipe * 16 + 16, top) })),
    k.wait('down the pipe', (W) => W.p.st !== 'play', k.DOWN),
    k.wait('into the cellar', (W) => W.lv.def.id === '1-1b' && W.p.ground && W.p.st === 'play'),
    k.search('the cellar token over the pillars', (c) => tokenOf(c, '1-1', 2) && standing(c), Object.assign({}, OPEN, { score: toward(12 * 16 + 8, k.rowTop(7)) })),
    k.search('out by the side pipe', (c) => c.p.st === 'pipeSide', Object.assign({}, OPEN, { after: 0, score: toward(15 * 16, k.rowTop(10)) })),
    k.wait('up out of the pipe at 150', (W) => W.lv.def.id === '1-1' && W.p.st === 'play'),
    k.advance('to the beacon', (W) => W.p.st !== 'play'),
  ];
}

// the route for a level id (full.cjs walks CONFIG.order with it)
const ROUTES = { '1-1': r11 };

module.exports = { r11, r11b, ROUTES, tokenOf };
