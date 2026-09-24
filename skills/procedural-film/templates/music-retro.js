// src/music.js : the retro film's score and sound effects (template). Load after src/chip.js.
//
// HOW CUES DRIVE IT
//   The timeline's cues play the chip at frame round(t * 60):
//     { t, kind: 'song', id, section }  switches to songs[id], starting at sections[section] (default row 0)
//     { t, kind: '<sfx>' }              fires sfx[kind]; the effect takes over its channels for its length,
//                                       then the song comes back on them
//   Example cue list (src/timeline.js):
//     cues: [
//       { t: 0, kind: 'song', id: 'overworld', section: 'a' },
//       { t: 1.2, kind: 'jump' },
//       { t: 1.6, kind: 'coin' },
//       { t: 3.5, kind: 'hit' },
//       { t: 6.8, kind: 'song', id: 'overworld', section: 'b' },
//     ]
//
// THE NOTATION (full notes in chip.js): one string per channel, one token per event, lengths in rows
// (16ths). `F5:4` a note, `r:2` a rest, `-:2` a tie, `@lead` an instrument (chip.js INST), `[ ... ]4`
// repeats, `|` the loop point. p1/p2 are the pulses, t the triangle, n the noise drums (NDRUM keys
// h o c x s). Every channel must be the same number of rows with the same loop point.
// Tempo: speed = frames a row. Speed 8 is 32 frames a beat = 112.5 bpm at 60 fps; set TIMELINE.bpm to match.
//
// THE SONG: 'overworld', 8 bars of 4/4 in F major, original. Section 'a' is bar 1, 'b' is bar 5.
// Chords: F | Dm | Bb C | F | Bb | F C | Gm C | F.
//
// ORIGINALITY RECORD (node tools/audio/melody.cjs --bars 8 overworld, decoded from the driver's writes):
//   bar 1: F5:3 A5 C6:4 A#5:2 A5:2 G5:4
//   bar 2: A5:2 F5:2 D5:4 E5:2 F5:2 G5:4
//   bar 3: A#5:3 A5 G5:2 F5:2 E5:4 C5:4
//   bar 4: D5:2 E5:2 F5:2 G5:2 A5:8
//   bar 5: C6:3 A#5 A5:2 C6:2 D6:4 A#5:4
//   bar 6: A5:2 G5:2 F5:2 A5:2 G5:8
//   bar 7: A#5:2 D6:2 C6:2 A#5:2 A5:2 G5:2 E5:4
//   bar 8: F5:4 C5:4 F5:8
//   Checked against the Claude Quest score (examples/claude-quest-game/src/music.js): no shared phrase.
FILM.chip.define({
  songs: {
    overworld: {
      speed: 8,
      sections: { a: 0, b: 64 },
      p1: '@lead | F5:3 A5 C6:4 A#5:2 A5:2 G5:4 A5:2 F5:2 D5:4 E5:2 F5:2 G5:4 ' +
        'A#5:3 A5 G5:2 F5:2 E5:4 C5:4 D5:2 E5:2 F5:2 G5:2 A5:8 ' +
        'C6:3 A#5 A5:2 C6:2 D6:4 A#5:4 A5:2 G5:2 F5:2 A5:2 G5:8 ' +
        'A#5:2 D6:2 C6:2 A#5:2 A5:2 G5:2 E5:4 F5:4 C5:4 F5:8',
      p2: '@harm | A4:8 C5:8 F4:8 A4:8 D5:8 E4:8 C5:8 A4:8 ' +
        'F4:8 D5:8 C5:8 E4:8 D4:8 E4:8 A4:8 A4:8',
      t: '| F2:4 C3:4 F2:4 C3:4 D2:4 A2:4 D2:4 A2:4 A#2:4 F2:4 C3:4 G2:4 F2:4 C3:4 F2:4 C3:4 ' +
        'A#2:4 F2:4 A#2:4 F2:4 F2:4 C3:4 C3:4 G2:4 G2:4 D3:4 C3:4 G2:4 F2:4 C3:4 F2:8',
      n: '| [h:2 h:2 s:2 h:2]16',
    },
  },
  sfx: {
    // jump: a square sweep on pulse 2 (the quiet harmony, so its onset stands out) up an octave and a half, fading
    jump: (ev, K) => ({ pri: 2, p2: K.pt(K.mhz('D5'), 12, { d: 2, v: [15, 4], bend: Math.pow(2.8, 1 / 11) }) }),
    // coin: a fast rising arpeggio, C6 E6 G6, then a ringing C7
    coin: (ev, K) => ({ pri: 2, p2: K.cat(K.pt(K.mhz('C6'), 2, { d: 2, v: [15, 15] }), K.pt(K.mhz('E6'), 2, { d: 1, v: [12, 12] }), K.pt(K.mhz('G6'), 2, { d: 1, v: [12, 12] }), K.pt(K.mhz('C7'), 12, { d: 1, v: [12, 0] })) }),
    // hit: a full-volume pulse on the cue frame falling fast, over a noise crunch
    hit: (ev, K) => ({ pri: 3, p1: K.pt(440, 14, { d: 2, v: [15, 0], bend: 0.9 }), n: K.nz([[10, 15], [10, 12], [11, 9], [12, 6], [12, 4], [13, 2]]) }),
  },
});
