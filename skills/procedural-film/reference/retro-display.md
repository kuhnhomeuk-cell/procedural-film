# Retro display

How a retro film gets from its 320x180 console buffer to the 1920x1080 frame.
The source is `src/crt.js` from the retro kit.

## Choose how to present

A retro shot draws into `FILM.native()`, a fixed 320x180 buffer where every pixel is an NES colour.
The timeline's `retro.present` says how that buffer reaches the output.

- `'nearest'` scales each native pixel to a 6x6 block with `FILM.presentNearest`.
  It is sharp, fast and costs nothing to render.
  Choose it by default, and always when the brief says "no CRT".
- `'crt'` shows the buffer on a simulated 1980s TV with `FILM.crt.present`.
  Choose it when the film should feel like a set in a room: scanlines, glow, colour bleed, a power-on and a power-off.
  It renders in software under the tools and is slow.

The timeline block:

```js
retro: {
  native: [320, 180],
  present: 'nearest', // or 'crt'
  crt: { caption: '', powerOn: null, powerOff: null },
},
```

A retro film needs `fps: 60`.
A `'crt'` film also needs `native: [320, 180]`, the only size the shaders take, and `tools/check.cjs` fails any other size.

## The API

```js
FILM.crt.present(nb.canvas, ctx, { frame: info.frame, T: info.T }) // f may also be a plain frame number
FILM.crt.mode          // 'crt' (default) or 'clean' (whole-pixel nearest, no TV)
FILM.crt.buttonsAt     // null, or f => a button mask at frame f; a game overlay sets it
FILM.crt.overlays      // { input: true, caption: true }
FILM.crt.backend       // 'webgl2' | 'webgl' | 'cpu' | 'nearest', null until the first present
FILM.crt.force         // set before the first present to test a fallback
FILM.crt.params        // the tunables, set before a render, never per frame
FILM.crt.power(f), FILM.crt.camera(f), FILM.crt.marks()
FILM.crt.captionWindow(), FILM.crt.inputWindows(), FILM.crt.settledFrame()
FILM.crt.reset()       // drop the GL state
```

`FILM.native()` returns the same buffer every frame and never clears it.
A scene paints all 320x180 pixels every frame, or last frame's pixels show through transparent sprite corners and the determinism check fails.

A CRT shot draws its sheet into the native buffer and presents it in one call:

```js
FILM.scene({
  id: 'crt',
  draw(ctx, t, info) {
    const nb = FILM.native();
    drawSheet(nb.ctx, info.frame);
    FILM.crt.present(nb.canvas, ctx, { frame: info.frame, T: info.T });
  },
});
```

## What the TV does

1. Each native pixel maps back to its NES palette index.
2. The console's composite signal is built from each index and decoded the way a TV decodes it.
   Flat areas come out as their exact palette colour, and edges get real colour bleed.
   The phase is fixed, so the fringes never crawl.
3. A blurred copy gives the glow and a wider one gives the halation.
4. The camera starts on the whole set, a wooden TV on a sideboard in a dark room lit only by its own screen, and pushes in until the tube fills the frame.
5. The tube draws one scanline per native row, with a beam that widens on bright rows, a light aperture grille, barrel curvature and vignette.
6. The result lands in the output context, then the proof layers go on top.

Backends are tried in order: WebGL2, WebGL1, a CPU approximation, then plain nearest.
`FILM.crt.force = 'cpu'` before the first present tests a fallback.

## Power windows and the caption

`retro.crt.powerOn` and `retro.crt.powerOff` are `[f0, f1]` in global frames, or `null` for none.
The key frames are laid out for a 150-frame power-on and a 120-frame power-off, and other lengths stretch them.
With no power-on the tube is lit and full-frame from frame 0.

The power-on runs from the dark set, through a click, a beam line and rolling snow, to a locked picture that fills the frame at `f1`.
The power-off collapses the raster to a line and then a dot while the camera pulls back to the dark set.
`FILM.crt.marks()` returns these key frames, so sound can land on them.

`retro.crt.caption` is the closing caption on the dark glass, with lines split on `\n`, or `''` for none.
It starts at the caption point: `powerOff[0] + round(90 * (powerOff[1] - powerOff[0]) / 120)`.
The film must end at least 30 frames after that point, or `captionWindow()` returns `null` and the caption never shows.
A 12-frame power-off at frame 201 puts the caption point at 210, so a film ending at 240 just fits.
About 150 frames after `powerOff[1]` gives a comfortable 2 seconds.

Start the power-on after any fade into the CRT shot, so the fade runs on dark glass.

The input display draws a small pad, bottom right, wherever `FILM.crt.buttonsAt(f)` returns a mask.
A shot-based film leaves `buttonsAt` as `null`, and no pad appears.

## Tunables

`FILM.crt.params` holds the defaults, and `FILM.crt.DEFAULTS` keeps a frozen copy.
Set them once before a render.
These are the ones worth touching:

| param | default | effect |
|---|---|---|
| `brightness` | 1.06 | overall gain |
| `glow`, `halo` | 0.07, 0.045 | softness and bloom around bright areas |
| `maskK` | 0.2 | grille strength, 0 for none |
| `sigmaMin`, `sigmaMax` | 0.15, 0.40 | scanline beam width on dark and bright rows |
| `artifacts` | 0.35 | how much composite fringing shows |
| `vignette` | 0.2 | edge darkening |
| `wide` | [0.44, 0.4, 0.3] | the wide shot of the set: zoom, centre x, centre y |
| `room` | 1.8 | how brightly the screen lights the room |

Leave the gamma, curvature and decoder values alone unless a frame shows a real fault.

## Determinism

A present is a pure function of the native pixels and the frame index.
Nothing carries over between frames, and all noise is hashed from pixel position and frame.

- Never draw vector shapes on the output after a present.
  Chrome rasterises a canvas differently once another canvas has been drawn into it, and the hash drifts.
  The kit draws its own overlays on a private scratch canvas and blends them in integer arithmetic.
  Do the same for any overlay of your own.
- The tools pin WebGL to SwiftShader whenever `src/crt.js` exists, so every machine renders the same pixels.
  `FILM_GL=gpu` uses the real GPU for quick previews, and results then match only on that GPU.
- `tools/check.cjs` check 11 fails unless the `webgl2` backend ran.

## Cost

SwiftShader renders the CRT in software, far slower than one 60 fps frame period.
The cost check will print a `WARN` on a `'crt'` film, and that is expected.
Only a hard budget you set with `--budget` fails it.
Render with `--workers N` rather than cutting CRT quality.

## Clean mode

`FILM.crt.mode = 'clean'` presents the buffer with `FILM.presentNearest`, whole-pixel and with no TV.
Use it to inspect the art, and check 11 confirms it paints only console colours.
To render a whole film without the TV, set `present: 'nearest'` instead.
