// Retro fixture shot 02: the same sheet presented through the CRT. The power-on starts on this
// shot's first frame and the power-off and caption close the film (TIMELINE.retro.crt).
FILM.scene({
  id: 'crt',
  draw(ctx, t, info) {
    const nb = FILM.native();
    FILM.retroFixtureSheet(nb.ctx, info.frame);
    FILM.crt.present(nb.canvas, ctx, { frame: info.frame, T: info.T });
  },
});
