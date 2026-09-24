# procedural-film

![Six frames from the butterfly-life film, alternating hand-inked paper shots and navy blueprint shots](media/banner.jpg)

An agent skill that turns a topic into a short film or a small game.
It makes drawn and photo-doodle vertical films, retro pixel-art films at 60 fps, and a playable NES-style platformer.
The platformer starts from a starter game called ROBOT RUN and deploys to your own Vercel account.
Every pixel is drawn in vanilla JavaScript on a canvas and every sound is synthesised in Web Audio, so the film ships with zero media assets.
The output is one self-contained HTML player plus MP4 exports.

The reference film is `examples/butterfly-life`, the life cycle of a monarch butterfly: 17 shots, 32 seconds, 120 bpm, 1080x1920 at 24 fps.

- Watch the phone cut: [`examples/butterfly-life/exports/butterfly-life-phone.mp4`](examples/butterfly-life/exports/butterfly-life-phone.mp4)
- Interactive player: download [`examples/butterfly-life/dist/butterfly-life.html`](examples/butterfly-life/dist/butterfly-life.html) and open it in a browser

## What is in the repo

| Path | Contents |
|---|---|
| `skills/procedural-film/` | The skill. `SKILL.md` is the pipeline, `foundation/` is the engine and tools copied into each new film, `retro/` adds the pixel-art engine and sound chip, `game/` holds the ROBOT RUN starter, `templates/` holds the four planning documents, `reference/` holds the shot-type index, scene and music guides, and frames from the example as the visual target. |
| `examples/butterfly-life/` | The butterfly film as the skill produces it: planning docs, source, tools, the HTML player and the phone MP4. |

## Claude Quest: a game on the same engine

Three more examples push the engine from vertical films into a 320x180 NES-style platformer starring Claw'd.
Play the game at https://claude-quest-nu.vercel.app with a keyboard, a gamepad or the on-screen pad.

| Path | Contents |
|---|---|
| `examples/claude-quest/` | The first pixel-art film: 17 hand-animated shots, 40 seconds, 60 fps. |
| `examples/claude-quest-v2/` | The film rebuilt as one continuous run of a real game engine, played from a recorded controller tape, on a simulated CRT with an emulated NES sound chip. The 720p cut is in `exports/`. |
| `examples/claude-quest-game/` | The playable game with four levels and a boss fight. Its bots replay a controller tape through every level to prove each one can be finished, and its gates run before every deploy. |

These three are the worked examples the retro mode was built from.
Ask for a retro film or a game and the skill starts from its own retro engine and the ROBOT RUN starter, not from these folders.

Claude Quest is an unofficial fan project, not affiliated with or endorsed by Anthropic.
The art, music and levels are original; the look borrows the grammar of 1985 platformers.

## Requirements

- Node.js 20 or newer
- ffmpeg on the `PATH`
- Chromium for Playwright, installed after the `npm install` below with `npx --prefix examples/butterfly-life/tools playwright install chromium`
- The Vercel CLI, only to deploy a game
- An agent that runs skills and dispatches parallel subagents, for example Claude Code

## Install the skill

Clone the repo, then link the skill into your agent's skills folder.
A link keeps the worked example reachable at `examples/butterfly-life/` beside the skill.

```bash
git clone https://github.com/kuhnhomeuk-cell/procedural-film.git
```

```bash
ln -s "$PWD/procedural-film/skills/procedural-film" ~/.claude/skills/procedural-film
```

For another agent, link it into that agent's skills folder.

## Make a film

Ask your agent for a procedural film about a subject, for example "make a procedural film about the life of a honeybee".
`skills/procedural-film/SKILL.md` holds the full pipeline.
Expect a long run: one agent per shot writes a scene file of 1000+ lines, then critic waves review every shot, so a film spends a large share of a usage plan.

## Rebuild the butterfly film

```bash
npm install --prefix examples/butterfly-life/tools
```

```bash
node examples/butterfly-life/tools/check.cjs
```

```bash
node examples/butterfly-life/tools/render.cjs
```

`check.cjs` runs the six-check gate and exits 0 when green.
`render.cjs` writes `examples/butterfly-life/exports/butterfly-life.mp4`.
`node examples/butterfly-life/tools/build.cjs` rebuilds the HTML player.

## Credit

The look and editing are modelled on Kevin Ngo's ["The life of a fruit fly"](https://x.com/kevin_t_ngo/status/2099858454043349342).
`examples/butterfly-life/docs/reference-analysis.md` records what was taken from it.

## License

MIT. See [`LICENSE`](LICENSE).
