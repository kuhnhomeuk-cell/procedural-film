// Shot 01: game (the whole attract film). The game draws global frame f into the native 320x180 buffer,
// then the TV presents it. FILM.crt.buttonsAt reads the attract tape, so the pad shows what was pressed.
(function () {
  'use strict';

  // the attract tape's buttons at frame f: null (no pad) until the power-on has settled, past the tape's
  // end, or with no tape
  let tape = null;
  function buttonsAt(f) {
    const A = FILM.__game && FILM.__game.ATTRACT;
    if (!A || !FILM.game) return null;
    if (!tape) tape = FILM.game.decode(A.rle, A.length) || new Uint8Array(0);
    const crt = FILM.TIMELINE && FILM.TIMELINE.retro && FILM.TIMELINE.retro.crt;
    const lit = crt && Array.isArray(crt.powerOn) ? crt.powerOn[1] : 0;
    return f >= lit && f < tape.length ? tape[f] : null;
  }
  if (FILM.crt) FILM.crt.buttonsAt = buttonsAt;

  FILM.scene({
    id: 'game',
    draw(ctx, t, info) {
      const f = info.frame; // global frame index at 60 fps
      const nb = FILM.native();
      FILM.game.draw(nb.ctx, f);
      FILM.crt.present(nb.canvas, ctx, { frame: f, T: info.T });
    },
  });
})();
