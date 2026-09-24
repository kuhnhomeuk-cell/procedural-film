// Retro fixture sprites: original, fixture-only art. Every colour is an NES entry, every sprite
// uses at most 3 colours plus transparent ('.').
(function () {
  const R = FILM.retro;
  const N = R.NES;
  Object.assign(R.RETRO_PAL, {
    sky: N[0x21], // #3CBCFC
    ground: N[0x17], // #C84C0C
    ink: N[0x0f], // #000000
    hudWhite: N[0x30], // #FCFCFC
    gold: N[0x28], // #F0BC3C
    steel: N[0x10], // #BCBCBC
  });
  const P = R.RETRO_PAL;
  // robot palette: slot 1 outline, 2 body, 3 eye
  R.SPAL.robot = Object.freeze([N[0x0f], N[0x10], N[0x16]]);
  const head = [
    '......1111......',
    '.......11.......',
    '...1111111111...',
    '..122222222221..',
    '..123322223321..',
    '..123322223321..',
    '..122222222221..',
    '..122111111221..',
    '...1111111111...',
    '....12222221....',
    '..112222222211..',
    '..1.12222221.1..',
    '....12222221....',
    '....11111111....',
  ];
  R.SPRITES_DEF.robot1 = { l: R.slots(R.SPAL.robot), r: head.concat(['...11.....11....', '...11.....11....']) };
  R.SPRITES_DEF.robot2 = { l: R.slots(R.SPAL.robot), r: head.concat(['....11...11.....', '.....11.11......']) };
  const coin = [
    '..kkkk..',
    '.kaaaak.',
    'kaabbaak',
    'kaabbaak',
    'kaabbaak',
    'kaabbaak',
    '.kaaaak.',
    '..kkkk..',
  ];
  R.SPRITES_DEF.coin = { l: { k: P.ink, a: P.gold, b: P.hudWhite }, r: coin };
  // the HUD's blinking coin: three drawings of the same map
  R.SPRITES_DEF.hudcoin1 = { l: { k: P.ink, a: P.gold, b: P.hudWhite }, r: coin };
  R.SPRITES_DEF.hudcoin2 = { l: { k: P.ink, a: N[0x27], b: P.gold }, r: coin };
  R.SPRITES_DEF.hudcoin3 = { l: { k: P.ink, a: N[0x17], b: N[0x27] }, r: coin };
  R.SPRITES_DEF.brick = {
    l: { a: P.ground, b: N[0x27], k: P.ink },
    r: [
      'bbbbbbbbbbbbbbbk',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'kkkkkkkkkkkkkkkk',
      'bbbbkbbbbbbbkbbb',
      'aaakbaaaaaakbaaa',
      'aaakbaaaaaakbaaa',
      'aaakbaaaaaakbaaa',
      'kkkkkkkkkkkkkkkk',
      'bbbbbbbbbbbbbbbk',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'baaaaaakbaaaaaak',
      'kkkkkkkkkkkkkkkk',
      'bbbbkbbbbbbbkbbb',
    ],
  };
})();
