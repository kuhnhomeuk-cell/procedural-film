// src/music.js : the game's score and sound effects, registered on the retro kit's driver (src/chip.js,
// which loads first). Owner: audio. Notation and effect helpers: the header of src/chip.js and
// templates/music-retro.js. Every melody here is written for this game.
//
// THE SONGS (the ids the engine switches to, src/game/10-engine.js setSong)
//   title        4 bars, G major, loops: the overworld's second strain on the thin lead
//   overworld    the level song of every 'over' level: a half-bar intro (section 'intro', the first start
//                only), then A (row 8, the hook: G Em C D) and B (row 72: C G Am-D G); loops to A
//   underground  the level song of every 'under' level: a four-bar E minor riff, speed 8, loops whole
//   overworldFast, undergroundFast  the hurry-up variants: the same definition at speed minus 1
//   hurry        the 90-frame hurry-up jingle (the engine then plays the Fast variant)
//   death        144 frames, no loop, inside the 180-frame dead state
//   gameover     176 frames, no loop, inside the 180-frame game over
//   flag         168 frames (the engine's FANFARE), no loop: the course-clear fanfare at the beacon
//   credits      the overworld hook as a march, then the tonic held under the final card; no loop
//
// THE EFFECTS: one per event type the engine emits that makes a sound: start, levelstart, pause, unpause,
// cursor, continue, quit, jump, coin, bump, brick, sprout, powerup, oneup, stomp, kick, hurt, checkpoint,
// token, pipe, flagpole, tally, firework, clear. The events a song answers (die, lifelost, gameover,
// hurry, credits) have no effect of their own.
//
// ORIGINALITY RECORD (node tools/audio/melody.cjs --bars 8 overworld, then --bars 4 title underground flag;
// decoded from the driver's writes, pulse 1):
//   overworld  intro: D5 r G5 r B5:2 D6:2
//     bar 1: G5:2 B5:2 D6:3 B5 C6:2 B5:2 A5:4        bar 5: E5:2 G5:2 C6:2 E6:2 D6:3 C6 B5:4
//     bar 2: G5:2 E5:2 G5:2 B5:2 A5:3 G5 E5:4        bar 6: D6:2 B5:2 G5:2 B5:2 D6:4 r:2 D6:2
//     bar 3: E5:2 G5:2 C6:4 B5:2 A5:2 G5:2 E5:2      bar 7: C6:2 B5:2 A5:2 C6:2 F#5:3 A5 D6:4
//     bar 4: F#5:3 G5 A5:4 D5:4 r:4                  bar 8: B5:3 A5 G5:4 G4:4 r:4
//   title      bars 5-8 of the overworld on the thin lead; credits bars 1-4, then a held G5
//   underground  E5:2 r:2 G5:2 r:2 B5:2 A5:2 G5:2 r:2 | F#5:2 r:2 A5:2 r:2 B4:2 D#5:2 E5:2 r:2 |
//                C5:2 r:2 E5:2 r:2 G5:2 F#5:2 E5:2 r:2 | B4:2 r:2 D#5:2 r:2 F#5:4 E5:4
//   flag       D5:2 G5:2 B5:2 D6:6 E6:2 D6:2 | C6:2 B5:2 C6:2 A5:4 B5:2 D6:2 G6:7 (then it dies away)
//   Checked by note list against the Claude Quest score (examples/claude-quest-game/src/music.js)
//   and the retro template's overworld (templates/music-retro.js): no shared phrase; the fanfare's rhythm
//   is its own. The coin effect is a major third (C6 E6), not the familiar fourth.
(function () {
  'use strict';
  const K = FILM.chip;
  // the overworld's two strains, a bar a string (16 rows)
  const A = [
    'G5:2 B5:2 D6:3 B5 C6:2 B5:2 A5:4',
    'G5:2 E5:2 G5:2 B5:2 A5:3 G5 E5:4',
    'E5:2 G5:2 C6:4 B5:2 A5:2 G5:2 E5:2',
    'F#5:3 G5 A5:4 D5:4 r:4',
  ];
  const B = [
    'E5:2 G5:2 C6:2 E6:2 D6:3 C6 B5:4',
    'D6:2 B5:2 G5:2 B5:2 D6:4 r:2 D6:2',
    'C6:2 B5:2 A5:2 C6:2 F#5:3 A5 D6:4',
    'B5:3 A5 G5:4 G4:4 r:4',
  ];
  const A_HARM = 'B4:8 D5:8 G4:8 B4:8 E4:8 G4:8 F#4:8 A4:8';
  const B_HARM = 'E4:8 G4:8 D4:8 B4:8 C5:8 A4:8 B4:8 G4:8';
  const A_BASS = 'G2:4 D3:4 G2:4 D3:4 E2:4 B2:4 E2:4 B2:4 C3:4 G2:4 C3:4 G2:4 D3:4 A2:4 D3:4 F#2:4';
  const B_BASS = 'C3:4 G2:4 C3:4 E3:4 G2:4 D3:4 G2:4 B2:4 A2:4 E3:4 D3:4 A2:4 G2:4 D3:4 G2:8';
  const BEAT = 'h:2 h:2 s:2 h:2';
  // the cellar riff, a bar a string
  const CELLAR = [
    'E4:2 r:2 G4:2 r:2 B4:2 A4:2 G4:2 r:2',
    'F#4:2 r:2 A4:2 r:2 B3:2 D#4:2 E4:2 r:2',
    'C4:2 r:2 E4:2 r:2 G4:2 F#4:2 E4:2 r:2',
    'B3:2 r:2 D#4:2 r:2 F#4:4 E4:4',
  ];

  const SONGS = {
    title: {
      speed: 6,
      p1: '@leadHi ' + B.join(' '),
      p2: '@harm ' + B_HARM,
      t: '@bass ' + B_BASS,
      n: `[${BEAT}]8`,
    },
    overworld: {
      speed: 6,
      sections: { intro: 0, A: 8, B: 72 },
      p1: '@lead D5 r G5 r B5:2 D6:2 | ' + A.join(' ') + ' ' + B.join(' '),
      p2: '@stab r:4 B4 r D5:2 | @harm ' + A_HARM + ' ' + B_HARM,
      t: '@bass D3:4 D3:2 D3:2 | ' + A_BASS + ' ' + B_BASS,
      n: `[h:2]4 | [${BEAT}]16`,
    },
    underground: {
      speed: 8,
      p1: '@cave T+12 ' + CELLAR.join(' '),
      t: '@bass E2:8 E2:8 B1:8 B1:8 C2:8 C2:8 B1:8 B1:8',
      n: '[r:6 c r:5 c r:3]4',
    },
    // three rising stabs up a D chord and a held, shaking A: exactly 90 frames
    hurry: {
      speed: 5,
      loop: false,
      p1: '@hit B4:2 r D5:2 r F#5:2 r @alarm A5:9',
      p2: '@hit G4:2 r B4:2 r D5:2 r @alarm2 F#5:9',
      t: '@hold D3:2 r D3:2 r D3:2 r @ring D3:8 r',
      n: 'h:3 h:3 h:3 x:9',
    },
    // a G5-D5 drop, a stumble down the scale, the tonic dying away by frame 144
    death: {
      speed: 6,
      loop: false,
      p1: '@leadHi G5 D5:2 r:2 @lead F5:2 E5 D5 C5:2 B4 A4:2 @fade G4:10',
      p2: '@harm B4 G4:2 r:2 A4:2 G4 F4 E4:2 D4 C4:2 @fadeSoft B3:10',
      t: '@hold G2:2 r:3 C3:4 D3:5 @ring G2:8 r:2',
    },
    gameover: {
      speed: 11,
      loop: false,
      p1: '@sing D5:3 C5 B4:2 A4:2 G4:2 E4:2 @fade G4:4',
      p2: '@soft B4:3 A4 G4:2 F#4:2 E4:2 C4:2 @fadeSoft D4:4',
      t: '@hold G2:4 D2:4 C2:4 G2:4',
    },
    // the course-clear fanfare: 42 rows of 4 frames = 168, the last chord dies inside its own note
    flag: {
      speed: 4,
      loop: false,
      p1: '@brass D5:2 G5:2 B5:2 D6:6 E6:2 D6:2 C6:2 B5:2 C6:2 A5:4 B5:2 D6:2 @brassEnd G6:12',
      p2: '@brass2 B4:2 D5:2 G5:2 B5:6 C6:2 B5:2 A5:2 G5:2 A5:2 F#5:4 G5:2 A5:2 @brass2End B5:12',
      t: '@hold G2:6 G2:6 C3:8 D3:8 G2:12 r:2',
      n: '[h:2]15 x:12',
    },
    credits: {
      speed: 6,
      loop: false,
      p1: '@lead ' + A.join(' ') + ' @singEnd G5:32',
      p2: '@harm ' + A_HARM + ' @softEnd B4:32',
      t: '@bass ' + A_BASS + ' @ring G2:16 r:16',
      n: `[${BEAT}]8 r:32`,
    },
  };
  // the hurry-up variants: the same definition one frame a row faster; sections are rows, so they scale
  for (const id of ['overworld', 'underground']) SONGS[id + 'Fast'] = Object.assign({}, SONGS[id], { speed: SONGS[id].speed - 1 });

  const combo = (e) => Math.max(1, Math.min(9, Number(e.combo) || 1));
  const note = (n, len, v, d) => K.pt(K.mhz(n), len, { d: d == null ? 2 : d, v: v || [12, 10] });
  // Each effect returns { pri, p1?, p2?, t?, n? }; a new effect takes a channel when its priority is at least
  // the one playing there.
  const SFX = {
    // START on the title: a bright rising fifth and octave
    start: () => ({ pri: 6, p1: K.cat(note('C5', 5), note('G5', 5), note('C6', 5), K.pt(K.mhz('G6'), 18, { d: 2, v: [12, 0] })) }),
    levelstart: () => ({ pri: 1, p2: K.pt(K.mhz('G5'), 6, { d: 1, v: [6, 0] }) }),
    pause: () => ({ pri: 6, p1: K.cat(note('E6', 4, [10, 10]), K.gap(2), note('B5', 4, [10, 10]), K.gap(2), K.pt(K.mhz('E6'), 8, { d: 2, v: [10, 0] })) }),
    unpause: () => ({ pri: 6, p1: K.cat(note('B5', 3, [9, 9]), K.pt(K.mhz('E6'), 6, { d: 2, v: [9, 0] })) }),
    cursor: () => ({ pri: 2, p2: K.pt(K.mhz('A5'), 3, { d: 1, v: [8, 4] }) }),
    continue: () => ({ pri: 5, p2: K.cat(note('C6', 3), K.pt(K.mhz('G6'), 10, { d: 1, v: [11, 0] })) }),
    quit: () => ({ pri: 5, p2: K.pt(K.mhz('C5'), 12, { d: 2, v: [9, 0], bend: 0.97 }) }),
    // jump: a quick upward sweep on pulse 2; the big form starts lower and slower
    jump: (ev) => ({ pri: 2, p2: K.pt(K.mhz(ev.big ? 'G4' : 'C5'), ev.big ? 14 : 11, { d: ev.big ? 2 : 1, v: [14, 3], bend: ev.big ? 1.045 : 1.06 }) }),
    // coin: C6 then a ringing E6
    coin: () => ({ pri: 2, p2: K.cat(note('C6', 3, [13, 13], 1), K.pt(K.mhz('E6'), 16, { d: 1, v: [13, 0] })) }),
    // a head bump: a triangle knock over a short thud of noise
    bump: () => ({ pri: 2, t: K.tthud(K.mhz('C3'), 6, 0.9), n: K.nz([[12, 10], [13, 6], [14, 3]]) }),
    brick: () => ({ pri: 3, p1: K.pt(180, 8, { d: 2, v: [12, 0], bend: 0.92 }), n: K.nz([[9, 15], [10, 13], [11, 11], [12, 9], [12, 7], [13, 5], [13, 4], [14, 3], [14, 2], [15, 1]]) }),
    // the battery rising out of its crate: a slow climbing buzz
    sprout: () => ({ pri: 3, p1: K.pt(K.mhz('C4'), 30, { d: 1, v: [10, 6], bend: 1.025, wob: 0.01 }) }),
    // powered up: a charge-up arpeggio G B D G B D, then a held high G
    powerup: () => ({ pri: 5, p1: K.cat(...['G4', 'B4', 'D5', 'G5', 'B5', 'D6'].map((n) => note(n, 4, [13, 11])), K.pt(K.mhz('G6'), 14, { d: 2, v: [12, 0] })) }),
    oneup: () => ({ pri: 5, p2: K.cat(...['E6', 'G6', 'E7', 'C7', 'D7'].map((n) => note(n, 5, [11, 10], 1)), K.pt(K.mhz('G7'), 10, { d: 1, v: [11, 0] })) }),
    // a stomp: a falling blip, higher on each link of a combo
    stomp: (ev) => ({ pri: 3, p1: K.pt(330 * (1 + 0.12 * combo(ev)), 10, { d: 2, v: [15, 0], bend: 0.93 }) }),
    kick: (ev) => ({ pri: 3, p1: K.pt(260 * (1 + 0.1 * combo(ev)), 8, { d: 1, v: [14, 0], bend: 1.05 }) }),
    // hurt: a wobbling tone falling away
    hurt: () => ({ pri: 4, p1: K.pt(620, 22, { d: 0, v: [14, 2], bend: 0.96, wob: 0.04 }) }),
    checkpoint: () => ({ pri: 4, p2: K.cat(note('D6', 4, [12, 12], 1), note('A6', 4, [12, 12], 1), K.pt(K.mhz('D7'), 12, { d: 1, v: [11, 0] })) }),
    token: () => ({ pri: 4, p2: K.cat(note('E6', 3, [12, 12], 1), note('B6', 3, [12, 12], 1), K.pt(K.mhz('E7'), 18, { d: 1, v: [12, 0], vib: [0.01, 4] })) }),
    // into a pipe: a warbling tone sinking
    pipe: () => ({ pri: 5, p1: K.pt(240, 28, { d: 2, v: [12, 3], bend: 0.975, vib: [0.06, 5] }) }),
    // the grab at the beacon: a long rising slide
    flagpole: () => ({ pri: 5, p1: K.pt(K.mhz('G4'), 44, { d: 2, v: [12, 6], bend: 1.016 }) }),
    tally: () => ({ pri: 1, p2: K.pt(K.mhz('C7'), 2, { d: 1, v: [8, 8] }) }),
    firework: () => ({ pri: 3, n: K.nz([[12, 15], [12, 12], [13, 10], [13, 8], [14, 6], [14, 5], [15, 4], [15, 3], [15, 2], [15, 1]]) }),
    clear: () => ({ pri: 2, p2: K.cat(note('G5', 4, [10, 10], 1), K.pt(K.mhz('D6'), 12, { d: 1, v: [10, 0] })) }),
  };

  K.define({ songs: SONGS, sfx: SFX });
})();
