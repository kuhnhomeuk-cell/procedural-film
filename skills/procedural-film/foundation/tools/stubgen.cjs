#!/usr/bin/env node
// stubgen.cjs : generate one placeholder scene file per timeline shot, so the whole film
// can be checked and rendered before any real scene exists (the stub pass).
//
//   node tools/stubgen.cjs      writes src/scenes/NN-<id>.js for every shot in src/timeline.js
//   node tools/stubgen.cjs --retro   minimal retro stubs (automatic when the timeline declares retro)
//
// Overwrites existing scene files — run it before scene work starts, never after.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./common.cjs');
const TL = C.loadTimeline(path.join(C.SRC, 'timeline.js'));
const dir = path.join(C.SRC, 'scenes');
fs.mkdirSync(dir, { recursive: true });

const illustrated = (nn, id) => `// STUB
// Placeholder for shot ${nn} '${id}' (illustrated). The scene agent replaces this whole file.
FILM.scene({
  id: '${id}',
  draw(ctx, t, info) {
    const L = info.lib, P = L.pal;
    const p = L.clamp(t / info.dur);
    const q = L.clamp(L.onTwos(t) / info.dur);
    const seed = L.hash('${id}');
    L.paper(ctx);
    const W = FILM.W, H = FILM.H, cx = W / 2;
    // captions sit above the safe bottom the gate enforces: a vertical frame keeps clear of the
    // Shorts UI, a square frame needs only a margin
    const safeBottom = H >= W * 1.5 ? H - 380 : H - 80;
    L.inkPath(ctx, L.ellipsePts(cx, H * 0.45, W * 0.28, H * 0.21, 72), { closed: true, width: 5, seed: seed + 1, double: true });
    L.inkLine(ctx, W * 0.13, H * 0.68, W * 0.87, H * 0.68, { width: 3, seed: seed + 2 });
    L.inkCircle(ctx, W * 0.22 + W * 0.56 * q, H * 0.64, 44, { width: 3, seed: seed + 3, fill: P.orange });
    L.text(ctx, 'STUB ${nn}', cx, H * 0.17, { size: 60, weight: 600, align: 'center', color: P.annMagenta });
    L.text(ctx, info.shot.title || '${id}', cx, safeBottom - 120, { size: 44, align: 'center', color: P.ink });
    L.text(ctx, '${id}', cx, safeBottom - 70, { size: 30, align: 'center', color: P.inkSoft });
    if (p > 0.01) L.inkLine(ctx, W * 0.13, safeBottom - 20, W * 0.13 + W * 0.74 * p, safeBottom - 20, { width: 4, color: P.annBlue, seed: seed + 4, taper: 0 });
  },
});
`;

const schematic = (nn, id) => `// STUB
// Placeholder for shot ${nn} '${id}' (schematic). The scene agent replaces this whole file.
FILM.scene({
  id: '${id}',
  draw(ctx, t, info) {
    const L = info.lib, P = L.pal;
    const p = L.clamp(t / info.dur);
    L.blueprint(ctx);
    const W = FILM.W, H = FILM.H, cx = W / 2;
    // captions sit above the safe bottom the gate enforces: a vertical frame keeps clear of the
    // Shorts UI, a square frame needs only a margin
    const safeBottom = H >= W * 1.5 ? H - 380 : H - 80;
    L.guideCircle(ctx, cx, H * 0.45, W * 0.31, { alpha: 0.4 });
    L.glowDot(ctx, cx, H * 0.45, 10 + 8 * p, { rays: 12, rot: p * Math.PI });
    L.text(ctx, 'STUB ${nn}', cx, H * 0.17, { size: 60, weight: 600, align: 'center', color: P.magenta });
    L.text(ctx, info.shot.title || '${id}', cx, safeBottom - 120, { size: 44, align: 'center', color: P.lavender });
    L.text(ctx, '${id}', cx, safeBottom - 70, { size: 30, align: 'center', color: P.lavender, alpha: 0.6 });
    ctx.fillStyle = P.lineWhite;
    ctx.fillRect(140, 1526, 800 * p, 6);
  },
});
`;

// retro stub: one flat colour over the whole native buffer, the shot id centred, presented the way
// the timeline's retro.present says (the retro fixture scenes register the same way)
const RT = TL.raw && TL.raw.retro;
const crt = !!(RT && RT.present === 'crt');
const retroStub = (nn, id) => `// STUB
// Placeholder for shot ${nn} '${id}' (retro). The scene agent replaces this whole file.
(function () {
  'use strict';
  FILM.scene({
    id: '${id}',
    draw(ctx, t, info) {
      const R = FILM.retro, P = R.RETRO_PAL || {};
      const nb = FILM.native();
      const w = nb.canvas.width, h = nb.canvas.height;
      R.px(nb.ctx, 0, 0, w, h, P.sky || R.C(0x21));
      R.pxtext(nb.ctx, '${id}'.toUpperCase().slice(0, Math.floor((w - 16) / 8)), Math.floor(w / 2), Math.floor(h / 2) - 4, { color: P.hudWhite || R.C(0x30), align: 'center' });
      ${crt ? 'FILM.crt.present(nb.canvas, ctx, { frame: info.frame, T: info.T });' : 'FILM.presentNearest(nb.canvas, ctx);'}
    },
  });
})();
`;
const retro = process.argv.includes('--retro') || !!RT;
if (retro) console.log(`retro stubs (${process.argv.includes('--retro') ? '--retro' : 'timeline declares retro'}), present: ${crt ? 'crt' : 'nearest'}`);

for (const s of TL.shots) {
  const nn = path.basename(s.file).slice(0, 2);
  const mode = retro ? 'retro' : String(s.mode).toLowerCase();
  const code = retro ? retroStub(nn, s.id) : /schem|blue/.test(mode) ? schematic(nn, s.id) : illustrated(nn, s.id);
  const out = path.join(dir, path.basename(s.file));
  fs.writeFileSync(out, code);
  console.log(`${path.basename(s.file)}  ${mode}`);
}
