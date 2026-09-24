#!/usr/bin/env node
// gates.cjs : every release gate of the game, in order, with no network and no account.
//
//   node tools/gates.cjs [--site https://<name>.vercel.app]
//
// Runs check, levels-lint, art-check, audio/game-audio, proof/engine-scenarios, proof/levels, proof/full,
// proof/determinism, proof/clock and proof/menu, then site.cjs --site <url>, game-check and
// e2e/run.cjs --site <url> against the local server (e2e/serve.cjs, web/). Prints each gate's last output
// line and exits 1 at the first red. <url> is --site, else GAME.CONFIG.siteUrl, else https://<slug>.vercel.app.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { siteFor } = require('./config.cjs');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const GATES = [
  ['tools/check.cjs'],
  ['tools/levels-lint.cjs'],
  ['tools/art-check.cjs'],
  ['tools/audio/game-audio.cjs'],
  ['tools/proof/engine-scenarios.cjs'],
  ['tools/proof/levels.cjs'],
  ['tools/proof/full.cjs'],
  ['tools/proof/determinism.cjs'],
  ['tools/proof/clock.cjs'],
  ['tools/proof/menu.cjs'],
];
const AFTER = (site) => [['tools/site.cjs', '--site', site], ['tools/game-check.cjs'], ['tools/e2e/run.cjs', '--site', site]];

const show = (args) => ['node', ...args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
const lastLine = (s) => String(s || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()).filter(Boolean).pop() || '';

function gate(args) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: process.env });
  const so = lastLine(r.stdout);
  const last = (/^[\]}]$/.test(so) ? lastLine(r.stderr) + ' (JSON on stdout)' : so) || lastLine(r.stderr);
  const ok = r.status === 0 && !r.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${show(args)} -> exit ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${last}`);
  return ok;
}

function gates({ site } = {}) {
  const chosen = siteFor(site);
  if (chosen.placeholder) console.log(`[warn] no --site and GAME.CONFIG.siteUrl is empty; using the placeholder ${chosen.url}`);
  const all = [...GATES, ...AFTER(chosen.url)];
  for (let i = 0; i < all.length; i++) {
    if (!gate(all[i])) {
      console.log(`FAIL gates.cjs: gate ${i + 1} of ${all.length} is red (${all[i][0]})`);
      return false;
    }
  }
  console.log(`PASS gates.cjs: ${all.length} of ${all.length} gates green for ${chosen.url}`);
  return true;
}

module.exports = { gates, GATES, AFTER };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--site');
  const site = i >= 0 ? argv[i + 1] : null;
  let ok = false;
  try {
    ok = gates({ site });
  } catch (e) {
    console.log(`FAIL gates.cjs: ${e.message}`);
  }
  process.exit(ok ? 0 : 1);
}
