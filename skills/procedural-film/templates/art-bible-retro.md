# Art bible: <FILM TITLE>, retro mode

The house style for a pixel film.
Sections 1 to 9 are decided: change the numbers your film needs (its named colours, its sprite sizes, its backdrops) and leave the rules alone.
Section 10 is this film's own.

The whole retro kit lives on `FILM.retro`, created by `retro/src/pixel.js`.
The motion kit is `FILM.nes`.
Nothing in this mode is read from `FILM.lib`, whose drawn library is frozen and belongs to the drawn mode.

## 1 Frame and grid

- The native buffer is 320 × 180 game pixels, drawn at 60 fps.
- The film is presented at × 6, so the output is 1920 × 1080 and one game pixel is a 6 × 6 block.
- Every position, size and step is a whole game pixel.
  `FILM.retro.sprite`, `px` and `pxtext` round for you, so pass whole numbers and never rely on the rounding.
- The safe margin is 8 game pixels on every side.
  Must-read text and faces stay inside x 8 to 312 and y 8 to 172.
  `tools/check.cjs` gate 3 measures it as 48 output pixels at 1920 × 1080.
- The grid is 8 × 8 tiles: 40 columns by 22.5 rows.
  Ground sits on a tile row, so the floor top is a multiple of 8 (y 152 or y 160 in most shots).
- The native buffer is reused every frame and never cleared.
  Every scene paints all 320 × 180 pixels every frame, or last frame's pixels show through transparent sprite corners and determinism fails.

## 2 The NES palette

Every pixel is one of the 64 console colours in `FILM.retro.NES`.
Gate 7 checks every named colour and every sprite slot against that table.
Gate 8 checks every pixel of the native buffer on the draw and sweep frames.

A film names its colours once, in `src/sprites.js`, on `FILM.retro.RETRO_PAL`.
Each name carries its NES index in a comment, so a reader can find it on the console chart:

```js
Object.assign(FILM.retro.RETRO_PAL, {
  sky: FILM.retro.C(0x22),      // $22 #5C94FC, day sky
  ground: FILM.retro.C(0x17),   // $17, soil face
  groundHi: FILM.retro.C(0x27), // $27, soil lip
  ink: FILM.retro.C(0x0F),      // $0F #000000, outlines, night sky
  hudWhite: FILM.retro.C(0x30), // $30, HUD and card text
});
```

Rules:

1. Write colours as `FILM.retro.C(0xNN)`, never as a hex string typed by hand.
   `FILM.retro.nesIndex(hex)` returns -1 for a colour the console does not have.
2. Name a colour by its job (`sky`, `groundHi`), not by its hue.
3. Black is `$0F`.
   Do not use `$0D`, which some televisions read as a sync signal.
4. `hudWhite` must exist, because `pxtext` and the HUD use it by default.
5. Keep the film to one sky colour per backdrop and 12 to 20 named colours in all.

## 3 Sprites: three colours plus transparent

A sprite is a row map and a legend in `FILM.retro.SPRITES_DEF`.
`r` is an array of equal-length strings, `l` maps each character to an NES colour, and `.` is transparent.
Gate 9 fails any sprite, or any frame of a `legends` cycle, that uses more than 3 colours.

A character sprite uses only the slot keys `'1'`, `'2'` and `'3'`, like an NES sprite palette.
Its palette lives in `FILM.retro.SPAL`, and `FILM.retro.slots(p)` turns a palette into a legend.
A worked example, an 8 × 8 critter:

```js
const P = FILM.retro;
P.SPAL.critter = [P.C(0x26), P.C(0x17), P.C(0x0F)]; // body; shade, feet; eyes, outline
P.SPRITES_DEF.critter = {
  l: P.slots(P.SPAL.critter),
  r: [
    '..3333..',
    '.311113.',
    '31311313',
    '31111113',
    '31111123',
    '.312223.',
    '..3333..',
    '.22..22.',
  ],
};
P.sprite(ctx, 'critter', 40, 144);                                        // its own colours
P.sprite(ctx, 'critter', 60, 144, { pal: [P.C(0x2A), null, null], flip: true }); // green body, facing left
```

Slot meaning is fixed per character and written down in section 10: slot 1 the body, slot 2 the shade, slot 3 the outline and eyes.
A palette swap (`o.pal`) then recolours every drawing of that character the same way.
A detail that needs a fourth colour becomes a transparent hole, so plan what shows through it.

`FILM.retro.sprite(ctx, name, gx, gy, o)` takes `o.pal`, `o.flip`, `o.flipV`, `o.frame` (a `legends` variant) and an integer `o.scale`.
It returns the drawn `{ w, h }` in game pixels.

## 4 Tiles

- Tiles are 8 × 8, grouped into 16 × 16 metatiles.
  Ground, blocks, bricks and pipes are 16 × 16.
- A tile keys its legend with letters, for example `{ a: fill, b: shade, k: outline }`, and still uses at most 3 colours plus `.`.
  The `.` shows the backdrop behind it.
- An area variant (night, underground) reuses the same rows with a second legend, never a redrawn map.
- A strip of ground mixes two tile drawings per column from a fixed hash, so it does not look stamped.

## 5 Flat tone

- Fills are flat.
  Shading is baked into the sprite and tile maps as a second colour, never painted on top.
- The native buffer carries no gradients, no alpha blends, no blur, no shadows from the canvas API and no smoothing.
  A half-transparent pixel is a colour the console does not have, and gate 8 fails it.
- Every retro shot sets timeline `mode: 'none'`, so the engine's grain pass stays off.
- A fade between shots is the NES palette fade: a `'fade'` transition into a mode `'none'` shot steps every colour one brightness row darker to black, then back up.
  Never fade with `globalAlpha`.
- The only thing allowed off the console palette is the CRT presentation (`retro.present: 'crt'`), which runs after the native buffer is complete.

## 6 Backdrops

A backdrop is a flat sky fill plus tiles and scenery sprites, all inside the 320 × 180 buffer.
Nothing is drawn outside the native buffer, and there is no border art in the output frame.

Pick from three backdrops and name one per shot in the storyboard:

1. Day: `sky` fill, clouds, hills and bushes, the ground strip.
2. Night or underground: black `$0F` fill, the dark tile legend, a lit lip on the ground.
3. Card: black `$0F` fill, a `titleBox` or centred `pxtext`, one sprite at most.

Scenery sits behind characters and uses a different outline or shade from them, so the cast never sinks into the background.

## 7 Motion in frames at 60 fps

The console redraws every frame and moves things in whole game pixels.
Count time in frames, from `FILM.nes.frameOf(t)`, and never in seconds inside a scene.

Drawings hold for a fixed number of frames, counted on the global frame so a cycle runs on across a cut:

- `FILM.nes.step(frame, hold, n)` returns the drawing index of an `n`-drawing cycle holding each drawing `hold` frames.
- The NES blink cadence is 24, 8, 8, 8: drawing 0 for 24 frames, then 1, 2, 1 for 8 frames each, a 48-frame loop.
  `FILM.retro.shimmer(frame)` returns it for coins and blinking blocks.
- Walk and run cycles are 3 drawings.
  `FILM.nes.runHold(speed)` gives the hold from ground speed in game px per second: 6 frames under 60, 5 frames to 119, 4 frames at 120 and above.
- Enemy walks and torch flicker are 2 drawings holding 8 frames each.

Speeds are in game pixels per second, stepped per frame:

| Move | Speed | Per frame at 60 fps |
|---|---|---|
| Walk | 48 px/s | 0.8 px, so the sprite steps 1 px on four frames of five |
| Run | 90 px/s | 1.5 px, alternating 1 and 2 |
| Camera scroll | the hero's speed | right only, whole pixels |

Position is `Math.round(x0 + speed * frame / 60)`, so the steps come out even.

Jumps follow `FILM.nes.arc(y0, h, u)`, where `u` runs 0 to 1 over the airtime.
A hop of 24 px takes about 30 frames and a full jump of 48 px about 42 frames.

Music timing, at a tempo the score sets:

- At 150 bpm a beat is 24 frames and an eighth is 12 frames.
- At 100 bpm a beat is 36 frames and an eighth is 18 frames.
- Pick a tempo whose sixteenth is a whole number of frames (`60 × 60 / bpm / 4`), so hits land on frames.
- Take-offs, landings, stomps and coin pops land on a beat or an eighth.
- The camera eases over one beat at most.
  A sprite never eases: it moves at a constant speed or it stops.

A scene draws from `t` alone and never reads a previous frame.
Seed any variation from a hash of the shot id, and clamp `t` past the shot's end to its final pose.

## 8 Continuity

Cuts are hard and land on a beat.
Three devices carry the action across a cut:

1. The HUD table in the storyboard (score, coins, world, time per shot), copied exactly.
2. The world layout per shot, with world-x in game pixels, so consecutive shots continue the same ground.
3. Pose continuity: a cut mid-run shows a run drawing on both sides, and a cut mid-jump shows a jump drawing on both sides.

Each character keeps its facing, palette and size across a cut unless the story changes them on screen.

## 9 Pixel text only

All on-screen text is drawn by `FILM.retro.pxtext`, `FILM.retro.hud` or `FILM.retro.titleBox`.
`lib.text` and canvas `fillText` are banned in this mode: their letters are smoothed and their edge pixels are not console colours.

- Glyphs are 7 × 7 ink in 8 × 8 cells.
  A string is `(8 × n − 1) × scale` wide (`FILM.retro.pxtextWidth`).
- Inside the safe margin (304 px wide) a line fits 38 glyphs at scale 1, 19 at scale 2, 12 at scale 3 and 9 at scale 4.
- `o.shadow` takes an NES colour and adds a 1 px drop shadow down and right.
  Use black `$0F` behind text on a light sky.
- `FILM.retro.hud(ctx, o)` is the status bar across the top 32 px.
  `o.name` is required.
- `FILM.retro.titleBox(ctx, cx, y, o)` is the title plaque, with `o.text` required and `o.lines` for smaller lines under it.

### 9.1 What reads at phone size

A phone shows the 1920 × 1080 frame about 360 px wide, so one game pixel is roughly 1 phone pixel.

- Titles and a line the viewer must read: scale 2 or larger.
- Scale 1 is for the HUD and small labels a viewer can miss.
- A hero is at least 16 × 16.
  A sprite under 12 px tall reads as a dot and carries no expression.
- The hero differs from the backdrop in brightness row, not only in hue.
  An `$2x` body on a `$2x` sky disappears at phone size.
- Hold a must-read line for at least 90 frames.
- One point of action per shot, with at most 6 moving sprites on screen.

## Originality

The film borrows a console's rules, never its content.

1. No Nintendo characters, sprites, melodies or level layouts.
   Every sprite is drawn from scratch, never traced from a game bitmap, and every level is laid out for this film.
2. No third-party mascot is the hero unless the author owns it.
3. A film that borrows a brand's look carries one line saying it is not affiliated with that brand, on its end card and in its README.

## 10 Subject reference

*This film's own section.
Fill it before any scene is written.*

### 10.1 The story

*Two or three sentences: what happens, and how the viewer should feel at the end.*

### 10.2 Named colours

| Name | NES index | Job |
|---|---|---|
| *sky* | *$22* | *day sky* |
| hudWhite | $30 | HUD and card text (required) |

### 10.3 The cast

| Sprite names | Box | Slot 1 | Slot 2 | Slot 3 | Palettes in `SPAL` |
|---|---|---|---|---|---|
| *heroIdle, heroRun1 to heroRun3, heroJump* | *16 × 16* | *body $26* | *shade $17* | *outline $0F* | *hero, heroNight* |

*One line under the table per character: what it is for and which way it faces by default.*

### 10.4 Tiles and scenery

*Every tile and scenery sprite, its size, and its legend letters.*

### 10.5 Backdrops per shot

*Which of the three backdrops each shot uses, and the floor row.*

### 10.6 Brand and disclaimer

*The brand whose look this film borrows, if any, and the exact disclaimer line.*

### 10.7 Mistakes to avoid

*Extend this table with the film's own traps, each paired with the correct choice.*

| Mistake | Instead |
|---|---|
| A sprite with a fourth colour | A transparent hole, or split it into two sprites |
| A colour typed as a hex string | `FILM.retro.C(0xNN)` with its index in a comment |
| Text through `lib.text` | `FILM.retro.pxtext` |
| A fade through `globalAlpha` | The NES palette fade, a `'fade'` into a mode `'none'` shot |
| A drawing that changes every frame | `FILM.nes.step` with a hold of 4 frames or more |
| A position at a fraction of a pixel | `Math.round` of the stepped position |
| A retro call through `FILM.lib` | The same name on `FILM.retro` |
| A hero that shares the sky's brightness row | A body one row darker or lighter than the sky |
| A melody or level lifted from a console game | An original tune and an original layout |
