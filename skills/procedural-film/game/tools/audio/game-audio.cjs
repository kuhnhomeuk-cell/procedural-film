// game-audio.cjs : T6 static gate for the game's sound (docs/game-spec.md sections 7, 10 and 13.6).
//   node tools/audio/game-audio.cjs
// Runs src/chip.js and src/music.js in Node (the Node host) and proves, from the driver's own register writes:
//   levels     every song a level names (GAME.GAME_DEFS[*].song, read through the proof harness) is in
//              FILM.audio.songs, with the Fast variant the engine's hurry-up switches to
//   engine     every song the engine sets itself (setSong in src/game/10-engine.js: title, flag, death,
//              gameover, hurry and 'credits', the final card's song) is in FILM.audio.songs
//   events     every event type in the mock level (tools/audio/mock-events.js, the engine's own names) has
//              an effect, and every song it names exists
//   effects    no effect touches the DMC
//   songs      every song compiles: frames = rows x speed, a loop point inside the song
//   fast       each level song's Fast variant runs at speed minus 1 with every section scaled and the same
//              notes on every row
//   pause      a paused driver holds sf and silences the song (DMC stopped with $4015 = $0F) while effects
//              play; unpause resumes the same sf with every sounding voice retriggered, and from there the
//              song is register-for-register the unpaused song; a song event clears the pause
// Dropped with the Claude Quest score (each read a section of its spec or judged a song only it had): the
// spec section 7 event table and shell cues; the 10.2 effect table (priority, channels, length per effect);
// death 144 frames, gameover <= 176, sky sections A and B, boss loops, hurry 90 frames and its three stabs,
// death and gameover silent inside 180 frames; the boss lead on pulse 2 under a roar; the old credits
// parade's chord (the parade is now one final card); the film-invariance audio and event hashes; a pause
// with no song (it used 'death').
// Exits non-zero on any failure.
'use strict';
const H = require('./host.cjs');
const results = [];
function report(group, ok, msg, details = []) {
  results.push(ok);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${group}: ${msg}`);
  for (const d of details.slice(0, 30)) console.log(`       ${d}`);
  if (details.length > 30) console.log(`       ... ${details.length - 30} more`);
}

const FILM = H.load({ foley: false });
const A = FILM.audio;
const info = A.info();
const SFX = new Set(A.sfx);
const SONGS = new Set(A.songs);

// the level songs, from the game's own defs
let DEFS = null;
let defsErr = null;
try {
  DEFS = require('../proof/harness.cjs').load().GAME.GAME_DEFS || null;
} catch (e) {
  defsErr = e;
}
const LEVEL_SONGS = new Set();
for (const d of Object.values(DEFS || {})) {
  if (d.song && d.song !== 'none') LEVEL_SONGS.add(d.song);
}

// ---------------------------------------------------------------- helpers
/** Run a bare driver: evs is [[frame, event], ...]; returns per-frame writes and states. */
function drive(frames, evs, mute) {
  const d = A.driver(mute);
  const byF = new Map();
  for (const [f, e] of evs) {
    if (!byF.has(f)) byF.set(f, []);
    byF.get(f).push(Object.assign({ f }, e));
  }
  const writes = [];
  const states = [];
  for (let f = 0; f < frames; f++) {
    writes.push(d.frame(f, byF.get(f) || []));
    states.push(d.state());
  }
  return { writes, states };
}
/** The registers' values after each frame (the chip's view), for comparing two runs. */
function regTrace(writes) {
  const reg = {};
  return writes.map((w) => {
    const trig = [];
    for (let i = 0; i < w.length; i += 2) {
      reg[w[i]] = w[i + 1];
      if (w[i] === 0x4003 || w[i] === 0x4007 || w[i] === 0x400b || w[i] === 0x400f) trig.push(w[i]);
    }
    return { reg: Object.assign({}, reg), trig };
  });
}
/** Per-frame view of one channel from the writes: pulse { v, t, trig }, triangle { on, t, trig }, noise { v }. */
function channelTrace(writes, ch) {
  const base = ch === 'p1' ? 0x4000 : 0x4004;
  let v = 0;
  let t = 0;
  let triOn = false;
  let nv = 0;
  return writes.map((w) => {
    let trig = false;
    for (let i = 0; i < w.length; i += 2) {
      const a = w[i];
      const x = w[i + 1];
      if (ch === 'p1' || ch === 'p2') {
        if (a === base) v = x & 15;
        if (a === base + 2) t = (t & 0x700) | x;
        if (a === base + 3) {
          t = (t & 0xff) | ((x & 7) << 8);
          trig = true;
        }
      } else if (ch === 't') {
        if (a === 0x4008) triOn = x !== 0x80;
        if (a === 0x400a) t = (t & 0x700) | x;
        if (a === 0x400b) {
          t = (t & 0xff) | ((x & 7) << 8);
          trig = true;
        }
      } else if (ch === 'n' && a === 0x400c) nv = x & 15;
    }
    if (ch === 't') return { on: triOn, t, trig };
    if (ch === 'n') return { v: nv };
    return { v, t, trig };
  });
}
/** What the chip plays each frame, as a string: each pulse's volume, duty and (when sounding) timer, the
 * triangle's timer when on, the noise's volume and period, and any DMC sample started that frame. */
function audible(writes) {
  return regTrace(writes).map(({ reg }, f) => {
    const pul = (b) => {
      const v = reg[b] & 15;
      return v ? `${v}/${reg[b] >> 6}/${reg[b + 2] | ((reg[b + 3] & 7) << 8)}` : '0';
    };
    const tri = reg[0x4008] !== undefined && reg[0x4008] !== 0x80 ? String(reg[0x400a] | ((reg[0x400b] & 7) << 8)) : '-';
    const nv = reg[0x400c] & 15;
    const w = writes[f];
    const dmc = w.some((x, i) => i % 2 === 0 && x === 0x4015 && w[i + 1] & 0x10) ? `${reg[0x4010]}/${reg[0x4012]}/${reg[0x4013]}` : '';
    return [pul(0x4000), pul(0x4004), tri, nv ? `${nv}/${reg[0x400e]}` : '0', dmc].join(' ');
  });
}
const writesOf = (ev, frames) => drive(frames, [[0, ev]]).writes.map((w) => w.join(','));
const pitch = (t, tri) => {
  const hz = 1789773 / ((tri ? 32 : 16) * (t + 1));
  return 69 + 12 * Math.log2(hz / 440);
};
// ---------------------------------------------------------------- 1 the level songs
{
  if (!DEFS) report('levels', false, `GAME.GAME_DEFS did not load: ${defsErr ? defsErr.message : 'missing'}`);
  else {
    const bad = [];
    for (const [id, d] of Object.entries(DEFS)) {
      const s = d.song;
      if (!s || s === 'none') continue;
      if (!SONGS.has(s)) bad.push(`level ${id}: names the song '${s}', which music.js does not define`);
      else if (!SONGS.has(s + 'Fast')) bad.push(`level ${id}: no '${s}Fast' for the hurry-up`);
    }
    if (!LEVEL_SONGS.size) bad.push('no level names a song');
    report('levels', !bad.length, `every level song in GAME.GAME_DEFS exists with its Fast variant: ${[...LEVEL_SONGS].join(', ')}`, bad);
  }
}

// ---------------------------------------------------------------- 1b the engine's own songs
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/game/10-engine.js'), 'utf8');
  const ids = [...new Set([...src.matchAll(/setSong\(W, '([A-Za-z0-9_-]+)'/g)].map((m) => m[1]))].filter((x) => x !== 'none');
  const bad = ids.filter((x) => !SONGS.has(x)).map((x) => `the engine sets '${x}', which music.js does not define`);
  if (!ids.includes('credits')) bad.push("the engine sets no 'credits' song for the final card");
  report('engine', !bad.length, `every song the engine sets is defined: ${ids.join(', ')}`, bad);
}

// ---------------------------------------------------------------- 2 events (the mock level)
{
  const first = [...LEVEL_SONGS][0] || A.songs[0];
  const evs = require('./mock-events.js').events({ song: first });
  const bad = [];
  const types = new Set();
  for (const e of evs) {
    if (e.type === 'song') {
      if (e.id !== 'none' && !SONGS.has(e.id)) bad.push(`f${e.f}: song '${e.id}' is not defined`);
    } else {
      types.add(e.type);
      if (!SFX.has(e.type)) bad.push(`${e.type}: no effect`);
    }
  }
  report('events', !bad.length, `the ${types.size} event types of the mock level (${[...types].join(', ')}) all have an effect`, [...new Set(bad)]);
}

// ---------------------------------------------------------------- 3 effects
{
  // no effect ever plays the DMC: no program has a DMC channel, and beyond the driver's power-on writes
  // (a run with no event) no $4010, $4012 or $4013 write and no $4015 with the DMC bit (a `pause` also
  // cuts a drum the song was playing: $4015 = $0F and the DAC's rest level in $4011, which start nothing)
  const dmcWrites = (w) => {
    const out = [];
    for (let i = 0; i < w.length; i += 2) if (w[i] === 0x4010 || w[i] === 0x4012 || w[i] === 0x4013 || (w[i] === 0x4015 && w[i + 1] & 0x10)) out.push(`$${w[i].toString(16)} = ${w[i + 1]}`);
    return out.join(' ');
  };
  const quiet = drive(80, []).writes.map(dmcWrites);
  const dmc = [];
  for (const id of A.sfx) {
    for (const ev of [{ type: id }, { type: id, held: true }, { type: id, combo: 4 }, { type: id, big: true }]) {
      const chans = Object.keys(A.effect(ev)).filter((k) => k !== 'pri');
      if (chans.some((k) => !['p1', 'p2', 't', 'n'].includes(k))) dmc.push(`${id}: a program on ${chans.join(',')}`);
      const { writes } = drive(80, [[0, ev]]);
      writes.forEach((w, f) => {
        if (dmcWrites(w) !== quiet[f]) dmc.push(`${id} frame ${f}: ${dmcWrites(w)}`);
      });
    }
  }
  report('effects', !dmc.length, `none of the ${A.sfx.length} effects plays the DMC`, dmc);
}

// ---------------------------------------------------------------- 4 songs
{
  const bad = [];
  const lines = [];
  for (const [id, s] of Object.entries(info.songs)) {
    if (!(s.frames > 0) || s.frames !== s.rows * s.speed) bad.push(`${id}: ${s.rows} rows x speed ${s.speed} is not ${s.frames} frames`);
    if (s.loopFrame !== null && !(s.loopFrame >= 0 && s.loopFrame < s.frames)) bad.push(`${id}: loop at frame ${s.loopFrame}, outside its ${s.frames} frames`);
    lines.push(`${id.padEnd(16)} ${s.frames} frames, speed ${s.speed}, ${s.loopFrame === null ? 'no loop' : 'loops at ' + s.loopFrame}`);
  }
  if (!A.songs.length) bad.push('music.js defines no song');
  report('songs', !bad.length, `the ${A.songs.length} songs compile`, bad.length ? bad : lines);
}

// ---------------------------------------------------------------- 5 fast variants
{
  const bad = [];
  const lines = [];
  for (const id of LEVEL_SONGS) {
    const s = info.songs[id];
    const q = info.songs[id + 'Fast'];
    if (!s || !q) {
      bad.push(`${id}Fast: missing`);
      continue;
    }
    if (q.speed !== s.speed - 1) bad.push(`${id}Fast: speed ${q.speed}, want ${s.speed - 1}`);
    if (q.rows !== s.rows || q.frames !== q.rows * q.speed) bad.push(`${id}Fast: ${q.rows} rows / ${q.frames} frames`);
    if ((q.loopFrame === null) !== (s.loopFrame === null) || (s.loopFrame !== null && q.loopFrame / q.speed !== s.loopFrame / s.speed)) bad.push(`${id}Fast: loop at frame ${q.loopFrame}, the source loops at ${s.loopFrame}`);
    for (const k of Object.keys(s.sections)) if (q.sections[k] !== (s.sections[k] / s.speed) * q.speed) bad.push(`${id}Fast: section ${k} at frame ${q.sections[k]}, want ${(s.sections[k] / s.speed) * q.speed}`);
    // the same notes on every row: each channel's timer at each row start, first 96 rows
    const rows = Math.min(96, s.rows);
    const a = drive(rows * s.speed, [[0, { type: 'song', id }]]).writes;
    const b = drive(rows * q.speed, [[0, { type: 'song', id: id + 'Fast' }]]).writes;
    for (const ch of ['p1', 'p2', 't']) {
      const ta = channelTrace(a, ch);
      const tb = channelTrace(b, ch);
      for (let r = 0; r < rows; r++) {
        const x = ta[r * s.speed];
        const y = tb[r * q.speed];
        if (x.trig !== y.trig || (x.trig && x.t !== y.t)) {
          bad.push(`${id}Fast: ${ch} row ${r} differs from ${id}`);
          break;
        }
      }
    }
    lines.push(`${(id + 'Fast').padEnd(16)} speed ${q.speed} (${id} ${s.speed}), ${q.frames} frames (${s.frames}), loop ${q.loopFrame} (${s.loopFrame}), sections ${JSON.stringify(q.sections)}`);
  }
  report('fast', !bad.length, `the ${LEVEL_SONGS.size} level songs' fast variants run at speed minus 1 with scaled sections and the same notes`, bad.length ? bad : lines);
}

// ---------------------------------------------------------------- 6 the driver pause (spec 10.3)
{
  const HOLD = 240; // frames paused
  const id = [...LEVEL_SONGS][0] || A.songs[0];
  const song = [0, { type: 'song', id }];
  const N = 1400;
  const ref = drive(N, [song]);
  const refW = ref.writes;
  const has = (w, a, bit) => w.some((x, i) => i % 2 === 0 && x === a && (bit == null || w[i + 1] & bit));
  const rp1 = channelTrace(refW, 'p1');
  const rp2 = channelTrace(refW, 'p2');
  const rt = channelTrace(refW, 't');
  const rn = channelTrace(refW, 'n');
  // the frames an effect of this type holds its channels (0 when music.js has no such effect)
  const fxLen = (type) => {
    const e = SFX.has(type) ? A.effect({ type }) : null;
    return e ? Math.max(0, ...Object.keys(e).filter((k) => k !== 'pri').map((k) => e[k])) : 0;
  };
  const PAUSE_FX = fxLen('pause');
  const CURSOR_FX = fxLen('cursor');
  // pause points: on a drum hit when the song has one (the drum must be cut and never restarted while
  // paused), and inside the most voices sounding at once (each must be retriggered on unpause)
  let onDrum = -1;
  let midNotes = -1;
  let bestVoices = 0;
  for (let f = 60; f < Math.min(N - HOLD - 100, 800); f++) {
    if (onDrum < 0 && has(refW[f], 0x4015, 0x10)) onDrum = f;
    const voices = [rp1[f].v > 0 && !rp1[f].trig, rp2[f].v > 0 && !rp2[f].trig, rt[f].on && !rt[f].trig, rn[f].v > 0 && !has(refW[f], 0x400f)].filter(Boolean).length;
    if (voices > bestVoices) (bestVoices = voices), (midNotes = f);
  }
  const lines = [];
  const bad = [];
  if (!id) bad.push('no song to pause');
  if (midNotes < 0) bad.push(`no pause point found: the song '${id}' never sounds a held voice in frames 60..800`);
  for (const P0 of [onDrum, midNotes].filter((f) => f >= 0)) {
    const U = P0 + HOLD;
    const tag = `pause at ${P0}${P0 === onDrum ? ' (on a drum)' : ' (mid-note)'}`;
    const evs = [song, [P0, { type: 'pause' }], [P0 + 60, { type: 'cursor' }], [U, { type: 'unpause' }]];
    const run = drive(N, evs);
    const sfAt = ref.states[P0 - 1].sf; // the song frame the pause frame would have played
    const drift = [];
    for (let f = P0; f < U; f++) if (run.states[f].sf !== sfAt || !run.states[f].paused) drift.push(f);
    if (drift.length) bad.push(`${tag}: sf moved or the pause dropped on ${drift.length} frames (first ${drift[0]}: sf ${run.states[drift[0]].sf})`);
    // the song is silent: only the pause and cursor effects sound; the DMC is cut on the pause frame
    // ($4015 = $0F) and no drum starts until the unpause
    const p1 = channelTrace(run.writes, 'p1');
    const p2 = channelTrace(run.writes, 'p2');
    const tri = channelTrace(run.writes, 't');
    const noi = channelTrace(run.writes, 'n');
    const wP = run.writes[P0];
    if (!wP.some((x, i) => i % 2 === 0 && x === 0x4015 && wP[i + 1] === 0x0f)) bad.push(`${tag}: no $4015 = $0F on the pause frame`);
    const loud = [];
    for (let f = P0; f < U; f++) {
      const w = run.writes[f];
      if (has(w, 0x4010) || has(w, 0x4012) || has(w, 0x4013) || has(w, 0x4015, 0x10)) loud.push(`frame ${f}: a drum starts`);
      const inFx = f < P0 + PAUSE_FX || (f >= P0 + 60 && f < P0 + 60 + CURSOR_FX);
      if (inFx) continue;
      if (p1[f].v || p2[f].v) loud.push(`frame ${f}: a pulse sounds`);
      if (tri[f].on && f > P0) loud.push(`frame ${f}: the triangle sounds`);
      if (noi[f].v) loud.push(`frame ${f}: the noise sounds`);
    }
    if (loud.length) bad.push(`${tag}: the song is not silent: ${loud.slice(0, 4).join('; ')}${loud.length > 4 ? ` (+${loud.length - 4})` : ''}`);
    // what reaches the speaker between the pause effect and the cursor tick: silence
    const sr = 48000;
    const spf = sr / 60;
    const all = evs.map(([f, e]) => Object.assign({ f }, e));
    const buf = A.synth(sr, { events: all, samples: (P0 + 70) * spf, foley: false });
    const q0 = P0 + PAUSE_FX + 5;
    let e2 = 0;
    for (let i = q0 * spf; i < (P0 + 58) * spf; i++) e2 += buf[i] * buf[i];
    const rms = Math.sqrt(e2 / Math.max(1, (P0 + 58 - q0) * spf));
    if (q0 < P0 + 58 && !(rms < 1e-3)) bad.push(`${tag}: the output is not silent while paused (rms ${rms.toExponential(2)})`);
    // unpause: the same sf, the sounding voices retriggered, then register for register the unpaused song
    if (run.states[U].sf !== sfAt + 1 || run.states[U].paused) bad.push(`${tag}: unpause played sf ${run.states[U].sf - 1}, want ${sfAt}`);
    if (P0 === midNotes) {
      const wU = run.writes[U];
      const want = [[rp1, 0x4003, 'pulse 1'], [rp2, 0x4007, 'pulse 2'], [null, 0x400b, 'the triangle'], [rn, 0x400f, 'the noise']];
      const miss = want
        .filter(([tr, a]) => (a === 0x400b ? rt[P0].on : tr[P0].v > 0) && !has(wU, a))
        .map(([, , n]) => n);
      if (miss.length) bad.push(`${tag}: unpause did not retrigger ${miss.join(', ')}`);
    }
    const heard = audible(run.writes);
    const refHeard = audible(refW);
    let firstDiff = -1;
    for (let k = 10; k < N - U && firstDiff < 0; k++) if (heard[U + k] !== refHeard[P0 + k] || run.states[U + k].sf !== ref.states[P0 + k].sf) firstDiff = k;
    if (firstDiff >= 0) bad.push(`${tag}: ${firstDiff} frames after the unpause the song no longer matches the unpaused song`);
    lines.push(`${tag}: sf held at ${sfAt} for ${HOLD} frames, output rms ${rms.toExponential(1)} after the pause effect; unpause resumed sf ${sfAt} and matched the unpaused song for ${N - U - 10} frames`);
  }
  // a song event always clears the pause, and the new song plays from its top
  const s2 = drive(200, [song, [50, { type: 'pause' }], [80, { type: 'song', id }]]);
  if (s2.states[80].paused || s2.states[81].sf !== 2 || s2.states[81].song !== id) bad.push(`a song event during the pause did not clear it: ${JSON.stringify(s2.states[81])}`);
  else lines.push('a song event during a pause clears it: the new song plays from its top');
  report('pause', !bad.length, `the driver pause holds sf, silences '${id}' and lets effects play; unpause resumes the same sf`, bad.length ? bad : lines);
}


const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
