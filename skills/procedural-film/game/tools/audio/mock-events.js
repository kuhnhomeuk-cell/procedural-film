// mock-events.js : a stand-in for FILM.game.events() while src/game is being built. TOOLS ONLY:
// the shipped film never loads this file (music.js reads FILM.game.events() and nothing else).
//
// One played level of the starter: START, the level song, then a level's density of jumps, stomps, coins,
// bumps, a power-up, a pipe and the goal. Every type is one the engine emits (src/game/10-engine.js emit()).
// events(o): o.song is the level song id (default 'overworld', the starter's song).
// Node: require() it; a browser tool page: load it as a script and read window.GAME_MOCK.events().
(function (root) {
  'use strict';
  function events(o) {
    const level = (o && o.song) || 'overworld';
    const ev = [];
    const E = (f, type, data) => ev.push(Object.assign({ f, type }, data || {}));
    const song = (f, id, section) => E(f, 'song', section ? { id, section } : { id });
    const J = (f, big) => E(f, 'jump', { big });

    // START on the title, the level card, then the first playable frame
    E(200, 'start');
    song(200, 'none');
    E(300, 'levelstart');
    song(330, level);
    J(352, false);
    J(390, false);
    E(420, 'stomp', { combo: 1 });
    J(466, false);
    E(492, 'bump');
    E(492, 'coin');
    J(540, false);
    E(560, 'bump');
    E(562, 'sprout'); // the power-up rises out of the block
    E(640, 'powerup');
    J(676, true);
    E(700, 'brick');
    J(740, true);
    E(790, 'coin');
    E(806, 'coin');
    E(944, 'stomp', { combo: 1 });
    E(958, 'stomp', { combo: 2 });
    E(1000, 'hurt');
    J(1060, true);
    E(1100, 'checkpoint');
    E(1180, 'pipe'); // down into a side room
    song(1180, 'none');
    song(1210, level);
    for (let k = 0; k < 4; k++) E(1230 + k * 18, 'coin');
    E(1320, 'pipe'); // out
    J(1400, false);
    E(1430, 'flagpole', { height: 5000, frames: 58 }); // the goal
    song(1430, 'none');
    E(1500, 'clear');
    ev.sort((a, b) => a.f - b.f);
    return ev;
  }
  const api = { events };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GAME_MOCK = api;
})(typeof window !== 'undefined' ? window : globalThis);
