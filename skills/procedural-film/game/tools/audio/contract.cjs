// contract.cjs : checks the sound timing contract (docs/game-spec.md 10) from the driver's own register
// writes (music.js alone, no game needed), and, given an event list, how the real timeline meets it.
//   node tools/audio/contract.cjs [--events events.json]
//   lengths    the goal slide ('flagpole', when music.js has that effect) lasts exactly its event's
//              `frames`, so the slide sound ends as the hero lands
//   songs      every level song named in GAME.GAME_DEFS is a song music.js defines
//   timeline   (with events) every song event names a defined song (or 'none'), and the events are sorted
// Dropped with the Claude Quest score (they judged songs and events only it had): bossfall 64 frames; the
// flag fanfare's 168 frames and fade; the ending tag's tonic at 256; the rescue cadence inside 288; the
// flag -> tally, bossfall -> rescue, rescue -> ending and ending -> power-off gaps; the pulse-1 payoffs
// during the fanfare, the rescue and the ending.
'use strict';
const fs = require('fs');
const H = require('./host.cjs');
const args = process.argv.slice(2);
const ei = args.indexOf('--events');
const FILM = H.load({ foley: false });
const SONGS = new Set(FILM.audio.songs);
const out = [];
const ok = (cond, msg) => out.push(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
// per-frame volume of a pulse channel from the register log
function pulseVols(events, frames, base) {
  const buf = FILM.audio.synth(48000, { events, samples: Math.ceil(((frames + 2) / 60) * 48000), foley: false, log: true });
  const byF = new Map(buf.log);
  const v = new Array(frames).fill(0);
  let cur = 0;
  for (let f = 0; f < frames; f++) {
    for (const [a, val] of pairs(byF.get(f) || [])) if (a === base) cur = val & 15;
    v[f] = cur;
  }
  return v;
}
function* pairs(w) {
  for (let i = 0; i < w.length; i += 2) yield [w[i], w[i + 1]];
}
const lastOn = (v) => v.reduce((m, x, i) => (x > 0 ? i : m), -1);

if (FILM.audio.sfx.includes('flagpole')) {
  for (const n of [40, 70, 95]) {
    const v = pulseVols([{ f: 0, type: 'flagpole', height: 5000, frames: n }], n + 20, 0x4000);
    ok(lastOn(v) === n - 1, `flagpole frames ${n}: pulse 1 sounds frames 0..${lastOn(v)} (${lastOn(v) + 1} frames)`);
  }
} else out.push("SKIP flagpole length: music.js defines no 'flagpole' effect");

// the level songs, read from the game's own defs (loaded through tools/proof/harness.cjs)
{
  let defs = null;
  try {
    defs = require('../proof/harness.cjs').load().GAME.GAME_DEFS;
  } catch (e) {
    out.push(`FAIL the game did not load: ${e.message}`);
  }
  if (defs) {
    for (const [id, d] of Object.entries(defs)) {
      for (const s of [d.song]) if (s && s !== 'none') ok(SONGS.has(s), `level ${id}: its song '${s}' is defined in music.js`);
    }
  } else out.push('FAIL GAME.GAME_DEFS is missing');
}

if (ei >= 0) {
  const events = JSON.parse(fs.readFileSync(args[ei + 1], 'utf8'));
  const bad = events.filter((e) => e.type === 'song' && e.id !== 'none' && !SONGS.has(e.id));
  ok(!bad.length, `every song event names a defined song${bad.length ? ': ' + bad.map((e) => `f${e.f} ${e.id}`).join(', ') : ''}`);
  ok(!events.some((e, i) => i && e.f < events[i - 1].f), 'the events are sorted by frame');
}
console.log(out.join('\n'));
if (out.some((l) => l.startsWith('FAIL'))) process.exit(1);
