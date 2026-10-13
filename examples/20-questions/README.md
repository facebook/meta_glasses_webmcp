# 20 Questions

A glowing orb that plays 20 Questions **the other way round**: you think of the secret, and the
agent asks you yes/no questions and guesses it. Built as a `glasses_webmcp` example.

Unlike the other game examples, this page has no engine to beat you with — it never knows the
secret. It is a scoreboard and an orb: it counts questions, keeps the transcript, and flashes what
was just learned. All the difficulty is in the tool contract.

Scan the QR code with your phone to install it on Meta Ray-Ban Display, or click it to open the
web app in your browser.

| Sample | Install |
| :---: | :---: |
| ![20 Questions demo: told it is alive, not a pet, and can fly, the agent guesses an owl and is right](demo.gif) | [![QR code that installs the 20 Questions example on Meta Ray-Ban Display](install-qr.svg)](https://facebook.github.io/meta_glasses_webmcp/examples/20-questions/) |

## Quick start

From the workspace root:

```bash
yarn install
yarn workspace example-20-questions dev
# Open the printed http://localhost:5173 and talk to it with a WebMCP voice agent
```

Without an agent attached the page still runs — `window.TwentyQuestions.game` is drivable from the
console.

## Serving over HTTPS

For a browser that will not load a plain-HTTP dev server, `vite.config.ts` takes the same two
switches `examples/magic-ball` does, under a `Q20_` prefix so both can be served at once:

```bash
yarn workspace example-20-questions dev:https   # Q20_CERT_DIR=$PWD/certs, host q20.example.com, port 5184
```

`certs/` holds `key.pem` and `cert.pem` for that host. Port 5184 leaves the default port free for a plain
`dev`. Keep the key out of version control.

## Architecture

```
src/
  engine.ts   Pure helpers: answer normalisation, caption derivation, strategy coaching.
  game.ts     Shared state API (Game class) — one source of truth for UI + tools.
  render.ts   The orb: aura, fill level, flying caption, counter, end card.
  entrance.ts One-shot reveal: six traced arms spiral out and fill the glass.
  mcp.ts      Registers the tools and, more importantly, the agent contract.
  webmcp.ts   Local tool registry; publishes each tool to document.modelContext.
  main.ts     Entry point: wires input, rendering, and tools together.
```

## Why the tool results are so wordy

This example exists to show what it takes to make a **small** voice model play a turn-taking game
correctly. Three failures showed up against a live model, and each fix is a string in `mcp.ts`:

| Failure | Fix |
|---|---|
| The agent decides *it* holds the secret and asks the human to guess | `your_role` on every result, plus the role in the page `<title>` |
| The agent invents the human's answers and plays all twenty alone | `next_action` ends every non-terminal result with "stop calling tools and wait" |
| The agent enumerates rooms instead of halving the field | `strategy` coaching computed from the stored transcript |

Two details worth copying:

- **Results beat descriptions.** The freshest tool output is what the model steers on, so the role
  and the next action are repeated on *every* result rather than stated once in a description.
- **Terminal results must omit the keep-going directive**, or the agent loops after winning.

A time-based turn gate was tried and removed: the page cannot observe conversational turn
boundaries, so a cooldown produced only false positives. Duplicate records are instead caught
semantically, by comparing the question text, and returned as `ok: true` — an error makes the agent
apologise to the user about the scoreboard.

## Rendering on low-power hardware

This example is tuned for a wearable-class GPU: a tight thermal and power budget,
and no headroom for per-frame re-rasterisation. The rules that fell out of profiling it:

- **Animate only `transform` and `opacity`.** Those stay on the compositor. The
  caption's fly-in originally animated `filter: blur()` alongside `scale`, which
  re-rasters the text every frame; dropping the blur is invisible at speed.
- **Never animate a gradient.** The aura used to cross-fade its `background`
  between two radial gradients. Swapping the gradient instantly underneath a
  fading `opacity` is pixel-identical and free.
- **Size the one layer that must re-raster to what it actually covers.** Moving
  a mask stop cannot be composited, so the fill genuinely repaints while it
  rises — but only the sphere needs to. Shrinking that layer from the full
  600x600 canvas to a 330x330 box around the glass cuts it to 30% of the pixels.
- **Skip blend modes you don't need.** The sheen used `mix-blend-mode: screen`,
  which forces an extra render surface for the compositor to maintain forever.
  For a pure-white source `screen` and normal source-over are algebraically the
  same — `(1-a)·Cb + a` — so it was pure cost.
- **Don't hint what you don't need.** `will-change` promotes a layer for the
  page's whole life; on a memory-tight device that is worse than letting the
  browser promote for the 450ms an opacity transition actually runs.
- **Defer bitmaps you cannot use yet.** The end-of-round art is fetched when a
  round starts rather than at load, keeping it off the critical path.
- **Reveal with a path, not with frames.** The entrance spirals the galaxy out
  along its own arms until it has filled the glass. The arms were traced off
  `full.jpg` minus `empty.jpg` (which isolates the galaxy from the glass
  highlights the two share) — three strands, each paired with a 180-degree twin
  because the art is 2-fold symmetric, so 2.3 kB of path covers six arms.
  Against the megabytes a sprite sheet of the same reveal would cost, and with
  no new bitmap at all. It re-rasters like the waterline does, so it gets the
  same treatment: the 330 box, and the sphere clip. Once bloomed it fades to
  the ordinary full orb on opacity alone and the layer is removed.
- **Count the strands before you draw them.** Tracing only the brightest pair
  read as two fat ribbons, nothing like the picture — and two arms sweeping
  ~100 degrees have to open to a 528px stroke to blanket the disc, which is
  what made them fat. Counting distinct peaks per radius in the folded polar
  map says the art carries ~3.6 strands per half-turn. Six arms share the work,
  so the fill closes at 240px and the trace can stay a filament for most of its
  run. More arms, thinner: the total fill rate is about the same.
- **Feather with stacked strokes, not with a blur.** The obvious way to soften
  a mask edge is `feGaussianBlur`, and it is the wrong one here: the shape
  changes every frame, so the filter re-runs every frame. Stroking each arm
  three times over — concentric, widest and dimmest first, narrow and white
  last — gives a luminance mask that resolves as a soft edge out of plain
  fills. Three is a budget decision, not a taste one: each layer is another
  stroke rasterised per frame for every one of the six arms, and no banding
  survives the art's own noise at three.
- **Bound it with a clip, not a second mask.** The bloom runs past the rim, so
  something has to stop it dragging the art's halo out as a rectangle. A static
  `clip-path` circle does that for one clip; a second SVG mask would have cost
  a luminance surface rebuilt every frame. Watch the default region if you ever
  do add one — `maskUnits="userSpaceOnUse"` with no explicit `x`/`y`/`width`/
  `height` means -10%/120% *of the viewport*, which under a viewBox offset to
  (135, 82.5) silently bites the bottom-right corner off the sphere.

Measured with the Chrome tracing API over a three-second window covering one
recorded answer, in software raster (which exaggerates raster cost and so makes
the ranking clear):

| | raster tasks | raster time |
|---|---|---|
| before | 1171 | 473 ms |
| after | 444 | ~170 ms |

Idle costs no raster at all in either version — the float and sheen are pure
compositor transforms. **These numbers come from desktop software rasterisation,
not from wearable silicon.** They show the work removed, not the frame rate you will
see on the device; the only way to get that is to profile on the glasses.

## MCP tools

| Tool | Input | Description |
|------|-------|-------------|
| `twenty_questions_start_game` | `{}` | Reset the scoreboard to 20 |
| `twenty_questions_record_answer` | `{ question, answer, summary? }` | Log a question and what the human answered |
| `twenty_questions_record_guess` | `{ guess, correct }` | Log a guess and whether they confirmed it |
| `twenty_questions_read_state` | `{}` | Read status, counts, and transcript without spending a question |
| `twenty_questions_end_game` | `{ secret? }` | End the round and record what it was |

See [`public/llms.txt`](public/llms.txt) for the agent persona and strategy hints.

## Stack

Vite 6 and TypeScript, with no runtime dependencies. No framework.
