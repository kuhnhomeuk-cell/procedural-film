# Motion

What makes a shot feel alive rather than correct. Read at storyboard step 4 (when writing each shot's Motion and Camera) and at scene step 7 (before writing the draw body). The helpers named here live on `FILM.lib` and are pure functions of `t`, so they pass the determinism gate.

A procedural film fails in one characteristic way: every element eases in over the same beat, reaches its pose and stands still while the lines boil. Each frame is well drawn and the film is dull. The rules below exist to break that.

## 1. Every shot has a verb, a peak and an afterlife

Write these three into the storyboard entry before any numbers:

- **The verb**: the one action the shot is about, as a verb ("the shell *splits*", "the column *pours* south"). A shot whose verb is "is shown" is a slide.
- **The peak**: the single frame where that action is at its most extreme, on a beat, with a sound cue under it. Everything before builds toward it; everything after reacts to it.
- **The afterlife**: what keeps moving after the peak — a settle, a wobble, debris, a ring, a second smaller action. No shot ends on a frozen pose for longer than one beat unless the hold is the point (then say so in the storyboard: "hold, 1 beat, deliberate").

## 2. Tempo contrast

Interest comes from change in speed, not from speed. Plan each shot as a pattern of slow and fast:

- **Hold → snap**: stillness, then the fastest move in the shot. The held beat makes the snap land. The example film's eclosion (`09-eclosion.js`), oyamel-winter (`15-oyamel-winter.js`) and spring-egg (`16-spring-egg.js`) are built this way: `tools/motion.cjs` measures their peak at 6 to 18 times their median.
- **Build → release**: a slow push or growing tremor across two beats, cut short by the hit.
- **Never one speed throughout.** A pull-back or a migration column that moves at a constant rate for three seconds reads as a screensaver. Break it with a beat where something inside the move accelerates, stops or changes direction.

Across the film, alternate dense-fast shots with sparse-slow ones, the same way the plates alternate.

## 3. The principles that matter at 24 fps on twos

| Principle | What it means here | Helper |
|---|---|---|
| Anticipation | A small move the opposite way just before the main move: a dip before a jump, a pull-back before a strike. 2–4 frames. | `lib.keys` with a dip key, or `ease.inBack` |
| Squash and stretch | Stretch along the direction of travel while fast, squash on impact, keep the area. | `lib.squash(ctx, x, y, s, fn, rot)` |
| Arcs | Living things travel on curves, never straight lines between poses. | `lib.arcPt(p, a, b, bend)` |
| Overshoot and settle | Arrive past the target and settle back. Pops overshoot 6–10%; springs wobble. | `ease.outBack`, `ease.snap`, `lib.spring` |
| Follow-through and overlap | Parts don't stop together: the body stops, the antennae, wings or tail keep going for a few frames. | `lib.spring(t - tStop)` on the trailing part |
| Staggered timing | Many similar things never start on the same frame. Spread starts over a beat. | `lib.stagger(t, i, n, t0, spread, dur, e)` |
| Secondary action | A small independent motion that supports the main one: dust at a landing, a leaf trembling as the larva walks. | any of the above, smaller and later |
| Impact | A hit is sold by 3 things at once on the same frame: a squash, a camera jolt, and a ring or flash. | `lib.punch`, `lib.shake`, `guideCircle` ring |

`lib.keys(t, [[t0, v0, ease], [t1, v1, ease], ...])` is the general tool: a keyframed number or array with holds (repeat a value to hold it). Use it when a move has more than two poses.

## 4. Recipes

Impact on a beat:

```js
const HIT = 1.0; // T 2.5
const cam = L.shake(t, [HIT], { amp: 18, seed: ID });                 // screen jolt, decays in 0.35 s
const s = 1 - 0.35 * L.punch(tw, HIT, { dur: 0.3 });                  // squash, rings back through 1
L.camera(ctx, { x: 540 - cam.x, y: 960 - cam.y, rot: cam.rot }, () => {
  L.squash(ctx, x, floorY, s, () => drawSubject(ctx));               // pivot on the contact point
});
const ring = L.seg(t, HIT, HIT + 0.3, 'outExpo');                     // screen-fixed, full 24 fps
if (ring > 0 && ring < 1) L.guideCircle(ctx, x, floorY, 40 + 200 * ring, { color: P.annMagenta, alpha: 1 - ring, width: 6 });
```

Anticipated throw along an arc:

```js
const dip = L.keys(tw, [[0, 0], [0.12, 30, 'outQuad'], [0.2, 0, 'inQuad']]);   // 3 frames down, 2 back
const fly = L.seg(tw, 0.2, HIT, 'inQuad');                                       // accelerates into the hit
const [x, y] = tw < 0.2 ? [x0, y0 + dip] : L.arcPt(fly, [x0, y0], [x1, y1], -0.5);
const stretch = tw < 0.2 ? 1 - dip / 140 : 1 + 0.25 * fly;
```

Sprung arrival with a trailing part:

```js
const body = L.spring(tw - B_ARRIVE, { freq: 3, damp: 0.4 });         // settles quickly
const tail = L.spring(tw - B_ARRIVE - 0.08, { freq: 2.2, damp: 0.25 }); // starts later, wobbles longer
```

A crowd that pops in and then breathes:

```js
for (let i = 0; i < N; i++) {
  const p = L.stagger(tw, i, N, B_IN, 0.5, 0.25, 'outBack');
  const breathe = 1 + 0.04 * L.noise1(info.T * 1.5, sd('b', i));
  if (p > 0) drawMember(ctx, i, p * breathe);
}
```

`tools/fixtures/scenes/05-motion-kit.js` runs all of these in one 2-second shot; snap it with `node tools/snap.cjs --fixtures --shot motion-kit --samples 18 --sheet`.

## 5. Camera language

The camera is the cheapest source of energy and the easiest to overuse. Per shot, pick one:

- **Locked**: the default for schematics; the geometry animates.
- **Push-in / pull-back**: slow (1.00 → 1.05) under a build, or exponential for a macro dive; land the end of the move on a beat.
- **Snap zoom**: 4–6 frames, `outExpo`, keeping one screen point fixed; use it into a match cut.
- **Jolt**: `lib.shake` on impacts only, 12–25 px, decayed within 0.4 s. Constant shake is noise.
- **Drift**: a few pixels of `noise1` offset on a held shot, so a hold still breathes.
- **Parallax**: layers under separate `lib.camera` calls moving at different rates (background 0.3×, subject 1×, foreground debris 1.6×) — depth for free on a pan or a pull-back.

Match-cut shapes stay screen-fixed whatever the camera does (see `scene-anatomy.md`).

## 6. Transitions

A hard cut on the beat is the default and stays the default. The others are punctuation, one or two per film:

| Kind | Use |
|---|---|
| `cut` | Everything, on the beat. |
| `flash` | A hit, a birth, a burst: the white frame lands on the cut. |
| `push` (`dir`) | Travel or sequence: the next shot shoves the last off frame with a short smear. 0.2–0.3 s. |
| `zoom` (`x`, `y`) | Going inside or through: the outgoing shot blows past the lens about (x, y) and fades off the next. 0.25–0.4 s. |
| `iris` (`x`, `y`) | Closing on or opening from one point. |
| `wipe` (`dir`) | Chapter change; rarely. |
| `fade` | Time passing; almost never in a 30 s film. |

## 7. Measuring it

`node tools/motion.cjs` renders every frame small and prints, per shot, a motion sparkline and three leads:

- **STILL** — a stretch longer than one beat where only boil and grain move. On a phone that is a frozen frame.
- **FLAT** — the busiest frame is under twice the median: no accents, one speed throughout.
- **MISSED CUE** — a sound cue with no visible jump in motion under it (or a stop, like a landing).

They are leads for the critic wave, not failures: a deliberate hold is a choice. Its blind spot: an accent inside continuous fast motion (a change of direction, a squash while flying) may not register; check those on consecutive frames with `snap --times`. On the butterfly example it flags `egg-loop` (a near-still ending, deliberate) and the middle of `egg-blueprint` (only a nucleus a few pixels wide moves for a beat), and passes the eclosion and spring-egg snaps.

## 8. Anti-patterns

- Everything eases in with `outCubic` over the same 12 frames.
- All members of a group appear on the same frame.
- A pose reached on beat 2 and held until the cut on beat 6.
- Motion only in the overlays while the subject stands still.
- Straight-line travel between two points.
- A sound hit with nothing on screen reacting to it.
- Camera shake used as atmosphere rather than impact.
- Easing longer than one beat on a character move (it floats; see art bible §7.2).
