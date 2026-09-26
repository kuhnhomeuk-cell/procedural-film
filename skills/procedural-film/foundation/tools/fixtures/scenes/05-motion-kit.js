// Fixture scene: the motion helpers on one paper plate. Exercises keys, arcPt, squash, punch, shake,
// spring and stagger: an anticipation dip before the throw, a landing hit on beat 2 (t 0.5), a bounce
// that rings down, a roll into the sign on beat 4 (t 1.5) and a wave through the dots, so no beat is still.
FILM.scene({
  id: 'motion-kit',
  draw(ctx, tIn, info) {
    const L = info.lib, P = L.pal;
    const t = L.clamp(tIn, 0, info.dur);
    const tw = L.onTwos(t);
    const HIT = 0.5; // beat 2, the ball lands
    const BUMP = 1.5; // beat 4, the ball rolls into the sign
    const cam = L.shake(t, [HIT, [BUMP, 0.5]], { amp: 22, seed: 'motion-kit' });
    L.paper(ctx);
    L.camera(ctx, { x: 540 - cam.x, y: 960 - cam.y, rot: cam.rot }, () => {
      // 1. floor line
      L.inkLine(ctx, 90, 1320, 990, 1320, { width: 3, seed: 1 });

      // 2. the ball: anticipation dip, a thrown arc, squash on landing, a bounce that rings down, a roll
      const R = 70, start = [220, 1320 - R], land = [640, 1320 - R];
      const dip = L.keys(tw, [[0, 0], [0.12, 34, 'outQuad'], [0.2, 0, 'inQuad']]);
      const fly = L.seg(tw, 0.2, HIT, 'inQuad');
      const u = L.seg(tw, HIT, HIT + 0.6);
      const hop = 150 * Math.abs(Math.sin(u * 2 * Math.PI)) * Math.pow(1 - u, 2);
      const roll = L.seg(tw, 1.15, BUMP, 'inCubic') * 124 - 30 * L.spring(tw - BUMP, { freq: 2.5, damp: 0.5 });
      let bx, by;
      if (tw < 0.2) [bx, by] = [start[0], start[1] + dip];
      else if (tw < HIT) [bx, by] = L.arcPt(fly, start, land, -0.55);
      else [bx, by] = [land[0] + roll, land[1] - hop];
      const s = tw < 0.2 ? 1 - dip / 140 : tw < HIT ? 1 + 0.25 * fly : 1 - 0.45 * L.punch(tw, HIT, { dur: 0.35 }) - 0.15 * L.punch(tw, BUMP, { dur: 0.3 });
      L.squash(ctx, bx, by + R, s, () => {
        L.inkCircle(ctx, bx, by, R, { fill: P.sun, width: 3.2, seed: 2 });
        L.hatch(ctx, L.ellipsePts(bx + 18, by + 22, 50, 40, 32), { angle: -0.6, spacing: 8, seed: 3, alpha: 0.5 });
      });

      // 3. a sign that springs up on the hit, then tips back and wobbles when the ball bumps it
      const up = L.spring(tw - HIT, { freq: 3, damp: 0.28 });
      const tip = 0.3 * L.punch(tw, BUMP, { dur: 0.5, cycles: 2 });
      const signH = 260 * up;
      const [tx, ty] = [880 + Math.sin(tip) * signH, 1320 - Math.cos(tip) * signH];
      L.inkLine(ctx, 880, 1320, tx, ty, { width: 4, seed: 4 });
      L.inkCircle(ctx, tx, ty, 44 * L.clamp(up, 0, 1.3), { fill: P.white, width: 3, seed: 5 });

      // 4. dots pop one after another (staggered starts, outBack), then a wave runs through them
      for (let i = 0; i < 7; i++) {
        const p = L.stagger(tw, i, 7, HIT, 0.5, 0.25, 'outBack');
        const wave = 46 * L.punch(tw, BUMP + 0.05 * i, { dur: 0.45, cycles: 1 });
        if (p > 0) L.inkCircle(ctx, 180 + i * 120, 560 - wave, 30 * p, { fill: P.sage, width: 2.4, seed: 10 + i });
      }
    });
    // 5. impact rings, screen-fixed, at full 24 fps
    for (const [at, x, r0] of [[HIT, 640, 60], [BUMP, 830, 40]]) {
      const ring = L.seg(t, at, at + 0.3, 'outExpo');
      if (ring > 0 && ring < 1) L.guideCircle(ctx, x, 1320, r0 + 220 * ring, { color: P.annMagenta, alpha: 1 - ring, width: 7 });
    }
  },
});
