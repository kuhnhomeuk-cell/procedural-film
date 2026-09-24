#!/usr/bin/env node
// site.cjs : the whole static site in web/ (docs/game-spec.md 12.1 to 12.5 and 13.9). Owner: P7.
//
//   node tools/site.cjs [--site https://<project>.vercel.app] [--quiet]
//
// 1. Builds web/index.html (the game, build.cjs --game) and web/film.html (the film). Each page's media
//    scan must be empty on the HTML exactly as build.cjs wrote it.
// 2. W3: inserts right after <meta charset> a Content-Security-Policy <meta> with one sha256 per inline
//    script, and into the game page (before <style>) the share block from a fixed template whose only
//    variable is SITE (validated against ^https://[a-z0-9-]+\.vercel\.app$). Then asserts that each final
//    page equals its scanned page plus exactly those inserted blocks, and that every media-scan hit in the
//    final page lies inside the share block (its og.png URLs), so the scanner needs no exemption.
// 3. W4: renders og.png (1200x630), favicon.ico (16, 32, 48) and apple-touch-icon.png (180x180) in
//    Chromium from the built page (?proof=1&clean=1) and writes them with tools/png.cjs.
// 4. W5: writes web/vercel.json.
// 5. T9: fails above 900 KB raw or 240 KB brotli for index.html (warns above 750 KB or 200 KB).
// Each deploy replaces the whole site, so web/ always holds all six files. Exits 1 on any failure.
// SITE is --site, else GAME.CONFIG.siteUrl, else the https://<slug>.vercel.app placeholder (with a warning).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const C = require('./common.cjs');
const CFG = require('./config.cjs');
const { build } = require('./build.cjs');
const PNG = require('./png.cjs');

const WEB = path.join(C.ROOT, 'web');
const SITE_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const KB = 1024;
const BUDGET = { rawFail: 900 * KB, rawWarn: 750 * KB, brFail: 240 * KB, brWarn: 200 * KB };

// 12.3; SITE is the only per-deploy variable, the words come from GAME.CONFIG
function shareTemplate() {
  const cfg = CFG.loadConfig();
  const desc = [cfg.description, cfg.legal].filter(Boolean).join(' ');
  return [
    '<meta property="og:type" content="website">',
    `<meta property="og:title" content="${CFG.esc(cfg.title)}">`,
    `<meta property="og:description" content="${CFG.esc(desc)}">`,
    '<meta property="og:url" content="SITE/">',
    '<meta property="og:image" content="SITE/og.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="The ${CFG.esc(cfg.title)} title screen">`,
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:image" content="SITE/og.png">',
  ].join('\n');
}

// 12.5, verbatim
const VERCEL_JSON = {
  cleanUrls: true,
  trailingSlash: false,
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    },
    { source: '/', headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }] },
    { source: '/(og.png|favicon.ico|apple-touch-icon.png)', headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }] },
  ],
};

const CHARSET = '<meta charset="utf-8">\n';

/** A *.vercel.app origin, or exactly GAME.CONFIG.siteUrl when it is an https origin. */
function siteOk(site) {
  if (SITE_RE.test(site)) return true;
  const own = String(CFG.loadConfig().siteUrl || '').replace(/\/+$/, '');
  return !!own && /^https:\/\/[a-z0-9.-]+$/.test(own) && site === own;
}

function shareBlock(site) {
  if (!siteOk(site)) throw new Error(`--site must match ${SITE_RE} or GAME.CONFIG.siteUrl (got ${JSON.stringify(site)})`);
  return shareTemplate().split('SITE').join(site);
}

/** Every inline script's exact text (between <script> and </script>), in page order. */
function inlineScripts(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  const opens = (html.match(/<script\b/g) || []).length;
  if (opens !== out.length) throw new Error(`${opens} <script> tags but ${out.length} plain inline scripts (an attribute or src crept in)`);
  return out;
}
const sha = (text) => "'sha256-" + crypto.createHash('sha256').update(text, 'utf8').digest('base64') + "'";

function cspMeta(html) {
  const hashes = inlineScripts(html).map(sha);
  return (
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${hashes.join(' ')}; ` +
    `style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'">\n`
  );
}

/**
 * Insert the blocks and prove the result: final === scanned + exactly these blocks, at the documented
 * places. blocks: [{ name, text, at }] where at is an index into the scanned page (ascending).
 */
function insert(scanned, blocks) {
  let out = '';
  let from = 0;
  for (const b of blocks) {
    if (b.at < from || b.at > scanned.length) throw new Error(`block ${b.name}: bad position ${b.at}`);
    out += scanned.slice(from, b.at) + b.text;
    from = b.at;
  }
  out += scanned.slice(from);
  // independent check: each block occurs exactly once in the final page and removing them all gives the scanned page back
  let back = out;
  for (const b of blocks) {
    const n = out.split(b.text).length - 1;
    if (n !== 1) throw new Error(`block ${b.name} occurs ${n} times in the final page`);
    back = back.replace(b.text, '');
  }
  if (back !== scanned) throw new Error('the final page is not the scanned page plus exactly the inserted blocks');
  if (out.length !== scanned.length + blocks.reduce((a, b) => a + b.text.length, 0)) throw new Error('length mismatch after insertion');
  return out;
}

function finishPage(name, scanned, share) {
  const at = scanned.indexOf(CHARSET);
  if (at < 0 || scanned.indexOf(CHARSET, at + 1) >= 0) throw new Error(`${name}: expected exactly one ${CHARSET.trim()}`);
  const blocks = [{ name: 'csp', text: cspMeta(scanned), at: at + CHARSET.length }];
  if (share) {
    const st = scanned.indexOf('<style>');
    if (st < 0 || st < at) throw new Error(`${name}: no <style> in the head for the share block`);
    blocks.push({ name: 'share', text: share + '\n', at: st });
  }
  const final = insert(scanned, blocks);
  // the CSP lists exactly the final page's scripts (inserting meta tags touched none of them)
  const want = cspMeta(final);
  if (!final.includes(want)) throw new Error(`${name}: the CSP hashes do not match the final page's scripts`);
  // every media-scan hit in the final page lies inside the share block (its og.png URLs)
  const lines = final.split('\n');
  const shareStart = share ? final.slice(0, final.indexOf(share)).split('\n').length : -1; // 1-based line
  const shareEnd = share ? shareStart + share.split('\n').length - 1 : -2;
  const hits = C.scanForbidden(final);
  const outside = hits.filter((h) => h.line < shareStart || h.line > shareEnd);
  if (outside.length) throw new Error(`${name}: media hits outside the share block: ${outside.map((h) => `line ${h.line} ${h.pattern}`).join('; ')}`);
  return { final, blocks, hits, scripts: inlineScripts(final).length, lines: lines.length };
}

// ------------------------------------------------------------------------------------------------ W4 images
async function renderImages(log) {
  const { serve } = require('./e2e/serve.cjs');
  const srv = await serve({ port: 0, root: WEB });
  const browser = await C.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(srv.url + '/?proof=1&clean=1', { waitUntil: 'load' });
    await page.waitForFunction(() => window.FILM && FILM.shell && FILM.shell.proof && FILM.shell.stats.state === 'title', null, { timeout: 20000 });
    // One synchronous task: no animation frame can run between painting and reading. The title console
    // is created exactly as the shell's (a fresh save: hi 0, feel modern), stepped with 0 to mt = 60, and
    // painted with the title menu over it, as the shell paints its title (docs/game-spec.md 12.4).
    const shot = await page.evaluate((order) => {
      const GAME = FILM.__game;
      const L = FILM.retro;
      const t = FILM.game.create({ shellMenu: true, top: 0, feel: 'modern' });
      let n = 0;
      while (t.state().mt < 60 && n++ < 1000) t.step(0);
      const tokens = {};
      for (const id of order) tokens[id] = 0;
      const save = { v: 1, hi: 0, reach: order[0], cleared: false, tokens,
        settings: { feel: 'modern', crt: 'on', vol: 8, mute: false, input: false, flash: 'full', keys: GAME.menu.DEFAULT_KEYS } };
      const nb = FILM.native();
      const view = { reducedFlash: false };
      t.draw(nb.ctx, view);
      GAME.menu.draw(nb.ctx, GAME.menu.init('title', { save }), { top: t.state().top }, save, { saveOff: false });
      const px = FILM.shell.proof.pixels();
      const sprite = (name) => {
        const c = L.spriteCanvas(name);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        return { width: c.width, height: c.height, data: Array.from(d) };
      };
      const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
      return { mt: t.state().mt, mode: t.mode, w: nb.w, h: nb.h, px, bg: hex(L.NES[0x0f]), nes: L.NES.map(hex), idleS: sprite('hero_small_idle'), idleB: sprite('hero_big_idle') };
    }, CFG.loadConfig().order.slice());
    if (errors.length) throw new Error(`page errors while rendering the images: ${errors.slice(0, 3).join(' | ')}`);
    if (shot.mt !== 60 || shot.mode !== 'title') throw new Error(`title console at mt ${shot.mt} (${shot.mode}), want mt 60 on the title`);
    if (shot.w !== 320 || shot.h !== 180 || shot.px.length !== 320 * 180 * 4) throw new Error(`native buffer ${shot.w}x${shot.h}`);
    // the og picture is the console's own pixels: every one a lib.NES colour
    const nes = new Set(shot.nes.map((c) => c.join(',')));
    let off = 0;
    for (let i = 0; i < shot.px.length; i += 4) if (!nes.has(shot.px[i] + ',' + shot.px[i + 1] + ',' + shot.px[i + 2]) || shot.px[i + 3] !== 255) off++;
    if (off) throw new Error(`${off} title pixels are not opaque lib.NES colours`);
    const bg = [...shot.bg, 255];
    const title = { width: 320, height: 180, data: Buffer.from(shot.px) };
    const og = PNG.blit(PNG.canvas(1200, 630, bg), title, (1200 - 960) / 2, (630 - 540) / 2, 3);
    const idleS = { width: shot.idleS.width, height: shot.idleS.height, data: Buffer.from(shot.idleS.data) };
    const idleB = { width: shot.idleB.width, height: shot.idleB.height, data: Buffer.from(shot.idleB.data) };
    if (idleS.width !== 16 || idleS.height !== 16) throw new Error(`hero_small_idle is ${idleS.width}x${idleS.height}, want 16x16`);
    if (idleB.width !== 24 || idleB.height !== 24) throw new Error(`hero_big_idle is ${idleB.width}x${idleB.height}, want 24x24`);
    const icons = [1, 2, 3].map((k) => {
      const size = 16 * k;
      const im = PNG.blit(PNG.canvas(size, size, [0, 0, 0, 0]), idleS, 0, 0, k);
      return { size, png: PNG.encode(size, size, im.data) };
    });
    const apple = PNG.blit(PNG.canvas(180, 180, bg), idleB, (180 - 144) / 2, (180 - 144) / 2, 6);
    log(`images: title console at mt ${shot.mt}, ${320 * 180} native pixels all lib.NES`);
    return {
      og: PNG.encode(1200, 630, og.data),
      favicon: PNG.ico(icons),
      apple: PNG.encode(180, 180, apple.data),
    };
  } finally {
    await browser.close();
    await srv.close();
  }
}

// ------------------------------------------------------------------------------------------------ main
async function site({ site: siteUrl = CFG.siteFor().url, quiet = false } = {}) {
  const log = (s) => !quiet && console.log(s);
  const problems = [];
  const warns = [];
  const share = shareBlock(siteUrl);
  fs.mkdirSync(WEB, { recursive: true });

  // 1. both builds, each scanned exactly as build.cjs wrote it
  const game = build({ game: true, out: path.join(WEB, 'index.html'), quiet: true });
  const film = build({ out: path.join(WEB, 'film.html'), quiet: true });
  for (const [name, b] of [['index.html', game], ['film.html', film]]) {
    if (b.hits.length) problems.push(`${name}: ${b.hits.length} media hit(s): ${b.hits.slice(0, 5).map((h) => `line ${h.line} ${h.pattern}`).join('; ')}`);
    log(`build ${name}: ${b.src.files.length} files, media scan ${b.hits.length} hit(s)`);
  }
  if (problems.length) return { ok: false, problems, warns };

  // 2. W3 head blocks
  const pages = {};
  for (const [name, b, sh] of [['index.html', game, share], ['film.html', film, null]]) {
    try {
      const r = finishPage(name, b.html, sh);
      fs.writeFileSync(path.join(WEB, name), r.final);
      pages[name] = r;
      log(`W3 ${name}: CSP with ${r.scripts} script hashes${sh ? ' + share block' : ''}; final = scanned + exactly ${r.blocks.length} block(s); ${r.hits.length} media hit(s), all inside the share block`);
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (problems.length) return { ok: false, problems, warns };

  // 4. W5 (before the images: the image pass serves web/ with these headers)
  fs.writeFileSync(path.join(WEB, 'vercel.json'), JSON.stringify(VERCEL_JSON, null, 2) + '\n');
  log('W5 vercel.json written');

  // 3. W4 images
  try {
    const im = await renderImages(log);
    fs.writeFileSync(path.join(WEB, 'og.png'), im.og);
    fs.writeFileSync(path.join(WEB, 'favicon.ico'), im.favicon);
    fs.writeFileSync(path.join(WEB, 'apple-touch-icon.png'), im.apple);
    const og = PNG.info(im.og), ap = PNG.info(im.apple), ico = PNG.icoInfo(im.favicon);
    log(`W4 og.png ${og.width}x${og.height} (${im.og.length} B), favicon.ico ${ico.map((e) => e.png.width).join('/')} (${im.favicon.length} B), apple-touch-icon.png ${ap.width}x${ap.height} (${im.apple.length} B)`);
    if (og.width !== 1200 || og.height !== 630) problems.push(`og.png is ${og.width}x${og.height}`);
    if (ap.width !== 180 || ap.height !== 180) problems.push(`apple-touch-icon.png is ${ap.width}x${ap.height}`);
    if (ico.map((e) => e.png.width + 'x' + e.png.height).join(',') !== '16x16,32x32,48x48') problems.push('favicon.ico is not 16, 32, 48');
  } catch (e) {
    problems.push(`images: ${e.message}`);
  }

  // 5. T9 size budget
  const html = fs.readFileSync(path.join(WEB, 'index.html'));
  const br = zlib.brotliCompressSync(html, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: html.length } });
  const sizes = { raw: html.length, brotli: br.length };
  const kb = (n) => (n / KB).toFixed(1) + ' KB';
  if (sizes.raw > BUDGET.rawFail) problems.push(`index.html is ${kb(sizes.raw)} raw (limit 900 KB)`);
  else if (sizes.raw > BUDGET.rawWarn) warns.push(`index.html is ${kb(sizes.raw)} raw (warn above 750 KB)`);
  if (sizes.brotli > BUDGET.brFail) problems.push(`index.html is ${kb(sizes.brotli)} brotli (limit 240 KB)`);
  else if (sizes.brotli > BUDGET.brWarn) warns.push(`index.html is ${kb(sizes.brotli)} brotli (warn above 200 KB)`);
  log(`T9 index.html ${kb(sizes.raw)} raw (limit 900), ${kb(sizes.brotli)} brotli (limit 240)`);

  // web/ holds exactly the six files
  const want = ['apple-touch-icon.png', 'favicon.ico', 'film.html', 'index.html', 'og.png', 'vercel.json'];
  const have = fs.readdirSync(WEB).filter((f) => !f.startsWith('.')).sort();
  const extra = have.filter((f) => !want.includes(f));
  const missing = want.filter((f) => !have.includes(f));
  if (missing.length) problems.push(`web/ is missing ${missing.join(', ')}`);
  if (extra.length) warns.push(`web/ also holds ${extra.join(', ')} (it would deploy too)`);
  return { ok: problems.length === 0, problems, warns, sizes, site: siteUrl };
}

module.exports = { site, shareBlock, cspMeta, inlineScripts, finishPage, SITE_RE, siteOk, VERCEL_JSON, shareTemplate, BUDGET };

if (require.main === module) {
  const args = C.parseArgs(process.argv.slice(2), ['quiet']);
  const chosen = CFG.siteFor(typeof args.site === 'string' ? args.site : null);
  const siteUrl = chosen.url;
  if (chosen.placeholder) console.log(`[warn] no --site and GAME.CONFIG.siteUrl is empty; using the placeholder ${siteUrl}`);
  if (!siteOk(siteUrl)) {
    console.error(`[FAIL] --site must match ${SITE_RE} or GAME.CONFIG.siteUrl (got ${JSON.stringify(siteUrl)})`);
    process.exit(1);
  }
  const t0 = process.hrtime.bigint();
  site({ site: siteUrl, quiet: !!args.quiet }).then(
    (r) => {
      for (const w of r.warns) console.log(`[warn] ${w}`);
      for (const p of r.problems) console.log(`[FAIL] ${p}`);
      const s = Number((process.hrtime.bigint() - t0) / 1000000n) / 1000;
      console.log(`${r.ok ? 'PASS' : 'FAIL'} site.cjs for ${siteUrl}: ${r.problems.length} problem(s) in ${s.toFixed(1)}s`);
      process.exit(r.ok ? 0 : 1);
    },
    (e) => {
      console.error(`[FAIL] site.cjs: ${e.stack || e.message}`);
      process.exit(1);
    }
  );
}
