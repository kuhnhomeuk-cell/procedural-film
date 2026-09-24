#!/usr/bin/env node
// deploy.cjs : a new Vercel project for the game, named from GAME.CONFIG (vercelProject, else slug).
//
//   node tools/deploy.cjs --dry-run      runs tools/gates.cjs, then prints every command a real run would run;
//                                        never calls vercel and does not need the CLI installed
//   node tools/deploy.cjs                the release: name check, gates, project add, link, deploy, production e2e
//   options: --skip-gates   run only site.cjs before the deploy (only right after running gates.cjs yourself)
//            --redeploy     deploy web/ again to the project an earlier run of this script created and linked
//                           (web/.vercel/project.json must name it); never creates or touches another project
//
// 1. `vercel project ls` (read only, filtered and paged): abort when the project name already exists
//    (never overwrite a project).
// 2. tools/gates.cjs --site <url>: every gate, site.cjs for that URL, game-check and the local e2e.
// 3. `vercel project add <name>` must succeed (it fails on an existing name: the no-overwrite guarantee).
// 4. `vercel link --yes --project <name> --cwd <abs>/web`, then `vercel deploy --prod --yes --cwd <abs>/web`.
//    No `cd X &&` anywhere; every command runs with an argument array and prints its own last output line.
// 5. The production host answers 200 without authentication and serves this build (its og:url names that
//    host). If Vercel gave the project another host than predicted, site.cjs is re-run for the real host and
//    web/ deployed again to the same project.
// 6. The e2e suite against the production URL; then the URL and the controls are printed.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
// the Vercel CLI: VERCEL_BIN if set, else the first `vercel` on PATH
const VERCEL = process.env.VERCEL_BIN || (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'vercel.cmd' : 'vercel')).find((f) => fs.existsSync(f)) || 'vercel';
const NODE = process.execPath;
const CFG = require('./config.cjs').loadConfig();
const NAMES = [CFG.vercelProject || CFG.slug];
const OWN_HOST = CFG.siteUrl ? new URL(CFG.siteUrl).host : null;
const SITE_RE = { test: (u) => /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(u) || (!!OWN_HOST && /^https:\/\/[a-z0-9.-]+$/.test(u) && new URL(u).host === OWN_HOST), toString: () => `*.vercel.app${OWN_HOST ? ' or ' + OWN_HOST : ''}` };

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const SKIP_GATES = argv.includes('--skip-gates');
const REDEPLOY = argv.includes('--redeploy');

const GATES = ['tools/gates.cjs'];

const show = (cmd, args) => [cmd === NODE ? 'node' : cmd, ...args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
const lastLine = (s) => String(s || '').split('\n').map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()).filter(Boolean).pop() || '';

function run(cmd, args, { capture = false, allowFail = false, timeout = 30 * 60 * 1000 } = {}) {
  console.log(`$ ${show(cmd, args)}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, env: process.env });
  const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
  // a JSON answer ends in a bare brace: its stderr status line says more
  const so = lastLine(r.stdout);
  const last = (/^[\]}]$/.test(so) ? lastLine(r.stderr) + ' (JSON on stdout)' : so) || lastLine(r.stderr);
  console.log(`  -> exit ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${last}`);
  if ((r.status !== 0 || r.error) && !allowFail) throw new Error(`${show(cmd, args)} failed (exit ${r.status}): ${last}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out, last };
}

// 1. read-only name check: every project whose name contains the project name, every page
function existingNames() {
  const names = new Set();
  let next = null;
  for (let page = 0; page < 50; page++) {
    const args = ['project', 'ls', '--filter', NAMES[0], '--format', 'json', '--non-interactive', ...(next ? ['--next', String(next)] : [])];
    const r = run(VERCEL, args, { capture: true });
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch (e) {
      throw new Error(`vercel project ls did not print JSON: ${r.last}`);
    }
    for (const p of j.projects || []) if (p && p.name) names.add(p.name);
    next = j.pagination && j.pagination.next;
    if (!next) return { names, scope: j.contextName || '?' };
  }
  throw new Error('vercel project ls: more than 50 pages');
}

function pickName() {
  const { names, scope } = existingNames();
  const taken = NAMES.filter((n) => names.has(n));
  console.log(`  scope ${scope}; projects matching '${NAMES[0]}': ${names.size ? [...names].join(', ') : 'none'}`);
  if (taken.length === NAMES.length) throw new Error(`${NAMES.join(' and ')} already exists in ${scope}: aborting (never overwrite a project)`);
  const name = NAMES.find((n) => !names.has(n));
  console.log(`  project name: ${name}${taken.length ? ` (${taken.join(', ')} exists)` : ''}`);
  return { name, scope };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': `${CFG.slug}-deploy-check` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function linkedName() {
  const f = path.join(WEB, '.vercel', 'project.json');
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.projectName || null;
  } catch (e) {
    return null;
  }
}

// the production host: the deployment's alias that is <name>*.vercel.app (the shortest one)
function productionHost(deployUrl, name) {
  const r = run(VERCEL, ['inspect', deployUrl, '--format', 'json', '--non-interactive'], { capture: true, allowFail: true });
  let aliases = [];
  try {
    const j = JSON.parse(r.stdout);
    aliases = (j.aliases || j.alias || []).map((a) => (typeof a === 'string' ? a : a.alias || a.domain || '')).filter(Boolean);
  } catch (e) {
    /* fall through */
  }
  const own = aliases.map((a) => 'https://' + a.replace(/^https?:\/\//, '')).filter((u) => SITE_RE.test(u) && new URL(u).hostname.startsWith(name));
  own.sort((a, b) => a.length - b.length);
  return { host: own[0] || null, aliases };
}

async function deployAndVerify(name, site) {
  const d = run(VERCEL, ['deploy', '--prod', '--yes', '--cwd', WEB, '--non-interactive']);
  const urls = String(d.stdout).match(/https:\/\/[a-z0-9.-]+\.vercel\.app/g) || [];
  const deployUrl = urls.length ? urls[urls.length - 1] : lastLine(d.stdout);
  if (!/^https:\/\//.test(deployUrl)) throw new Error(`vercel deploy printed no deployment URL (last line: ${deployUrl})`);
  const ph = productionHost(deployUrl, name);
  console.log(`  deployment ${deployUrl}; aliases: ${ph.aliases.join(', ') || 'none reported'}`);
  return { deployUrl, host: ph.host || site };
}

async function verify(host) {
  const r = await get(host + '/');
  const og = /<meta property="og:url" content="([^"]*)\/">/.exec(r.body || '');
  console.log(`  GET ${host}/ -> ${r.status}; og:url ${og ? og[1] : 'none'}`);
  return { ok: r.status === 200, ogHost: og ? og[1] : null, status: r.status };
}

async function main() {
  console.log(`deploy.cjs${DRY ? ' --dry-run' : ''}: ${ROOT}`);
  if (!DRY && !fs.existsSync(VERCEL)) throw new Error(`the Vercel CLI was not found on PATH (set VERCEL_BIN to its path): ${VERCEL}`);

  let name, site;
  if (DRY) {
    // no vercel call at all: the name check is listed below, not run
    name = REDEPLOY ? linkedName() || NAMES[0] : NAMES[0];
    site = CFG.siteUrl ? CFG.siteUrl.replace(/\/+$/, '') : `https://${name}.vercel.app`;
  } else if (REDEPLOY) {
    name = linkedName();
    if (!name || !NAMES.includes(name)) throw new Error(`--redeploy needs web/.vercel/project.json linked to ${NAMES.join(' or ')} by an earlier run (found ${name})`);
    site = CFG.siteUrl ? CFG.siteUrl.replace(/\/+$/, '') : `https://${name}.vercel.app`;
    console.log(`  redeploying to the linked project ${name}`);
  } else {
    ({ name } = pickName());
    site = CFG.siteUrl ? CFG.siteUrl.replace(/\/+$/, '') : `https://${name}.vercel.app`;
  }
  if (!SITE_RE.test(site)) throw new Error(`${site} does not match ${SITE_RE}`);

  const gateCmds = SKIP_GATES ? [['tools/site.cjs', '--site', site]] : [[...GATES, '--site', site]];
  const vercelCmds = [
    ...(REDEPLOY ? [] : [['project', 'add', name, '--non-interactive']]),
    ['link', '--yes', '--project', name, '--cwd', WEB, '--non-interactive'],
    ['deploy', '--prod', '--yes', '--cwd', WEB, '--non-interactive'],
    ['inspect', '<deployment-url>', '--format', 'json', '--non-interactive'],
  ];

  if (DRY) {
    // the gates run for real (local only); vercel never does
    for (const g of gateCmds) run(NODE, g);
    console.log('\nA real run would now run, in order (the vercel commands below were not run):');
    if (!REDEPLOY) console.log(`  ${show(VERCEL, ['project', 'ls', '--filter', name, '--format', 'json', '--non-interactive'])}`);
    for (const v of vercelCmds) console.log(`  ${show(VERCEL, v)}`);
    console.log(`  GET ${site}/  (200 without authentication, og:url ${site})`);
    console.log(`  ${show(NODE, ['tools/e2e/run.cjs', site])}`);
    console.log(`\nDRY RUN: gates run; vercel not called; no project created, nothing deployed. Would deploy ${name} to ${site}.`);
    return;
  }

  // 2. gates and the site
  for (const g of gateCmds) run(NODE, g);
  // 3. the no-overwrite guarantee: add fails on an existing name
  if (!REDEPLOY) run(VERCEL, ['project', 'add', name, '--non-interactive']);
  // 4. link and deploy (web/ only; --cwd with the absolute path)
  run(VERCEL, ['link', '--yes', '--project', name, '--cwd', WEB, '--non-interactive']);
  let { deployUrl, host } = await deployAndVerify(name, site);
  // 5. the real production host; a different one than predicted gets its own share meta and a redeploy
  if (host !== site && !CFG.siteUrl) {
    console.log(`  the production host is ${host}, not ${site}: rebuilding the share meta and deploying again`);
    run(NODE, ['tools/site.cjs', '--site', host]);
    run(NODE, ['tools/game-check.cjs', '--only', 'G1']);
    ({ deployUrl, host } = await deployAndVerify(name, host));
  }
  let v = null;
  for (let i = 0; i < 10; i++) {
    v = await verify(host);
    if (v.ok && v.ogHost === host) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!v.ok) throw new Error(`${host}/ answered ${v.status} (Deployment Protection or not live yet)`);
  if (v.ogHost !== host) throw new Error(`${host}/ serves og:url ${v.ogHost}, not this build`);
  // 6. production e2e
  run(NODE, ['tools/e2e/run.cjs', host]);
  console.log(`\nLIVE: ${host}  (deployment ${deployUrl}, project ${name})`);
  console.log('Controls: arrows or WASD move, Z jumps, X runs and throws, Enter starts and pauses, F fullscreen, C CRT, M mute; on a phone, the on-screen pad.');
}

main().catch((e) => {
  console.error(`[FAIL] deploy.cjs: ${e.message}`);
  process.exit(1);
});
