'use strict';
// config.cjs : read GAME.CONFIG from src/game/00-config.js in Node (a vm with a GAME = FILM.__game stub).
//   const { loadConfig, siteFor } = require('./config.cjs');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'game', '00-config.js');

let cached = null;
function loadConfig() {
  if (cached) return cached;
  if (!fs.existsSync(FILE)) throw new Error(`${path.relative(ROOT, FILE)} is missing; the game tools read GAME.CONFIG from it.`);
  const GAME = {};
  const FILM = { __game: GAME };
  const sandbox = { GAME, FILM, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
  const cfg = (sandbox.FILM.__game && sandbox.FILM.__game.CONFIG) || (sandbox.GAME && sandbox.GAME.CONFIG) || GAME.CONFIG;
  if (!cfg || typeof cfg !== 'object') throw new Error('src/game/00-config.js did not set GAME.CONFIG.');
  for (const k of ['title', 'slug', 'saveKey', 'order']) if (!cfg[k]) throw new Error(`GAME.CONFIG.${k} is empty.`);
  cached = cfg;
  return cfg;
}

// The share URL: an explicit value, else CONFIG.siteUrl, else the https://<slug>.vercel.app placeholder.
function siteFor(explicit) {
  const cfg = loadConfig();
  if (explicit) return { url: String(explicit).replace(/\/+$/, ''), placeholder: false };
  if (cfg.siteUrl) return { url: String(cfg.siteUrl).replace(/\/+$/, ''), placeholder: false };
  return { url: `https://${cfg.slug}.vercel.app`, placeholder: true };
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { loadConfig, siteFor, esc, CONFIG_FILE: FILE };
