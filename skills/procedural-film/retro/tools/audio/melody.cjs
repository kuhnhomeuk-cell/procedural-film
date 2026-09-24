// melody.cjs : what each song's melody really is, decoded from the driver's own register writes.
//   node tools/audio/melody.cjs [--bars 4] [--ch p1|p2] [song ...]
// For the copyright review: renders each song alone with the register log on, follows the chosen pulse
// channel's writes ($4000 volume, $4002/$4003 timer; a $4003 write on a row boundary is a new note) and
// prints the notes bar by bar as name:rows, converting each timer back to the nearest equal-tempered
// note (with the tuning error in cents, which the 11-bit timer causes). Rests are r:rows.
// Loads the project's own src/lib.js, src/timeline.js, src/chip.js and src/music.js in a vm sandbox
// (the minimal loader lifted from examples/claude-quest-game/tools/audio/host.cjs). Writes nothing.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = path.join(path.resolve(__dirname, '..', '..'), 'src');
const H = {
  load() {
    const sb = { console, Math, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8Array, Map, Set, Object, Array, Number, String, Error, JSON, isFinite, Proxy, Symbol, Reflect };
    sb.window = sb;
    sb.globalThis = sb;
    sb.FILM = {};
    vm.createContext(sb);
    for (const f of ['lib.js', 'timeline.js', 'chip.js', 'music.js']) {
      const file = path.join(SRC, f);
      if (!fs.existsSync(file)) throw new Error(`melody.cjs: ${file} is missing`);
      vm.runInContext(fs.readFileSync(file, 'utf8'), sb, { filename: file });
    }
    return sb.FILM;
  },
};
const args = process.argv.slice(2);
const bi = args.indexOf('--bars');
const BARS = bi >= 0 ? Number(args[bi + 1]) : 4;
const ci = args.indexOf('--ch');
const CH = ci >= 0 ? args[ci + 1] : 'p1';
const pick = args.filter((a, i) => !a.startsWith('--') && !(bi >= 0 && i === bi + 1) && !(ci >= 0 && i === ci + 1));
const FILM = H.load();
const info = FILM.audio.info();
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const base = CH === 'p2' ? 0x4004 : 0x4000;

for (const id of pick.length ? pick : FILM.audio.songs) {
  const s = info.songs[id];
  // a song with an intro before its hook (song.section 'A') is counted in bars from the hook
  const A = s.sections && s.sections.A != null ? s.sections.A / s.speed : 0;
  const frames = Math.min(s.frames, (16 * BARS + A) * s.speed);
  const buf = FILM.audio.synth(48000, { events: [{ f: 0, type: 'song', id }], samples: Math.ceil((frames / 60) * 48000) + 800, foley: false, log: true });
  let vol = 0;
  let timer = 0;
  const onsets = []; // [row, name, cents] or [row, null] for a rest
  const byF = new Map(buf.log);
  let sounding = false;
  for (let f = 0; f < frames; f++) {
    const w = byF.get(f) || [];
    let trig = false;
    for (let i = 0; i < w.length; i += 2) {
      if (w[i] === base) vol = w[i + 1] & 15;
      if (w[i] === base + 2) timer = (timer & 0x700) | w[i + 1];
      if (w[i] === base + 3) {
        timer = (timer & 0xff) | ((w[i + 1] & 7) << 8);
        trig = true;
      }
    }
    if (f % s.speed !== 0) continue;
    const row = f / s.speed;
    if (trig && vol > 0) {
      const hz = 1789773 / (16 * (timer + 1));
      const m = 69 + 12 * Math.log2(hz / 440);
      const r = Math.round(m);
      onsets.push([row, NAMES[r % 12] + (Math.floor(r / 12) - 1), Math.round((m - r) * 100)]);
      sounding = true;
    } else if (vol === 0 && sounding) {
      // silent on a row boundary: a rest if the note before has ended (the driver's gap frame sits
      // at a note's end, so look one frame on)
      const next = byF.get(f + 1) || [];
      let v2 = 0;
      for (let i = 0; i < next.length; i += 2) if (next[i] === base) v2 = next[i + 1] & 15;
      if (v2 === 0) {
        onsets.push([row, null]);
        sounding = false;
      }
    } else if (!sounding && trig) sounding = false;
  }
  const rowsTotal = Math.floor(frames / s.speed);
  const bars = [];
  const intro = [];
  for (let k = 0; k < onsets.length; k++) {
    const [row, name, cents] = onsets[k];
    const len = Math.min(k + 1 < onsets.length ? onsets[k + 1][0] : rowsTotal, row < A ? A : Infinity) - row;
    const bar = Math.floor((row - A) / 16);
    (row < A ? intro : (bars[bar] = bars[bar] || [])).push(name ? `${name}${len > 1 ? ':' + len : ''}${Math.abs(cents) > 12 ? `(${cents > 0 ? '+' : ''}${cents}c)` : ''}` : `r${len > 1 ? ':' + len : ''}`);
  }
  if (onsets.length && onsets[0][0] > 0) (bars[0] = bars[0] || []).unshift(`r:${onsets[0][0]}`);
  console.log(`${id} (${s.speed} frames a 16th, ${(3600 / (4 * s.speed)).toFixed(1)} bpm), ${CH}:`);
  if (A) console.log(`  intro (${A} rows): ${intro.join(' ') || 'r:' + A}`);
  bars.forEach((b, i) => console.log(`  bar ${i + 1}: ${(b || []).join(' ')}`));
}
