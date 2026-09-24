---
name: procedural-film
description: Procedural film — turn a subject into a short animated film drawn and scored entirely in JavaScript, in one of three modes: drawn (every pixel computed, zero assets), photo-doodle (real photographs with animated doodles drawn over them) or retro (pixel art on an NES palette with a chip score). Use when the user asks for a procedural film, a short hand-drawn animated film about a subject, a film that doodles on photos, or a retro pixel-art film. It also makes a retro platformer game: use it when the user asks for a retro platformer game, an NES-style game or a pixel-art game to play in the browser.
---

# Procedural film

Turn a topic into a **film**: roughly 30 seconds at 24 fps, every event on a **beat grid** (bpm → beats → frames), every stroke and every audio sample computed in plain browser JavaScript. The deliverable is `dist/<slug>.html` (a self-contained player) plus `exports/<slug>.mp4` and its phone and preview transcodes.

The skill also makes a retro platformer game that plays in the browser. That track is under "Retro game" at the end of this file.

## Modes — pick one before step 1

| | **drawn** (default) | **photo-doodle** | **retro** |
|---|---|---|---|
| What is on screen | every pixel computed: hand-inked **paper plate** shots cut against navy **blueprint plate** shots | a background-removed **photograph** per shot, standing on tinted paper, with animated doodles drawn over and around it | pixel art on the NES palette, shown sharp or on an optional old TV |
| Frame | vertical 1080×1920 | square 1080×1080 | 1920×1080 at 60 fps, drawn at 320×180 |
| Subject | explaining something real: a life cycle, a process, how a thing works | a story staged on ordinary objects, where each photo becomes a set (a clock becomes a bed, a pine cone becomes a mountain) | a story told as a side-scrolling pixel scene |
| Assets | none at all | photographs you source, licence and cut out yourself | none at all |
| Extra steps | — | 1b source the photographs, 3b write the cast | 3c draw the cast sheet |
| Extra files | — | `src/photos.js` (generated), `src/props.js`, `src/cast.js`, `assets/` | `src/pixel.js`, `src/chip.js`, `src/crt.js` (from `retro/`), `src/sprites.js` |

All three modes run the same ten steps, the same gate and the same beat grid; the deltas are marked **photo-doodle:** inside each step, and the retro deltas are marked **retro:**. Say which mode you are in when you confirm the brief.

The square frame exists only because the timeline declares it — `width: 1080, height: 1080` in `FILM.TIMELINE`. Everything follows from there: the canvas, the player's aspect, the stub layout, and the gate's safe-area rule (a vertical film reserves the bottom 380 px for the Shorts UI, a square film an 80 px margin; `safeBottom` on the timeline overrides both). Forget it and you get a silent vertical film with no error and a green gate.

A retro film works the same way. Its timeline declares `width: 1920, height: 1080, fps: 60` and a `retro` block. The gate's retro checks switch on only when that block is there. Forget it and the gate runs the film as a drawn one without a word.

This skill packages a proven pipeline. It ships these folders:

- `foundation/` — the engine and tools, copied into the new project: `src/core.js`, `src/lib.js`, `src/player.js`, `src/music.js` (engine plus a demo score), `src/props.js` (photo-doodle: the shared doodle props), and `tools/` (build, check, snap, render, stubgen, audio analysis, fixtures, and `photos.cjs` + `cutout.py` for photo-doodle). Everything is driven by `src/timeline.js`, so no tool code changes per film.
- `templates/` — the four planning documents every film starts from, plus, for photo-doodle, `art-bible-photo-doodle.md` (that mode's house style, ready to fill) and `cast.js` (a worked character module to rewrite).
- `retro/`: the retro kit, copied over `foundation/` for a retro film. It holds `src/pixel.js` (the pixel kit on `FILM.retro`), `src/chip.js` (the NES sound chip), `src/crt.js` (the old TV), the retro fixtures and `tools/audio/melody.cjs`.
- `game/`: the starter game, copied over `retro/` for a retro game. It is a one-level platformer called ROBOT RUN with its console, levels, sprites, proofs and release tools.
- `reference/` — read when a step below points at one; the three example images first.

Look first: `reference/example-contact-sheet.jpg` (the whole example film, 24 labelled frames), `reference/example-paper-frame.jpg` and `reference/example-blueprint-frame.jpg` (one full frame of each plate). That density and that finish are the bar.

## The gate

`node tools/check.cjs` is the gate: six checks (media scan, determinism, source scan, timeline, draw, frame cost), and exit 0 means green. From the stub pass onward, no step is done while the gate is red. On real scenes it takes under a minute — let it finish.

## Worked example

`butterfly-life` is a finished film from this pipeline, at `../../examples/butterfly-life/` from this skill folder, or online at https://github.com/kuhnhomeuk-cell/procedural-film/tree/main/examples/butterfly-life when that folder is absent. When a template leaves the shape of a filled document unclear, read its counterpart there: `docs/art-bible.md`, `docs/storyboard.md`, `src/timeline.js`, `src/scenes/`, `src/music.js`. Take its structure; the subject comes from step 2's research.

## Pipeline

### 0. Brief

Ask one round of questions: the subject, what the film must include about it, and the length if it differs from 30 seconds. Invent the rest and say what you invented.

Done when: the subject is one written sentence the user has seen.

**retro:** the length must be a whole number of bars. A bar is 16 rows times the chip speed in frames: speed 6 is 1.6 s, speed 8 is 2.133 s, speed 9 is 2.4 s and speed 10 is 2.667 s. Pick the speed whose bars fill the length exactly, so a 12 s film is 5 bars at speed 9.

### 1. Setup

Create the project folder named for the film's slug and copy `foundation/` into it. Run `npm install` in `tools/` (Playwright; add `npx playwright install chromium` there if the browser is missing) and confirm ffmpeg is on the PATH, or set `FFMPEG` to its binary. Copy the templates into `docs/` and set the subject in `docs/CONTRACT.md`'s Goal.

**photo-doodle:** also copy `templates/cast.js` to `src/cast.js` (you rewrite its bodies in step 3b), create `assets/raw/` and `assets/cut/`, and install the cut-out tool once:

```bash
uv venv --python 3.12 ~/.cache/procedural-film-rembg/.venv
uv pip install --python ~/.cache/procedural-film-rembg/.venv/bin/python "rembg[cpu]" pillow
~/.cache/procedural-film-rembg/.venv/bin/python -c "from rembg import new_session; new_session('isnet-general-use')"
```

The last line downloads the ~180 MB model once, so do it before you need it. On Windows the interpreter is `~/.cache/procedural-film-rembg/.venv/Scripts/python.exe`; `python -m venv` and `pip install` work the same way if `uv` is absent. `tools/cutout.py` reads that interpreter path from its own header — point it at wherever you built the environment.

Done when: `node tools/smoke.cjs` passes, `node tools/check.cjs --fixtures` is green and `node tools/render.cjs --fixtures --scale 0.5` yields `exports/fixtures.mp4` with sound. The **fixtures** mini-film proves the toolchain before the film invests in planning.

**retro:** copy `foundation/`, then copy `retro/` over it (`cp -R <skill>/retro/. <project>/`). Copy `templates/sprites.js` to `src/sprites.js` and `templates/music-retro.js` to `src/music.js`. Done when `node tools/check.cjs --fixtures=tools/fixtures/retro` is green and `node tools/render.cjs --fixtures=tools/fixtures/retro --scale 0.5` gives a 60 fps mp4 with sound. Skip the drawn fixtures in a retro project. They are not expected to pass the determinism check there.
The drawn files that come with `foundation/` (`src/props.js`, the drawn fixtures, `tools/cutout.py`, `tools/photos.cjs`) can stay, because the gate ignores them.
Every tool finds the project from its own folder, so `node <project>/tools/check.cjs` works from any directory.
The gate is green when it exits 0, and a WARN still counts as green. Expect a cost WARN on retro films.

### 1b. Photographs — photo-doodle only

Source one photograph per shot, plus a spare or two. Three rules, in order of how much they cost to get wrong:

1. **Licence.** Only what you can actually use: public domain, CC0, CC BY, CC BY-SA. Record every file's title, author, licence and source URL in `docs/CREDITS.md` as you download, not afterwards. Say plainly in the handover which terms travel with the film — CC BY-SA asks that a work built on it be shared alike, which is a real constraint on a film someone means to publish.
2. **Cut-out quality.** The background comes off locally: `cutout.py` (rembg, `isnet-general-use`) trims to the object's alpha bounds and writes `assets/cut/<id>.webp`. Objects on a plain contrasting background cut cleanly; an object the same colour as its background does not — a green cactus against green foliage came back as confetti. **Look at every cut-out before you build a shot around it** (compose them into one sheet with any image tool you like), and search again rather than accept a ragged one. When a photo holds several objects, crop to one before cutting.
3. **Shape.** Prefer a clear silhouette with something to hang a doodle on: a handle, a spout, a rim, a hole. The shape is the set.

Then `node tools/photos.cjs` embeds `assets/cut/*.webp` into `src/photos.js` as WebP data URIs, and scenes draw them with `lib.photo(ctx, id, cx, baseY, { h })`.

Two engine facts worth knowing before you plan shots: photos are decoded before the first frame (drawing an undecoded image is a determinism failure), and drawing the same photo at two different sizes in one page can resample differently once the browser has a texture history for it — if an end card shows every photo as a thumbnail, draw those through an offscreen canvas at 1:1 instead of scaling live. The determinism check catches it, but at the end of the build rather than the start.

Done when: every shot has a licensed, cleanly cut photograph, `docs/CREDITS.md` is complete, and `node tools/photos.cjs` reports every id.

### 2. Research

List the phases of the subject's story, then run one web search per open question and capture two to four authoritative full-text sources into `.tmp/research/`. Research lands in exactly two places downstream: the art bible's subject reference and each shot's Subject section.

**photo-doodle:** a story staged on objects has little to research and the gate below does not apply to it. Research instead what the film will be judged on for truth: how each real object behaves (steam leaves a spout and widens; a trumpet sounds at the bell, not the valves; pine-cone scales overlap upward), one line per object, straight into the art bible's section 9. Invented story, observed objects.

Done when: every phase of the story traces to a captured source; in photo-doodle, every object has its observed behaviour written down.

**retro:** research stays light, as in photo-doodle. Write down what the story needs to be true (how the subject moves, what it looks like at 16 px) in section 10 of the art bible.

### 3. Art bible

Fill `docs/art-bible.md` from the template. Sections 1–9 are the house style — already decided. Only the two marked subject sections change: 2.2 (the subject palette, every colour a named hex, mirrored into the marked block in `src/lib.js`) and 10 (the subject reference built from the captured sources — one subsection per drawable element with sizes, ratios, counts, poses, sequences — ending in Mistakes to avoid, each mistake paired with the correct drawing).

**photo-doodle:** use `templates/art-bible-photo-doodle.md` instead — a different house style, already written and proven. Change what your film genuinely needs (tints, cast sizes, the floor line), keep the rules, and fill its section 9. What that bible fixes, because these are the things parallel scene agents get wrong independently: one tinted paper plate per shot and a night plate where ink becomes chalk; line widths by role and **never dark ink on a dark part of a photograph**; washes offset off their outline, arriving after it, and **never on top of a photograph**; the photo at 40 to 65 percent of frame height standing on a floor line; **density** (8 to 15 distinct doodle elements per shot, nothing important under 40 px, three things moving at any moment); and draw-on over the first second, then movement.

Thin, timid shots are that mode's default failure: a photo with four small doodles around it reads as unfinished, and every agent will produce one unless the bible says otherwise and the review enforces it.

**retro:** use `templates/art-bible-retro.md` instead. It fixes the native 320×180 grid, the NES palette, three colours per sprite, motion in frames at 60 fps and pixel text only. Fill its section 10. The named colours live on `RETRO_PAL` in `src/sprites.js`, not in `src/lib.js`, and `src/sprites.js` is the mirror of section 10.2.
`RETRO_PAL` must define `hudWhite`, because `pxtext` and the HUD use it by default.
The palette snap in the done-when below is for drawn films. A retro film judges its swatches on the 3c cast sheet.

If the user wants a different look than the house style, run a reference analysis first — `templates/reference-analysis.md` shows the method (step through one reference video, written notes only, end with numbered style rules) — then update art-bible sections 1–9 to match before continuing.

Done when: every element the storyboard will draw has a drawing rule and a palette name, `src/lib.js` holds the same values as section 2.2, the mistakes list exists, and `node tools/snap.cjs --fixtures --shot palette --samples 5 --sheet` has been looked at: every swatch named, each colour judged against its neighbours on both plates. Every scene agent copies this palette, so a wrong hue costs every scene file.

### 3c. The cast sheet: retro only

Redraw `src/sprites.js` (copied from `templates/sprites.js`) into this film's cast, tiles and props, each on `FILM.retro.SPRITES_DEF` with its palette on `FILM.retro.SPAL`. Then draw one test frame on the native buffer with every sprite in every pose, as `retro/tools/fixtures/retro/scenes/01-sheet.js` does for the fixture cast. It costs one snap and catches size, contrast and a missing pose before any scene uses them.
The cast sheet is its own fixtures dir, `tools/fixtures/cast/`, with a `timeline.js` and a `scenes/` folder. It has no `sprites.js` or `music.js` of its own, so both come from `src/`. Run it with `node tools/check.cjs --fixtures=tools/fixtures/cast` and snap it with `--fixtures=tools/fixtures/cast`.

Done when: one frame shows every sprite in every pose the film needs, and the gate's palette and sprite checks (7 and 9) are green.

### 3b. The cast — photo-doodle only

A story mode needs recurring characters, and characters drift when each scene draws its own. Rewrite `src/cast.js` (copied from `templates/cast.js`) into this film's two or three characters, built on `FILM.props`: one function each, a small named set of poses, returned anchors so scenes hang props off them, and `night: true` support. Then every scene calls `FILM.cast.<name>` and none of them redraws a character.

Draw one test frame with the whole cast and every prop on it before any scene is written — it costs one snap and catches proportions, contrast and missing poses while it is still cheap.

Done when: a single frame shows every character in every pose it needs, and the art bible names their size ranges.

### 4. Storyboard

Read `reference/shot-types.md` for the shot types the example film proves, then fill `docs/storyboard.md` from the template: logline; numbers (pick a bpm, then beat = 60/bpm seconds and the duration lands in whole bars); summary table; acts mapped to bars; a shared-geometry table for every shape that survives a **match cut**; then one entry per shot — 1 to 3 seconds each, boundaries on the beat grid, plates alternating — with all eight subsections, the Sound cues timestamped on the grid.

**photo-doodle:** the summary table also names, per shot, the photo id, the paper tint and **what the object becomes** — that last column is the film. "The teapot, with steam" is not an idea; "the teapot is the rest stop, and its steam becomes a face that looks at him" is. Add a per-shot position for the hero too, so the character advances across the film instead of standing in the same place in every frame.

**retro:** the shared geometry is the four tables G1 to G4 in the storyboard template, counted in frames at 60 fps and in native pixels: HUD state per shot, hero world-x at each shot start, fixed landmarks, and jump specs. Pick the bpm from the chip speed, bpm = 900/speed (speed 8 is 112.5), so every row lands on a frame. The duration is a whole number of bars. A bar is 16 rows times the chip speed in frames: speed 6 is 1.6 s, speed 8 is 2.133 s, speed 9 is 2.4 s and speed 10 is 2.667 s. Pick the speed whose bars fill the length exactly, so a 12 s film is 5 bars at speed 9. Write "None" under each shot's Overlays subsection, because retro has none. The safe area is 8 native pixels on every side (x 48 to 1872, y 48 to 1032 at output size).

Done when: the shots tile [0, duration] exactly, with no gaps or overlaps, every shot has all eight subsections, every match-cut shape has a shared-geometry table, and the doc survives a self-review with a critic's eye: every number in the prose matches the tables (beat arithmetic, act boundaries), and no must-read content sits outside the safe area (x 60–940, y 220–1540 vertical; x 60–1020, y 70–1000 square) — arithmetic included. Storyboard errors compound into every scene; this is the cheapest moment to catch them.

### 5. Timeline

Write `src/timeline.js` from the storyboard (shape in the storyboard template): title, bpm, duration, **width and height**, the shots array (id, file, start, end, mode, title, transitionIn, brief), and the flat cues list collected from the Sound sections. A vertical film may leave width and height out and get 1080×1920; **a photo-doodle film must declare `width: 1080, height: 1080`**, because nothing else in the pipeline knows the frame is square. The stub pass is this step's test — it fails loudly on a malformed timeline.

**retro:** a retro film must declare `fps: 60`, `width: 1920, height: 1080` and a `retro` block, `retro: { native: [320, 180], present: 'nearest' }` or `present: 'crt'` with its `crt` caption and power windows (see `reference/retro-display.md`). The first cue starts the chip song: `{ t: 0, kind: 'song', id: '<song id>', section: 'a' }`.

### 6. Stub pass

Run `node tools/stubgen.cjs` to generate a placeholder scene per shot, run the gate, then `node tools/render.cjs --scale 0.5 --out exports/draft-stubs.mp4` and watch the draft end to end. This is the tracer bullet: timeline, scenes, gate, render and audio all proven before any real scene is drawn.

Done when: the gate is green and the draft MP4 shows every shot in order, every cut on the grid.

**retro:** run `node tools/stubgen.cjs --retro`. Each stub fills the whole native buffer with one `RETRO_PAL` colour, writes the shot id with `FILM.retro.pxtext` and presents it with `FILM.presentNearest`. In a CRT film, change the present call to `FILM.crt.present`.

### 7. Scenes

One agent per scene file — file ownership is law (docs/CONTRACT.md). Each scene agent reads `reference/scene-anatomy.md`, its storyboard entry, the art bible and the shared geometry, then writes `src/scenes/NN-<id>.js`, snaps a contact sheet (`node tools/snap.cjs --shot <id> --samples 6 --sheet`) and looks at every frame, iterating until the sheet is on-brief. `snap --only` renders one shot while sibling files are half-written, so scene agents run in parallel freely.

Each scene brief names the files the agent owns, the shared-geometry tables that bind it, and the scene file that owns the canonical progress glyph.

**photo-doodle:** the brief also names the photo id, the paper tint, what the object becomes, and the four rules agents break on their own — density (8 to 15 elements), scale (nothing important under 40 px), contrast (chalk over dark photo areas, checked on a rendered frame), and pigment never on a photo. Expect to send most shots back once: a first pass is reliably too sparse and too small, and the correction that works is specific — "the hero at s 0.85, the caption at size 46 in clear paper, add the crowd of four" — not "make it denser".

**retro:** each scene agent also reads `templates/art-bible-retro.md` (as the film's `docs/art-bible.md`) and `reference/retro-display.md`. A scene draws into `FILM.native()` and presents it with `FILM.presentNearest` or `FILM.crt.present`, whichever the timeline names. All text is pixel text from `FILM.retro.pxtext`. The brief names the G1 to G4 rows the shot must match.
`FILM.native()` returns the same buffer every frame and never clears it. Paint all 320×180 pixels every frame, or last frame's pixels show through transparent sprite corners and the determinism check fails.

Done when: every shot's contact sheet has been eyeballed and judged on-brief, and the gate is green.

### 8. Music

Compose `src/music.js` per `reference/music.md`: keep the engine, replace the CH chord table, the MIX.ride automation and the whole score() function, implementing every cue in `FILM.TIMELINE.cues` at its exact time so the hits land on the cuts.

Done when: `node tools/audio/render-audio.cjs` then `node tools/audio/analyze.cjs .tmp/audio/score.wav --cues` matches onsets to cues within 10 ms, `node tools/audio/peaks.cjs .tmp/audio/score.wav` shows headroom under the limiter ceiling, and the gate is green.

The limiter protects the peaks, not the loudness: a score that passes both checks can still land near −20 LUFS, which is half the loudness of everything else in a feed. Measure the master with `ffmpeg -i <master> -af ebur128 -f null /dev/null` and normalise the delivered transcodes to about −14 LUFS with `loudnorm=I=-14:TP=-1.5:LRA=11`.

**retro:** the score is chip music, so follow `reference/retro-sound.md` instead of `reference/music.md`. `src/music.js` calls `FILM.chip.define` with the songs and sound effects, and the timeline cues drive it: a `song` cue switches the song, any other kind fires that sound effect. Run `node tools/audio/melody.cjs` and paste its notes into the header of `src/music.js` as the originality record. The done-when checks above apply, except the chip has no limiter: peaks must stay under 0 dBFS, and `render-audio` prints the peak.

### 9. Critic waves

Start with the whole film on one sheet: `node tools/snap.cjs --samples 24 --sheet --scale 0.25`. A shot that fails to read at that size is a P1 — the fix is composition, not more detail.

**photo-doodle:** two more questions per shot, answered on the frame. *With the words removed, does the frame still say what is happening?* — if only the caption carries it, the doodles are decoration and the shot needs staging, not polish. *Can you find the hero in under a second?* — a character camouflaged against the photograph needs a chalk halo pass or clear paper to stand on.

**retro:** the gate already checks the NES rules (palette, pixels, sprite colours, sound). Critics judge what a gate cannot: can each shot be read on a phone, is the hero easy to find, and is the pixel text large enough.

Then review every shot on rendered frames: fresh contact sheets, critic subagents scoring composition, faithfulness to the storyboard, motion and density. Critics **measure** ratio-critical geometry in pixels against the art bible (band fractions, thirds, safe-area arithmetic, shared-geometry positions) rather than judging by eye alone, and snap both sides of every match cut to compare.

Fix in waves — prioritised briefs (P1 first, each citing evidence frames), file ownership (resume the owning agent rather than spawning a fresh one), re-snap after every fix. The director spot-checks every P1 fix on fresh frames. Spot-check determinism by snapping the same frames in two different orders and comparing file hashes.

Done when: every P1 and P2 fix is verified on fresh frames and the gate is green.

### 10. Deliver

`node tools/render.cjs` writes the master (crf 16; a 30 s film renders in minutes). Then the transcodes:

```bash
ffmpeg -i exports/<slug>.mp4 -vf scale=720:1280 -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k exports/<slug>-phone.mp4   # photo-doodle: scale=720:720
ffmpeg -i exports/<slug>.mp4 -c:v libx264 -crf 23 -preset medium -c:a copy exports/<slug>-preview.mp4
```

**retro:** nearest-neighbour scaling keeps the pixels sharp, and both transcodes get the loudness normalisation from step 8:

```bash
ffmpeg -i exports/<slug>.mp4 -vf scale=1280:720:flags=neighbor -c:v libx264 -crf 23 -preset medium -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 128k exports/<slug>-phone.mp4
ffmpeg -i exports/<slug>.mp4 -c:v libx264 -crf 23 -preset medium -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 128k exports/<slug>-preview.mp4
```

`node tools/build.cjs` writes `dist/<slug>.html`. Then watch the master end to end with sound, and open the HTML player once (click or space to play, arrow keys step frames, `?shot=<id>` loops one shot).

Write `exports/<slug>-shots.md` last: one line per shot saying what it shows, so whoever shares the film can caption it.

Done when: master, phone transcode, the HTML file and `exports/<slug>-shots.md` exist, the gate is green, and the final watch-through found nothing to fix.

## Retro game

The same kit makes a side-scrolling platformer that plays in the browser. Every step below is short on purpose. The detail for each one is in `reference/retro-game.md`, and each step names the section to read. Run every command from the project folder.

### G0. Brief

Get a title, a hero and a one-sentence premise from the user. Invent everything else, and say which parts you invented when you confirm the brief.

Done when: the user has confirmed the title, the hero and the premise.

### G1. Setup

Copy `foundation/` into an empty project folder, then `retro/` over it, then `game/` over that. The order matters because a later overlay replaces a file of the same name. Then run `npm --prefix tools install` and `npm --prefix tools exec -- playwright install chromium`. See "Assembly".

Done when: `node tools/gates.cjs` is green on the untouched starter, ROBOT RUN. This proves the toolchain before anything changes.

### G2. Config

Fill in `src/game/00-config.js`: the slug, the title, the hero's name, `saveKey` as `<slug>.save.v1`, the level order and `firstLevel`. Add a legal line when the game borrows a character, logo or brand that belongs to someone else. Copy `templates/game-spec.md` to `docs/` and fill in its blanks. See "The config file".

Done when: the config and `docs/game-spec.md` have no blanks left.

### G3. Art

Write the art bible from `templates/art-bible-retro.md`. Redraw every name listed in `src/manifest.js` in `src/sprites.js`, because the manifest is the contract. See "Sprites".

Done when: `node tools/art-check.cjs` is green and you have looked at a title frame and a gameplay frame. `node tools/site.cjs` renders the title screen to `web/og.png`.

### G4. Levels

Rewrite `src/game/01-levels.js` (the level definitions and `CONFIG.order`) and `tools/proof/levels.data.cjs`. See "Adding a level".

Done when: `node tools/levels-lint.cjs` is green.

### G5. Foes and mechanics

This step is optional, since the starter has one walking foe. A new foe or mechanic goes in through the module seam. See "Adding a foe or mechanic".

Done when: `node tools/proof/engine-scenarios.cjs` is green.

### G6. Routes and tapes

Add each level's route to `tools/proof/programs/routes.cjs` and its program to `tools/proof/programs/`. Run `node tools/proof/levels.cjs --replan` and then `node tools/proof/full.cjs --replan`, and commit the tapes. After every re-plan of the first level, run `node tools/attract.cjs` before any gate. See "The route and the program" and "The tapes".

Done when: `node tools/proof/levels.cjs`, `node tools/proof/full.cjs` and `node tools/proof/determinism.cjs` are green.

### G7. Music and sound effects

Write `src/music.js` on the chip. It needs every song the engine switches to, a `<song>Fast` variant of each level song and an effect for every event that makes a sound. Run `node tools/audio/melody.cjs` and paste its output into the originality record at the top of `src/music.js`. See "Sound".

Done when: `node tools/audio/game-audio.cjs` is green.

### G8. Attract film

Run `node tools/attract.cjs`, then `node tools/render.cjs --out exports/attract.mp4`. Without `--out`, the file is named after the project folder. Watch it, or snap frames from it. See "The attract film".

Done when: you have watched the attract film and found nothing to fix.

### G9. Gates

Done when: `node tools/gates.cjs` is green on all 13 gates and `node tools/deploy.cjs --dry-run` is green. See "The gates".

### G10. Deploy

Deploy only when the user asks. It runs on the user's own signed-in Vercel CLI, and `vercel login` is theirs to run. Then run `node tools/deploy.cjs`, and `node tools/deploy.cjs --redeploy` for later releases. Never deploy on your own initiative. See "Deploy".

Done when: the user has the live address.

Known limits: the camera only scrolls forward, a pipe exit past a token means each token is proven by its own program, and CONTINUE stays greyed out until there is a second level.
