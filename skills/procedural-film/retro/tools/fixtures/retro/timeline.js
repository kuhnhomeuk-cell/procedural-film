// Retro fixture timeline for testing the tools (not a film). 4 seconds, 2 shots, 60 fps.
// Shot 01 presents the native buffer with FILM.presentNearest; shot 02 presents the same sheet
// through FILM.crt.present. Both shots are mode 'none', so the 'fade' into shot 02 runs the NES
// palette fade (FILM.transitions.fade in pixel.js acts only when the incoming shot is mode 'none').
// CRT windows are global frames: the power-on starts at frame 150, after the 0.5 s fade (120-150),
// so the fade runs on dark glass. The power-off is 12 frames (201-213) so its caption point
// (off0 + 90/120 of the window = 210) leaves 30 frames to the film's end at 240 and 'TEST CARD' shows.
FILM.TIMELINE = {
  title: 'retro-fixture',
  width: 1920,
  height: 1080,
  fps: 60,
  bpm: 112.5, // the chip song: speed 8 = 8 frames a row, 4 rows a beat = 32 frames = 112.5 bpm at 60 fps
  duration: 4,
  retro: {
    native: [320, 180],
    present: 'crt',
    crt: { caption: 'TEST CARD', powerOn: [150, 200], powerOff: [201, 213] },
  },
  shots: [
    { id: 'sheet', file: '01-sheet.js', start: 0, end: 2, mode: 'none', brief: 'Fixture sprite sheet on the native buffer, presented nearest-neighbour; the robot walks.' },
    { id: 'crt', file: '02-crt.js', start: 2, end: 4, mode: 'none', transitionIn: { dur: 0.5, kind: 'fade' }, brief: 'The same sheet through the CRT: power-on, picture, power-off, caption.' },
  ],
  cues: [
    { t: 0, kind: 'song', id: 'test', section: 'a' },
    { t: 1, kind: 'blip' },
    { t: 2.5, kind: 'thud' },
  ],
};
