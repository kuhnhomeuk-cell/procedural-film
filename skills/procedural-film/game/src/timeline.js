/*
 * timeline.js : the attract film. One continuous shot: the attract tape (GAME.ATTRACT, recorded from
 * tools/proof/tapes/<firstLevel>.modern.json) played on one TV. 1920x1080 output, 60 fps (the console's
 * refresh). The game draws each frame into the native 320x180 buffer (FILM.native()), src/crt.js presents it.
 *
 * The block between the attract markers is written by tools/attract.cjs (never by hand): the tape's length
 * in frames, the frame the level song starts, the level song's id and the closing caption (CONFIG.title).
 * The timeline is evaluated on its own by the tools, so it cannot read GAME at load time.
 *
 * Layout in global frames, the game frame equal to the film frame (as in examples/claude-quest-game):
 *   powerOn  [0, ON]              the set powers on over the title and the lives screen
 *   play     the tape runs to its last frame (the beacon), then the engine plays on (pole, fanfare)
 *   powerOff [TAPE + ON, TAPE + ON + OFF]   ON frames after the tape ends, so the goal is seen
 *   the dark glass with the closing caption, padded to whole bars at 112.5 bpm (128 frames a bar)
 */
(function () {
  'use strict';
  const FILM = (window.FILM = window.FILM || {});
  // <attract> written by tools/attract.cjs
  const ATTRACT = { tape: 1641, songAt: 110, song: "overworld", caption: "ROBOT RUN" };
  // </attract>
  const ON = 120, OFF = 120, BAR = 128;
  const offAt = ATTRACT.tape + ON;
  const FRAMES = Math.ceil((offAt + OFF) / BAR) * BAR;
  FILM.TIMELINE = {
    title: 'attract',
    bpm: 112.5, // the chip songs count in 60 Hz frames: speed 8 = 8 frames a row = 32 frames a beat
    duration: FRAMES / 60,
    fps: 60,
    width: 1920,
    height: 1080,
    retro: {
      native: [320, 180],
      present: 'crt',
      crt: { caption: ATTRACT.caption, powerOn: [0, ON], powerOff: [offAt, offAt + OFF] },
    },
    shots: [
      { id: 'game', file: '01-game.js', start: 0, end: FRAMES / 60, mode: 'none', title: 'Attract',
        brief: 'The TV powers on, the attract tape plays the first level to its beacon, the TV powers off on the title.' },
    ],
    // the sound follows the game's own events when a game is loaded (src/chip.js); this cue is the fallback
    cues: [{ t: ATTRACT.songAt / 60, kind: 'song', id: ATTRACT.song }],
  };
})();
