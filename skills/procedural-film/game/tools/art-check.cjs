#!/usr/bin/env node
// art-check.cjs : the art gate (docs/game-spec.md 13.6, T6). Exits non-zero on any failure.
//
//   node tools/art-check.cjs
//
// Loads src/lib.js, src/pixel.js (FILM.retro), src/sprites.js and src/manifest.js in a sandbox (no browser,
// no canvas) and checks:
//   A1 every name in FILM.SPRITE_MANIFEST has a map in FILM.retro.SPRITES_DEF of exactly its declared size
//      (so no name falls back to the magenta placeholder), every row the same length
//   A2 every map (each legend variant) uses at most 3 opaque colours, every one a FILM.retro.NES colour,
//      and every key in its rows is '.' or in its legend
//   A3 hero and foe maps (hero_*, foe_*: the palette-swapped characters) use only the keys 1 2 3 and '.'
//   A4 every FILM.retro.SPAL palette is three FILM.retro.NES colours (or a cycle of such)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function load() {
  const sb = { console, Math, Object, Array, String, Number, Map, Set, WeakMap, JSON, Error, isFinite, parseInt, parseFloat, Float64Array, Uint32Array, Uint8Array, Int16Array, Float32Array };
  sb.window = sb; // the scripts read FILM both as window.FILM and as a bare global
  const ctx = vm.createContext(sb);
  for (const f of ['lib.js', 'pixel.js', 'sprites.js', 'manifest.js']) {
    const file = path.join(SRC, f);
    if (!fs.existsSync(file)) throw new Error(`art-check: src/${f} is missing`);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return sb.FILM;
}

// palette-swapped characters key their pixels by the slots 1 2 3; tiles, items and goals use free keys
const SLOT_KEYS = /^(hero|foe)_/;

function main() {
  const FILM = load();
  const L = FILM.retro;
  const M = FILM.SPRITE_MANIFEST || {};
  const SP = L.SPRITES_DEF;
  const NES = new Set(L.NES.map((c) => c.toUpperCase()));
  const fails = { A1: [], A2: [], A3: [], A4: [] };
  const names = Object.keys(M);
  if (!names.length) fails.A1.push('FILM.SPRITE_MANIFEST is empty or missing (src/manifest.js)');
  for (const name of names) {
    const m = M[name];
    const def = SP[name];
    if (!def) {
      fails.A1.push(`${name}: no map (draws the magenta placeholder)`);
      continue;
    }
    const rows = def.r;
    if (!Array.isArray(rows) || rows.length !== m.h || rows.some((r) => typeof r !== 'string' || r.length !== m.w)) {
      const lens = Array.isArray(rows) ? [...new Set(rows.map((r) => r.length))].join('/') : '?';
      fails.A1.push(`${name}: map is ${lens}x${Array.isArray(rows) ? rows.length : '?'}, manifest says ${m.w}x${m.h}`);
      continue;
    }
    const keys = new Set(rows.join('').replace(/\./g, ''));
    const legends = def.legends || [def.l];
    legends.forEach((lg, li) => {
      const cols = new Set();
      for (const k of keys) {
        const c = lg && lg[k];
        if (!c) fails.A2.push(`${name}${legends.length > 1 ? '#' + li : ''}: key '${k}' has no colour`);
        else if (!NES.has(String(c).toUpperCase())) fails.A2.push(`${name}: key '${k}' is ${c}, not a FILM.retro.NES colour`);
        else cols.add(String(c).toUpperCase());
      }
      if (cols.size > 3) fails.A2.push(`${name}: ${cols.size} opaque colours (${[...cols].join(' ')}), the limit is 3`);
    });
    if (SLOT_KEYS.test(name)) {
      const bad = [...keys].filter((k) => !'123'.includes(k));
      if (bad.length) fails.A3.push(`${name}: character map uses key(s) ${bad.map((k) => `'${k}'`).join(' ')} (only 1 2 3 .)`);
    }
  }

  const isPal = (p) => Array.isArray(p) && p.length === 3 && p.every((c) => NES.has(String(c).toUpperCase()));
  for (const k of Object.keys(L.SPAL || {})) {
    const p = L.SPAL[k];
    const ok = isPal(p) || (Array.isArray(p) && p.length > 0 && p.every(isPal));
    if (!ok) fails.A4.push(`FILM.retro.SPAL.${k} is ${JSON.stringify(p)}: not three NES colours (or a cycle of such)`);
  }

  const labels = {
    A1: `every manifest name (${names.length}) has a map of exactly its size`,
    A2: 'every map uses at most 3 opaque FILM.retro.NES colours',
    A3: 'hero and foe maps use only the keys 1 2 3 and .',
    A4: `every FILM.retro.SPAL palette (${Object.keys(L.SPAL || {}).length}) is three NES colours`,
  };
  let ok = true;
  for (const k of Object.keys(fails)) {
    const f = fails[k];
    console.log(`[${f.length ? 'FAIL' : 'PASS'}] ${k} ${labels[k]}`);
    for (const line of f.slice(0, 20)) console.log('       ' + line);
    if (f.length > 20) console.log(`       ... ${f.length - 20} more`);
    if (f.length) ok = false;
  }
  console.log(ok ? 'art-check OK' : 'art-check FAILED');
  process.exit(ok ? 0 : 1);
}

main();
