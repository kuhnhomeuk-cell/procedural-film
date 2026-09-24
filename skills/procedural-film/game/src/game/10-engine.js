// game/10-engine.js : the console program. One step function runs everything the cartridge does in
// a 60 Hz frame: the title, the lives screens, the levels (SMB-grade platformer physics on a 16 px
// tile grid), the goal (the beacon pole, the walk into the goal house, the tally and fireworks), the
// clear card and the final card. Live play (FILM.game.create) and the attract tape (GAME.ATTRACT,
// src/game/21-attract.js) both drive this same step(). Owner: game.
//
// Units: game px in the native 320x180 frame; velocities in px per frame. The SMB-style constants
// are written in 1/4096 px (Q(0x1900) = 1.5625 px/f), all exactly representable, so the simulation
// is bit-exact in any JS engine. No Math.random: nothing here is random.
//
// A world W is plain data. step(W, buttons) advances it one frame and returns that frame's events
// (docs/v2-architecture.md 4.2). snapshot(W) returns the compact record game/30-draw.js paints.
//
// Every world is live (W.live is always true). Levels are GAME.GAME_DEFS by id (src/game/01-levels.js);
// the game's name, hero and level order come from GAME.CONFIG (src/game/00-config.js).
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});

  const BUTTONS = Object.freeze({ A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128 });
  const { A, B, SELECT, START, UP, DOWN, LEFT, RIGHT } = BUTTONS;
  GAME.BUTTONS = BUTTONS;

  // ------------------------------------------------------------------------------------------
  // Physics constants (after the 1985 platformer's own tables)
  // ------------------------------------------------------------------------------------------
  const Q = (v) => v / 4096;
  const PH = {
    minWalk: Q(0x130), walkAcc: Q(0x098), runAcc: Q(0x0e4), relDec: Q(0x0d0), skidDec: Q(0x1a0),
    maxWalk: Q(0x1900), maxRun: Q(0x2900), skidTurn: Q(0x900), maxFall: 4,
    // [horizontal speed below which this row applies, jump velocity, gravity while A is held and rising, gravity otherwise]
    jumps: [
      [Q(0x1000), -4, Q(0x200), Q(0x700)],
      [Q(0x24ff), -4, Q(0x1e0), Q(0x600)],
      [Infinity, -5, Q(0x280), Q(0x900)],
    ],
    stompVy: -4,
    enemyWalk: 0.5, shellSpeed: 3, itemSpeed: 1, enemyGrav: 0.25,
  };
  GAME.PH = PH;

  const TIMER_FRAMES = 24; // the HUD clock ticks once every 24 frames
  const GROW_FRAMES = 60; // the power-up pause
  const TALLY_STEP = 10; // time units per tally tick (one tick a frame)
  const TITLE2_FRAMES = 20; // after START the cursor flickers this long
  const LIVES_FRAMES = 90; // the black lives screen
  const PIPE_DARK = 12; // frames between vanishing into a pipe and the next room
  const FANFARE = 168; // the course-clear fanfare: from landing at the pole's foot to the first tally tick
  const TALLY_HOLD = 5; // frames after the last tally tick before the lives screen
  const POP_LIFE = 48; // a score pop's life in frames
  const COMBO = [100, 200, 400, 500, 800, 1000, 2000, 4000, 5000, 8000];
  const POPS = ['100', '200', '400', '500', '800', '1000', '2000', '4000', '5000', '8000', '1UP', '50'];
  GAME.POPS = POPS;
  // backdrop flashes (NES colour index shown instead of the level's backdrop for a frame or two)
  const FLASH_PALE = 0x31;
  // the grow flicker: S small, M mid, L large, 5 frames each
  const GROW_SEQ = 'SMSMSMLSMLML';
  const BUMP_DY = [-3, -5, -6, -6, -5, -3, -2, -1];

  // the modern feel's assists (docs/game-spec.md 3.4)
  const COYOTE_FRAMES = 5; // a jump still counts this many airborne frames after walking off a ledge
  const BUFFER_FRAMES = 6; // an A press this early before landing jumps on the first grounded frame (A held)
  const CORNER_PX = 4; // a head graze of a block edge up to this many px slides past it
  const HURRY_AT = 100; // time units left when the hurry jingle plays
  const HURRY_JINGLE = 90; // the jingle's frames, then the fast song
  const CLEAR_FRAMES = 150; // the clear card
  const GAMEOVER_FRAMES = 180;
  const DEAD_FRAMES = 180;
  // the final card, after the last level's clear card
  const CREDITS_WAIT = 60; // START leaves the card from this long after it appears
  const CREDITS_HOLD = 3600; // the final card returns to the title by itself after this long
  const LIVES_START = 3, LIVES_MAX = 99, MULTI_WINDOW = 240, MULTI_MAX = 10;
  GAME.TIMING = Object.freeze({
    COYOTE_FRAMES, BUFFER_FRAMES, CORNER_PX, HURRY_AT, HURRY_JINGLE, CLEAR_FRAMES,
    GAMEOVER_FRAMES, DEAD_FRAMES, CREDITS_WAIT, CREDITS_HOLD, LIVES_FRAMES: 90, TITLE2_FRAMES: 20,
    LIVES_START, LIVES_MAX, MULTI_WINDOW, MULTI_MAX,
  });

  // ------------------------------------------------------------------------------------------
  // Tiles
  // ------------------------------------------------------------------------------------------
  const C = (ch) => ch.charCodeAt(0);
  const SOLID = new Uint8Array(128);
  // N: a 1UP block, C: a multi-coin brick, +: a hidden 1UP block (stops a head, never a body)
  for (const ch of '#BX?MU[]{}hH-_jJWGNC') SOLID[C(ch)] = 1;
  const DOT = C('.'), COIN = C('o'), USED = C('U'), BRICK = C('B'), QB = C('?'), MB = C('M');
  const WALL = C('#');
  const PLUS = C('+'), MULTI = C('C'), LIFE_B = C('N');
  GAME.SOLID = SOLID;

  const rowTop = (r) => r * 16 - 12;
  const rowOf = (y) => Math.floor((y + 12) / 16);
  GAME.rowTop = rowTop;
  GAME.rowOf = rowOf;

  // ------------------------------------------------------------------------------------------
  // Level definitions, by id (GAME.GAME_DEFS); the order and the first level from GAME.CONFIG
  // ------------------------------------------------------------------------------------------
  const CONFIG = () => GAME.CONFIG || {};
  const firstLevel = () => CONFIG().firstLevel || (CONFIG().order || [])[0] || (GAME.GAME_ORDER || [])[0] || '1-1';
  function defOf(W, key) {
    const d = GAME.GAME_DEFS && GAME.GAME_DEFS[key];
    if (!d) throw new Error(`${CONFIG().title || 'game'}: no level '${key}' in GAME.GAME_DEFS`);
    return d;
  }
  const mainOf = (def) => def.main || def.id;
  // the level the title screen shows: the first level's first screen
  function titleDef(W) {
    const G = GAME.GAME_DEFS || {};
    return G[firstLevel()] || G[W.startId];
  }
  GAME.mainOf = mainOf;
  // the tokens a main level holds: the `t` cells and def.tokens of it and its sub-areas
  function levelTokens(main) {
    const D = GAME.GAME_DEFS || {};
    let n = 0;
    for (const id in D) {
      const d = D[id];
      if (mainOf(d) !== main) continue;
      for (const row of d.rows || []) for (const ch of row) if (ch === 't') n++;
      n += (d.tokens || []).length;
    }
    return n;
  }
  // every token the game holds: those of each main level in the play order (GAME.CONFIG.order)
  function tokensMax() {
    const order = CONFIG().order || GAME.GAME_ORDER || [];
    let n = 0;
    for (const id of order) n += levelTokens(id);
    return n;
  }
  GAME.levelTokens = levelTokens;
  GAME.tokensMax = tokensMax;

  // The hero's body: centred on x + 8, 10 x 16 small, 20 x 22 big (the big drawing is 24 x 24).
  // y is the feet. bodyL / bodyR are the first and last pixel columns of the body.
  const HALF_W = (p) => (p.big ? 10 : 5);
  const bodyH = (p) => (p.big ? 22 : 16);
  const bodyL = (p) => p.x + 8 - HALF_W(p);
  const bodyR = (p) => p.x + 7 + HALF_W(p);
  const DRAW_H = (p) => (p.big ? 24 : 16); // the drawing's height, for pipes and the HUD rule
  GAME.drawTop = (p) => p.y - DRAW_H(p);

  function cell(lv, tx, ty) {
    if (ty < 0 || ty > 11) return DOT;
    if (tx < 0 || tx >= lv.w) return WALL; // the ends of a level are walls
    return lv.grid[ty * lv.w + tx];
  }
  const solidAt = (lv, x, y) => SOLID[cell(lv, Math.floor(x / 16), rowOf(y))] === 1;
  // a hidden block (+) stops a head, never a body
  const headAt = (lv, x, y) => {
    const c = cell(lv, Math.floor(x / 16), rowOf(y));
    return SOLID[c] === 1 || c === PLUS;
  };
  function setCell(lv, tx, ty, ch) {
    const i = ty * lv.w + tx;
    const code = typeof ch === 'number' ? ch : C(ch);
    if (lv.grid[i] === code) return;
    lv.grid[i] = code;
    lv.changes.push(i, code);
  }

  // The seam (docs/game-spec.md 2.4): enemy kinds (GAME.KINDS) and systems (GAME.systems) registered by
  // src/game/11..19 (src/game/15-tokens.js is one). A system's spawn hook may place a kind's enemy with
  // GAME.K.makeEnemy. Hooks that are absent are skipped.
  GAME.KINDS = GAME.KINDS || {};
  GAME.systems = GAME.systems || [];
  const systemsOf = () => GAME.systems;
  // an enemy's kind interface; the walker (`g`) has none
  const kindOf = (W, e) => GAME.KINDS[e.kind];
  // spawn-only characters that never stay in the grid, even with no system to take them
  const SPAWN_ONLY = { t: 1 };

  let buildSerial = 0;
  // def: a level definition; W: the world it is built for (the systems' spawn and build hooks see it);
  // key: its id (default def.id)
  function buildLevel(def, W, key) {
    if (key === undefined) key = def.id;
    const sys = systemsOf(W);
    const rows = def.rows;
    const w = rows[0].length;
    const grid = new Uint8Array(w * 12);
    const lv = {
      def, idx: key, w, grid, orig: null, changes: [], uid: ++buildSerial, maxCam: w * 16 - 320, t: 0,
      ents: [], pole: null, flagY: 0,
    };
    lv.multi = {}; // multi-coin bricks by cell index: { t0, n }
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < w; c++) {
        let ch = rows[r][c];
        const x = c * 16, feet = rowTop(r) + 16;
        let spawned = false;
        for (const s of sys) {
          if (s.spawn && s.spawn[ch]) {
            const left = s.spawn[ch](lv, c, r, def, W);
            ch = typeof left === 'string' && left.length === 1 ? left : '.';
            spawned = true;
            break;
          }
        }
        if (spawned) {
          // the system took the cell
        } else if (ch === 'g') {
          lv.ents.push(makeEnemy('walker', x, feet));
          ch = '.';
        } else if (ch === '!') {
          lv.pole = { tx: c, topY: rowTop(r) };
        } else if (SPAWN_ONLY[ch]) {
          ch = '.';
        }
        grid[r * w + c] = C(ch);
      }
    }
    lv.orig = grid.slice();
    // pipe tops for the pipe doors
    const rimRow = (tx) => {
      for (let r = 0; r < 12; r++) if (grid[r * w + tx] === C('[')) return r;
      return -1;
    };
    if (def.pipeDown) lv.pipeDownY = rowTop(rimRow(def.pipeDown.tx));
    if (def.pipeUp) lv.pipeUpY = rowTop(rimRow(def.pipeUp.tx));
    if (lv.pole) lv.flagY = lv.pole.topY + 8;
    // a level may cap its camera (def.camLock, in px)
    lv.camCap = def.camLock != null ? def.camLock : null;
    for (const s of sys) if (s.build) s.build(lv, def, W);
    return lv;
  }
  GAME.buildLevel = buildLevel;

  // ------------------------------------------------------------------------------------------
  // World
  // ------------------------------------------------------------------------------------------
  // coyote, buf: the assists' counters (modern feel)
  function newPlayer(x, y, big) {
    return {
      x, y, vx: 0, vy: 0, big: !!big, face: 1, ground: true, jumping: false, jumped: false,
      gHold: PH.jumps[0][2], gFall: PH.jumps[0][3], airMax: PH.maxWalk,
      skid: false, pose: 'idle', anim: 0, animT: 0, combo: 0,
      st: 'play', t: 0, hide: false, behind: false, inv: 0, growT: -1,
      coyote: 0, buf: 0,
    };
  }

  // opts: start (level id, default GAME.CONFIG.firstLevel), feel ('modern' | 'nes'), top (the saved
  // hi-score), shellMenu (the shell draws the title menu and the pause panel), and for proofs only
  // form ('small' | 'big') and lives.
  function newWorld(opts) {
    opts = opts || {};
    const feel = opts.feel === 'nes' ? 'nes' : 'modern';
    const W = {
      f: 0, mode: 'title', mt: 0, prev: 0, btn: 0,
      score: 0, coins: 0, lives: 3, top: 0,
      time: 400, timeT: 0, timerOn: false, world: '1-1',
      song: null, li: 0, lv: null, cam: 0, p: null,
      items: [], parts: [], pops: [], bumps: [],
      freeze: 0, seq: null, goal: null, pending: 0, ev: [], castleFlag: 0, poleScore: null,
      stats: { bugs: 0, coins: 0 }, introPlayed: false, flashC: 0, flashN: 0,
      live: true,
      // the visual clock: every animation in the snapshot reads it; it holds while paused
      vf: 0,
      feel, assist: feel === 'modern',
    };
    const form = opts.form === 'big' ? 'big' : 'small';
    const lives = Math.floor(Number(opts.lives));
    // an unknown start (a stale save) begins at the first level rather than failing at the lives screen
    const G = GAME.GAME_DEFS || {};
    const first = firstLevel();
    let startId = typeof opts.start === 'string' && opts.start ? opts.start : first;
    if (!G[startId] && G[first]) startId = first;
    Object.assign(W, {
      top: Math.max(0, Math.floor(Number(opts.top) || 0)),
      shellMenu: !!opts.shellMenu,
      startId,
      startForm: form,
      startLives: lives >= 1 ? Math.min(LIVES_MAX, lives) : LIVES_START,
      areas: [], // the current area and, inside a sub-area entered by a down pipe, its parent
      mainId: null, // the main level of the current area
      tokens: {}, // collected token bits by main level id, kept for the whole run
      mid: null, // the checkpoint passed: { id, tx, row }
      continues: 0, retries: 0, // retries: lives lost in the run
      bgm: null, hurried: false, hurryT: 0, // the level's song id, hurry state, the jingle's frames left
      lvCoins: 0, clearTime: 0, clearNext: null,
      cont: null, clear: null, credits: null,
    });
    showTitle(W);
    return W;
  }

  // a run's starting state (a new console, or back at the title after END or the credits)
  function newRun(W) {
    W.score = 0;
    W.coins = 0;
    W.lives = W.startLives;
    W.big = W.startForm !== 'small';
    W.tokens = {};
    W.mid = null;
    W.continues = 0;
    W.retries = 0;
    W.stats = { bugs: 0, coins: 0 };
    W.hurried = false;
    W.hurryT = 0;
    W.cont = null;
    W.clear = null;
    W.credits = null;
  }

  // docs/game-spec.md 3.1: START pauses only in open play
  function pausable(W) {
    const p = W.p;
    return !!(W.mode === 'play' && p && p.st === 'play' && W.freeze === 0 && !W.goal && !W.seq);
  }
  GAME.pausable = pausable;

  function tokenCount(W) {
    let n = 0;
    if (W.tokens) for (const k in W.tokens) for (let b = W.tokens[k] | 0; b; b &= b - 1) n++;
    return n;
  }
  GAME.tokenCount = tokenCount;

  function emit(W, type, data) {
    const e = { f: W.f, type };
    if (data) for (const k in data) e[k] = data[k];
    W.ev.push(e);
  }
  // section: which part of the overworld song ('intro' on the first start, 'A' the hook, 'B')
  function setSong(W, id, section) {
    const key = section ? id + '/' + section : id;
    if (W.song === key) return;
    W.song = key;
    emit(W, 'song', section ? { id, section } : { id });
  }
  function flash(W, color, n) {
    W.flashC = color;
    W.flashN = n;
  }
  function addScore(W, v) {
    W.score += v;
  }
  // a score pop centred on x with its top at y; pops born together stack 8 px apart
  function pop(W, idx, x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    for (let moved = true; moved; ) {
      moved = false;
      for (const s of W.pops) {
        if (s.t < 12 && Math.abs(s.x - x) < 22 && Math.abs(s.y - y) < 8) {
          y = Math.floor(s.y) - 8;
          moved = true;
        }
      }
    }
    W.pops.push({ v: idx, x, y, t: 0 });
  }
  // the score pop index for a label ('200' -> 1); -1 if there is none
  const popOf = (label) => POPS.indexOf(String(label));
  const gainLife = (W) => (W.lives = Math.min(LIVES_MAX, W.lives + 1));
  function comboPoints(W, n, x, y) {
    if (n <= COMBO.length) {
      addScore(W, COMBO[n - 1]);
      pop(W, n - 1, x, y);
    } else {
      gainLife(W);
      emit(W, 'oneup');
      pop(W, 10, x, y);
    }
  }
  function collectCoin(W) {
    W.coins++;
    W.stats.coins++;
    W.lvCoins++;
    addScore(W, 200);
    emit(W, 'coin');
    if (W.coins >= 100) {
      W.coins -= 100;
      gainLife(W);
      emit(W, 'oneup');
    }
  }

  // The level's song: its id in W.bgm, the fast variant after the hurry jingle (which holds it off
  // until it ends)
  function levelSong(W, section) {
    setSong(W, W.bgm + (W.hurried ? 'Fast' : ''), section);
  }
  function startHurry(W) {
    W.hurried = true;
    W.hurryT = HURRY_JINGLE;
    emit(W, 'hurry');
    setSong(W, 'hurry');
  }

  function showTitle(W) {
    W.mode = 'title';
    W.mt = 0;
    const def = titleDef(W);
    W.lv = buildLevel(def, W, def.id);
    W.li = def.id;
    W.areas = [W.lv];
    W.cam = 0;
    const s = W.lv.def.start;
    W.p = newPlayer(s.x, s.y, false);
    W.items = []; W.parts = []; W.pops = []; W.bumps = [];
    W.world = '1-1';
    W.timerOn = false;
    W.big = false;
    W.score = 0; W.coins = 0; W.lives = 3;
    W.stats = { bugs: 0, coins: 0 };
    W.introPlayed = false;
    W.seq = null;
    W.goal = null;
    W.freeze = 0;
    newRun(W);
  }

  // key: the id of the level to start after the lives screen
  function enterLives(W, key) {
    W.mode = 'lives';
    W.mt = 0;
    W.pending = key;
    W.world = defOf(W, key).world;
    W.timerOn = false;
    setSong(W, 'none');
  }

  // cap for the camera (the level's camLock, the level's end)
  const camCapOf = (lv) => (lv.camCap != null ? Math.min(lv.camCap, lv.maxCam) : lv.maxCam);

  function startLevel(W, key) {
    const def = defOf(W, key);
    const lv = buildLevel(def, W, key);
    W.areas = [lv];
    W.lv = lv;
    W.li = key;
    W.cam = 0;
    W.p = newPlayer(def.start.x, def.start.y, W.big);
    W.items = []; W.parts = []; W.pops = []; W.bumps = [];
    W.freeze = 0;
    W.seq = null;
    W.goal = null;
    W.poleScore = null;
    W.castleFlag = 0;
    W.time = def.time;
    W.timeT = 0;
    W.timerOn = def.time > 0;
    W.world = def.world;
    W.mode = 'play';
    W.mt = 0;
    let mid = null;
    const p = W.p;
    W.mainId = mainOf(def);
    W.hurried = false;
    W.hurryT = 0;
    W.bgm = def.song;
    W.lvCoins = 0;
    W.clear = null;
    // a respawn after the checkpoint: feet at the post, the camera on him, the enemies he had passed gone
    if (W.mid && W.mid.id === W.mainId && def.id === W.mainId && def.mid) {
      mid = W.mid;
      p.x = mid.tx * 16;
      p.y = rowTop(mid.row);
      p.ground = true;
      W.cam = Math.max(0, Math.min(camCapOf(lv), Math.floor(p.x + 8 - 128)));
      lv.ents = lv.ents.filter((e) => !(e.x < p.x + 64));
    } else if (def.start.drop) dropIn(p, def.start);
    if (def.kind === 'over') {
      // the overworld song opens with its intro only on the first start
      setSong(W, def.song, W.introPlayed ? 'A' : 'intro');
      W.introPlayed = true;
    } else setSong(W, def.song);
    emit(W, 'levelstart', { id: def.id, lives: W.lives, checkpoint: !!mid });
    for (const s of GAME.systems) if (s.enter) s.enter(W, lv);
  }

  // a drop start: the head just clear of the HUD band at start.y, falling
  function dropIn(p, s) {
    p.x = s.x;
    p.y = s.y + DRAW_H(p);
    p.vx = 0;
    p.vy = 0;
    p.ground = false;
    p.jumping = false;
    p.jumped = false;
    p.gFall = PH.jumps[0][3];
  }

  // ------------------------------------------------------------------------------------------
  // Step
  // ------------------------------------------------------------------------------------------
  function step(W, btn) {
    W.ev = [];
    btn &= 255;
    const pressed = btn & ~W.prev;
    W.btn = btn;
    // pause: the world and every clock hold; only f, prev, btn and ev change
    if (W.mode === 'pause' || (W.mode === 'play' && pressed & START && pausable(W))) {
      if (W.mode === 'play') {
        W.mode = 'pause';
        W.p.buf = 0;
        emit(W, 'pause');
      } else if (pressed & START) {
        W.mode = 'play';
        emit(W, 'unpause');
      }
      W.prev = btn;
      W.f++;
      return W.ev;
    }
    if (W.flashN > 0) W.flashN--;
    switch (W.mode) {
      case 'title':
        if (W.f === 0 || W.mt === 0) setSong(W, 'title');
        W.mt++;
        if (pressed & START) {
          emit(W, 'start');
          setSong(W, 'none');
          W.mode = 'title2';
          W.mt = 0;
        }
        break;
      case 'title2':
        if (++W.mt >= TITLE2_FRAMES) enterLives(W, W.startId);
        break;
      case 'lives':
        if (++W.mt >= LIVES_FRAMES) startLevel(W, W.pending);
        break;
      case 'play':
        W.mt++;
        play(W, btn, pressed);
        break;
      case 'gameover':
        if (++W.mt >= GAMEOVER_FRAMES) {
          W.mode = 'continue';
          W.mt = 0;
          W.cont = { sel: 0 };
        }
        break;
      case 'continue':
        continueStep(W, pressed);
        break;
      case 'clear':
        if (++W.mt >= CLEAR_FRAMES) {
          const next = W.clearNext;
          W.clear = null;
          W.clearNext = null;
          if (next) enterLives(W, next);
          else enterCredits(W);
        }
        break;
      case 'credits':
        creditsStep(W, pressed);
        break;
    }
    W.prev = btn;
    W.f++;
    W.vf++;
    return W.ev;
  }
  GAME.step = step;
  GAME.newWorld = newWorld;

  // the continue screen: UP, DOWN or SELECT moves the cursor, A or START confirms
  function continueStep(W, pressed) {
    W.mt++;
    const c = W.cont;
    if (pressed & (UP | DOWN | SELECT)) {
      c.sel ^= 1;
      emit(W, 'cursor');
    } else if (pressed & (A | START)) {
      W.cont = null;
      if (c.sel === 0) {
        const id = W.mainId || W.startId;
        W.lives = LIVES_START;
        W.score = 0;
        W.coins = 0;
        W.continues++;
        W.mid = null;
        W.big = false;
        emit(W, 'continue', { id });
        enterLives(W, id);
      } else {
        emit(W, 'quit');
        showTitle(W);
      }
    }
  }

  // the clear card, entered when the goal's fireworks are done
  function enterClear(W) {
    const def = W.lv.def;
    const id = mainOf(def);
    const tokens = W.tokens[id] | 0;
    const mdef = (GAME.GAME_DEFS && GAME.GAME_DEFS[id]) || def;
    W.mid = null;
    W.clear = { id, name: mdef.name || '', tokens, max: levelTokens(id), coins: W.lvCoins, time: W.clearTime, score: W.score };
    W.clearNext = def.next || mdef.next || null;
    W.mode = 'clear';
    W.mt = 0;
    W.timerOn = false;
    setSong(W, 'none');
    emit(W, 'clear', { id, score: W.score, time: W.clearTime, tokens });
  }

  // the final card, after the last level's clear card (its own song, GAME CLEAR, the run's totals).
  // START returns to the title from CREDITS_WAIT frames in; it goes back by itself at CREDITS_HOLD.
  function enterCredits(W) {
    const n = tokenCount(W);
    const max = tokensMax();
    W.credits = { t: 0, score: W.score, top: W.top, tokens: n, max, perfect: max > 0 && n >= max };
    W.mode = 'credits';
    W.mt = 0;
    setSong(W, 'credits');
    emit(W, 'credits', { score: W.score, tokens: n, retries: W.retries | 0 });
  }
  function creditsStep(W, pressed) {
    const c = W.credits;
    c.t++;
    W.mt++;
    if ((c.t >= CREDITS_WAIT && pressed & START) || c.t >= CREDITS_HOLD) {
      W.credits = null;
      showTitle(W);
    }
  }

  // A copy of a world that shares nothing mutable with it (the tape's planner plays futures on copies).
  // Level definitions and original grids never change and are shared. A level also copies its change
  // log (a cloned console can be drawn), its multi-coin bricks, and whatever each system added (their
  // cloneLevel hooks).
  const flat = (o) => (o ? Object.assign({}, o) : o);
  function cloneLevel(lv) {
    const c = Object.assign({}, lv);
    c.grid = lv.grid.slice();
    c.changes = lv.changes.slice();
    c.hist = null;
    c.histLen = -1;
    c.ents = lv.ents.map(flat);
    if (lv.multi) {
      c.multi = {};
      for (const k in lv.multi) c.multi[k] = flat(lv.multi[k]);
    }
    for (const s of GAME.systems) if (s.cloneLevel) s.cloneLevel(lv, c);
    return c;
  }
  function cloneWorld(W) {
    const c = Object.assign({}, W);
    const map = new Map();
    const lvOf = (lv) => {
      if (!lv) return lv;
      if (!map.has(lv)) map.set(lv, cloneLevel(lv));
      return map.get(lv);
    };
    c.lv = lvOf(W.lv);
    c.p = flat(W.p);
    c.items = W.items.map(flat);
    c.parts = W.parts.map(flat);
    c.pops = W.pops.map(flat);
    c.bumps = W.bumps.map(flat);
    c.seq = flat(W.seq);
    c.goal = flat(W.goal);
    c.poleScore = flat(W.poleScore);
    c.stats = flat(W.stats);
    c.ev = [];
    c.areas = W.areas.map(lvOf);
    c.tokens = Object.assign({}, W.tokens);
    c.mid = flat(W.mid);
    c.cont = flat(W.cont);
    c.clear = flat(W.clear);
    c.credits = flat(W.credits);
    for (const s of GAME.systems) if (s.cloneWorld) s.cloneWorld(W, c);
    return c;
  }
  GAME.cloneWorld = cloneWorld;

  function play(W, btn, pressed) {
    const lv = W.lv;
    const p = W.p;
    // the hurry jingle runs on the play clock; then the fast song, unless something else took the music
    if (W.hurryT > 0 && --W.hurryT === 0 && W.song === 'hurry') levelSong(W, lv.def.kind === 'over' ? 'A' : undefined);
    if (W.freeze > 0) {
      // the power-up pause: only the player's grow flicker runs
      p.growT = GROW_FRAMES - W.freeze;
      W.freeze--;
      if (W.freeze === 0) {
        p.big = true;
        W.big = true;
        p.growT = -1;
      }
      return;
    }
    const frozen = p.st === 'dead'; // a death holds the world still
    if (!frozen) lv.t++;
    const sys = systemsOf(W);
    if (!frozen) for (const s of sys) if (s.pre) s.pre(W, lv, p);
    if (p.st === 'play') controlPlayer(W, lv, p, btn, pressed);
    else scripted(W, lv, p);
    if (W.mode !== 'play' || W.lv !== lv) return; // a door or a death changed the scene
    if (p.st === 'play') passCheckpoint(W, lv, p);
    if (!frozen) {
      stepEnemies(W, lv, btn);
      stepItems(W, lv);
    }
    if (!frozen) for (const s of sys) if (s.step) s.step(W, lv);
    stepParts(W, lv);
    // the camera only scrolls forward, holding the player at 40% of the screen
    if (p.st === 'play' || p.st === 'walkCastle' || p.st === 'poleHop') {
      // catching up after a pause (the flagpole swing) eases in at up to 3 px a frame
      const tgt = Math.floor(p.x + 8 - 128);
      const cap = lv.camCap != null ? Math.min(lv.camCap, lv.maxCam) : lv.maxCam;
      if (tgt > W.cam && W.cam < cap) W.cam = Math.min(tgt, cap, W.cam + Math.max(3, Math.ceil(Math.abs(p.vx))));
    }
    if (W.timerOn && p.st === 'play') {
      if (++W.timeT >= TIMER_FRAMES) {
        W.timeT = 0;
        if (W.time > 0) W.time--;
        if (W.time === HURRY_AT && !W.hurried) startHurry(W);
        if (W.time === 0) hurt(W, true, 'time');
      }
    }
    if (p.inv > 0) p.inv--;
    if (W.score > W.top) W.top = W.score;
  }

  // the checkpoint post: passed when his body's left edge reaches its column in the main level
  function passCheckpoint(W, lv, p) {
    const def = lv.def;
    if (!def.mid || mainOf(def) !== def.id || (W.mid && W.mid.id === def.id)) return;
    if (bodyL(p) >= def.mid.tx * 16) {
      W.mid = { id: def.id, tx: def.mid.tx, row: def.mid.row };
      emit(W, 'checkpoint', { id: def.id });
    }
  }

  // ------------------------------------------------------------------------------------------
  // The player under control
  // ------------------------------------------------------------------------------------------
  function controlPlayer(W, lv, p, btn, pressed) {
    const d = (btn & RIGHT ? 1 : 0) - (btn & LEFT ? 1 : 0);
    const run = (btn & B) !== 0;
    let bufSet = false;
    if (p.ground) {
      const maxV = run ? PH.maxRun : PH.maxWalk;
      if (d !== 0) {
        if (p.vx !== 0 && Math.sign(p.vx) !== d) {
          // skid: brake hard, turn round once slow enough
          const s = Math.abs(p.vx) - PH.skidDec;
          if (s <= PH.skidTurn) {
            p.vx = 0;
            p.skid = false;
          } else {
            p.vx = Math.sign(p.vx) * s;
            p.skid = true;
          }
          p.face = d;
        } else {
          p.skid = false;
          p.face = d;
          let s = Math.abs(p.vx);
          if (s < PH.minWalk) s = PH.minWalk;
          else if (s < maxV) s = Math.min(maxV, s + (run ? PH.runAcc : PH.walkAcc));
          else if (s > maxV) s = Math.max(maxV, s - PH.relDec);
          p.vx = d * s;
        }
      } else {
        p.skid = false;
        const s = Math.abs(p.vx) - PH.relDec;
        p.vx = s <= 0 ? 0 : Math.sign(p.vx) * s;
      }
      // the jump buffer (modern): an A press made just before landing, still held, jumps now
      if (pressed & A || (W.assist && p.buf > 0 && btn & A)) jump(W, p, run);
    } else {
      if (d !== 0) {
        // air control: keep momentum, steer within the speed the jump started with
        const acc = Math.abs(p.vx) >= PH.maxWalk ? PH.runAcc : PH.walkAcc;
        let nv = p.vx + d * acc;
        if (nv * d > p.airMax) nv = d * Math.max(p.airMax, p.vx * d);
        p.vx = nv;
      }
      if (W.assist) {
        // coyote time: a jump a few frames after walking off a ledge still counts as a ground jump;
        // any other airborne A press is buffered for the landing
        if (pressed & A) {
          if (p.coyote > 0 && !p.jumped) jump(W, p, run);
          else {
            p.buf = BUFFER_FRAMES;
            bufSet = true;
          }
        }
        if (!p.ground && p.coyote > 0) p.coyote--;
      }
    }
    if (p.buf > 0 && !bufSet) p.buf--;

    moveX(W, lv, p);
    moveY(W, lv, p, btn);
    animate(p, d);
    touchTiles(W, lv, p);
    doors(W, lv, p, btn);
    if (p.y > 200) die(W, 'pit');
  }

  // a ground jump: the jump row from the current speed, the air speed cap from the run state
  function jump(W, p, run) {
    const s = Math.abs(p.vx);
    const row = PH.jumps.find((j) => s < j[0]);
    p.vy = row[1];
    p.gHold = row[2];
    p.gFall = row[3];
    p.jumping = true;
    p.jumped = true;
    p.ground = false;
    p.skid = false;
    p.airMax = run || s > PH.maxWalk ? PH.maxRun : PH.maxWalk;
    p.coyote = 0;
    p.buf = 0;
    emit(W, 'jump', { big: p.big });
  }

  function moveX(W, lv, p) {
    p.x += p.vx;
    if (p.x < W.cam) {
      p.x = W.cam;
      if (p.vx < 0) p.vx = 0;
    }
    const offs = p.big ? [2, 11, 20] : [2, 13];
    const hw = HALF_W(p);
    const R = bodyR(p), L = bodyL(p);
    if (p.vx >= 0) {
      for (const o of offs) {
        if (solidAt(lv, R, p.y - o)) {
          p.x = Math.floor(R / 16) * 16 - 8 - hw;
          if (p.vx > 0) p.vx = 0;
          return;
        }
      }
    }
    if (p.vx <= 0) {
      for (const o of offs) {
        if (solidAt(lv, L, p.y - o)) {
          p.x = Math.floor(L / 16) * 16 + 8 + hw;
          if (p.vx < 0) p.vx = 0;
          return;
        }
      }
    }
  }

  function land(p) {
    p.ground = true;
    p.vy = 0;
    p.jumping = false;
    p.jumped = false;
    p.combo = 0;
    p.coyote = 0;
  }

  function moveY(W, lv, p, btn) {
    const h = bodyH(p);
    const lx = bodyL(p) + 1, rx = bodyR(p) - 1;
    if (p.ground) {
      if (solidAt(lv, lx, p.y) || solidAt(lv, rx, p.y)) return;
      // walked off a ledge: fall with the gravity of the current speed
      p.ground = false;
      p.jumping = false;
      p.vy = 0;
      const row = PH.jumps.find((j) => Math.abs(p.vx) < j[0]);
      p.gFall = row[3];
      if (W.assist) p.coyote = COYOTE_FRAMES;
    }
    if (!(btn & A)) p.jumping = false;
    p.vy += p.jumping && p.vy < 0 ? p.gHold : p.gFall;
    if (p.vy > PH.maxFall) p.vy = PH.maxFall;
    const y0 = p.y;
    p.y += p.vy;
    if (p.vy < 0) {
      const hy = p.y - h;
      const cx = p.x + 8;
      // head-corner correction (modern): a graze of a block's edge slides past it
      if (W.assist && p.vy <= -1 && cornerSlip(W, lv, p, hy, lx, rx, cx)) return;
      let hx = null;
      if (headAt(lv, cx, hy)) hx = cx;
      else if (headAt(lv, lx, hy)) hx = lx;
      else if (headAt(lv, rx, hy)) hx = rx;
      if (hx !== null) {
        const ty = rowOf(hy);
        p.y = rowTop(ty) + 16 + h;
        p.vy = 0;
        p.jumping = false;
        bumpBlock(W, lv, Math.floor(hx / 16), ty);
      }
    } else if (solidAt(lv, lx, p.y) || solidAt(lv, rx, p.y)) {
      const top = rowTop(rowOf(p.y));
      if (top >= y0 - 1) {
        p.y = top;
        land(p);
      }
    }
  }

  // docs/game-spec.md 5.2 E-corner: the centre probe clear and exactly one edge probe in a block that is
  // not hidden (+): shift him clear by at most CORNER_PX if nothing else is then in the way
  function cornerSlip(W, lv, p, hy, lx, rx, cx) {
    if (headAt(lv, cx, hy)) return false;
    const hl = headAt(lv, lx, hy), hr = headAt(lv, rx, hy);
    if (hl === hr) return false;
    const hx = hl ? lx : rx;
    const col = Math.floor(hx / 16);
    const c = cell(lv, col, rowOf(hy));
    if (c === PLUS) return false;
    const shift = hl ? (col + 1) * 16 - lx : -(rx - col * 16 + 1);
    if (Math.abs(shift) > CORNER_PX) return false;
    const nx = p.x + shift;
    if (nx < W.cam) return false;
    const hw = HALF_W(p);
    const L = nx + 8 - hw, R = nx + 7 + hw;
    if (headAt(lv, nx + 8, hy) || headAt(lv, L + 1, hy) || headAt(lv, R - 1, hy)) return false;
    for (const o of p.big ? [2, 11, 20] : [2, 13]) if (solidAt(lv, L, p.y - o) || solidAt(lv, R, p.y - o)) return false;
    p.x = nx;
    return true;
  }

  // d: the direction held (a player pushing against a wall keeps walking on the spot)
  function animate(p, d) {
    if (p.ground) {
      if (p.skid) p.pose = 'skid';
      else if (p.vx === 0 && !d) {
        p.pose = 'idle';
        p.animT = 0;
      } else {
        const s = Math.max(Math.abs(p.vx), d ? 0.5 : 0);
        const period = s >= 2.25 ? 3 : s >= 1.5 ? 4 : s >= 0.8 ? 6 : 8;
        if (++p.animT >= period) {
          p.animT = 0;
          p.anim = (p.anim + 1) % 3;
        }
        p.pose = 'run' + (p.anim + 1);
      }
    } else if (p.jumped) p.pose = 'jump';
  }

  // coins the body touches
  function touchTiles(W, lv, p) {
    const h = bodyH(p);
    const x0 = Math.floor(bodyL(p) / 16), x1 = Math.floor(bodyR(p) / 16);
    const y0 = rowOf(p.y - h + 2), y1 = rowOf(p.y - 1);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (cell(lv, tx, ty) === COIN) {
          setCell(lv, tx, ty, DOT);
          collectCoin(W);
        }
      }
    }
  }

  // pipes and the goal pole
  function doors(W, lv, p, btn) {
    const def = lv.def;
    if (def.pipeDown && p.ground && btn & DOWN && !(btn & (LEFT | RIGHT))) {
      const px = def.pipeDown.tx * 16;
      if (p.x + 8 >= px + 4 && p.x + 8 <= px + 28 && p.y === lv.pipeDownY) {
        p.st = 'pipeDown';
        p.t = 0;
        p.vx = 0;
        p.behind = true;
        p.pose = 'idle';
        emit(W, 'pipe');
        setSong(W, 'none'); // the console silences the music as he goes in
        return;
      }
    }
    // the side pipe's mouth is rows row..row+1; he walks in standing on the row below it
    if (def.pipeSide && p.ground && btn & RIGHT && p.y === rowTop(def.pipeSide.row != null ? def.pipeSide.row + 2 : 10)) {
      const mx = def.pipeSide.tx * 16;
      if (bodyR(p) + 1 >= mx) {
        p.st = 'pipeSide';
        p.t = 0;
        p.vx = 0;
        p.face = 1;
        p.behind = true;
        emit(W, 'pipe');
        setSong(W, 'none');
        return;
      }
    }
    if (lv.pole) {
      const poleX = lv.pole.tx * 16 + 7;
      if (bodyR(p) + 1 >= poleX) grabPole(W, lv, p);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Blocks
  // ------------------------------------------------------------------------------------------
  function bumpBlock(W, lv, tx, ty) {
    const c = cell(lv, tx, ty);
    const p = W.p;
    const x = tx * 16, y = rowTop(ty);
    if (c === QB) {
      setCell(lv, tx, ty, USED);
      W.bumps.push({ tx, ty, t: 0, code: USED });
      W.parts.push({ k: 'coin', x: x + 4, y: y - 14, vy: -5.5, y0: y - 14, t: 0 });
      collectCoin(W);
      bumpTop(W, lv, tx, ty);
    } else if (c === MB || c === LIFE_B || c === PLUS) {
      // M: the power-up; N and +: the 1UP (the power-up's drawing in the life palette)
      const k = c === MB ? 'power' : 'life';
      setCell(lv, tx, ty, USED);
      W.bumps.push({ tx, ty, t: 0, code: USED });
      W.items.push({ k, x, y: y + 16, vx: 0, vy: 0, st: 'sprout', t: 0, ground: true, y1: y });
      emit(W, 'sprout');
      bumpTop(W, lv, tx, ty);
    } else if (c === MULTI) {
      // the multi-coin brick: a coin a bump; the first bump opens a MULTI_WINDOW-frame window; it is spent
      // (used) on the bump that pays the 10th coin, or on the first bump after the window (that one pays)
      const i = ty * lv.w + tx;
      const m = lv.multi[i] || (lv.multi[i] = { t0: lv.t, n: 0 });
      const late = lv.t - m.t0 >= MULTI_WINDOW;
      m.n++;
      const spent = m.n >= MULTI_MAX || late;
      if (spent) setCell(lv, tx, ty, USED);
      W.bumps.push({ tx, ty, t: 0, code: spent ? USED : MULTI });
      W.parts.push({ k: 'coin', x: x + 4, y: y - 14, vy: -5.5, y0: y - 14, t: 0 });
      collectCoin(W);
      bumpTop(W, lv, tx, ty);
    } else if (c === BRICK) {
      if (p.big) {
        setCell(lv, tx, ty, DOT);
        for (let i = 0; i < 4; i++) {
          const right = i & 1, low = i >> 1;
          W.parts.push({ k: 'frag', x: x + right * 8, y: y + low * 8, vx: right ? 1 : -1, vy: low ? -4 : -6, t: 0, flip: !!right });
        }
        addScore(W, 50);
        emit(W, 'brick');
        bumpTop(W, lv, tx, ty);
      } else {
        W.bumps.push({ tx, ty, t: 0, code: BRICK });
        emit(W, 'bump');
        bumpTop(W, lv, tx, ty);
      }
    } else {
      emit(W, 'bump');
    }
  }

  // a block knocked from below knocks whatever stands on it
  function bumpTop(W, lv, tx, ty) {
    const top = rowTop(ty), x = tx * 16;
    for (const e of lv.ents) {
      if (!alive(e) || e.st === 'wait') continue;
      const K = kindOf(W, e);
      if (K && K.flier) continue; // a flier never stands on a block
      if (Math.abs(e.y - top) <= 2 && e.x + 14 > x && e.x + 2 < x + 16) knock(W, e, e.x + 8 >= x + 8 ? 1 : -1, 1);
    }
    for (const it of W.items) {
      if (it.st === 'move' && Math.abs(it.y - top) <= 2 && it.x + 14 > x && it.x + 2 < x + 16) {
        it.vy = -3.5;
        it.ground = false;
        it.vx = (it.x + 8 >= x + 8 ? 1 : -1) * Math.abs(it.vx || PH.itemSpeed);
      }
    }
    if (cell(lv, tx, ty - 1) === COIN) {
      setCell(lv, tx, ty - 1, DOT);
      W.parts.push({ k: 'coin', x: x + 4, y: top - 30, vy: -5.5, y0: top - 30, t: 0 });
      collectCoin(W);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Enemies
  // ------------------------------------------------------------------------------------------
  function makeEnemy(kind, x, y) {
    return { kind, x, y, vx: -PH.enemyWalk, vy: 0, ground: true, st: 'wait', t: 0, grace: 0, chain: 0 };
  }
  const alive = (e) => e.st === 'walk' || e.st === 'wait';
  // the top of an enemy's body: the walker stands 14 px; a kind says its own
  const eTop = (e, K) => e.y - (K ? K.top : 14);
  // score pops start just above the drawing (every enemy drawing is 16 tall), centred on it
  const popX = (e) => e.x + 8;
  const popY = (e) => e.y - 16 - 8;

  function walker(lv, e) {
    e.x += e.vx;
    const yy = e.y - 8;
    if (e.vx > 0 && solidAt(lv, e.x + 14, yy)) {
      e.x = Math.floor((e.x + 14) / 16) * 16 - 15;
      e.vx = -e.vx;
      return 1;
    }
    if (e.vx < 0 && solidAt(lv, e.x + 1, yy)) {
      e.x = Math.floor((e.x + 1) / 16) * 16 + 15;
      e.vx = -e.vx;
      return 1;
    }
    if (e.ground && !solidAt(lv, e.x + 4, e.y) && !solidAt(lv, e.x + 11, e.y)) {
      e.ground = false;
      e.vy = 0;
    }
    if (!e.ground) {
      e.vy = Math.min(PH.maxFall, e.vy + PH.enemyGrav);
      const y0 = e.y;
      e.y += e.vy;
      if (solidAt(lv, e.x + 4, e.y) || solidAt(lv, e.x + 11, e.y)) {
        const top = rowTop(rowOf(e.y));
        if (top >= y0 - 1) {
          e.y = top;
          e.vy = 0;
          e.ground = true;
        }
      }
    }
    return 0;
  }

  function knock(W, e, dir, n) {
    W.stats.bugs++;
    e.st = 'dead';
    e.vy = -3;
    e.vx = dir * 0.75;
    e.t = 0;
    comboPoints(W, n, popX(e), popY(e));
    emit(W, 'kick', { combo: n });
  }

  function stepEnemies(W, lv, btn) {
    const p = W.p;
    const ents = lv.ents;
    for (const e of ents) {
      if (e.st === 'gone') continue;
      if (e.st === 'wait') {
        if (e.x <= W.cam + 320 + 8) e.st = 'walk';
        else continue;
      }
      e.t++;
      if (e.grace > 0) e.grace--;
      if (e.st === 'flat') {
        if (e.t > 30) e.st = 'gone';
        continue;
      }
      if (e.st === 'dead') {
        e.vy = Math.min(PH.maxFall, e.vy + PH.enemyGrav);
        e.x += e.vx;
        e.y += e.vy;
        if (e.y > 220) e.st = 'gone';
        continue;
      }
      const K = kindOf(W, e);
      if (K) K.move(W, lv, e);
      else walker(lv, e);
      if (e.y > 220 || e.x < W.cam - 48 || e.x > W.cam + 400) e.st = 'gone';
    }
    // enemy against enemy: two walkers turn away from each other; fliers pass by
    for (let i = 0; i < ents.length; i++) {
      const a = ents[i];
      if (a.st !== 'walk') continue;
      for (let j = i + 1; j < ents.length; j++) {
        const b = ents[j];
        if (b.st !== 'walk') continue;
        if (Math.abs(a.x - b.x) >= 14 || Math.abs(a.y - b.y) >= 14) continue;
        const Ka = kindOf(W, a), Kb = kindOf(W, b);
        if ((Ka && Ka.flier) || (Kb && Kb.flier)) continue;
        const l = a.x < b.x ? a : b, r = l === a ? b : a;
        if (l.vx > 0) l.vx = -l.vx;
        if (r.vx < 0) r.vx = -r.vx;
      }
    }
    if (p.st !== 'play') return;
    const pl = bodyL(p), pr = bodyR(p) + 1, pt = p.y - bodyH(p) + 4, pb = p.y;
    for (const e of ents) {
      if (e.st !== 'walk') continue;
      const K = kindOf(W, e);
      const el = e.x + 2, er = e.x + 14, et = eTop(e, K), eb = e.y;
      if (!(pr > el && pl < er && pb > et && pt < eb)) continue;
      if (K && K.spiky) {
        // spikes hurt from every side, a stomp included
        if (p.inv > 0) continue;
        hurt(W, false, 'spike');
        return;
      }
      if (p.vy > 0 && p.y - p.vy <= et + 6) {
        stomp(W, e, p, btn);
        continue;
      }
      if (p.inv > 0) continue;
      hurt(W, false, 'enemy');
      return;
    }
  }

  function stomp(W, e, p, btn) {
    p.combo++;
    emit(W, 'stomp', { combo: p.combo });
    const K = kindOf(W, e);
    if (K) {
      if (K.onStomp) K.onStomp(W, W.lv, e, p);
    } else {
      e.st = 'flat';
      e.t = 0;
      W.stats.bugs++;
      comboPoints(W, p.combo, popX(e), popY(e));
    }
    p.vy = PH.stompVy;
    p.jumping = (btn & A) !== 0;
    p.gHold = PH.jumps[0][2];
    p.gFall = PH.jumps[0][3];
    p.ground = false;
    p.coyote = 0;
    p.buf = 0;
  }

  // A hit: the big hero drops to small with 120 invincible frames in both feel modes (D6); the small
  // hero dies. cause: enemy, spike (a kind's), pit, time.
  function hurt(W, fatal, cause) {
    const p = W.p;
    if (!fatal && p.big) {
      p.big = false;
      W.big = false;
      p.inv = 120;
      emit(W, 'hurt', { cause: cause || 'enemy' });
      return;
    }
    die(W, cause);
  }

  function die(W, cause) {
    const p = W.p;
    if (p.st === 'dead') return;
    p.st = 'dead';
    p.t = 0;
    p.vx = 0;
    p.vy = 0;
    p.big = false;
    W.big = false;
    W.timerOn = false;
    p.buf = 0;
    p.coyote = 0;
    p.growT = -1;
    W.freeze = 0;
    emit(W, 'die', { cause: cause || 'enemy' });
    setSong(W, 'death');
  }

  // ------------------------------------------------------------------------------------------
  // Items: the power-up and the 1UP
  // ------------------------------------------------------------------------------------------
  function stepItems(W, lv) {
    const p = W.p;
    for (const it of W.items) {
      if (it.gone) continue;
      it.t++;
      if (it.st === 'sprout') {
        it.y -= 0.5;
        if (it.y <= it.y1) {
          it.y = it.y1;
          it.st = 'move';
          it.vx = PH.itemSpeed;
        }
        continue;
      }
      walker(lv, it);
      if (it.y > 220 || it.x < W.cam - 32) {
        it.gone = true;
        continue;
      }
      if (p.st !== 'play') continue;
      if (bodyR(p) + 1 > it.x + 2 && bodyL(p) < it.x + 14 && p.y > it.y - 14 && p.y - bodyH(p) < it.y) {
        it.gone = true;
        if (it.k === 'life') {
          // the 1UP: a life, no points
          gainLife(W);
          emit(W, 'oneup');
          pop(W, 10, p.x + 8, p.y - DRAW_H(p) - 12);
          continue;
        }
        addScore(W, 1000);
        // the pop rises from above his head (the grown head)
        pop(W, 5, p.x + 8, p.y - 24 - 12);
        emit(W, 'powerup');
        if (!p.big) {
          W.freeze = GROW_FRAMES;
          p.growT = 0;
        }
      }
    }
    W.items = W.items.filter((it) => !it.gone);
  }

  // ------------------------------------------------------------------------------------------
  // Particles, score pops, bumped blocks
  // ------------------------------------------------------------------------------------------
  function stepParts(W, lv) {
    for (const q of W.parts) {
      q.t++;
      if (q.k === 'coin') {
        q.y += q.vy;
        q.vy += 0.35;
        if (q.vy > 0 && q.y >= q.y0 - 18) {
          q.gone = true;
          pop(W, 1, q.x + 4, q.y - 8);
        }
      } else if (q.k === 'frag') {
        q.x += q.vx;
        q.y += q.vy;
        q.vy += 0.3;
        if (q.y > 200) q.gone = true;
      } else if (q.k === 'fw') {
        if (q.t >= FW_LIFE) q.gone = true;
      }
    }
    W.parts = W.parts.filter((q) => !q.gone);
    // score pops keep rising for their whole life
    for (const s of W.pops) {
      s.t++;
      s.y -= s.t <= 16 ? 1 : 0.5;
    }
    W.pops = W.pops.filter((s) => s.t < POP_LIFE);
    for (const b of W.bumps) b.t++;
    W.bumps = W.bumps.filter((b) => b.t < BUMP_DY.length);
  }

  // ------------------------------------------------------------------------------------------
  // The goal: the beacon pole, then the walk into the goal house
  // ------------------------------------------------------------------------------------------
  function grabPole(W, lv, p) {
    const pole = lv.pole;
    const top = p.y - DRAW_H(p);
    const rel = top - pole.topY;
    const score = rel <= 12 ? 5000 : rel <= 36 ? 2000 : rel <= 60 ? 800 : rel <= 80 ? 400 : 100;
    const idx = POPS.indexOf(String(score));
    addScore(W, score);
    // the slide: the hero and the flag come down together, at about 3 px a frame, in `frames` frames
    const base = rowTop(9);
    const frames = Math.max(1, Math.ceil((base - p.y) / 3));
    W.slide = { y0: p.y, f0: lv.flagY, frames };
    emit(W, 'flagpole', { height: score, frames });
    setSong(W, 'none');
    W.timerOn = false;
    W.clearTime = W.time; // the clear card's TIME: the clock at the grab
    // fireworks: three for a grab at the very top, otherwise the clock's last digit if it is 1, 3 or 6
    W.fireworks = score === 5000 ? 3 : [1, 3, 6].indexOf(W.time % 10) >= 0 ? W.time % 10 : 0;
    p.st = 'pole';
    p.t = 0;
    p.vx = 0;
    p.vy = 0;
    p.x = pole.tx * 16 + 7 - 8 - HALF_W(p); // the body's right edge against the pole
    p.face = 1;
    p.pose = 'pole1';
    W.poleScore = { v: idx, x: pole.tx * 16 + 22, y: rowTop(9) + 4, yEnd: Math.max(pole.topY + 4, Math.floor(top)) };
    W.seq = { k: 'flag', t: 0 };
  }

  // ------------------------------------------------------------------------------------------
  // Scripted player states (pipes, pole, the walk into the goal house, death)
  // ------------------------------------------------------------------------------------------
  function scripted(W, lv, p) {
    p.t++;
    if (W.goal) goalSeq(W, lv, p);
    if (W.mode !== 'play') return;
    const h = DRAW_H(p);
    switch (p.st) {
      case 'pipeDown':
        p.y += 1;
        if (p.t >= h + 2) {
          p.hide = true;
          p.st = 'pipeGone';
          p.t = 0;
        }
        break;
      case 'pipeGone':
        if (p.t >= PIPE_DARK) enterArea(W, lv.def.pipeDown.to);
        break;
      case 'pipeSide':
        p.x += 1;
        animate(p, 1);
        if (p.t >= 20) {
          p.hide = true;
          p.st = 'pipeGone2';
          p.t = 0;
        }
        break;
      case 'pipeGone2':
        if (p.t >= PIPE_DARK) exitArea(W, lv.def.pipeSide);
        break;
      case 'pipeUp':
        p.y -= 1;
        if (p.y <= lv.pipeUpY) {
          p.y = lv.pipeUpY;
          p.st = 'play';
          p.behind = false;
          land(p);
        }
        break;
      case 'pole':
        flagSeq(W, lv, p);
        break;
      case 'poleHop':
        p.x += p.vx;
        p.vy += 0.25;
        p.y += p.vy;
        if (p.vy > 0 && p.y >= rowTop(10)) {
          p.y = rowTop(10);
          p.st = 'walkCastle';
          p.t = 0;
        }
        break;
      case 'walkCastle': {
        p.vx = 1.25;
        p.face = 1;
        p.x += p.vx;
        p.ground = true;
        animate(p, 1);
        // through the goal house's door: the door and the wall right of it are drawn over him
        // (30-draw.js), so he is hidden once the drawing's left edge passes the door's left edge
        if (p.x - 4 >= castleDoor(lv)) {
          p.hide = true;
          p.st = 'inCastle';
          p.t = 0;
        }
        break;
      }
      case 'inCastle':
        break;
      case 'dead':
        if (p.t === 30) p.vy = -4;
        if (p.t > 30) {
          p.vy = Math.min(4, p.vy + 0.25);
          p.y += p.vy;
        }
        if (p.t >= DEAD_FRAMES) {
          W.lives--;
          W.retries++;
          emit(W, 'lifelost', { lives: W.lives });
          if (W.lives > 0) enterLives(W, lv.def.respawn || mainOf(lv.def));
          else {
            W.mode = 'gameover';
            W.mt = 0;
            emit(W, 'gameover');
            setSong(W, 'gameover');
          }
        }
        break;
    }
  }

  // Down a pipe into another area: a fresh build of def `key`; the area he left is kept as its parent
  // (W.areas holds at most the two).
  function enterArea(W, key) {
    const parent = W.lv;
    const def = defOf(W, key);
    const lv = buildLevel(def, W, key);
    W.areas = [parent, lv];
    W.lv = lv;
    W.li = key;
    W.cam = 0;
    const s = def.start;
    const p = W.p;
    if (s.drop) dropIn(p, s); // the head just clear of the HUD band, in the gap in the ceiling
    else {
      p.x = s.x;
      p.y = s.y;
      p.vx = 0;
      p.vy = 0;
      land(p);
    }
    p.hide = false;
    p.behind = false;
    p.st = 'play';
    p.t = 0;
    W.items = []; W.parts = []; W.pops = []; W.bumps = [];
    W.mainId = mainOf(def);
    W.bgm = def.song;
    levelSong(W, def.kind === 'over' ? 'A' : undefined);
    for (const s2 of GAME.systems) if (s2.enter) s2.enter(W, lv);
  }

  // Out of a side pipe, rising from the target's pipeUp: the parent area itself when the pipe leads back
  // to it, otherwise a fresh build (the parent is dropped).
  function exitArea(W, side) {
    const key = side.to;
    const tdef = defOf(W, key);
    const parent = W.areas.length > 1 && W.areas[0].def === tdef ? W.areas[0] : null;
    const lv = parent || buildLevel(tdef, W, key);
    W.areas = [lv];
    W.mainId = mainOf(lv.def);
    W.lv = lv;
    W.li = key;
    const p = W.p;
    if (side.at === 'start' || !lv.def.pipeUp) {
      // no pipe to rise from: arrive at the area's start
      W.cam = 0;
      if (lv.def.start.drop) dropIn(p, lv.def.start);
      else {
        p.x = lv.def.start.x;
        p.y = lv.def.start.y;
        p.vx = 0;
        p.vy = 0;
        land(p);
      }
      p.hide = false;
      p.behind = false;
      p.st = 'play';
      p.t = 0;
    } else {
      const px = lv.def.pipeUp.tx * 16;
      W.cam = Math.max(0, Math.min(lv.maxCam, px - 96));
      p.x = px + 8;
      p.y = lv.pipeUpY + DRAW_H(p);
      p.vx = 0;
      p.vy = 0;
      p.face = 1;
      p.hide = false;
      p.behind = true;
      p.pose = 'idle';
      p.st = 'pipeUp';
      p.t = 0;
    }
    W.items = []; W.parts = []; W.pops = []; W.bumps = [];
    emit(W, 'pipe');
    W.bgm = lv.def.song;
    levelSong(W, lv.def.kind === 'over' ? 'A' : undefined); // back in the open air: the overworld's hook
    for (const s of GAME.systems) if (s.enter) s.enter(W, lv);
  }

  // the world x of the goal house's door's left edge (the door is 14 px wide at x 33..46 of the 80 px
  // goal_house drawing; def.castle is the house's column)
  const castleDoor = (lv) => lv.def.castle * 16 + 33;
  GAME.castleDoor = castleDoor;

  const FLIP_FRAMES = 12; // round the pole at its foot before the hop off
  function flagSeq(W, lv, p) {
    const base = rowTop(9); // the top of the block the pole stands on
    const flagEnd = base - 16;
    const ps = W.poleScore;
    if (ps && ps.y > ps.yEnd) ps.y = Math.max(ps.yEnd, ps.y - 3);
    if (W.seq.k === 'flag') {
      // the hero and the flag slide together and arrive on the same frame (W.slide.frames after the grab)
      const sl = W.slide;
      const k = Math.min(sl.frames, p.t);
      p.y = sl.y0 + ((base - sl.y0) * k) / sl.frames;
      lv.flagY = sl.f0 + ((flagEnd - sl.f0) * k) / sl.frames;
      p.pose = k < sl.frames && (p.t >> 2) & 1 ? 'pole2' : 'pole1';
      if (k >= sl.frames) {
        // at the pole's foot: the course-clear fanfare starts on this frame
        p.y = base;
        lv.flagY = flagEnd;
        W.seq = { k: 'flip', t: 0 };
        p.x = lv.pole.tx * 16 + 9 - 8 + HALF_W(p); // round the pole: the body's left edge against it
        p.face = -1;
        setSong(W, 'flag');
        W.goal = { t: 0, fw: 0, end: -1, flagT: -1 };
      }
    } else if (W.seq.k === 'flip') {
      if (++W.seq.t >= FLIP_FRAMES) {
        p.st = 'poleHop';
        p.t = 0;
        p.face = 1;
        p.vx = 1;
        p.vy = -1.5;
        p.pose = 'jump';
        p.jumped = true;
        W.seq = null;
      }
    }
  }

  // From the frame the hero reaches the pole's foot (t 0, the fanfare's first frame): he swings round
  // the pole, hops off and walks into the goal house, and its signal climbs out of the roof, all inside
  // the fanfare's 168 frames; then the clock tallies into the score, then the fireworks burst, then the
  // clear card.
  const CFLAG_FRAMES = 48; // the goal house's signal climb
  const FW_EVERY = 16; // frames between fireworks
  const FW_LIFE = 30; // one firework's frames
  function goalSeq(W, lv, p) {
    const g = W.goal;
    const t = ++g.t;
    const ps = W.poleScore;
    if (ps && ps.y > ps.yEnd) ps.y = Math.max(ps.yEnd, ps.y - 2);
    if (p.hide && g.flagT < 0) g.flagT = t;
    if (g.flagT >= 0) W.castleFlag = Math.min(14, Math.floor(((t - g.flagT) * 14) / CFLAG_FRAMES));
    if (t >= FANFARE && g.end < 0) {
      if (W.time > 0) {
        const n = Math.min(W.time, TALLY_STEP);
        W.time -= n;
        addScore(W, n * 50);
        emit(W, 'tally', { n: W.time });
      } else {
        g.end = t;
        W.poleScore = null;
      }
    }
    if (g.end < 0) return;
    const total = W.fireworks || 0;
    const k = t - g.end;
    if (g.fw < total && k % FW_EVERY === 0) {
      // round the goal house (x from its left edge, y the burst's centre), clear of the pole and the HUD band
      const spots = [[-46, 74], [92, 66], [24, 62], [70, 92], [-20, 96], [44, 80]];
      const [dx, dy] = spots[g.fw % spots.length];
      W.parts.push({ k: 'fw', x: lv.def.castle * 16 + dx, y: dy, t: 0 });
      addScore(W, 500);
      emit(W, 'firework');
      // one sky flash, on the first burst only: three full-screen flashes inside a second would sit on
      // the broadcast photosensitivity limit (no more than three flashes in any one second)
      if (g.fw === 0) flash(W, FLASH_PALE, 1);
      g.fw++;
    }
    if (k >= (total ? (total - 1) * FW_EVERY + FW_LIFE : 0) + TALLY_HOLD) {
      W.goal = null;
      enterClear(W); // the clear card, then the lives screen for def.next (or the final card)
    }
  }

  // ------------------------------------------------------------------------------------------
  // Snapshot: the compact per-frame record the draw pass paints
  // ------------------------------------------------------------------------------------------
  // spr is a flat Int16Array of [name, x, y, flags, pal] in world px. flags: 1 flip, 2 flip vertical,
  // 4 behind the tiles. name >= 1000 is a score pop (GAME.POPS[name - 1000]). pal: 0 normal, else a
  // GAME.PAL slot.
  const NAMES = [];
  const NI = new Map();
  function ni(name) {
    let i = NI.get(name);
    if (i === undefined) {
      i = NAMES.length;
      NAMES.push(name);
      NI.set(name, i);
    }
    return i;
  }
  GAME.NAMES = NAMES;
  GAME.ni = ni;

  // C (the multi-coin brick) draws as its kind's brick. Two level kinds: over (open air) and under
  const TILE_NAMES = {
    over: { '#': 'tile_ground', B: 'tile_brick', U: 'tile_used', X: 'tile_stair', C: 'tile_brick' },
    under: { '#': 'tile_ground_under', G: 'tile_ground_under', B: 'tile_brick_under', W: 'tile_brick_under', U: 'tile_used', X: 'tile_stair', C: 'tile_brick_under' },
  };
  GAME.TILE_NAMES = TILE_NAMES;
  const MODE_CODE = { title: 0, title2: 0, lives: 1, play: 2, gameover: 3, pause: 4, continue: 5, clear: 6, credits: 7 };
  GAME.MODE_CODE = MODE_CODE;

  // Sprite entries anchor at the feet so any drawing size stands right: flag 32 means x is the body
  // centre and y the feet; 64 means x is where the drawing's right edge meets (the goal pole), 128 its
  // left edge. The draw pass reads each drawing's size from FILM.SPRITE_MANIFEST.
  const ANCHOR_FEET = 32, ANCHOR_RIGHT = 64, ANCHOR_LEFT = 128;
  GAME.ANCHOR = { FEET: ANCHOR_FEET, RIGHT: ANCHOR_RIGHT, LEFT: ANCHOR_LEFT };
  // every palette slot and flag a snapshot sprite can carry (docs/game-spec.md 2.4 and 2.6): 5 the
  // walker underground (FILM.retro.SPAL.foeU), 8 the 1UP (SPAL.life), 12 brick fragments underground
  // (SPAL.fragmentU)
  const PAL = Object.freeze({ FOE_U: 5, LIFE: 8, FRAG_U: 12 });
  const FLAG = Object.freeze({ FLIP: 1, FLIPV: 2, BEHIND: 4, BUMP: 16, FEET: 32, RIGHT: 64, LEFT: 128, FLICKER: 256 });
  GAME.PAL = PAL;
  GAME.FLAG = FLAG;

  function playerSprite(W, out) {
    const p = W.p;
    if (p.hide) return;
    if (p.inv > 0 && (p.inv >> 1) & 1) return;
    const vf = W.vf;
    let name;
    if (p.growT >= 0) {
      const c = GROW_SEQ[Math.min(GROW_SEQ.length - 1, Math.floor(p.growT / 5))];
      name = c === 'S' ? 'hero_small_idle' : c === 'M' ? 'hero_grow_mid' : 'hero_big_idle';
    } else if (p.st === 'dead') {
      name = 'hero_small_dead';
    } else {
      let pose = p.pose;
      // idle life: standing still, the hero blinks for 8 frames every 3 seconds
      if (pose === 'idle' && vf % 180 < 8) pose = 'blink';
      name = (p.big ? 'hero_big_' : 'hero_small_') + pose;
    }
    let flags = p.face < 0 ? 1 : 0;
    if (p.behind) flags |= 4;
    const pal = 0;
    let x = Math.floor(p.x) + 8;
    if (p.pose === 'pole1' || p.pose === 'pole2') {
      // on the pole the grip hand is at the drawing's edge: stand the drawing against the pole's pixels
      const pole = W.lv.pole;
      if (p.face > 0) {
        x = pole.tx * 16 + 7;
        flags |= ANCHOR_RIGHT;
      } else {
        x = pole.tx * 16 + 9;
        flags |= ANCHOR_LEFT;
      }
    } else flags |= ANCHOR_FEET;
    out.push(ni(name), x, Math.floor(p.y), flags, pal);
  }

  // a firework burst centred on (x, y): one star, then a ring, then a wide double ring (48 px across)
  const FW_RING1 = [[-10, 0], [10, 0], [0, -10], [0, 10]];
  const FW_RING2 = [[-13, -13], [13, -13], [-13, 13], [13, 13]];
  const FW_RING3 = [[-22, 0], [22, 0], [0, -22], [0, 22]];
  function fireworkSprites(q, out) {
    const x = q.x - 8, y = q.y - 8;
    const put = (n, dx, dy) => out.push(ni('goal_firework_' + n), x + dx, y + dy, 0, 0);
    if (q.t < 6) put(1, 0, 0);
    else if (q.t < 14) {
      put(2, 0, 0);
      for (const [dx, dy] of FW_RING1) put(1, dx, dy);
    } else if (q.t < 22) {
      put(3, 0, 0);
      for (const [dx, dy] of FW_RING1) put(2, dx, dy);
      for (const [dx, dy] of FW_RING2) put(1, dx, dy);
    } else {
      for (const [dx, dy] of FW_RING2) put(3, dx, dy);
      for (const [dx, dy] of FW_RING3) put(q.t & 2 ? 2 : 1, dx, dy);
    }
  }

  // docs/game-spec.md 8. s.f is the visual clock (W.vf - 1), and every animation below reads it, so a
  // paused frame stands still. Modes 1, 3, 5, 6 and 7 carry an empty spr; mode 4 (pause) carries the
  // frozen play record.
  function snapshot(W) {
    const areaDef = W.mode === 'lives' ? defOf(W, W.pending) : W.lv ? W.lv.def : null;
    const main = areaDef ? mainOf(areaDef) : '';
    const inPlay = W.mode === 'play' || W.mode === 'pause';
    const s = {
      m: MODE_CODE[W.mode], f: W.vf - 1, btn: W.btn, score: W.score, coins: W.coins, lives: W.lives, top: W.top,
      world: W.world, time: inPlay ? W.time : -1,
      lv: W.lv, chg: W.lv ? W.lv.changes.length : 0, cam: W.cam, lt: W.lv ? W.lv.t : 0,
      spr: null, hide: null, cflag: W.castleFlag, flagY: W.lv ? W.lv.flagY : 0,
      title: W.mode === 'title' || W.mode === 'title2' ? { started: W.mode === 'title2', mt: W.mt } : null,
      flash: W.flashN > 0 ? W.flashC : 0, door: -1,
      shell: !!W.shellMenu, pausable: pausable(W),
      lid: areaDef ? String(areaDef.id) : '', main: String(main), name: areaDef && areaDef.name ? String(areaDef.name) : '',
      tokens: W.tokens[main] | 0, tokenTotal: tokenCount(W),
      clear: W.mode === 'clear' && W.clear ? Object.assign({}, W.clear) : null,
      cont: W.mode === 'continue' && W.cont ? { sel: W.cont.sel } : null,
      credits: W.mode === 'credits' && W.credits ? Object.assign({}, W.credits) : null,
    };
    if (!inPlay && W.mode !== 'title' && W.mode !== 'title2') {
      s.spr = new Int16Array(0);
      return s;
    }
    const lv = W.lv;
    const p = W.p;
    const out = [];
    const f = W.vf;
    if (lv.def.castle && p.st === 'walkCastle') s.door = castleDoor(lv);
    // behind-the-tiles sprites first: sprouting items, the player in a pipe
    for (const it of W.items) {
      out.push(ni('item_power'), Math.floor(it.x), Math.floor(it.y) - 16, it.st === 'sprout' ? 4 : 0, it.k === 'life' ? PAL.LIFE : 0);
    }
    // the checkpoint post, in the main level only: its flag flies once passed
    if (lv.def.mid && mainOf(lv.def) === lv.def.id) {
      const m = lv.def.mid;
      const on = !!(W.mid && W.mid.id === lv.def.id);
      out.push(ni(on ? 'item_checkpoint_on' : 'item_checkpoint_off'), m.tx * 16, rowTop(m.row) - 32, 0, 0);
    }
    if (lv.pole) out.push(ni('goal_flag'), lv.pole.tx * 16 + 7 - 16, Math.floor(lv.flagY), 0, 0);
    for (const e of lv.ents) {
      if (e.st === 'wait' || e.st === 'gone') continue;
      if (e.x < W.cam - 32 || e.x > W.cam + 336) continue;
      const K = kindOf(W, e);
      if (K) {
        // a registered kind draws itself: [name, drawHeight, flags, pal]
        const r = K.sprite(W, lv, e, f);
        if (!r) continue;
        out.push(ni(r[0]), Math.floor(e.x), Math.floor(e.y) - r[1], (r[2] | 0) | (e.st === 'dead' ? FLAG.FLIPV : 0), r[3] | 0);
        continue;
      }
      let name, h, flags = 0;
      if (e.st === 'flat') {
        name = 'foe_walker_flat';
        h = 8;
      } else {
        // the walker's drawings face left (at the player); mirrored when walking right
        name = e.st === 'dead' ? 'foe_walker_1' : (e.t >> 3) & 1 ? 'foe_walker_2' : 'foe_walker_1';
        h = 16;
        if (e.vx > 0) flags |= 1;
      }
      if (e.st === 'dead') flags |= 2;
      out.push(ni(name), Math.floor(e.x), Math.floor(e.y) - h, flags, lv.def.kind === 'under' ? PAL.FOE_U : 0);
    }
    for (const sy of systemsOf(W)) if (sy.sprites) sy.sprites(W, lv, out, f);
    playerSprite(W, out);
    const fragPal = lv.def.kind === 'under' ? PAL.FRAG_U : 0;
    for (const q of W.parts) {
      if (q.k === 'coin') out.push(ni('item_coinpop_' + (1 + ((q.t >> 1) & 3))), Math.floor(q.x), Math.floor(q.y), 0, 0);
      else if (q.k === 'frag') out.push(ni((q.t >> 2) & 1 ? 'item_fragment_2' : 'item_fragment_1'), Math.floor(q.x), Math.floor(q.y), q.flip ? 1 : 0, fragPal);
      else if (q.k === 'fw') fireworkSprites(q, out);
    }
    // score pops (x is the centre); not during the grow pause, when the world holds still
    if (W.freeze === 0) for (const sp of W.pops) out.push(1000 + sp.v, sp.x, Math.floor(sp.y), 0, 0);
    if (W.poleScore) out.push(1000 + W.poleScore.v, W.poleScore.x, Math.floor(W.poleScore.y), 0, 0);
    // bumped blocks ride above their cell for a few frames
    if (W.bumps.length) {
      s.hide = [];
      const names = TILE_NAMES[lv.def.kind] || TILE_NAMES.over;
      for (const bp of W.bumps) {
        s.hide.push(bp.ty * lv.w + bp.tx);
        const ch = String.fromCharCode(bp.code);
        out.push(ni(names[ch] || 'tile_used'), bp.tx * 16, rowTop(bp.ty) + BUMP_DY[bp.t], 16, 0);
      }
    }
    s.spr = Int16Array.from(out);
    return s;
  }
  GAME.snapshot = snapshot;

  // ------------------------------------------------------------------------------------------
  // The seam: the kit the 1x modules may use (docs/game-spec.md 2.4). Nothing else is theirs.
  // ------------------------------------------------------------------------------------------
  GAME.K = Object.freeze({
    Q, PH, BUTTONS, rowTop, rowOf, cell, solidAt, headAt, setCell,
    bodyL, bodyR, bodyH, drawH: DRAW_H,
    emit, setSong, addScore, pop, popOf,
    comboPoints, hurt, makeEnemy,
  });
})();
