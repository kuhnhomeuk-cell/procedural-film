# <GAME TITLE>: game build spec

Version 1, <date>.
Every path below is relative to the game project root (foundation, then retro, then game, copied in that order).
This file is the one contract for the work packages in section 14.
Where this spec and a design note disagree, this spec wins.
The owner can overturn any decision here.
Sections marked **BLANK** belong to this game and are filled in before any package starts.
Every other section describes the shipped starter and is kept true to it.

## 0. Units and conventions

Codes: R principles, D decisions, F level rules, E engine, V events, U shell, W web, T tests, P packages.
"Live" means a console made by `FILM.game.create()`, the game itself.
"Film" means the attract film (`FILM.game.sim()`), the attract demo and the proof tools.
Distances are native 320x180 pixels, time is 60 Hz frames, and `Q(v) = v / 4096`.
Tile row r has its top at `rowTop(r) = 16r - 12`.
A map has 12 rows, the ground rows 10 and 11 fill y 148 to 180, and the HUD band is y 0 to 31.
Every level id, title and save key comes from `GAME.CONFIG` in `src/game/00-config.js`.
No file other than `00-config.js` may name a level id as a literal default: read `GAME.CONFIG.firstLevel` and `GAME.CONFIG.order`.

## 1. Principles and decisions

### 1.1 Principles

- R5 The shell: a title menu (NEW GAME, CONTINUE, OPTIONS), options for feel, display, volume, input display and flashing, a saved hi-score and progress, an attract demo after idling on the title, keyboard, gamepad and touch, remappable keys, pause on a hidden tab, audio started by the first input, exact 60 Hz stepping on fast displays, and a CRT with a clean fallback.
- R6 Inside the native buffer everything stays NES-truthful: only `lib.NES` colours, 3-colour character sprites, 320x180, 60 Hz and 2A03-style sound.
  Every sprite, melody, effect note sequence and line of text is original.
- R7 The game deploys as a static site to a new Vercel project that the author owns, and never overwrites an existing project.
  `index.html` is the self-contained game, with an og image, a favicon, share meta and the attract film as `film.html`.
- R8 Proof comes before shipping: a bot finishes every level in both feel modes, the determinism checks pass, and the browser tests run against the local server and then the production URL.

### 1.2 Decisions

- D8 Menus (title, options, controls, pause panel) are pure state machines in `src/game/50-menu.js`.
  The engine keeps only gameplay modes (section 3.1).
- D9 The engine never touches storage.
  The shell derives every save from the console's events.
- D10 The clock is the pure module `src/game/45-clock.js`.
  Timing comes only from the animation frame stamp, never from `Date` or `performance.now`.
- D11 Pause is input.
  P, Escape, a hidden tab, a lost focus and a pad disconnect inject START into the input stream, so every pause is replayable from the tape.
  Pause freezes the song inside the audio driver and lets effects play.
- D12 Hurry-up at 100 time units: a 90-frame jingle, then a faster variant of the level song derived automatically.
- D13 Level proofs run in both feel modes, with the planner's `o.free: true`.
- D14 The Content-Security-Policy travels as a `<meta>` tag with one sha256 hash per inline script.
  Share meta is added after the media scan from a fixed template, and the scanner gets no exemption.

### 1.3 Disclaimer rule

When the game borrows a third party's character, logo or brand name, set `GAME.CONFIG.legal` to a one-line disclaimer.
It then shows in the menu help rows, in `og:description` and on the share card.
The art stays original even then: a borrowed name never licenses a copied sprite, melody or layout.

### 1.4 This game's decisions (BLANK)

- D15 <title, hero name and one-sentence premise>
- D16 <what this game adds through the seam, if anything>
- D17 <anything cut from the starter>

## 2. Architecture

### 2.3 Files and load order

`tools/common.cjs` loads `src/game/*.js` in sorted order, so the numeric prefix is the load order.

| File | Role |
|---|---|
| `src/game/00-config.js` | `GAME.CONFIG`: title, slug, hero name, save key, legal line, level order, first level, site URL, Vercel project |
| `src/game/01-levels.js` | `GAME.GAME_DEFS` and `GAME.GAME_ORDER`, the maps |
| `src/game/10-engine.js` | engine, routing, modes, feel, items, checkpoint, the seam (2.4) |
| `src/game/11-19-*.js` | new kinds and systems through the seam; `15-tokens.js` ships as the example |
| `src/game/20-tape.js` | the planner (`GAME.moves`, `GAME.goals`, `GAME.makeBot`) |
| `src/game/21-attract.js` | the recorded attract tape, written by `tools/attract.cjs` |
| `src/game/30-draw.js` | the snapshot painter |
| `src/game/40-api.js` | `FILM.game` (2.5) |
| `src/game/45-clock.js` | the pure fixed-step clock |
| `src/game/50-menu.js` | the pure menus and their painters |
| `src/sprites.js`, `src/manifest.js` | sprites and names |
| `src/music.js` | songs, effects, the driver pause |
| `src/shell.js` | the game page |
| `src/timeline.js`, `src/scenes/*` | the attract film |

Banned in every `src` file, checked by the media scan and check 3:
`url(`, `.src =`, `data:`, `base64`, `fetch(`, `import(`, `new Image`, `<link`, `@font-face`, quoted media file names, `Math.random`, `Date` (even inside a string), `performance.now` and crypto randomness.

### 2.4 The engine seam

`10-engine.js` exports one kit and two registries.
Nothing else in the engine is public to the `11-19` modules.

```js
GAME.K = Object.freeze({
  Q, PH, BUTTONS, rowTop, rowOf, cell, solidAt, headAt, setCell,
  bodyL, bodyR, bodyH, drawH,
  emit, setSong, addScore, pop, popOf,
  comboPoints, hurt, makeEnemy,     // hurt(W, fatal, cause)
});
GAME.KINDS = {};   // enemy kinds by name
GAME.systems = []; // systems, registered by name
```

An enemy kind supplies `top` (hitbox height), `flier`, `spiky`, `move(W, lv, e)`, `onStomp(W, lv, e, p)` and `sprite(W, lv, e, vf)`.
The engine owns spawn, activation, despawn, the death fall and player contact.

A system is an object with a `name` and any of these hooks, called in array order:

| Hook | Called |
|---|---|
| `spawn[ch](lv, tx, ty, def, W)` | `buildLevel`, per map cell whose character has an entry; returns the character left in the grid (default `.`) |
| `build(lv, def, W)` | end of `buildLevel` |
| `enter(W, lv)` | after a level or area starts |
| `pre(W, lv, p)` | each unfrozen play frame, before the player moves |
| `step(W, lv)` | each unfrozen play frame, after the player moves |
| `sprites(W, lv, out, vf)` | `snapshot`, pushes sprite records |
| `cloneLevel(src, dst)`, `cloneWorld(src, dst)` | deep-copy everything the system added |

A worked example with a full boss fight through this seam lives in `examples/claude-quest-game`.

### 2.5 Public API (`src/game/40-api.js`)

```js
FILM.game.create(opts) -> { step(buttons) -> events[], state(), snapshot(), draw(ctx, view), frame, mode, pausable }
// opts: start (level id, default GAME.CONFIG.firstLevel), feel ('modern' | 'nes'), top (hi-score seed), shellMenu
FILM.game.demo()              // the attract demo: { step() -> events[], snapshot(), draw(ctx, view), done, frame }
FILM.game.sim()               // the attract film: the console at CONFIG.firstLevel fed GAME.ATTRACT, cached
FILM.game.record(input, length, feel)   // a recording for 21-attract.js: { length, fp, rle, feel }
FILM.game.encode(tape), decode(rle, length), fingerprint(S), events(), tape(), draw(ctx, f), filmLength(), BUTTONS
```

`FILM.game` is frozen.

## 3. State machines

### 3.1 Engine modes

| Mode | Code | Enters | Leaves |
|---|---|---|---|
| `title` | 0 | boot | START |
| `title2` | 0 | START on the title | `lives` after 20 frames |
| `lives` | 1 | new game, death, clear, continue | `play` after 90 frames |
| `play` | 2 | level start | death, clear, pause |
| `gameover` | 3 | lives reach 0 | `continue` after 180 frames |
| `pause` | 4 | START while `pausable` | START |
| `continue` | 5 | after `gameover` | CONTINUE or END |
| `clear` | 6 | after the goal | `lives` for `def.next` after 150 frames, or `credits` after the last level |
| `credits` | 7 | the last clear | START from 60 frames in, or by itself after 3600 |

In `pause`, only the frame counter, the button state and the event list change, so the world is frozen and the snapshot clock `W.vf` holds.

### 3.2 Shell states

| State | Input goes to | Leaves |
|---|---|---|
| `boot` | none | first frame drawn, then `title` |
| `title` | `GAME.menu.step` | NEW GAME, CONTINUE, OPTIONS, or 1080 idle frames to `demo` |
| `options`, `controls` | `GAME.menu.step` | BACK or B |
| `demo` | any button edge ends it (consumed) | `title` |
| `game` | the console | the engine enters `pause` or returns to `title` |
| `paused` | `GAME.menu.step` (pause); START resumes | RESUME, OPTIONS, QUIT |

NEW GAME creates `create({ start: CONFIG.firstLevel, feel, top, shellMenu: true })` and sends START on its first step.
CONTINUE does the same with `start: save.reach`, and stays disabled while `save.reach` is `CONFIG.firstLevel`.

## 4. Levels

### 4.1 Jump envelope and level rules (checked by `tools/levels-lint.cjs`)

Measured in NES-accurate mode, perfect last-frame takeoff, A held, tiles edge to edge:

| Landing height change (tiles) | -5 | -4 | -3 | -2 | -1 | 0 | +1 | +2 | +3 | +4 | +5 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Walk-speed jump, max gap | 7 | 7 | 6 | 6 | 6 | 5 | 5 | 4 | 4 | 3 | none |
| Run-speed jump, max gap | 12 | 11 | 10 | 10 | 9 | 8 | 8 | 7 | 7 | 6 | none |

- F1 A required gap is at most the walk maximum minus 1, and an optional or finale gap at most the run maximum minus 2.
- F2 A required climb is at most 3 tiles, and a 4-tile climb appears only on optional routes.
- F3 No standing surface has its top above y 68 (row 5 is the highest), so the big hero stays below the HUD band.
- F5 Every token has a listed route in `tools/proof/levels.data.cjs`.
- F6 A ceiling has no opening within 6 columns of a standing surface in row 7 or above.

Every jump listed in `levels.data.cjs` is also flown by the engine itself, and a required jump needs a takeoff window of at least 16 px.

### 4.2 Legend additions (BLANK)

The starter's legal characters are the set in `tools/levels-lint.cjs` (`LEGAL`).
List each new character here with its meaning, whether it is solid and how it is drawn, and add it to `LEGAL`.

| Char | Meaning | Solid | Drawn as |
|---|---|---|---|
| <char> | <meaning> | <yes/no/head only> | <sprite or tile> |

### 4.3 Level definition schema

Only these fields are read by the starter engine:

```js
{
  id, name,                  // name shows on the lives screen, the pause panel and the clear card
  world, kind, rows, time, song,
  start: { x, y, drop },     // drop: the hero starts falling from y
  main,                      // the main level an area belongs to (default: id)
  next,                      // the level after the goal
  respawn,                   // where a death in this area restarts (default: main)
  mid: { tx, row },          // checkpoint post column and its floor row
  pipeDown: { tx, to },      // DOWN on this pipe enters area `to`
  pipeUp: { tx },            // where a returning side pipe lets the hero out
  pipeSide: { tx, row, to, at },  // RIGHT into this mouth; at: 'pipeUp'
  pole, castle,              // the goal pole column and the goal house column
  scenery,                   // [[name, tx, y?], ...]
  camLock,                   // a camera cap in px
  tokens, tokenBase,         // token overlays [[tx, ty, bit]] and the first bit for `t` characters
}
GAME.GAME_ORDER = [...];     // the main levels in play order; must equal GAME.CONFIG.order
```

### 4.4 Maps (BLANK)

<one subsection per level: id, name, kind, width, the 12 rows, its tokens and checkpoint>

### 4.11 Pacing

Each level teaches one idea safely, tests it, twists it, and ends on a finale.
The opening is safe: 120 frames of holding right from the start (19 tiles at run speed) meet no foe, pit or wall, so a new player learns to move first.

| Level | Taught safely | Tested | Twist | Finale | Clean run |
|---|---|---|---|---|---|
| <id> | <idea, with no way to die> | <the idea with a cost> | <the idea changed> | <the last beat before the goal> | <seconds> |

## 5. Assists

The modern feel (`W.assist`) adds three assists and changes no speed or arc:
- Coyote time: a jump still counts for 5 airborne frames after walking off a ledge.
- Jump buffer: an A press up to 6 frames before landing jumps on the first grounded frame while A is still held.
- Corner correction: a head graze of a block edge up to 4 px slides past it, never for a hidden block.

The NES-accurate feel runs without them.
Feel is chosen on the title's options and is fixed for a run.
An assist may open a route, but no route may depend on one.

## 6. Entities (BLANK)

<each new kind or system: its map character, hitbox, movement, stomp rule, damage cause and events>

## 7. Event contract

The engine emits these events (V), and every sound-bearing one needs a song or an effect:

`song {id, section?}`, `start`, `levelstart`, `jump`, `coin`, `bump`, `brick`, `sprout`, `powerup`, `oneup`, `stomp`, `kick`, `hurt {cause}`, `die {cause}`, `lifelost`, `gameover`, `continue`, `quit`, `cursor`, `pause`, `unpause`, `pipe`, `checkpoint`, `token`, `hurry`, `flagpole`, `tally`, `firework`, `clear`, `credits`.

Damage causes: `enemy`, `spike`, `pit`, `time`.
Shell-only cues, sent straight to the audio queue and never emitted by the engine: `cursor`, `select`, `back`.
A new event is added here, in `tools/audio/events.cjs` and in the sound test in the same change.

## 8. Snapshot contract

`snapshot()` returns a plain record the painter, the shell and the tests read.
It carries the mode code `m`, the visual frame `f` (`W.vf - 1`), score, coins, lives, the hi-score `top`, the current area and main level ids, the token bitmask, the `clear` and `continue` card data, and `spr`, an `Int16Array` of `[nameIndex, x, y, flags, pal]` records.
A paused snapshot carries the frozen world, so the pause panel draws over it.

## 9. Art and copy (BLANK)

<the sprite list by manifest name with its palette, and every line of on-screen copy>
Every glyph used must exist in the font, and every sprite has at most 3 opaque colours.

## 10. Sound

### 10.1 Songs and effects (BLANK)

<each song with its event and mood, each effect with its event>

### 10.3 Driver pause

- `pause`: the song frame stops and the song voices go silent, while effects keep running so the pause jingle plays.
- `unpause`: the song voices return on the same song frame, so the song resumes on the same bar.
- A `song` event always clears the pause.

### 10.4 Audio invariance

The same events always render the same samples.
`tools/audio/game-audio.cjs` checks that every sound-bearing event has a program, that a paused driver holds its song frame, and that `unpause` resumes it.

## 11. Shell

- `src/shell.js` runs only on the game page and builds its own DOM: the TV canvas at 16:9, a chrome row for messages, the touch pad when needed, and a polite live region.
- The clock (U1) advances in whole 60 Hz steps from the animation frame stamp, counts a gap over 250 ms as one step and drops a backlog over 5 steps.
- Input (U2) merges keys, touch, pad and a latch per step, so a press shorter than a frame still lands.
- Remapping (U3) gives each action two key slots, swaps on a clash and refuses fixed keys.
- Audio (U6) starts on the first pointer or key gesture, and the shell replays the last `song` event once sound starts.
- Persistence (U9) lives in `localStorage[GAME.CONFIG.saveKey]`, validated per field, and falls back to memory with `SAVE OFF` shown when storage fails.
- The proof hooks (`?proof=1` only) feed controller bytes and nothing else, so they can do nothing a player cannot.

## 12. Web, CSP and deploy

- `node tools/site.cjs --site https://<name>.vercel.app` builds `web/index.html` (the game) and `web/film.html`, adds the CSP and share meta, renders `og.png`, `favicon.ico` and `apple-touch-icon.png`, and writes `web/vercel.json`.
- Each deploy replaces the whole site, so `web/` always holds every file.
- The CSP meta is `default-src 'none'` with one `sha256` per inline script, and the page makes no request except itself and `/favicon.ico`.
- `node tools/deploy.cjs --dry-run` runs every gate and prints each command a real release would run, without calling Vercel.
- A real deploy runs only when the author asks, on the author's own Vercel sign-in.
  It creates a new project named from `GAME.CONFIG.vercelProject` (else the slug), aborts if that name exists, and never touches another project.

## 13. Test plan

`node tools/gates.cjs` runs 13 gates in this order, prints each gate's last output line and stops at the first red:

1. `tools/check.cjs`: the static and media gates.
2. `tools/levels-lint.cjs`: the map rules and the jump envelope (4.1).
3. `tools/art-check.cjs`: every manifest name has a sprite of its size, at most 3 colours, no placeholder.
4. `tools/audio/game-audio.cjs`: the event contract (7) and the driver pause (10.3).
5. `tools/proof/engine-scenarios.cjs`: pause, assists, checkpoint, continue, routing, hurry, clear and credits.
6. `tools/proof/levels.cjs`: every level program replays its tapes in both feel modes (`--replan` after a level edit).
7. `tools/proof/full.cjs`: one run from the title to the final card per feel mode.
8. `tools/proof/determinism.cjs`: every tape replays to identical hashes, and clones stay in step.
9. `tools/proof/clock.cjs`: display rates from 50 to 240 Hz give 60 steps a second.
10. `tools/proof/menu.cjs`: every menu screen, disabled rows, swap-on-rebind and the idle-to-demo action.
11. `tools/site.cjs --site <url>`: the site build.
12. `tools/game-check.cjs`: the media scan, the NES pixel audit, no console errors or CSP violations, and the size budget.
13. `tools/e2e/run.cjs --site <url>`: the browser tests PW1 to PW14 against the local server.

## 14. Work packages

Each package owns its files outright, and no file has two owners.
A package may read anything.
Integration order: P1, P4 and P5 first, then P2, then P3 and P6, then P7.

| Package | Owns | Depends on |
|---|---|---|
| P1 engine | `src/game/10-engine.js`, `20-tape.js`, `40-api.js`, `tools/proof/harness.cjs`, `engine-scenarios.cjs` | none |
| P2 mechanics | `src/game/11-19-*.js` and their scenario proofs | P1 |
| P3 levels | `src/game/01-levels.js`, `tools/levels-lint.cjs`, `tools/proof/levels*.cjs`, `full.cjs`, `programs/*`, `tapes/*` | P1, P2 |
| P4 art | `src/sprites.js`, `src/manifest.js`, `src/game/30-draw.js`, `tools/art-check.cjs` | none |
| P5 audio | `src/music.js`, `tools/audio/*` | none |
| P6 shell | `src/shell.js`, `src/game/45-clock.js`, `50-menu.js`, `clock.cjs`, `menu.cjs` | P1, P4, P5 |
| P7 release | `tools/build.cjs`, `site.cjs`, `deploy.cjs`, `game-check.cjs`, `gates.cjs`, `determinism.cjs`, `tools/e2e/*`, `web/*`, the attract film | all |

A package is done when the gates it owns are green and `node tools/gates.cjs` is green on the merged tree.
