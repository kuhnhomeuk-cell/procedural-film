// src/sprites.js : the retro film's cast (template). Original, neutral art: copy it into src/ and redraw.
//
// THE FORMAT
//   FILM.retro.SPRITES_DEF[name] = { l, r }
//     r : rows of equal-length strings, one char a pixel. '.' (or any char missing from the legend) is
//         transparent.
//     l : the legend, char -> an NES colour, written FILM.retro.C(0xNN) as in the art bible, never a free hex.
//         N[0xNN] below (N = FILM.retro.NES) gives the same '#RRGGBB'. New code uses C().
//   FILM.retro.SPRITES_DEF[name] = { legends: [l0, l1, ...], r } : palette-cycle frames of one map,
//     picked by sprite(g, name, x, y, { frame }). Used below for the robot's hurt flash.
//   Characters key their pixels by the slot chars '1' '2' '3' and take their legend from
//   R.slots(R.SPAL.<name>), so sprite(..., { pal }) can swap the whole palette like an NES sprite palette.
//   Tiles and props key their legend by letters, e.g. { a: fill, b: shade, k: outline }.
//   Draw with FILM.retro.sprite(g, name, gx, gy, { flip, flipV, frame, pal }) on the native buffer.
//
// THE 3-SLOT RULE (check gate 9): every sprite, and every legend variant of it, uses at most 3 colours
// plus transparent, like an NES sprite palette. Every colour is an NES entry (gate 8 and the RETRO_PAL
// audit): name a colour once in RETRO_PAL with C(0xNN), then use the name.
//
// THE CAST
//   robot_idle, robot_run1..3, robot_jump, robot_hurt  16x16  the hero: a round robot, antenna, one visor eye
//   nut1, nut2                                          16x16  the foe: a walking hex nut with two legs
//   ground, brick, question                             16x16  tiles
//   coin1..3                                             8x8   a coin spinning (full, turning, edge-on)
//   hudcoin1..3                                          8x8   the HUD's shimmering coin (R.hud draws these)
(function () {
  const R = FILM.retro;
  const N = R.NES;
  Object.assign(R.RETRO_PAL, {
    ink: N[0x0f], // $0F #000000
    hudWhite: N[0x30], // $30 #FCFCFC
    sky: N[0x21], // $21 #3CBCFC
    steel: N[0x10], // $10 #BCBCBC
    shadow: N[0x00], // $00 #747474
    visor: N[0x2c], // $2C #00E8D8
    hurt: N[0x16], // $16 #D82800
    moss: N[0x1a], // $1A #00A800
    lime: N[0x29], // $29 #80D010
    dirt: N[0x17], // $17 #C84C0C
    clay: N[0x27], // $27 #FC9838
    rust: N[0x07], // $07 #7C0800
    gold: N[0x28], // $28 #F0BC3C
    amber: N[0x38], // $38 #FCE4A0
    violet: N[0x13], // $13 #8000F0
  });
  const P = R.RETRO_PAL;

  // ---------------------------------------------------------------- the hero: slot 1 outline, 2 body, 3 eye
  R.SPAL.robot = Object.freeze([P.ink, P.steel, P.visor]);
  R.SPAL.robotHurt = Object.freeze([P.ink, P.hudWhite, P.hurt]);
  // the round body, rows 0-12; the legs (rows 13-15) change per pose
  const body = [
    '......1331......',
    '.......11.......',
    '.....111111.....',
    '...1122222211...',
    '..122222222221..',
    '.12211111111221.',
    '.12211113311221.',
    '.12211113311221.',
    '.12211111111221.',
    '1122222222222211',
    '1122222222222211',
    '..122222222221..',
    '...1122222211...',
  ];
  const hurtBody = body.slice();
  hurtBody[6] = '.12211131311221.';
  hurtBody[7] = '.12211113111221.';
  const legs = {
    idle: ['.....11..11.....', '.....11..11.....', '....111..111....'],
    run1: ['....11....11....', '...11......11...', '..111.......111.'],
    run2: ['.....11..11.....', '......1111......', '.....111.111....'],
    run3: ['......11.11.....', '.....11...11....', '....111...111...'],
    jump: ['...111....111...', '..111......111..', '................'],
  };
  const robot = R.slots(R.SPAL.robot);
  R.SPRITES_DEF.robot_idle = { l: robot, r: body.concat(legs.idle) };
  R.SPRITES_DEF.robot_run1 = { l: robot, r: body.concat(legs.run1) };
  R.SPRITES_DEF.robot_run2 = { l: robot, r: body.concat(legs.run2) };
  R.SPRITES_DEF.robot_run3 = { l: robot, r: body.concat(legs.run3) };
  R.SPRITES_DEF.robot_jump = { l: robot, r: body.concat(legs.jump) };
  // hurt: an X in the visor, flashing between the normal and the white palette (pass { frame })
  R.SPRITES_DEF.robot_hurt = { legends: [robot, R.slots(R.SPAL.robotHurt)], r: hurtBody.concat(legs.jump) };

  // ---------------------------------------------------------------- the foe: slot 1 outline, 2 shell, 3 eyes
  R.SPAL.nut = Object.freeze([P.ink, P.violet, P.hudWhite]);
  const nut = [
    '...1........1...',
    '...1111111111...',
    '..122222222221..',
    '.12222222222221.',
    '.12233222233221.',
    '.12231222231221.',
    '.12222222222221.',
    '.12221111112221.',
    '.12222222222221.',
    '..122222222221..',
    '...1111111111...',
  ];
  const nutL = R.slots(R.SPAL.nut);
  R.SPRITES_DEF.nut1 = { l: nutL, r: ['................', '................'].concat(nut, ['....11....11....', '...111....111...', '................']) };
  R.SPRITES_DEF.nut2 = { l: nutL, r: ['................', '................'].concat(nut, ['.....11..11.....', '....111..111....', '................']) };

  // ---------------------------------------------------------------- tiles (16x16)
  R.SPRITES_DEF.ground = {
    l: { g: P.moss, a: P.dirt, k: P.ink },
    r: [
      'gggggggggggggggg',
      'gggggggggggggggg',
      'ggagggggaggggagg',
      'aaaagaaaaagaaaaa',
      'aaaaaaaaaaaaaaaa',
      'aakaaaaaaaaakaaa',
      'aaaaaaakaaaaaaaa',
      'aaaaaaaaaaaaaaaa',
      'akaaaaaaaaakaaaa',
      'aaaaaakaaaaaaaaa',
      'aaaaaaaaaaaaaaka',
      'aaakaaaaaaaaaaaa',
      'aaaaaaaaakaaaaaa',
      'aaaaaaaaaaaaaaaa',
      'akaaaaakaaaaakaa',
      'aaaaaaaaaaaaaaaa',
    ],
  };
  R.SPRITES_DEF.brick = {
    l: { a: P.clay, b: P.amber, k: P.rust },
    r: [
      'bbbbbbbbbbbbbbbb',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'kkkkkkkkkkkkkkkk',
      'bbbbbbbbbbbbbbbb',
      'aaakbaaaaaakbaaa',
      'aaakbaaaaaakbaaa',
      'kkkkkkkkkkkkkkkk',
      'bbbbbbbbbbbbbbbb',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'kkkkkkkkkkkkkkkk',
      'bbbbbbbbbbbbbbbb',
      'aaakbaaaaaakbaaa',
      'aaakbaaaaaakbaaa',
      'kkkkkkkkkkkkkkkk',
    ],
  };
  R.SPRITES_DEF.question = {
    l: { a: P.gold, b: P.amber, k: P.ink },
    r: [
      'kkkkkkkkkkkkkkkk',
      'kbbbbbbbbbbbbbak',
      'kbkaaaaaaaaaakak',
      'kbaaaakkkkaaaaak',
      'kbaaakkaakkaaaak',
      'kbaaakkaakkaaaak',
      'kbaaaaaaakkaaaak',
      'kbaaaaaakkaaaaak',
      'kbaaaaakkaaaaaak',
      'kbaaaaakkaaaaaak',
      'kbaaaaaaaaaaaaak',
      'kbaaaaakkaaaaaak',
      'kbaaaaakkaaaaaak',
      'kbkaaaaaaaaaakak',
      'kaaaaaaaaaaaaaak',
      'kkkkkkkkkkkkkkkk',
    ],
  };

  // ---------------------------------------------------------------- the coin (8x8), spin frames
  const coinL = { k: P.ink, a: P.gold, b: P.amber };
  R.SPRITES_DEF.coin1 = { l: coinL, r: ['..kkkk..', '.kaaaak.', 'kaabbaak', 'kaabbaak', 'kaabbaak', 'kaabbaak', '.kaaaak.', '..kkkk..'] };
  R.SPRITES_DEF.coin2 = { l: coinL, r: ['...kk...', '..kaak..', '..kabk..', '..kabk..', '..kabk..', '..kabk..', '..kaak..', '...kk...'] };
  R.SPRITES_DEF.coin3 = { l: coinL, r: ['...kk...', '...ak...', '...ak...', '...ak...', '...ak...', '...ak...', '...ak...', '...kk...'] };
  // the HUD's shimmering coin: the full coin in three palettes
  const full = R.SPRITES_DEF.coin1.r;
  R.SPRITES_DEF.hudcoin1 = { l: coinL, r: full };
  R.SPRITES_DEF.hudcoin2 = { l: { k: P.ink, a: P.clay, b: P.gold }, r: full };
  R.SPRITES_DEF.hudcoin3 = { l: { k: P.ink, a: P.dirt, b: P.clay }, r: full };
})();
