// game/15-tokens.js : the collectible tokens (spinning medals, up to 32 per main level). Owner: game.
// docs/game-spec.md 6.8 (X8) and 4.10.
//
// One system behind the engine seam (docs/game-spec.md 2.4). A token comes
// from a `t` in the map (numbered by column, left to right, from def.tokenBase) or from def.tokens
// ([tx, ty, bit] overlays for maps that must stay byte-identical). W.tokens[main] is the run's bitmask
// per main level: it survives deaths and continues, so a rebuilt level never shows a collected token.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});
  const register = (sys) => {
    const i = GAME.systems.findIndex((q) => q.name === sys.name);
    if (i >= 0) GAME.systems[i] = sys;
    else GAME.systems.push(sys);
  };
  const K = GAME.K;
  const { rowTop, bodyL, bodyR, bodyH } = K;

  const TOKEN_SCORE = 1000;
  const mainOf = (def) => def.main || def.id;

  function collect(W, lv, tk) {
    const main = mainOf(lv.def);
    W.tokens[main] = (W.tokens[main] | 0) | (1 << tk.bit);
    tk.got = true;
    K.addScore(W, TOKEN_SCORE);
    K.pop(W, K.popOf(String(TOKEN_SCORE)), tk.x + 8, tk.y - 8);
    K.emit(W, 'token', { id: main, n: tk.bit });
  }

  // registered once, by name (a second load of this file replaces it rather than doubling every hook)
  register({
    name: 'tokens',
    spawn: {
      t(lv, tx, ty) {
        (lv.tokenSpots || (lv.tokenSpots = [])).push([tx, ty]);
        return '.';
      },
    },
    build(lv, def, W) {
      const spots = lv.tokenSpots || [];
      delete lv.tokenSpots;
      // numbered by column, left to right (the spawn pass runs row by row)
      spots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const base = def.tokenBase | 0;
      const list = spots.map(([tx, ty], i) => [tx, ty, base + i]);
      for (const o of def.tokens || []) list.push([o[0], o[1], o[2] | 0]);
      const have = (W && W.tokens && W.tokens[mainOf(def)]) | 0;
      lv.tokens = list
        .filter(([, , bit]) => !(have & (1 << bit)))
        .map(([tx, ty, bit]) => ({ tx, ty, bit, x: tx * 16, y: rowTop(ty), got: false }));
    },
    step(W, lv) {
      const list = lv.tokens;
      const p = W.p;
      if (!list.length || p.st !== 'play') return;
      const l = bodyL(p), r = bodyR(p), top = p.y - bodyH(p);
      for (const tk of list) {
        // his body over the medal's box x+2..x+14, y+2..y+14
        if (r >= tk.x + 2 && l < tk.x + 14 && p.y > tk.y + 2 && top < tk.y + 14) collect(W, lv, tk);
      }
      if (list.some((tk) => tk.got)) lv.tokens = list.filter((tk) => !tk.got);
    },
    sprites(W, lv, out, vf) {
      if (!lv.tokens.length) return;
      const n = GAME.ni('item_token_' + (1 + ((vf >> 3) & 3)));
      for (const tk of lv.tokens) {
        if (tk.x < W.cam - 32 || tk.x > W.cam + 336) continue;
        out.push(n, tk.x, tk.y, 0, 0);
      }
    },
    cloneLevel(src, dst) {
      dst.tokens = src.tokens.map((tk) => Object.assign({}, tk));
    },
  });
})();
