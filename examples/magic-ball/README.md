# Magic Ball

A twenty-sided die tumbling through purple liquid inside a sealed sphere. Ask it anything, and the
agent's four-word verdict is the face that lands against the window. Built as a
`glasses_webmcp` example.

Scan the QR code with your phone to install it on Meta Ray-Ban Display, or click it to open the
web app in your browser.

| Sample | Install |
| :---: | :---: |
| ![Magic Ball demo: asked whether it will rain on a picnic tomorrow, the die tumbles and lands showing Pack an umbrella; asked what to have for lunch, it lands showing Something fried](demo.gif) | [![QR code that installs the Magic Ball example on Meta Ray-Ban Display](install-qr.svg)](https://facebook.github.io/meta_glasses_webmcp/examples/magic-ball/) |

## Quick start

From the workspace root:

```bash
yarn install
yarn workspace example-magic-ball dev
# Open the printed http://localhost:5173 and talk to it with a WebMCP voice agent
```

Without an agent attached the page still works — click the ball to shake it, or drive it from the
console with `window.MagicBall.ball`.

## The oracle, and the fair die underneath it

The ball ships as an **AI oracle**: the agent decides the verdict, passes it as `answer`, and it is
painted onto whichever face the look-ahead says will win. The die still tumbles for real and still
genuinely decides _where_ it lands — it is just carrying someone else's writing.

```
"How much will GPU prices go down this year?"  ->  "Not much"
"What should I have for lunch?"                ->  "Something fried"
"Will the demo work?"                          ->  "Good luck"
```

Underneath it, intact, is the **fair die**: a real tumble picks one of the twenty stock replies
and the agent reads back whatever face wins, knowing nothing in advance. Both variants of
`magic_ball_ask` live in `mcp.ts` and exactly one is registered.

|                            | `ai` (shipped)                | `die`               |
| -------------------------- | ----------------------------- | ------------------- |
| Who decides                | the model                     | the tumble          |
| `ask` arguments            | `{ question, answer, tone? }` | `{ question }`      |
| Question must be yes-or-no | **no**                        | yes                 |
| Answers                    | any verdict, ≤30 characters   | the twenty stock replies |

The mode is a property of the build — `MODE` in [`src/mode.ts`](src/mode.ts) — and there is
deliberately **no runtime switch**: no toggle, no query parameter, no stored preference. A toggle
was built and removed. A ball that can quietly change which kind of ball it is produces sessions
where the agent's instructions and the page disagree, and it is not worth the confusion.

Both sets of prompts are kept, so flipping back is a switch rather than a rewrite. Three things
change:

|                           | AI oracle (shipped)   | Fair die                                                    |
| ------------------------- | --------------------- | ----------------------------------------------------------- |
| `MODE` in `src/mode.ts`   | `'ai'`                | `'die'`                                                     |
| `<title>` in `index.html` | "YOU are the oracle…" | "the BALL answers, not you…" (kept in the comment above it) |
| Agent persona             | `public/llms.txt`     | `public/llms.die.md`, renamed over it                      |

The tool descriptions need nothing: both variants of `magic_ball_ask` live in `mcp.ts` and
`MODE` picks which one registers. `llms.die.md` is inert in this build — hosts fetch `llms.txt` —
and the two personas are deliberately kept apart rather than merged, because a persona describing
both balls is exactly how the agent ends up refusing a "how much" question on the oracle build.

### Getting a small model to stop refusing

The first live run of the oracle failed in a way the die mode had trained into it:

> **You:** how much will GPU prices go down this year?
> **Assistant:** That's not a yes-or-no question the ball can answer — want to rephrase it as will
> GPU prices go down this year?

Nothing in the oracle's tool description said to refuse; it just did not say loudly enough _not_ to.
The fix is spread across all three places the model reads, strongest last:

- the `<title>`, which becomes part of the system prompt: "answer any question in four words or
  fewer... Not just yes/no questions";
- `public/llms.txt`, which gets a section headed "Any question is a valid question" with worked
  non-yes/no examples;
- the tool description and `your_role` on **every** result: "Never refuse a question for not being
  yes-or-no, never ask the human to rephrase... A 'how much' question gets a quantity, a 'when'
  question gets a time."

Worth noting the failure mode in general: a prohibition the page never stated can still be inherited
from a neighbouring design. Saying "you may" is weaker than deleting the reason it thought it may not.

### Getting a voice model to keep shaking

The second live failure showed up only on a voice agent, running the same page a text agent handled
correctly:

> **You:** Ask the ball if this hairdo looks cool.
> **Assistant:** Shaking the ball... one sec. _(shakes — "Looks sharp" — and never says it)_
> **You:** Do you think my wife will like it?
> **Assistant:** I'd say she's very likely to love it. But hey, does she usually go for bold looks,
> or play it safe?

The text agent shook the ball for both questions and read both verdicts back. Two separate holes in
the persona, which the voice model fell through and the text model happened not to:

- **An escape hatch with no trigger.** `llms.txt` used to close "How the ball talks" with "if the
  human wants your actual analysis they will ask for it outside the ball; answer that as yourself".
  Nothing said what "outside the ball" looks like, so the only signal left was phrasing — and "**do
  you think** my wife will like it?" is phrased as a direct request for the assistant's opinion. The
  hatch fired on the second question of the session.

  It is gone, and nothing narrower replaced it: **every reply is routed through the ball**, with no
  exception left for the model to find. Follow-ups, questions aimed straight at the assistant,
  "seriously, what do you actually think?", "stop being the ball for a second", and remarks that are
  not questions at all all get a shake. In `ai` mode there was never anywhere to step out to
  anyway — the verdict already _is_ the model's honest read, four words long. The only call that is
  not a shake is `magic_ball_history`, which quotes the ball back.
- **A preamble that spent the turn.** "Shaking the ball... one sec." is harmless on screen and fatal
  out loud: the model said it, called the tool, and stopped, so the human heard an announcement and
  then silence. The persona forbade explaining the answer but never forbade talking before it. The
  rhythm now says to say nothing during the call, and `next_action` on every result adds that
  announcing the shake does not count — the human has heard nothing until the answer is spoken.

### Where "I'm done" actually gets decided

Neither harness ever checks that the ball was shaken, because in both of them a turn ends the moment
the model stops asking for tools:

- **Text agent** — an AI SDK `streamText` loop. It runs another step for as long as the previous
  step emitted tool calls; the only explicit `stopWhen` conditions are budget guards (step count).
  The normal exit is a step that produced text and no tool call.
- **Voice agent** — no loop in the client at all. The server generates one response per user turn.
  If it contains a function call, the client executes it, returns the output, and asks for another
  response; if it contains only speech, `response.done` fires and the turn is over.

So "completed the request" is not a check anyone performs. It is the model's own next-token choice
at the top of its turn, made once, before anything can intervene. Nothing shakes the ball
afterwards.

That changes what the persona should say. "Every reply is a shake and a verdict" describes the
_shape of the reply_, which is a judgement the model makes while already composing a conversational
answer — too late. What the page wants is a **precondition on speaking at all**, so `llms.txt` leads
with one:

> **You may not speak until `magic_ball_ask` has returned.** … You are finished with a message
> only when both of these have happened, in this order: 1. the call returned an `answer`. 2. you
> said that `answer` out loud.

Defining "finished" explicitly is the part that was missing. A model with no stated completion
condition falls back to its own, which for a conversational assistant is "I have said something
helpful".

Worth being clear about the limit: this is an instruction, not a guarantee. The enforcement version
lives in the harness — a realtime session can be configured with `tool_choice: "required"`, which
makes a tool call mandatory rather than requested. A page can only ask.

Worth noting in general: an escape hatch is only as narrow as the signal that opens it, and "when
the human wants X" names no signal at all. A conditional exception in a persona is a decision handed
to the model every single turn, so for a toy like this one the cheap fix is not a better condition
but no condition — an unconditional rule is the only kind a chatty model cannot argue its way out
of. Also worth noting that a persona is not done when one agent runs it well: the loopholes a strong
model steps over are the ones a weaker or chattier one walks into, and voice is where "say the
answer" stops being free.

The fair-die build keeps its escape hatch in `llms.die.md`, because there the model genuinely does
not know the answer and "ask me separately" is a real thing to offer.

## Architecture

```
src/
  physics.ts  Pure engine: vec3/quaternion math, the icosahedron, and two contacts
              (the window plane and the spherical wall). No DOM, no RNG of its own.
  ball.ts     Shared state API (Ball class) — owns the die, the shuffled answers,
              and the status machine idle → shaking → presenting → settled.
  mode.ts     Which of the two balls this build is. One constant, no runtime switch.
  render.ts   Canvas: perspective projection, painter's-algorithm faces, text
              painted in each face's own plane, plus the DOM readout.
  mcp.ts      Registers the tools and, more importantly, the agent contract.
  webmcp.ts   Local tool registry; publishes each tool to document.modelContext.
  main.ts     Entry point: rAF loop, click-to-shake, tool registration.
```

## Why the agent cannot cheat

The interesting failure in a fortune-teller demo is not a physics bug, it is the assistant being
_helpful_: asked "will it rain tomorrow?", a model wants to answer. Then the human hears a verdict
that has nothing to do with the die they are watching tumble.

The fix is structural rather than rhetorical: **`magic_ball_ask` hands back the answer
itself, in one call.**

The obvious alternative — a `shake` tool plus a `read_answer` tool — was tried first and is worse,
for a reason that has nothing to do with either tool. Two calls means a **turn boundary** between
them, and a turn boundary is somewhere the model can start talking. Told to wait, it mostly waits;
told anything at all, it sometimes fills the silence with a verdict of its own. One call gives it no
such moment: the first thing it can say, it can only say with the real answer in front of it.

### The look-ahead

The first version of the one-call design got its answer by **blocking** for the two seconds the die
took to land. Correct, but the assistant audibly stalled.

It does not need to wait, because `stepBody` is deterministic and draws no randomness of its own.
`Ball.ask()` throws the die, then runs the entire tumble immediately on a _copy_ of the body
(`planTumble`, ~0.1ms), which reports the face that wins and how many fixed steps it takes to get
there. The tool returns that answer at once; `tick()` then replays the identical trajectory on the
live body, step for step, and the die lands on exactly that face.

This is a look-ahead, **not** a rigged outcome. Nothing steers the die and no answer is chosen in
advance — the simulation has simply already been run. Over 300 seeded shakes, replayed at a ragged
frame rate, the string the tool returned and the string on screen disagreed **0 times**, and
`ask()` returns in 0.09ms at p50 (1.9ms worst) instead of 1850ms.

### Lining the die up with the voice

The look-ahead removed the stall but created a pacing problem in its place. `ask()` returns in
microseconds; the agent does not speak for seconds afterwards, once model latency and TTS have both
had their turn. At the raw ~2s tumble the die had landed and been sitting there for a beat before
the human heard a word, so the spoken answer arrived as a caption for something that had already
finished happening.

Two dials in `ball.ts` fix that, and neither one touches the physics:

- **`THROW_DELAY_MS`** (800ms) — the window stays dark and empty before the die drops in.
- **`REPLAY_RATE`** (0.72) — how much clock time each replayed step consumes.

A third, in `physics.ts`, is **`SHAKE_SPIN`** (0.14): the peak angular velocity the die is thrown
with. It is the dial for how much the die visibly tumbles, and it is not free — `AIR_DAMP` has to
bleed that spin off before the die will hold still enough to settle, so a faster throw takes longer
and more often ends on the `MAX_TUMBLE_STEPS` backstop instead of coming to rest on its own. Over
200 seeded shakes, median steps and backstop rate: 0.06 → 93, 1%; 0.10 → 101, 3%; 0.14 → 121, 5%;
0.20 → 132, 12%; 0.30 → 148, 13%. Past ~0.14 the curve turns over — the die is spinning too hard to
go quiet inside four seconds and the backstop starts doing the work.

Slowing the *replay* rather than lowering gravity matters: the physics constants are tuned over 300
seeded shakes for a die that reliably settles flat, and `planTumble` has already walked this exact
trajectory to pick the answer. Stretching playback changes the pace without changing a step of the
path, so the face that lands is still the face the tool returned — verified over 60 seeded shakes,
0 disagreements.

Measured end to end, from `ask()` to a readable answer: **median 3.9s, p90 5.6s, max 6.8s** (the
backstop case). Tune both dials to your own agent's latency; a text agent answering in under a
second wants a much shorter delay than a voice one.

If you would rather the reveal came first regardless, block on `ball.whenSettled()` inside `ask`
again — the machinery is still there, `read_answer` uses it.

### Emptying the window

Two things clear an answer, and both dissolve it over 400ms rather than cutting:

- **A new question.** This makes a shake read as three beats — the old verdict fades, the window
  sits empty for an instant, then the die drops back in. `ask()` decides the whole new shake up
  front on a scratch body and _queues_ it, leaving the live body alone so the previous answer still
  has something to fade off. That is what lets the tool return the new answer instantly while the
  old one is visibly still on screen.
- **Seven seconds.** The page cannot see the agent thinking, and between the human speaking and
  `ask` landing there are seconds of model latency. Without the linger the previous verdict sits
  there through all of it, reading as a reply to the question just asked.

Beat two is free: the die is thrown deep in the sphere where the depth fog hides it, so the window
is plain purple liquid until it nears the glass. (Verified — the brightest pixel drawn is 0/255
until then.) A question against an already-empty ball skips straight to the roll.

The two triggers share one `clearing` state and differ only in whether a shake is queued behind the
fade: a question queues one and the die rolls in, the linger does not and the window just empties.

The rest is belt and braces:

| Failure                                         | Fix                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The assistant answers the question itself       | It has the real answer before it can speak; plus `your_role` on **every** result and the role in the page `<title>`                                 |
| The answer arriving before the human can see it | `getState().answer` stays `null` until the die actually gets there, so the on-screen readout never runs ahead of the die (verified: 0 early frames) |
| The screen disagreeing with what was said       | `settle()` reveals the _stored_ reading rather than re-reading the face, so the two cannot drift                                                    |
| The answer paraphrased or editorialised         | `next_action` says "say the `answer` field out loud word for word, then stop"                                                                       |
| A die fading out to black instead of to the aura | Faces composite on alpha, not by scaling rgb toward black — an opaque black triangle hid the liquid coming back up behind it                        |
| A follow-up answered as the assistant           | "Everything goes through the ball" in `llms.txt`, repeated in `your_role` and in the tool description                                               |
| The verdict never spoken after a preamble       | The rhythm forbids talking during the call; `next_action` adds that announcing the shake does not count                                             |

Descriptions are read once; results are read every turn. That is why the role is repeated on all
three tools rather than stated once — the pattern is borrowed from
[`20-questions`](../20-questions).

`magic_ball_read_answer` survives as a re-read for when the human shakes the ball by hand
(clicking it shakes it), and because smoke suites call the first registered tool with
no arguments, so a read-only one has to go first.

## Changes from the original demo

The rigid-body solver, the icosahedron and the face-text projection are the original's, line for
line. Everything else follows from one new requirement: **the original never had to decide when the
die had stopped.** It tumbled until the page went away. Here a tool call blocks on that moment, so
it has to actually arrive, and quickly.

- **A settle test the eye would recognise.** The simulation's own sleep threshold is almost never
  reached: contacts with the window are intermittent — usually one vertex at a time — so the die
  converges on the glass asymptotically and is still drifting after six seconds. Waiting for
  `asleep` put the median answer at 5.4s. `isFlatOnWindow()` instead asks whether a face is squarely
  presented and near the glass, and `Ball` requires that to hold for six frames.
- **Gravity ×3, damping ×2.** `GRAVITY` 0.04 → 0.12 and `AIR_DAMP` 0.99 → 0.98. Gravity also scales
  the contact normal force, so friction and the torque that tips an edge-landing flat both get
  stronger with it. Over 300 seeded shakes this moves the median from 5.4s to **2.0s** (p90 3.0s),
  with 294/300 settling on their own rather than on the backstop.
- **A reading pose.** Physics leaves the die rolled to an arbitrary angle, off-centre, and up to 20°
  off square — legible on a desk monitor, not through a 143px window. `Ball` eases position and
  orientation into `readingPose()` over 450ms, which reads as the die floating up to the glass to
  show you. It uses the `qSlerp` and `faceUprightOrientation` helpers the original defined but never
  called.
- **A backstop.** A tumble is capped at 240 steps (four seconds); past that the face nearest the
  window is presented anyway, so a die wedged against the wall can never stall the answer.
- **A look-ahead instead of a wait.** `planTumble()` runs the tumble on a copy of the body the
  moment the ball is shaken, so the outcome is known before the first frame is drawn and the tool
  never has to block. See "The look-ahead" above.
- **Fixed-timestep integration.** The original stepped once per `requestAnimationFrame`, so the die
  fell twice as fast on a 120Hz display. `Ball.tick()` accumulates real time and steps at 60Hz.
- **One die, not two.** The original kept two pre-shuffled icosahedra and picked one per shake to
  work around snapshot rendering; here a single die is reshuffled on every shake. That reshuffle is
  also what keeps the answers fair — any bias in _which face_ the physics favours is washed out,
  because which message sits on that face is redrawn each time.
- **A ball.** The original drew on a transparent background. Here the ball is a
  render (`public/magic-ball.jpg`, cropped from `magic-ball.png`) behind the canvas, with the liquid and the
  glow as CSS layers on top of it; the canvas still draws only what shows through the window. The
  crop is what makes that work — it is sized and offset so the opening in the artwork lands on the
  aperture the canvas clips to, to within a third of a pixel. The arithmetic is in `style.css`.
  The canvas is CPU-backed (`willReadFrequently`): the Meta Ray-Ban Display WebView composites a
  GPU canvas without alpha, so its transparent pixels come out black and hide the ball.

`physics.ts` takes its RNG as an argument, so all of the above is measurable: seed a `Ball`, drive
`tick()` with a synthetic clock, and the whole thing runs headless in Node.

## MCP tools

| Tool                           | Input                         | Description                                                                                |
| ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `magic_ball_read_answer` | `{}`                          | Re-read the answer already in the window, without shaking                                  |
| `magic_ball_ask`         | `{ question, answer, tone? }` | **Shipped.** The model supplies the verdict; the die is made to land showing it, in ~0.1ms |
| `magic_ball_ask`         | `{ question }`                | Fair-die build only: shake and return the answer the die is going to land on               |
| `magic_ball_history`     | `{}`                          | The questions and answers so far this session                                              |

See [`public/llms.txt`](public/llms.txt) for the agent persona.

## Stack

Vite 6 and TypeScript, with no runtime dependencies. No framework, no 3D library — the renderer
is ~150 lines of 2D canvas.
