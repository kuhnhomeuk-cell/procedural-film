#!/usr/bin/env node
// game-check.cjs : T7 game page gates (docs/game-spec.md 13.7 and 13.9). Owner: P7.
//
//   node tools/game-check.cjs [--only G1,G2,G3,G4] [--fast N (default 8)]
//
// Run after tools/site.cjs (it checks web/ as site.cjs left it).
//   G1  the game page as build.cjs writes it has an empty media scan; web/index.html and web/film.html are
//       exactly those builds plus the W3 blocks (CSP meta with one sha256 per inline script right after
//       <meta charset>, the share block from the fixed template for the SITE the page names), and
//       web/vercel.json is W5 verbatim.
//   G2  pixel audit, clean mode: every tape in tools/proof/tapes fed with fast(8), the native buffer
//       sampled on the first painted frame of every 30-frame window and on every new screen (state and
//       mode), plus the title, options, controls, pause, continue, clear, final card and demo screens;
//       every pixel of FILM.native() must be an opaque lib.NES colour.
//   G3  zero console errors and zero CSP violations while playing the full tapes (and the whole G2 run);
//       GAME.NAMES.length < 1000 afterwards.
//   G4  the T9 budgets: index.html size (fail > 900 KB raw or 240 KB brotli); first title pixels
//       (first-contentful-paint, median of 3: <= 1000 ms, and <= 2500 ms at a 4x CPU throttle);
//       step + snapshot + drawSnap on the last CONFIG.order level's modern tape (p95 <= 4 ms, p99 <= 8 ms); 60 +/- 0.5 steps per
//       second over 10 s; JS heap after 10 full-tape replays within 20% of the heap after the first.
//       G4 runs on the platform GPU (what a desktop player has); G2 and G3 on SwiftShader.
// Exits 1 on any failure.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('./common.cjs');
const { build } = require('./build.cjs');
const S = require('./site.cjs');
const E = require('./e2e/lib.cjs');
const { serve } = require('./e2e/serve.cjs');

const WEB = path.join(C.ROOT, 'web');
const TAPES = path.join(__dirname, 'proof', 'tapes');
const args = C.parseArgs(process.argv.slice(2));
const ONLY = typeof args.only === 'string' ? args.only.split(',') : null;
const FAST = Math.max(1, Math.min(16, Number(args.fast || 8)));
const want = (g) => !ONLY || ONLY.includes(g);
// the level order and first level from the game's own config (src/game/00-config.js)
const LOADED = require('./proof/harness.cjs').load().GAME;
const CONFIG = LOADED.CONFIG;
const FIRST = CONFIG.firstLevel;
const LAST = CONFIG.order[CONFIG.order.length - 1];

let failures = 0;
function report(id, name, ok, summary, details = []) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id} ${name}: ${summary}`);
  for (const d of details.slice(0, 30)) console.log(`       ${d}`);
  if (details.length > 30) console.log(`       ... ${details.length - 30} more`);
  if (!ok) failures++;
}

// ------------------------------------------------------------------------------------------------ G1
function g1() {
  const probs = [];
  const game = build({ game: true, out: path.join(C.TMP, 'game-check-index.html'), quiet: true });
  const film = build({ out: path.join(C.TMP, 'game-check-film.html'), quiet: true });
  for (const f of [game.outFile, film.outFile]) fs.rmSync(f, { force: true });
  if (game.hits.length) probs.push(`game page media scan: ${game.hits.map((h) => `line ${h.line} ${h.pattern}`).join('; ')}`);
  if (film.hits.length) probs.push(`film page media scan: ${film.hits.map((h) => `line ${h.line} ${h.pattern}`).join('; ')}`);
  const read = (f) => (fs.existsSync(path.join(WEB, f)) ? fs.readFileSync(path.join(WEB, f), 'utf8') : null);
  const index = read('index.html');
  const filmHtml = read('film.html');
  let site = null;
  if (!index) probs.push('web/index.html is missing (run tools/site.cjs)');
  else {
    const m = /<meta property="og:url" content="([^"]*)\/">/.exec(index);
    site = m ? m[1] : null;
    if (!site || !S.siteOk(site)) probs.push(`og:url names ${site}, which does not match ${S.SITE_RE} or GAME.CONFIG.siteUrl`);
    else {
      try {
        const want1 = S.finishPage('index.html', game.html, S.shareBlock(site)).final;
        if (want1 !== index) probs.push('web/index.html is not the current game build plus exactly the W3 blocks (rebuild with tools/site.cjs)');
      } catch (e) {
        probs.push('index.html: ' + e.message);
      }
    }
    // the head, in order: charset, CSP, viewport ... apple title, the share block, style
    const head = index.slice(0, index.indexOf('</head>'));
    const order = ['<meta charset="utf-8">', '<meta http-equiv="Content-Security-Policy"', '<meta name="viewport"', `<title>${require('./config.cjs').esc(require('./config.cjs').loadConfig().title)}</title>`,
      '<meta name="description"', '<meta name="apple-mobile-web-app-title"', '<meta property="og:type"', '<meta name="twitter:image"', '<style>'];
    let at = -1;
    for (const o of order) {
      const i = head.indexOf(o);
      if (i <= at) probs.push(`head: ${o} missing or out of order`);
      at = Math.max(at, i);
    }
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(index);
    const nScripts = S.inlineScripts(index).length;
    if (!csp || (csp[1].match(/'sha256-/g) || []).length !== nScripts) probs.push(`CSP hashes do not cover the ${nScripts} scripts`);
    if (csp && !/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'( 'sha256-[A-Za-z0-9+/=]+')*; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'$/.test(csp[1])) probs.push('CSP policy text differs from W3');
  }
  if (!filmHtml) probs.push('web/film.html is missing');
  else {
    try {
      if (S.finishPage('film.html', film.html, null).final !== filmHtml) probs.push('web/film.html is not the current film build plus exactly the CSP meta');
    } catch (e) {
      probs.push('film.html: ' + e.message);
    }
  }
  const vj = read('vercel.json');
  if (!vj || JSON.stringify(JSON.parse(vj)) !== JSON.stringify(S.VERCEL_JSON)) probs.push('web/vercel.json differs from W5');
  report('G1', 'media scan and head blocks', probs.length === 0,
    probs.length ? `${probs.length} problem(s)` : `build scans 0 hits (game ${game.src.files.length} files, film ${film.src.files.length}); index.html and film.html = build + W3 blocks exactly; share host ${site}; vercel.json = W5`,
    probs);
}

// ------------------------------------------------------------------------------------------------ G2 + G3
// Installed in the page after boot: audits the native buffer after the shell paints (rAF callbacks run in
// registration order, and the shell re-registers first in its own callback).
function installAudit() {
  const L = FILM.retro;
  const hex = (s) => (parseInt(s.slice(1, 3), 16) << 16) | (parseInt(s.slice(3, 5), 16) << 8) | parseInt(s.slice(5, 7), 16);
  const nes = new Set(L.NES.map(hex));
  const A = (window.__audit = { samples: 0, pixels: 0, bad: [], seen: {}, win: -1, lastKey: '', force: false });
  A.audit = (why) => {
    const nb = FILM.native();
    const d = nb.ctx.getImageData(0, 0, nb.w, nb.h).data;
    let off = 0, first = null;
    for (let i = 0; i < d.length; i += 4) {
      const c = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      if (d[i + 3] !== 255 || !nes.has(c)) {
        off++;
        if (!first) first = { x: (i / 4) % nb.w, y: Math.floor(i / 4 / nb.w), rgba: [d[i], d[i + 1], d[i + 2], d[i + 3]] };
      }
    }
    A.samples++;
    A.pixels += d.length / 4;
    const st = FILM.shell.stats;
    const key = st.state + '|' + st.mode;
    A.seen[key] = (A.seen[key] | 0) + 1;
    if (off) A.bad.push({ why, key, frame: st.frame, level: st.levelId, off, first });
  };
  const tick = () => {
    requestAnimationFrame(tick);
    const st = FILM.shell.stats;
    const key = st.state + '|' + st.mode;
    const w = Math.floor(st.frame / 30);
    if (key !== A.lastKey) {
      A.lastKey = key;
      A.win = w;
      A.audit('screen');
    } else if (w !== A.win || A.force) {
      A.win = w;
      A.force = false;
      A.audit('frame');
    }
  };
  requestAnimationFrame(tick);
  return true;
}

async function g2g3(browser, url) {
  const t = await E.open(browser, url, { profile: 'desktop' });
  const details = [];
  let g3Errors = [];
  let names = null;
  let fed = 0, fedFrames = 0;
  try {
    await t.goto('?proof=1&clean=1');
    await t.title();
    await t.page.evaluate(installAudit);
    // the audit must see a planted off-palette pixel (one synchronous task, so no paint intervenes)
    const control = await t.page.evaluate(() => {
      const A = window.__audit;
      const g = FILM.native().ctx;
      g.fillStyle = '#ff00fe';
      g.fillRect(7, 7, 1, 1);
      A.audit('control');
      const caught = A.bad.length === 1 && A.bad[0].off === 1 && A.bad[0].first.x === 7 && A.bad[0].first.y === 7;
      A.bad = [];
      A.samples = 0;
      A.pixels = 0;
      A.seen = {};
      return caught;
    });
    if (!control) throw new Error('the pixel audit missed a planted off-palette pixel');
    const auditNow = () => t.page.evaluate(() => window.__audit.audit('forced'));
    await t.steps(10);
    // title, options, controls, back
    await t.key('ArrowDown');
    await t.key('Enter');
    await t.until(() => FILM.shell.stats.state === 'options', null, 3000);
    await t.steps(3);
    await auditNow();
    for (let i = 0; i < 5; i++) await t.key('ArrowDown');
    await t.key('Enter');
    await t.until(() => FILM.shell.stats.state === 'controls', null, 3000);
    await t.steps(3);
    await auditNow();
    await t.key('Escape');
    await t.key('Escape');
    await t.until(() => FILM.shell.stats.state === 'title', null, 3000);
    // every tape, fed as NEW QUEST would, fast(8)
    const files = fs.readdirSync(TAPES).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) {
      const tape = JSON.parse(fs.readFileSync(path.join(TAPES, f), 'utf8'));
      const r = await t.page.evaluate(
        async ([tp, n]) => {
          FILM.shell.proof.fast(n);
          const res = await FILM.shell.proof.feed(tp);
          return res;
        },
        [tape, FAST]
      );
      fed++;
      fedFrames += r.frames;
      if (!r.match) details.push(`${f}: fp ${r.fp} differs from the tape's ${tape.fp}`);
      if (/^full\./.test(f)) {
        // the final card holds on live input after the tape's last frame
        await t.steps(240);
        await auditNow();
      }
    }
    await t.page.evaluate(() => FILM.shell.proof.fast(0));
    // pause: START, lives screen, play, START
    await t.page.evaluate((first) => FILM.shell.proof.feed({ opts: { start: first, feel: 'modern' }, rle: '08:1,00:5j,08:1,00:a' }), FIRST);
    await t.until(() => FILM.shell.stats.state === 'paused' && !FILM.shell.proof.feeding, null, 10000);
    await t.steps(5);
    await auditNow();
    // continue: one life, the hero stands still until the first level's clock runs out (or a foe
    // reaches him first); either death is the last life, so the shell must show the continue screen.
    // No dependence on the level's layout: only on its clock (a level with no clock fails loudly).
    const firstTime = ((LOADED.GAME_DEFS || {})[FIRST] || {}).time | 0;
    if (firstTime <= 0) throw new Error(`continue screen: the first level '${FIRST}' has no clock (time ${firstTime}); the idle-to-time-up death needs time > 0`);
    const idleFrames = firstTime * 24 + 240; // the HUD clock ticks once every 24 frames (TIMER_FRAMES)
    await t.page.evaluate(([first, n]) => {
      FILM.shell.proof.fast(16);
      return FILM.shell.proof.feed({ opts: { start: first, feel: 'modern', lives: 1 }, rle: '08:1,00:5j,00:' + n.toString(36) });
    }, [FIRST, idleFrames]);
    await t.until(() => FILM.shell.stats.mode === 'continue' && !FILM.shell.proof.feeding, null, 90000);
    await t.page.evaluate(() => FILM.shell.proof.fast(0));
    await t.steps(5);
    await auditNow();
    await t.key('ArrowDown'); // END
    await t.steps(5);
    await auditNow();
    await t.key('Enter');
    await t.until(() => FILM.shell.stats.state === 'title', null, 5000);
    // the attract demo
    await t.steps(5);
    await t.page.evaluate(() => FILM.shell.proof.idle(1080));
    await t.until(() => FILM.shell.stats.state === 'demo', null, 3000);
    await t.steps(200);
    await auditNow();
    const A = await t.page.evaluate(() => ({ samples: window.__audit.samples, pixels: window.__audit.pixels, bad: window.__audit.bad.slice(0, 20), nBad: window.__audit.bad.length, seen: window.__audit.seen }));
    names = await t.page.evaluate(() => FILM.__game.NAMES.length);
    const csp = await t.csp();
    g3Errors = [...t.errors.slice(0), ...csp.map((c) => 'CSP: ' + c)];
    const need = { title: /^title\|title$/, options: /^options\|/, controls: /^controls\|/, pause: /^paused\|pause$/, continue: /\|continue$/,
      clear: /\|clear$/, credits: /\|credits$/, demo: /^demo\|/, play: /^game\|play$/, lives: /\|lives$/, gameover: /\|gameover$/ };
    const missing = Object.keys(need).filter((k) => !Object.keys(A.seen).some((s) => need[k].test(s)));
    for (const b of A.bad) details.push(`off-palette: ${b.off} px at ${b.key} frame ${b.frame} ${b.level} (first ${JSON.stringify(b.first)})`);
    if (missing.length) details.push(`screens never sampled: ${missing.join(', ')}`);
    const okG2 = A.nBad === 0 && missing.length === 0 && details.length === 0;
    report('G2', 'pixel audit (clean, every pixel a lib.NES colour)', okG2,
      `planted-pixel control caught; ${fed} tapes (${fedFrames} frames) fed at fast(${FAST}); ${A.samples} samples, ${A.pixels} pixels, ${A.nBad} off-palette sample(s); screens: ${Object.entries(A.seen).map(([k, v]) => `${k} ${v}`).join(', ')}`,
      details);
  } catch (e) {
    report('G2', 'pixel audit', false, e.message, details);
  } finally {
    await t.close();
  }
  const okG3 = g3Errors.length === 0 && names != null && names < 1000;
  report('G3', 'no console errors or CSP violations; GAME.NAMES < 1000', okG3, `${g3Errors.length} error(s)/violation(s) over the whole G2 run (both full tapes included); GAME.NAMES.length ${names}`, g3Errors);
}

// ------------------------------------------------------------------------------------------------ G4
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, p) => {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function g4(url) {
  const probs = [];
  const lines = [];
  // size
  const html = fs.readFileSync(path.join(WEB, 'index.html'));
  const br = zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: html.length } });
  const kb = (n) => (n / 1024).toFixed(1);
  if (html.length > S.BUDGET.rawFail) probs.push(`index.html ${kb(html.length)} KB raw > 900`);
  if (br.length > S.BUDGET.brFail) probs.push(`index.html ${kb(br.length)} KB brotli > 240`);
  const warn = html.length > S.BUDGET.rawWarn || br.length > S.BUDGET.brWarn ? ' (above the warn line)' : '';
  lines.push(`size ${kb(html.length)} KB raw (limit 900), ${kb(br.length)} KB brotli (limit 240)${warn}`);

  const browser = await E.launch({ gl: 'gpu' });
  try {
    // first title pixels, three loads each
    for (const [label, rate, limit] of [['desktop', 1, 1000], ['4x CPU throttle', 4, 2500]]) {
      const got = [];
      for (let k = 0; k < 3; k++) {
        const t = await E.open(browser, url, { profile: 'desktop' });
        if (rate > 1) await (await t.cdp()).send('Emulation.setCPUThrottlingRate', { rate });
        await t.goto('');
        await t.title(30000);
        await t.page.waitForFunction(() => performance.getEntriesByType('paint').some((e) => e.name === 'first-contentful-paint'), null, { timeout: 30000 });
        got.push(await t.page.evaluate(() => performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint').startTime));
        await t.close();
      }
      const m = median(got);
      if (m > limit) probs.push(`first title pixels ${m.toFixed(0)} ms (${label}) > ${limit}`);
      lines.push(`first title pixels (${label}) median ${m.toFixed(0)} ms of ${got.map((x) => x.toFixed(0)).join('/')} (limit ${limit})`);
    }
    const t = await E.open(browser, url, { profile: 'desktop' });
    try {
      await t.goto('?proof=1&clean=1');
      await t.title();
      // step + snapshot + drawSnap over the last level's tape, in one task (the console's draw is snapshot + drawSnap)
      const tapeLast = E.tape(`${LAST}.modern`);
      const cost = await t.page.evaluate((tp) => {
        const GAME = FILM.__game;
        for (let i = 0; i < 400 && GAME.warmStep(64) !== true; i++);
        const runs = [];
        const dec = (rle) => {
          const out = [];
          for (const r of rle.split(',')) {
            const [b, n] = r.split(':');
            for (let k = parseInt(n, 36); k > 0; k--) out.push(parseInt(b, 16));
          }
          return out;
        };
        const bytes = dec(tp.rle);
        const g = FILM.native().ctx;
        const c = FILM.game.create(tp.opts);
        for (const b of bytes) {
          const t0 = performance.now();
          c.step(b);
          c.draw(g, { reducedFlash: false });
          runs.push(performance.now() - t0);
        }
        return runs;
      }, tapeLast);
      const p95 = pct(cost, 95), p99 = pct(cost, 99);
      if (p95 > 4 || p99 > 8) probs.push(`step+draw p95 ${p95.toFixed(2)} ms / p99 ${p99.toFixed(2)} ms over the ${LAST} tape (limits 4 / 8)`);
      lines.push(`step + snapshot + drawSnap over ${LAST} (${cost.length} frames): p50 ${pct(cost, 50).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${Math.max(...cost).toFixed(2)} ms (limits 4 / 8)`);
      // step rate in play
      await t.key('Enter');
      await t.until(() => FILM.shell.stats.mode === 'play', null, 6000);
      await t.steps(60);
      const rate = await t.page.evaluate(
        () =>
          new Promise((resolve) => {
            let t0 = null, n0 = 0;
            const tick = (stamp) => {
              if (t0 === null) {
                t0 = stamp;
                n0 = FILM.shell.stats.steps;
              }
              if (stamp - t0 >= 10000) return resolve(((FILM.shell.stats.steps - n0) * 1000) / (stamp - t0));
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          })
      );
      if (Math.abs(rate - 60) > 0.5) probs.push(`step rate ${rate.toFixed(3)} steps/s`);
      lines.push(`step rate ${rate.toFixed(3)} steps/s over 10 s (60 +/- 0.5)`);
      // memory: heap after 10 full-tape replays (step + draw every frame) within 20% of after the first
      const full = E.tape('full.modern');
      const cdp = await t.cdp();
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage');
        return (await cdp.send('Runtime.getHeapUsage')).usedSize;
      };
      const replayOnce = () =>
        t.page.evaluate((tp) => {
          const out = [];
          for (const r of tp.rle.split(',')) {
            const [b, n] = r.split(':');
            for (let k = parseInt(n, 36); k > 0; k--) out.push(parseInt(b, 16));
          }
          const g = FILM.native().ctx;
          const c = FILM.game.create(tp.opts);
          for (const b of out) {
            c.step(b);
            c.draw(g, { reducedFlash: false });
          }
          return c.mode;
        }, full);
      const m1 = await replayOnce();
      const h1 = await heap();
      for (let k = 1; k < 10; k++) await replayOnce();
      const h10 = await heap();
      const growth = h10 / h1 - 1;
      if (m1 !== 'credits') probs.push(`the full tape replay ended in ${m1}, not the final card ('credits')`);
      if (growth > 0.2) probs.push(`heap grew ${(growth * 100).toFixed(1)}% over 10 full-tape replays`);
      lines.push(`JS heap after 1 full-tape replay ${(h1 / 1048576).toFixed(2)} MB, after 10 ${(h10 / 1048576).toFixed(2)} MB (${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(1)}%, limit +20%)`);
      if (t.errors.length) probs.push(`errors during G4: ${t.errors.slice(0, 3).join(' | ')}`);
    } finally {
      await t.close();
    }
  } finally {
    await browser.close();
  }
  report('G4', 'budgets (T9)', probs.length === 0, probs.length ? `${probs.length} over budget` : 'every budget met', [...lines, ...probs.map((p) => 'FAIL ' + p)]);
}

async function main() {
  const t0 = Date.now();
  if (want('G1')) g1();
  const need = want('G2') || want('G3') || want('G4');
  if (need) {
    for (const f of ['index.html', 'film.html', 'vercel.json']) if (!fs.existsSync(path.join(WEB, f))) throw new Error(`web/${f} is missing: run node tools/site.cjs first`);
    const srv = await serve({ port: 0, root: WEB });
    try {
      if (want('G2') || want('G3')) {
        const browser = await E.launch({ gl: 'swiftshader' });
        try {
          await g2g3(browser, srv.url);
        } finally {
          await browser.close();
        }
      }
      if (want('G4')) await g4(srv.url);
    } finally {
      await srv.close();
    }
  }
  console.log(`${failures ? 'FAIL' : 'PASS'} game-check.cjs: ${failures} gate(s) failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`[FAIL] game-check.cjs: ${e.stack || e.message}`);
  process.exit(1);
});
