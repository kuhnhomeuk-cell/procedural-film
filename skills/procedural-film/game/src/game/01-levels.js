// game/01-levels.js : the game's levels (docs/game-spec.md 4). Owner: the level author.
//
// GAME.GAME_DEFS is the level table, keyed by id; GAME.GAME_ORDER lists the main levels in play order and
// must equal GAME.CONFIG.order (src/game/00-config.js).
//
// Grid: 16 px tiles, 12 rows; row r has its top at y = 16r - 12, the ground rows 10 and 11 fill y 148..180
// and rows 0 to 2 stay empty (the HUD band). tools/levels-lint.cjs checks every map (F1 to F8, the static
// rules) and jumps every jump listed in tools/proof/levels.data.cjs with the engine's own physics.
//
// Legend (the kept engine, src/game/10-engine.js buildLevel and TILE_NAMES):
//   .  air            #  ground            B  brick             X  hard stair block
//   ?  crate (coin)   M  crate (battery)   o  coin              g  walker
//   [ ]  pipe rim     { }  pipe body       h H  side pipe mouth  - _  side pipe body   j J  side pipe join
//   !  beacon top     |  beacon mast       W  wall (under)      G  floor (under)     t  token
//
// def fields: id, name, world, kind ('over' | 'under'), rows, time, song, start { x, y, drop? },
// mid { tx, row } (the checkpoint), pipeDown { tx, to }, pipeUp { tx }, pipeSide { tx, row, to, at },
// pole (the mast column), castle (the goal house's first column), main / respawn (a sub-area's level),
// tokenBase (a sub-area's first token bit), scenery [[name, col, y?]].
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const GAME = (FILM.__game = FILM.__game || {});

  // a map builder: w columns of air over a two-row floor; put(col, row, str) writes str left to right
  function map(w) {
    const g = [];
    for (let r = 0; r < 12; r++) g.push(Array(w).fill(r >= 10 ? '#' : '.'));
    const api = {
      put(c, r, s) {
        for (let i = 0; i < s.length; i++) g[r][c + i] = s[i];
        return api;
      },
      pit(c0, c1) {
        for (let c = c0; c <= c1; c++) g[10][c] = g[11][c] = '.';
        return api;
      },
      // a pipe two columns wide at c, h tiles tall, standing on the floor
      pipe(c, h) {
        api.put(c, 10 - h, '[]');
        for (let r = 11 - h; r <= 9; r++) api.put(c, r, '{}');
        return api;
      },
      // a column of stair blocks h high
      stack(c, h) {
        for (let r = 10 - h; r <= 9; r++) g[r][c] = 'X';
        return api;
      },
      rows: () => g.map((r) => r.join('')),
    };
    return api;
  }

  // ---------------------------------------------------------------------------------------------
  // 1-1 FIRST SIGNAL (overworld, 200 tiles). Left to right: the start field and a lone coin crate (16);
  // the crate row with the battery (M at 23) and a walker to stomp; a low pipe (36) and the down pipe
  // (46, into the cellar); the first pit (58-60) under an arc of coins; two walkers; the brick deck
  // (72-79, a token over it); the checkpoint lamp (92); the twin stairs over a two-tile gap (104-113,
  // a token over the gap); crates and a walker pair; the second pit (131-133); the coin shelf (140-144);
  // the exit pipe (150, where the cellar sends him back up); the last walkers, the five-step stair
  // (174-178) and the beacon tower (186) before the radio hut (191).
  // ---------------------------------------------------------------------------------------------
  const m = map(200);
  m.put(16, 6, '?');
  m.put(22, 6, 'BMB?B');
  m.put(28, 9, 'g');
  m.put(30, 6, 'ooo');
  m.pipe(36, 2);
  m.put(41, 9, 'g');
  m.pipe(46, 3);
  m.put(57, 7, 'o').put(58, 6, 'ooo').put(61, 7, 'o');
  m.pit(58, 60);
  m.put(66, 9, 'g').put(69, 9, 'g');
  m.put(72, 6, 'BBB?BBBB');
  m.put(76, 4, 't');
  m.put(84, 8, 'ooo');
  m.put(98, 9, 'g');
  for (let i = 0; i < 4; i++) m.stack(104 + i, i + 1).stack(113 - i, i + 1);
  m.pit(108, 109);
  m.put(108, 4, 't');
  m.put(120, 6, '?B?');
  m.put(124, 9, 'g').put(127, 9, 'g');
  m.pit(131, 133);
  m.put(140, 6, 'BB?BB');
  m.put(140, 5, 'ooooo');
  m.pipe(150, 2);
  m.put(158, 9, 'g').put(162, 9, 'g');
  m.put(166, 8, 'oooo');
  for (let i = 0; i < 5; i++) m.stack(174 + i, i + 1);
  m.put(186, 3, '!');
  for (let r = 4; r <= 8; r++) m.put(186, r, '|');
  m.put(186, 9, 'X');
  const W11 = m.rows();

  // 1-1b THE CELLAR: down the pipe at 46 into sixteen coins and a token over the twin pillars, out by the
  // side pipe back up the exit pipe at 150
  const W11B = [
    /* 0*/ '....................',
    /* 1*/ '....................',
    /* 2*/ '....................',
    /* 3*/ 'W..WWWWWWWWWWWWWW{}W',
    /* 4*/ 'W...........t....{}W',
    /* 5*/ 'W..oooooooo......{}W',
    /* 6*/ 'W..oooooooo......{}W',
    /* 7*/ 'W........GG.GG...{}W',
    /* 8*/ 'W........GG.GG.h-j}W',
    /* 9*/ 'W........GG.GG.H_J}W',
    /*10*/ 'GGGGGGGGGGGGGGGGGGGG',
    /*11*/ 'GGGGGGGGGGGGGGGGGGGG',
  ];

  const DEFS = {
    '1-1': {
      id: '1-1', name: 'FIRST SIGNAL', world: '1-1', kind: 'over', rows: W11, time: 300, song: 'overworld',
      start: { x: 40, y: 148 }, mid: { tx: 92, row: 10 },
      pipeDown: { tx: 46, to: '1-1b' }, pipeUp: { tx: 150 },
      pole: 186, castle: 191,
      scenery: [
        ['scenery_hill_big', 0], ['scenery_bush_3', 9], ['scenery_hill_small', 50], ['scenery_bush_1', 62],
        ['scenery_bush_2', 86], ['scenery_hill_big', 115], ['scenery_hill_small', 136], ['scenery_bush_2', 154],
        ['scenery_bush_1', 181],
        ['scenery_cloud_1', 8, 44], ['scenery_cloud_2', 27, 52], ['scenery_cloud_3', 55, 40], ['scenery_cloud_1', 80, 48],
        ['scenery_cloud_2', 100, 40], ['scenery_cloud_3', 125, 50], ['scenery_cloud_1', 147, 42], ['scenery_cloud_2', 170, 46],
      ],
    },
    '1-1b': {
      id: '1-1b', name: 'FIRST SIGNAL', world: '1-1', kind: 'under', rows: W11B, time: 0, song: 'underground',
      main: '1-1', respawn: '1-1', start: { x: 20, y: 36, drop: true },
      pipeSide: { tx: 15, row: 8, to: '1-1', at: 'pipeUp' }, tokenBase: 2,
    },
  };

  GAME.GAME_DEFS = DEFS;
  GAME.GAME_ORDER = ['1-1'];
})();
