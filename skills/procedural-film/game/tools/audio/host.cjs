// host.cjs : run the film's audio code (lib.js, timeline.js, foley.js, chip.js, music.js) in Node, no browser.
// The same source files the page loads, evaluated in a vm sandbox, so a render here is the render the
// film makes (tools/audio/seek.cjs proves the browser path matches). Shared helpers for the audio tools.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '.tmp', 'audio');

/**
 * A fresh FILM with the audio stack loaded. chip.js (the driver and the APU) loads before music.js (the
 * songs and effects it registers through FILM.chip.define). timeline.js and foley.js load when present;
 * opts.foley false leaves foley.js out.
 */
function load(opts = {}) {
  const sb = { console, Math, Float32Array, Float64Array, Uint32Array, Int32Array, Uint8Array, Map, Set, Object, Array, Number, String, Error, JSON, isFinite };
  sb.window = sb;
  sb.globalThis = sb;
  sb.FILM = {};
  vm.createContext(sb);
  const optional = (f) => fs.existsSync(path.join(SRC, f));
  const files = ['lib.js', ...['timeline.js'].filter(optional), ...(opts.foley === false ? [] : ['foley.js'].filter(optional)), 'chip.js', 'music.js'];
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), sb, { filename: path.join(SRC, f) });
  return sb.FILM;
}

/**
 * The real events: FILM.game.events() from a Chromium page with the film's full load order.
 * Resolves null when src/game has no scripts yet or FILM.game.events is missing.
 */
async function gameEvents() {
  const gameDir = path.join(SRC, 'game');
  if (!fs.existsSync(gameDir) || !fs.readdirSync(gameDir).some((f) => f.endsWith('.js'))) return null;
  const C = require('../common.cjs');
  const src = C.sources({ player: false, lenient: true });
  const browser = await C.launch();
  try {
    const pg = await C.openPage(browser, src.files.filter((f) => fs.existsSync(f)), { scale: 0.1, prefix: 'audio-events' });
    const errs = [...pg.loadErrors.map((e) => `${e.file}:${e.line} ${e.message}`), ...pg.pageErrors];
    const ev = await pg.page.evaluate(() => (window.FILM.game && typeof FILM.game.events === 'function' ? FILM.game.events() : null));
    await pg.close();
    if (!ev && errs.length) throw new Error('the game did not load:\n  ' + errs.join('\n  '));
    return ev;
  } finally {
    await browser.close();
  }
}

/** Real events when the game provides them (unless mock is asked for), else the mock list; or a saved list. */
async function events(opts = {}) {
  if (opts.file) return { events: JSON.parse(fs.readFileSync(opts.file, 'utf8')), source: `${opts.file} (a saved event list)` };
  const real = opts.mock ? null : await gameEvents();
  return real ? { events: real, source: 'FILM.game.events() (the real game)' } : { events: mockEvents(), source: 'tools/audio/mock-events.js (mock)' };
}

function mockEvents() {
  delete require.cache[require.resolve('./mock-events.js')];
  return require('./mock-events.js').events();
}

/** Write a 32-bit float WAV; mono data is written to both channels. */
function writeWav(file, data, sr) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const n = data.length;
  const buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 8, 28);
  buf.writeUInt16LE(8, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) {
    buf.writeFloatLE(data[i], 44 + i * 8);
    buf.writeFloatLE(data[i], 48 + i * 8);
  }
  fs.writeFileSync(file, buf);
  return file;
}

/** Read a float WAV's first channel. */
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12;
  let fmt = null;
  let data = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  const n = Math.floor(data.length / 4 / fmt.ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readFloatLE(i * 4 * fmt.ch);
  return { sr: fmt.sr, data: out };
}

/** ffmpeg ebur128: integrated loudness (LUFS), loudness range and true peak (dBTP). */
function loudness(file) {
  // ffmpeg writes the ebur128 summary to stderr
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ebur128 failed (exit ${r.status}): ${String(r.stderr).slice(-400)}`);
  const txt = r.stderr;
  const sum = txt.slice(txt.lastIndexOf('Summary'));
  const num = (re) => {
    const m = re.exec(sum);
    return m ? Number(m[1]) : NaN;
  };
  return { I: num(/I:\s+(-?[\d.]+) LUFS/), LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/Peak:\s+(-?[\d.]+) dBFS/), summary: sum.trim() };
}

function fnv(data) {
  const u = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 | 0;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 0x01000193);
    if ((i & 3) === 3) h2 = Math.imul(h2 ^ h1, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

module.exports = { ROOT, SRC, OUT, load, gameEvents, events, mockEvents, writeWav, readWav, loudness, fnv };
