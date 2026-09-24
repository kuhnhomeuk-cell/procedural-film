# Retro sound

How a retro film is scored on the chip.
The kit's `src/chip.js` holds the driver and an emulated NES sound chip, and the film's own `src/music.js` registers the score.

## The chip

The sound is built the way a 1980s cartridge built it.
A driver runs once per 60 Hz frame, steps the song, lets effects take their channels, and writes chip registers.
The emulated chip plays those writes and nothing else.

| channel | key | what it can do |
|---|---|---|
| pulse 1 | `p1` | square wave, four duty widths, 16 volume steps |
| pulse 2 | `p2` | the same, and most effects take it |
| triangle | `t` | fixed-volume bass, on or off |
| noise | `n` | hats, snares, crashes from short patterns |
| DMC | `d` | four sampled drums: kick, snare and two timpani |

Five voices is the whole band.
Two pulses carry the lead and the harmony, the triangle carries the bass.
Every chord is an arpeggio or an implication.

## No effect nodes

The film is one mono buffer, the chip times one flat gain, copied to both channels.
Never add a reverb, delay, compressor or panner.
`tools/check.cjs` check 10 fails when `music.js` or `chip.js` builds one.
Echo is written as notes: a quieter copy of the line a few rows late on the other pulse.

## The notation

`FILM.chip.define({ songs, sfx })` registers the score, and it merges, so it can be called more than once.
Each song gives `speed`, optional `sections`, and one string per channel.

- `C5:2` is a note two rows long.
  A row is a 16th note, and a bare `C5` is one row.
- `r:2` is a rest and `-:2` ties onto the note before.
- `@lead` picks an instrument, and `T+12` transposes what follows.
- `[ ... ]4` repeats its contents four times.
- `|` marks where the song loops back to.
- Noise tokens are pattern names such as `h`, `o`, `c`, `x`, `s`.
- DMC tokens are `K` kick, `S` snare, `L` deep kick, and the timpani `D`, `A`, `C`, `G`.

Pulse instruments include `lead`, `harm`, `brass`, `soft`, `stab`, `shim`, `echo`, `arp` and `sing`.
The triangle uses `bass` by default, and `hold` or `ring` sustain longer.

Every channel of a song must have the same length and the same loop point, or `define` throws.

A complete score that renders and passes the gates:

```js
FILM.chip.define({
  songs: {
    test: {
      speed: 8,
      sections: { a: 0 },
      p1: '@lead | C5:2 E5:2 G5:4 A5:2 G5:2 E5:4 D5:2 F5:2 A5:4 G5:8',
      p2: '@harm | E4:4 G4:4 C5:4 G4:4 F4:4 A4:4 B4:8',
      t: '| C3:4 G2:4 A2:4 E2:4 F2:4 D2:4 G2:8',
      n: '| [h:2 h:2 s:2 h:2]4',
    },
  },
  sfx: {
    blip: (ev, K) => ({ pri: 2, p2: K.cat(K.pt(K.mhz('E6'), 2, { d: 1, v: [12, 12] }), K.pt(K.mhz('B6'), 10, { d: 1, v: [12, 0], trig: false })) }),
    thud: (ev, K) => ({ pri: 2, p2: K.cat(K.pt(330, 2, { d: 2, v: [15, 15] }), K.pt(165, 10, { d: 2, v: [14, 0], bend: 0.94, trig: false })), n: K.nz([[12, 15], [12, 11], [13, 7], [13, 4], [13, 2]]) }),
  },
});
```

## Tempo

`speed` is frames per row.
At 60 fps with 16th-note rows, the tempo is `900 / speed` bpm.
Speed 8 is 112.5 bpm, speed 6 is 150, speed 5 is 180.
Set the timeline's `bpm` to the same number, so the cut grid and the music agree.
A song is `rows * speed` frames long, and the test song above is 32 rows at speed 8, or 256 frames.
A bar is 16 rows, so speed 6 is 1.6 s, speed 8 is 2.133 s, speed 9 is 2.4 s and speed 10 is 2.667 s.

## How cues drive a film

With no game loaded, the chip reads `FILM.TIMELINE.cues`, each at frame `round(t * 60)`.

- `{ t, kind: 'song', id, section }` starts that song, at the named section's row when given, replacing the one playing.
- Any other `kind` fires `sfx[kind]` on that frame.

```js
cues: [
  { t: 0, kind: 'song', id: 'test', section: 'a' },
  { t: 1, kind: 'blip' },
  { t: 2.5, kind: 'thud' },
],
```

A song with `loop: false` plays once and stops.
Time a closing song so its last note rings out before the film ends.

## Sound effects

Each effect is a function `(ev, K) => ({ pri, p1?, p2?, t?, n? })` that returns one frame program per channel it takes.
`K` is `FILM.chip`, and its helpers build those programs:

| helper | builds |
|---|---|
| `K.pt(hz, n, { d, v, bend, vib, wob, trig })` | a pulse tone for `n` frames, duty `d`, volume `[from, to]`, pitch bend per frame |
| `K.psw(hz, n, { p, s, neg, v, hold })` | a tone moved by the hardware sweep, rising with `neg` |
| `K.trill(a, b, n, { v, d })` | two notes swapped every frame, a shimmer |
| `K.nz([[period, vol, mode], ...])` | a noise burst, one row per frame |
| `K.tthud(hz, n, ratio)` | a triangle knock falling by `ratio` each frame |
| `K.gap(n)`, `K.cat(...)` | `n` silent frames, and programs joined end to end |
| `K.mhz('E6')`, `K.midi('E6')` | a note name to hertz or to a MIDI number |

Priority decides who owns a channel.
A new effect takes a channel when its priority is at least the one playing there.
The song keeps time silently under an effect and comes back in step when the effect ends.
Keep ambient effects at 0 to 2, story hits at 3 to 4, and the one moment that must be heard at 5 or more.
Open a hit with a loud pulse frame on its cue frame, or it reads late under the song.

## FILM.audio

```js
FILM.audio.render(ctx, { start = 0, dest = ctx.destination }) // the whole film, from global time start
FILM.audio.live(audioCtx, { dest })  // the same driver in real time, for a player
FILM.audio.synth(sampleRate, opts)   // the raw mono buffer, for tools
FILM.audio.songs, FILM.audio.sfx, FILM.audio.info()
```

A retro film with no `FILM.chip.define` call throws when rendered.

## Originality: the melody record

Every melody must be your own.
The chip's sound makes any tune feel familiar, so check what you wrote against what you might be echoing.

1. Run `node tools/audio/melody.cjs`.
   It decodes each song's melody back from the driver's register writes and prints notes bar by bar as `name:rows`.
   `--ch p2` reads the second pulse, `--bars 8` reads more bars, and a song id limits the output.
2. Paste the decoded first bars into the project's notes, one line per song.
3. Name any known tune in the same role, such as another game's level theme, and write one line on how yours differs in key, contour, rhythm or opening figure.
4. When the contour or rhythm of an opening bar matches a known tune, rewrite it.

The same rule covers effects: pick your own pitches and intervals for a pickup or a jingle.
Hardware sweeps and arpeggio shimmer are chip idioms, free to use.

## Loudness

The chip's flat gain is set to land near -14 LUFS on a typical score.
A sparse or very dense score will miss it.
Measure the master as in SKILL.md step 8, and normalise the delivered transcodes to -14 LUFS there.
The chip has no limiter, so keep peaks under 0 dBFS. `render-audio` prints the peak.
