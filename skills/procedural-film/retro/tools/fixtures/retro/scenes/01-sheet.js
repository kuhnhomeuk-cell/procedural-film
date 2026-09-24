// Retro fixture shot 01: the sprite sheet on the native 320x180 buffer, presented nearest-neighbour.
// FILM.retroFixtureSheet(nb, f) is shared with shot 02, which presents the same sheet through the CRT.
(function () {
  'use strict';
  FILM.retroFixtureSheet = function sheet(g, f) {
    const R = FILM.retro, P = R.RETRO_PAL, nes = FILM.nes;
    R.px(g, 0, 0, 320, 180, P.sky);
    for (let x = 0; x < 320; x += 16) R.sprite(g, 'brick', x, 148), R.sprite(g, 'brick', x, 164);
    R.hud(g, { name: 'TEST', score: f * 10, coins: 7, world: '0-1', time: 400 - Math.floor(f / 24), frame: f });
    R.pxtext(g, 'FIXTURE', 160, 48, { color: P.hudWhite, shadow: P.ink, align: 'center', scale: 2 });
    for (let i = 0; i < 5; i++) {
      const hop = nes.arc(96, 6, ((f + i * 8) % 40) / 40);
      R.sprite(g, 'coin', 112 + i * 20, Math.round(hop));
    }
    // the robot walks right at 60 game px/s, 1 px a frame, a new drawing every runHold(60) frames
    const x = (f % 336) - 16;
    R.sprite(g, nes.step(f, nes.runHold(60), 2) ? 'robot2' : 'robot1', x, 132);
  };
  FILM.scene({
    id: 'sheet',
    draw(ctx, t, info) {
      const nb = FILM.native();
      FILM.retroFixtureSheet(nb.ctx, info.frame);
      FILM.presentNearest(nb.canvas, ctx);
    },
  });
})();
