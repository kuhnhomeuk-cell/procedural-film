// game/30-draw.js : paints one snapshot (game/10-engine.js) into the console's 320x180 frame buffer.
// Every pixel is repainted each frame, only in NES colours, through the retro kit (FILM.retro.sprite,
// FILM.retro.pxtext, FILM.retro.hud, FILM.retro.titleBox). Owner: game.
//
// Layers, back to front: backdrop (a flash may replace it for a frame); then, clipped below the HUD band
// (y >= 32) so nothing from the world ever enters it: scenery (def.scenery: scenery_cloud*, scenery_hill*,
// scenery_bush*), the goal house's signal, the goal house; sprites that sit behind the tiles (a power-up
// rising out of its block, the hero inside a pipe); tiles; bumped blocks; sprites; score pops; the goal
// house's door and right wall redrawn over the hero as he walks in. Then the HUD and the title / lives text.
//
// `view`, { now, reducedFlash }: `now` paints the level grid as it stands (a console draws the snapshot
// it just took; the attract film replays the change log instead), `reducedFlash` drops backdrop flashes
// and holds FLICKER sprites steady. The game's name and hero come from GAME.CONFIG.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = FILM.__game;
  const rowTop = GAME.rowTop;
  const CONFIG = () => GAME.CONFIG || {};

  let L = null; // FILM.retro (src/pixel.js), resolved on first draw
  let N = null;
  let PALS = null;
  function libs() {
    if (L) return;
    L = FILM.retro;
    N = L.NES;
    // palette slots used by the snapshot (GAME.PAL, docs/game-spec.md 2.6): 5 the walker underground (its
    // dark parts would vanish on black), 8 the 1UP, 12 brick fragments underground
    const SP = L.SPAL || {};
    PALS = [null, null, null, null, null, SP.foeU, null, null, SP.life, null, null, null, SP.fragmentU];
  }

  // Per-frame draw state, set at the top of drawSnap: the visual frame (animation clocks) and the
  // reduced-flashing option.
  const FLICKER = 256;
  let VF = 0;
  let REDUCED = false;
  // the palette slot a sprite shows this frame: FLICKER alternates its slot with the sprite's own every
  // 4 frames (held steady with reduced flashing)
  function palOf(fl, pal) {
    if (!pal) return 0;
    if (fl & FLICKER && !REDUCED && (VF >> 2) & 1) return 0;
    return pal;
  }

  const MANI = () => FILM.SPRITE_MANIFEST || {};
  const A = GAME.ANCHOR;
  // one reusable options object: lib.sprite reads it synchronously
  const O = { flip: false, flipV: false, pal: undefined };
  function spr(ctx, name, x, y, flags, pal) {
    if (flags & (A.FEET | A.RIGHT | A.LEFT)) {
      const m = MANI()[name];
      const w = m ? m.w : 16, h = m ? m.h : 16;
      y -= h;
      if (flags & A.FEET) x -= w >> 1;
      else if (flags & A.RIGHT) x -= w;
    }
    O.flip = !!(flags & 1);
    O.flipV = !!(flags & 2);
    O.pal = pal ? PALS[pal] || undefined : undefined;
    L.sprite(ctx, name, x, y, O);
  }

  // ------------------------------------------------------------------------------------------
  // Scenery: the level's own hand-placed list (def.scenery), checked against the map once (cached per level
  // definition): a hill or bush is dropped if any
  // column under it lacks ground or holds a pipe, block or the pole
  // ------------------------------------------------------------------------------------------
  const sceneryCache = new Map();
  const POLE_CODES = ['|'.charCodeAt(0), '!'.charCodeAt(0)];
  function scenery(lv) {
    if (sceneryCache.has(lv.def)) return sceneryCache.get(lv.def);
    const out = [];
    const orig = lv.orig;
    const w = lv.w;
    const at = (tx, ty) => (tx < 0 || tx >= w || ty < 0 || ty > 11 ? 46 : orig[ty * w + tx]);
    const M = MANI();
    for (const [name, col, cy] of lv.def.scenery || []) {
      const m = M[name] || { w: 32, h: 16 };
      const x = Math.round(col * 16);
      if (name.startsWith('scenery_cloud')) {
        out.push([name, x, cy, 0]);
        continue;
      }
      let ok = true;
      for (let c = Math.floor(x / 16); c <= Math.floor((x + m.w - 1) / 16) && ok; c++) {
        if (GAME.SOLID[at(c, 10)] !== 1) ok = false;
        for (let r = 7; r <= 9 && ok; r++) if (GAME.SOLID[at(c, r)] === 1 || POLE_CODES.indexOf(at(c, r)) >= 0) ok = false;
      }
      if (ok) out.push([name, x, 148 - m.h, name.startsWith('scenery_hill') ? 1 : 2]);
    }
    // clouds, then hills, then bushes in front
    out.sort((p, q) => p[3] - q[3]);
    sceneryCache.set(lv.def, out);
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Tiles
  // ------------------------------------------------------------------------------------------
  const TILE = {};
  function tileTable(kind) {
    if (TILE[kind]) return TILE[kind];
    const t = new Array(128).fill(null);
    const set = (ch, name) => (t[ch.charCodeAt(0)] = name);
    const names = GAME.TILE_NAMES[kind] || GAME.TILE_NAMES.over;
    for (const ch in names) set(ch, names[ch]);
    set('[', 'tile_pipe_tl'); set(']', 'tile_pipe_tr'); set('{', 'tile_pipe_l'); set('}', 'tile_pipe_r');
    set('h', 'tile_pipe_side_top'); set('H', 'tile_pipe_side_bottom'); set('-', 'tile_pipe_body_top'); set('_', 'tile_pipe_body_bottom');
    set('j', 'tile_pipe_join_top'); set('J', 'tile_pipe_join_bottom');
    set('!', 'goal_top'); set('|', 'goal_pole');
    set('?', '?'); set('M', '?'); set('o', 'o');
    // N (a 1UP inside) shimmers like any ? block; a hidden 1UP block (+) shows nothing until it is bumped
    set('N', '?');
    t['+'.charCodeAt(0)] = null;
    TILE[kind] = t;
    return t;
  }

  // the tile code of cell i as it was when the snapshot was taken (chg = length of the change log then)
  function histOf(lv) {
    if (lv.histLen === lv.changes.length) return lv.hist;
    const h = new Map();
    const c = lv.changes;
    for (let k = 0; k < c.length; k += 2) {
      let a = h.get(c[k]);
      if (!a) h.set(c[k], (a = []));
      a.push(k, c[k + 1]);
    }
    lv.hist = h;
    lv.histLen = c.length;
    return h;
  }
  function codeAt(lv, hist, i, chg) {
    const a = hist.get(i);
    if (!a) return lv.orig[i];
    let code = lv.orig[i];
    for (let k = 0; k < a.length; k += 2) {
      if (a[k] < chg) code = a[k + 1];
      else break;
    }
    return code;
  }

  // the ? block shimmer on the console's 48-frame cadence (FILM.retro.shimmer)
  const qName = (f) => 'tile_q_' + (1 + L.shimmer(f));

  // now: read the grid as it stands (a live console draws the snapshot it just took) instead of replaying
  // the change log up to the snapshot's length
  function drawTiles(ctx, s, f, now) {
    const lv = s.lv;
    const tab = tileTable(lv.def.kind);
    const grid = now ? lv.grid : null;
    const hist = now ? null : histOf(lv);
    const cam = s.cam;
    const tx0 = Math.max(0, Math.floor(cam / 16)), tx1 = Math.min(lv.w - 1, Math.floor((cam + 319) / 16));
    const hide = s.hide;
    const q = qName(f);
    const coin = 'item_coin_' + (1 + ((f >> 3) & 3));
    for (let ty = 0; ty < 12; ty++) {
      const y = rowTop(ty);
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * lv.w + tx;
        const code = grid ? grid[i] : codeAt(lv, hist, i, s.chg);
        const name = tab[code];
        if (!name) continue;
        if (hide && hide.indexOf(i) >= 0) continue;
        const x = tx * 16 - cam;
        if (name === '?') L.sprite(ctx, q, x, y);
        else if (name === 'o') L.sprite(ctx, coin, x + 4, y + 1);
        else L.sprite(ctx, name, x, y);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // HUD and text
  // ------------------------------------------------------------------------------------------
  // Text layers (the HUD, the title, the lives screen, the cards) are painted once per distinct
  // content into their own transparent canvas and blitted: pixel text is thousands of 1-px fills.
  // Each layer is a pure function of its key, so the cache never changes what a frame shows.
  const layers = new Map();
  function layer(ctx, id, key, h, paint) {
    let e = layers.get(id);
    if (!e) {
      const c = FILM.makeCanvas(320, h);
      e = { c, g: c.getContext('2d'), key: null };
      e.g.imageSmoothingEnabled = false;
      layers.set(id, e);
    }
    if (e.key !== key) {
      e.g.clearRect(0, 0, 320, h);
      paint(e.g);
      e.key = key;
    }
    ctx.drawImage(e.c, 0, 0);
  }
  GAME.layer = layer;
  function hud(ctx, s, f) {
    const shim = L.shimmer(f);
    const time = s.time >= 0 ? s.time : null;
    const name = String(CONFIG().heroName || 'PLAYER');
    layer(ctx, 'hud', name + '|' + s.score + '|' + s.coins + '|' + s.world + '|' + time + '|' + shim, L.HUD_H || 32, (g) =>
      L.hud(g, { name, score: s.score, coins: s.coins, world: s.world, time, frame: f, coin: 'item_hudcoin_' })
    );
  }

  // The title: the game's title box (GAME.CONFIG.title), PRESS START and the high score. When the game
  // page's shell runs the menu (s.shell), only the box is drawn here; the shell paints the menu.
  function titleText(ctx, s) {
    const title = String(CONFIG().title || 'GAME');
    if (s.shell) {
      layer(ctx, 'title', 'shell|' + title, 180, (g) => L.titleBox(g, 160, 38, { text: title }));
      return;
    }
    // after START the prompt flickers while the console gets ready
    const blink = s.title.started && (s.title.mt >> 2) & 1 ? 1 : 0;
    layer(ctx, 'title', title + '|' + s.top + '|' + blink, 180, (g) => {
      const white = N[0x30];
      L.titleBox(g, 160, 38, { text: title });
      if (!blink) L.pxtext(g, 'PRESS START', 160, 98, { color: white, align: 'center' });
      L.pxtext(g, 'HI-SCORE ' + String(s.top).padStart(6, '0'), 160, 122, { color: white, align: 'center' });
    });
  }

  // the lives screen: the world, the level's name under it, then the hero and his lives
  function livesText(ctx, s) {
    const name = s.name || '';
    layer(ctx, 'lives', s.world + '|' + s.lives + '|' + name, 180, (g) => {
      const white = N[0x30];
      L.pxtext(g, 'WORLD ' + s.world, 160, 60, { color: white, align: 'center' });
      if (name) L.pxtext(g, name, 160, 72, { color: white, align: 'center' });
      L.sprite(g, 'hero_small_idle', 132, 88);
      L.pxtext(g, '×', 158, 93, { color: white });
      L.pxtext(g, String(s.lives), 176, 93, { color: white });
    });
  }

  // ------------------------------------------------------------------------------------------
  // The screens: pause, continue, the clear card, the final card
  // ------------------------------------------------------------------------------------------
  const pad6 = (n) => String(Math.max(0, Math.floor(n || 0))).padStart(6, '0');
  // a line whose first glyph is a coloured mark (✓ or ✻), centred on x 160
  function markLine(g, mark, markColor, rest, y, color) {
    const w = L.pxtextWidth(mark + ' ' + rest);
    const x = 160 - Math.floor(w / 2);
    L.pxtext(g, mark, x, y, { color: markColor });
    L.pxtext(g, rest, x + 16, y, { color });
  }
  // the level's token medals in a row (collected salmon, missing grey), centred on x 160
  function tokenRow(g, bits, n, y) {
    const x0 = 160 - Math.floor(((n - 1) * 16 + 7) / 2);
    for (let i = 0; i < n; i++) L.pxtext(g, '✻', x0 + 16 * i, y, { color: (bits >> i) & 1 ? N[0x26] : N[0x00] });
  }
  function black(ctx) {
    ctx.fillStyle = N[0x0f];
    ctx.fillRect(0, 0, 320, 180);
  }

  // mode 4 without the shell's panel: PAUSED over the frozen frame
  function pausedText(ctx) {
    layer(ctx, 'paused', 'p', 180, (g) => L.pxtext(g, 'PAUSED', 160, 86, { color: N[0x30], align: 'center', shadow: N[0x0f] }));
  }

  // mode 5: GAME OVER, then CONTINUE or END with the ▶ on the chosen row
  function continueScreen(ctx, s) {
    const sel = s.cont && s.cont.sel ? 1 : 0;
    black(ctx);
    layer(ctx, 'continue', String(sel), 180, (g) => {
      const white = N[0x30];
      L.pxtext(g, 'GAME OVER', 160, 70, { color: white, align: 'center' });
      L.pxtext(g, 'CONTINUE', 136, 94, { color: white });
      L.pxtext(g, 'END', 136, 106, { color: white });
      L.pxtext(g, '▶', 120, sel ? 106 : 94, { color: N[0x26] });
    });
  }

  // mode 6: the clear card
  function clearCard(ctx, s) {
    const c = s.clear || {};
    black(ctx);
    const key = [c.id, c.name, c.tokens, c.max, c.time, c.score].join('|');
    layer(ctx, 'clear', key, 180, (g) => {
      const white = N[0x30];
      markLine(g, '✓', N[0x2a], (c.id || '') + ' CLEAR', 56, white);
      if (c.name) L.pxtext(g, c.name, 160, 70, { color: white, align: 'center' });
      tokenRow(g, c.tokens | 0, Math.max(0, Math.min(16, c.max | 0)), 88);
      L.pxtext(g, 'SCORE ' + pad6(c.score), 160, 108, { color: white, align: 'center' });
      L.pxtext(g, 'TIME ' + String(Math.max(0, c.time | 0)).padStart(3, '0'), 160, 120, { color: white, align: 'center' });
    });
  }

  // mode 7: the final card (after the last level's clear card): the game's title, GAME CLEAR, the hero,
  // the run's totals; PRESS START blinks once START is accepted
  function credits(ctx, s) {
    const c = s.credits || { t: 0 };
    const t = c.t | 0;
    const WAIT = GAME.TIMING.CREDITS_WAIT;
    black(ctx);
    const push = t >= WAIT && (t - WAIT) % 48 < 32 ? 1 : 0;
    const max = Math.max(0, Math.min(99, c.max | 0));
    const tokens = Math.max(0, Math.min(99, c.tokens | 0));
    const key = ['card', c.score, c.top, tokens, max, c.perfect ? 1 : 0, push].join('|');
    layer(ctx, 'credits', key, 180, (g) => {
      const white = N[0x30];
      markLine(g, '✻', N[0x26], String(CONFIG().title || ''), 44, white);
      L.pxtext(g, 'GAME CLEAR', 160, 60, { color: N[0x36], align: 'center' });
      L.pxtext(g, 'STARRING ' + String(CONFIG().heroName || ''), 160, 74, { color: white, align: 'center' });
      L.pxtext(g, 'SCORE ' + pad6(c.score), 160, 94, { color: white, align: 'center' });
      L.pxtext(g, 'HI-SCORE ' + pad6(c.top), 160, 106, { color: white, align: 'center' });
      if (max > 0) L.pxtext(g, 'TOKENS ' + String(tokens).padStart(2, '0') + '/' + String(max).padStart(2, '0'), 160, 118, { color: white, align: 'center' });
      if (c.perfect) L.pxtext(g, '✻ PERFECT ✻', 160, 130, { color: N[0x28], align: 'center' });
      if (push) L.pxtext(g, 'PRESS START', 160, 150, { color: white, align: 'center' });
    });
  }

  // ------------------------------------------------------------------------------------------
  // The frame
  // ------------------------------------------------------------------------------------------
  const CASTLE_Y = 68; // the goal house stands on the ground (goal_house is 80 tall, bottom at y 148)
  const CASTLE_TIP = [68, 16]; // where the goal house's signal (goal_signal) climbs out of its roof
  const BACKDROP = { over: 0x22 }; // under is black
  // film: true for the attract film's frames (FILM.game.draw), false for a console (FILM.game.create).
  // view: { now, reducedFlash } (see the header)
  function drawSnap(ctx, s, f, film, view) {
    libs();
    const now = !!(view && view.now);
    REDUCED = !!(view && view.reducedFlash);
    VF = f | 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const TL = FILM.TIMELINE;
    const off = film && TL && TL.crt && TL.crt.powerOff;
    // the attract film's set is dark after its power-off; a console never is
    if (s.m === 3 || (off && f >= off[1])) {
      ctx.fillStyle = N[0x0f];
      ctx.fillRect(0, 0, 320, 180);
      if (s.m === 3) L.pxtext(ctx, 'GAME OVER', 160, 86, { color: N[0x30], align: 'center' });
      ctx.restore();
      return;
    }
    if (s.m === 1) {
      ctx.fillStyle = N[0x0f];
      ctx.fillRect(0, 0, 320, 180);
      hud(ctx, s, f);
      livesText(ctx, s);
      ctx.restore();
      return;
    }
    if (s.m === 5 || s.m === 6 || s.m === 7) {
      if (s.m === 5) continueScreen(ctx, s);
      else if (s.m === 6) clearCard(ctx, s);
      else credits(ctx, s);
      ctx.restore();
      return;
    }
    const lv = s.lv;
    const kind = lv.def.kind;
    const cam = s.cam;
    const back = BACKDROP[kind] !== undefined ? BACKDROP[kind] : 0x0f;
    ctx.fillStyle = s.flash && !REDUCED ? N[s.flash] : N[back];
    ctx.fillRect(0, 0, 320, 180);
    // the world, clipped below the HUD band
    const HB = L.HUD_H || 32;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HB, 320, 180 - HB);
    ctx.clip();
    for (const [name, x, y] of scenery(lv)) {
      const sx = x - cam;
      const m = MANI()[name];
      if (sx > 320 || sx + (m ? m.w : 80) < 0) continue;
      L.sprite(ctx, name, sx, y);
    }
    const cx = lv.def.castle ? lv.def.castle * 16 - cam : null;
    const castleOn = cx !== null && cx < 320 && cx > -96;
    if (castleOn) {
      if (s.cflag > 0) {
        // the signal climbs out of the roof
        const tipY = CASTLE_Y + CASTLE_TIP[1];
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx + CASTLE_TIP[0], HB, 16, tipY - HB);
        ctx.clip();
        L.sprite(ctx, 'goal_signal', cx + CASTLE_TIP[0], tipY - s.cflag);
        ctx.restore();
      }
      L.sprite(ctx, 'goal_house', cx, CASTLE_Y);
    }
    const spr16 = s.spr;
    const NAMES = GAME.NAMES;
    // sprites behind the tiles
    for (let k = 0; k < spr16.length; k += 5) {
      const fl = spr16[k + 3];
      if (fl & 4 && spr16[k] < 1000) spr(ctx, NAMES[spr16[k]], spr16[k + 1] - cam, spr16[k + 2], fl, palOf(fl, spr16[k + 4]));
    }
    drawTiles(ctx, s, f, now);
    // bumped blocks, then the sprites and score pops (a pop's x is its centre)
    for (let k = 0; k < spr16.length; k += 5) {
      const fl = spr16[k + 3];
      if (fl & 16) L.sprite(ctx, NAMES[spr16[k]], spr16[k + 1] - cam, spr16[k + 2]);
    }
    for (let k = 0; k < spr16.length; k += 5) {
      const n = spr16[k];
      const fl = spr16[k + 3];
      if (n >= 1000) L.pxtext(ctx, GAME.POPS[n - 1000], spr16[k + 1] - cam, spr16[k + 2], { align: 'center', color: N[0x30] });
      else if (!(fl & 20)) spr(ctx, NAMES[n], spr16[k + 1] - cam, spr16[k + 2], fl, palOf(fl, spr16[k + 4]));
    }
    // walking into the goal house: its door and the wall right of it cover him
    if (castleOn && s.door >= 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(s.door - cam, CASTLE_Y, cx + 80 - (s.door - cam), 80);
      ctx.clip();
      L.sprite(ctx, 'goal_house', cx, CASTLE_Y);
      ctx.restore();
    }
    ctx.restore();
    hud(ctx, s, f);
    if (s.m === 0 && s.title) titleText(ctx, s);
    if (s.m === 4 && !s.shell) pausedText(ctx);
    ctx.restore();
  }
  GAME.drawSnap = drawSnap;

  // Warm-up: build every sprite drawing the attract film will blit (each name, mirror, flip and palette
  // it appears in, every tile and scenery piece) on an off-screen canvas once, before the first frame,
  // so no frame pays for building one mid-film. Only the kit's own caches change; no pixel does.
  function warm(states) {
    libs();
    const c = FILM.makeCanvas(64, 64);
    const g = c.getContext('2d');
    const seen = new Set();
    const NAMES = GAME.NAMES;
    for (const st of states) {
      const sp = st.spr;
      if (!sp) continue;
      for (let k = 0; k < sp.length; k += 5) {
        const n = sp[k];
        if (n >= 1000) continue;
        const key = n * 4096 + (sp[k + 3] & 3) * 256 + sp[k + 4];
        if (seen.has(key)) continue;
        seen.add(key);
        spr(g, NAMES[n], 0, 0, sp[k + 3] & 3, sp[k + 4]);
      }
    }
    const M = MANI();
    for (const name in M) L.sprite(g, name, 0, 0);
    return seen.size;
  }
  GAME.warm = warm;

  // The game page's warm-up (docs/game-spec.md 9.3, 11.1): warmStep(n) builds the next n manifest names
  // with every palette slot and mirror they can be drawn in, and returns true once all are built. The
  // title calls it once an animation frame, so no frame of play pays for building a drawing.
  const WARM_SETS = [
    [/^hero_/, [0], [0, 1]],
    [/^foe_/, [0, 5], [0, 1, 2, 3]],
    [/^item_power$/, [0, 8], [0, 1]],
    [/^item_fragment_/, [0, 12], [0, 1]],
  ];
  let warmNames = null;
  let warmAt = 0;
  function warmStep(n) {
    libs();
    if (!warmNames) warmNames = Object.keys(MANI());
    const end = Math.min(warmNames.length, warmAt + Math.max(1, n | 0));
    for (; warmAt < end; warmAt++) {
      const name = warmNames[warmAt];
      let pals = [0], flips = [0];
      for (const [re, p, fl] of WARM_SETS) if (re.test(name)) { pals = p; flips = fl; break; }
      for (const p of pals) for (const fl of flips) L.spriteCanvas(name, 0, p ? PALS[p] : undefined, !!(fl & 1), !!(fl & 2));
    }
    return warmAt >= warmNames.length;
  }
  GAME.warmStep = warmStep;
})();
