// Retro fixture score: an original 2-bar test song and two effects on chip.js.
// 32 rows at speed 8 (8 frames a row) = 256 frames, so one pass covers the 240-frame fixture.
FILM.chip.define({
  songs: {
    test: {
      speed: 8,
      sections: { a: 0 },
      p1: '@lead | C5:2 E5:2 G5:4 A5:2 G5:2 E5:4 D5:2 F5:2 A5:4 G5:8',
      p2: '@harm | E4:4 G4:4 C5:4 G4:4 F4:4 A4:4 B4:8',
      t: '| C3:4 G2:4 A2:4 E2:4 F2:4 D2:4 G2:8',
      n: '| [h:2 h:2 s:2 h:2]4',
    },
  },
  // thud opens with a full-volume pulse on its cue frame: a triangle knock plus period-12 noise alone
  // rises too slowly under the song, and its onset read one frame (17.7 ms) late.
  sfx: {
    blip: (ev, K) => ({ pri: 2, p2: K.cat(K.pt(K.mhz('E6'), 2, { d: 1, v: [12, 12] }), K.pt(K.mhz('B6'), 10, { d: 1, v: [12, 0], trig: false })) }),
    thud: (ev, K) => ({ pri: 2, p2: K.cat(K.pt(330, 2, { d: 2, v: [15, 15] }), K.pt(165, 10, { d: 2, v: [14, 0], bend: 0.94, trig: false })), n: K.nz([[12, 15], [12, 11], [13, 7], [13, 4], [13, 2]]) }),
  },
});
