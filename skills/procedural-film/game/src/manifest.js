// manifest.js : every sprite name the game draws, with its size in game px (native 320x180 frame).
// Owner: art (src/sprites.js draws them into FILM.retro.SPRITES_DEF). The engine and draw code
// (src/game/10-engine.js, 15-tokens.js, 30-draw.js) name exactly these; a name listed here but not yet
// drawn blits a magenta placeholder of this size (FILM.retro.spriteCanvas).
//
// Character sprites follow the NES sprite rule: exactly three colour slots, legend keys '1' '2' '3'
// ('.' transparent), so the game can palette-swap them through FILM.retro.SPAL (foeU, life, fragmentU).
// Tiles may use up to four colours (a background palette: 3 + the shared backdrop), legend keys free.
//
// Sizes are w x h in game px. A numbered family (name_1 .. name_N) is one entry a drawing.
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  const M = {};
  const add = (name, w, h, note) => (M[name] = { w, h, note: note || '' });
  const POSES = [
    ['idle', 'standing'],
    ['blink', 'standing, eyes shut (idle life)'],
    ['run1', 'run cycle drawing 1'],
    ['run2', 'run cycle drawing 2'],
    ['run3', 'run cycle drawing 3'],
    ['jump', 'airborne'],
    ['skid', 'braking, leaning back'],
    ['pole1', 'gripping the goal pole'],
    ['pole2', 'goal pole slide, second drawing'],
  ];

  // --- the hero, small (16x16, feet at the bottom, centred) ---
  for (const [pose, note] of POSES) add('hero_small_' + pose, 16, 16, note);
  add('hero_small_dead', 16, 16, 'the death pose');
  // --- the hero, growing (the power-up flicker between small, mid and big) ---
  add('hero_grow_mid', 20, 20, 'mid-size drawing used only in the grow flicker (feet at the bottom, centred)');
  // --- the hero, big (24x24, feet at the bottom, centred) ---
  for (const [pose, note] of POSES) add('hero_big_' + pose, 24, 24, note);

  // --- the walker foe (faces left; mirrored when walking right) ---
  add('foe_walker_1', 16, 16, 'walking, drawing 1');
  add('foe_walker_2', 16, 16, 'walking, drawing 2');
  add('foe_walker_flat', 16, 8, 'stomped flat');

  // --- items ---
  add('item_power', 16, 16, 'the grow power-up (a battery); also the 1UP in the SPAL.life palette');
  for (let i = 1; i <= 4; i++) add('item_coin_' + i, 8, 14, 'field coin spin ' + i);
  for (let i = 1; i <= 4; i++) add('item_coinpop_' + i, 8, 14, 'coin popping out of a block, spin ' + i);
  for (let i = 1; i <= 3; i++) add('item_hudcoin_' + i, 5, 8, 'HUD coin blink ' + i);
  for (let i = 1; i <= 4; i++) add('item_token_' + i, 16, 16, 'the token medal spinning: ' + ['face', 'narrow', 'edge', 'narrow mirrored'][i - 1]);
  add('item_fragment_1', 8, 8, 'brick fragment');
  add('item_fragment_2', 8, 8, 'brick fragment, rotated drawing');
  add('item_checkpoint_off', 16, 32, 'the checkpoint post, unlit');
  add('item_checkpoint_on', 16, 32, 'the checkpoint post, lit (passed)');

  // --- the goal: a beacon pole, the goal house the hero walks into, fireworks ---
  add('goal_pole', 16, 16, 'beacon pole segment (thin pole centred; map char |)');
  add('goal_top', 16, 16, 'beacon pole top (map char !)');
  add('goal_flag', 16, 16, 'the flag that slides down the pole (its right edge against the pole)');
  add('goal_house', 80, 80, 'the end-of-level goal house (5x5 tiles; its door at x 33-46 of the drawing)');
  add('goal_signal', 14, 14, 'the signal that rises out of the goal house roof (drawn at x 68 of the house)');
  for (let i = 1; i <= 3; i++) add('goal_firework_' + i, 16, 16, 'firework burst stage ' + i);

  // --- tiles (16x16): over (open air) and under ---
  add('tile_ground', 16, 16, 'ground (#)');
  add('tile_brick', 16, 16, 'breakable brick (B, and the multi-coin brick C)');
  for (let i = 1; i <= 3; i++) add('tile_q_' + i, 16, 16, '? block shimmer ' + i + ' (?, M, N)');
  add('tile_used', 16, 16, 'spent block (U)');
  add('tile_stair', 16, 16, 'hard stair block (X)');
  add('tile_ground_under', 16, 16, 'underground floor (# and G in an under level)');
  add('tile_brick_under', 16, 16, 'underground brick (B, W, C in an under level)');
  add('tile_pipe_tl', 16, 16, 'vertical pipe, top-left rim ([)');
  add('tile_pipe_tr', 16, 16, 'vertical pipe, top-right rim (])');
  add('tile_pipe_l', 16, 16, 'vertical pipe body left ({)');
  add('tile_pipe_r', 16, 16, 'vertical pipe body right (})');
  add('tile_pipe_side_top', 16, 16, 'sideways pipe mouth, top half (h)');
  add('tile_pipe_side_bottom', 16, 16, 'sideways pipe mouth, bottom half (H)');
  add('tile_pipe_body_top', 16, 16, 'sideways pipe body, top (-)');
  add('tile_pipe_body_bottom', 16, 16, 'sideways pipe body, bottom (_)');
  add('tile_pipe_join_top', 16, 16, 'where the sideways pipe meets the vertical one, top (j)');
  add('tile_pipe_join_bottom', 16, 16, 'join, bottom (J)');

  // --- scenery, placed by a level's def.scenery ([name, col, y]); 30-draw.js reads the prefixes
  // scenery_cloud (floats at y) and scenery_hill (behind the bushes) ---
  add('scenery_cloud_1', 32, 24, 'one-bump cloud');
  add('scenery_cloud_2', 48, 24, 'two-bump cloud');
  add('scenery_cloud_3', 64, 24, 'three-bump cloud');
  add('scenery_bush_1', 32, 16, 'one-bump bush');
  add('scenery_bush_2', 48, 16, 'two-bump bush');
  add('scenery_bush_3', 64, 16, 'three-bump bush');
  add('scenery_hill_small', 48, 19, 'small hill');
  add('scenery_hill_big', 80, 35, 'big hill');

  FILM.SPRITE_MANIFEST = M;
})();
