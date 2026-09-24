#!/usr/bin/env node
// build.cjs : inline every file in contract load order into one self-contained HTML page.
//
//   node tools/build.cjs                           writes dist/<slug>.html (slug = project folder name)
//   node tools/build.cjs --fixtures                writes dist/<slug>-fixtures.html from tools/fixtures
//   node tools/build.cjs --out path.html           the film page (web/film.html in a release)
//   node tools/build.cjs --game --out path.html    the game page (docs/game-spec.md 2.3 and 12.2):
//                                                  core, lib, manifest, crt, game/*.js (sorted), timeline,
//                                                  music, shell under the W2 head; exits 1 on any media hit
//
// Film page: black background, canvas fitted to the window at 9:16, click or space to play/pause with
// audio, left/right arrows to step, ?t=seconds for a still, ?shot=id to loop a shot, ?render=1 hides UI.
// The CSP and share meta (12.3) are added later by tools/site.cjs, after the media scan of this output.
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('./common.cjs');

// docs/game-spec.md 12.2. site.cjs inserts the CSP meta right after <meta charset> and the share block
// right before <style>; the W3 placeholder comments of the spec are not shipped.
function gameHead() {
  const cfg = require('./config.cjs').loadConfig();
  const { esc } = require('./config.cjs');
  const desc = [cfg.description, cfg.legal].filter(Boolean).join(' ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
    `<title>${esc(cfg.title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    '<meta name="theme-color" content="#000000">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    `<meta name="apple-mobile-web-app-title" content="${esc(cfg.title)}">`,
    '<style>html,body{margin:0;height:100%;background:#000}</style>',
    '</head>',
    '<body>',
    `<noscript>${esc(cfg.title)} needs JavaScript.</noscript>`,
  ].join('\n');
}

function scriptTag(f) {
  const code = fs.readFileSync(f, 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script>\n// ---- ${path.relative(C.ROOT, f).split(path.sep).join('/')}\n${code}\n</script>`;
}

function build({ fixtures = false, out = null, quiet = false, lenient = false, game = false } = {}) {
  const src = game ? C.gameSources() : C.sources({ fixtures, player: true, lenient });
  const outFile = out
    ? C.resolveOut(out)
    : path.join(C.ROOT, game ? 'web' : 'dist', game ? 'index.html' : fixtures ? `${C.SLUG}-fixtures.html` : `${C.SLUG}.html`);
  const parts = src.files.filter((f) => fs.existsSync(f)).map(scriptTag);
  let html;
  if (game) {
    html = `${gameHead()}\n${parts.join('\n')}\n</body>\n</html>\n`;
  } else {
    const title = fixtures ? `${C.SLUG} (fixtures)` : (src.timeline.raw && src.timeline.raw.title) || C.SLUG;
    html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000}</style>
</head>
<body>
${parts.join('\n')}
</body>
</html>
`;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  const hits = C.scanForbidden(html);
  if (!quiet) {
    for (const w of src.warnings) console.log(`[warn] ${w}`);
    console.log(`${src.files.length} files inlined -> ${outFile} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
    for (const f of src.files) console.log(`  ${path.relative(C.ROOT, f)}`);
    if (hits.length) {
      console.log(`[${game ? 'FAIL' : 'warn'}] ${hits.length} forbidden media pattern(s)${game ? ':' : '; run tools/check.cjs for details'}`);
      if (game) for (const h of hits.slice(0, 40)) console.log(`  line ${h.line}  ${h.pattern}  | ${h.text}`);
    } else console.log('media scan: 0 forbidden patterns');
  }
  return { outFile, html, hits, src };
}

if (require.main === module) {
  const args = C.parseArgs(process.argv.slice(2), ['fixtures', 'game']);
  const r = build({
    fixtures: typeof args.fixtures === 'string' ? args.fixtures : !!args.fixtures,
    out: typeof args.out === 'string' ? args.out : null,
    game: !!args.game,
  });
  // the game page ships as built: a media hit is a failure, never a warning (12.2)
  if (args.game && r.hits.length) process.exit(1);
}

module.exports = { build, gameHead };
