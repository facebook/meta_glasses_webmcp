# Password

A two-half word duel against the agent, built as a `glasses_webmcp` example.
A card comes up with a word on it and five banned words underneath. Describe it without
saying any of them.

**Half one:** the card is on your screen, you describe, the agent guesses.
**Half two:** the page hands the word to the agent, it describes, you guess.

Same four cards, same two minutes, same banned-word rule on both sides. At full time the
halves are compared — the question the game actually asks is whether you or the model is the
better clue-giver.

Scan the QR code with your phone to install it on Meta Ray-Ban Display, or click it to open the
web app in your browser.

| Sample | Install |
| :---: | :---: |
| ![Password demo: the round opens on SNORKEL; clued with biting on it to look at fish with your face in the sea, the agent guesses snorkel, then gets FLIPPER from floppy shoes you wear at the beach to kick faster](demo.gif) | [![QR code that installs the Password example on Meta Ray-Ban Display](install-qr.svg)](https://facebook.github.io/meta_glasses_webmcp/examples/password/) |

## Quick start

From the workspace root:

```bash
yarn install
yarn workspace example-password dev
# Open the printed http://localhost:5173 and talk to it with a WebMCP voice agent
```

`yarn workspace example-password test` vets the deck and runs the half-two handover suite: it loads the page into jsdom and drives the real
tools through `getTools`/`executeTool`, so what it asserts is the exact JSON a model would see
— how many calls stand between a card resolving and the agent being allowed to talk, and what
the page has already handed over by then.

Without an agent attached the page still runs — `window.Password.game` is drivable from the
console:

```js
const { game } = window.Password
game.newGame()
game.getState().card // the word on screen, plus its banned list
game.submitClue('sixth from the sun, with a big flat halo', 'saturn')
```

## Architecture

```
src/
  deck.ts     The card bank: 200 words, five banned words each. Original content.
  engine.ts   Pure referee: banned-word matching, guess matching, dealing, the clock format.
  game.ts     Shared state API (Game class) — rules, scoring, and the two halves.
  render.ts   The card: 3D flip on the vertical axis, HUD, scores, final tally.
  mcp.ts      Registers the tools and, more importantly, the agent contract.
  webmcp.ts   Local tool registry; publishes each tool to document.modelContext.
  main.ts     Entry point: wires state, rendering, and tools together.
```

## Why the page is the referee

The agent plays both sides of this game across the two halves, so every rule it could bend is
enforced on the other side of the tool boundary:

| The temptation                              | What stops it                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Peek at the word during half one            | The page never sends it. `password_read_state` withholds the card in half one, and says so in the result.                                |
| Score a point without your clue being vetted | `password_guess_word` takes `heard` and `guess` in **one** call. There is no path to a point that skips the banned-word check.           |
| Speak a banned word in half two             | `password_say_clue` vets the sentence **before** it is spoken. A blocked clue was never uttered — the agent has to find another angle.   |
| Brute-force past the vetter                 | Three blocked clues per card. The fourth burns the card and costs a point.                                                               |
| Award itself the win in half two            | The page holds the word. `password_report_guess` takes what you said and decides; the agent has no `correct` field to set.               |

The one thing the page cannot enforce is whether the agent reports your speech faithfully in
half one — it has no microphone of its own. That is handled in the contract rather than in
code: `heard` and `guess` are fused so faithful reporting is the shortest route to a point,
and the tool description is blunt about fabrication being the worst available move. Running
its own speech recognition would fix it properly, but the mic already belongs to the voice
agent, so on glasses that trade is a bad one.

## Banned-word matching

`violates()` in `engine.ts` does prefix matching in both directions, with a four-character
floor on the shorter side: `ring` catches `rings`, `rings` catches `ring`, and `planet`
catches `planetary`. That eagerness is the point — "planetary" is exactly the dodge the rule
exists to stop — but it does mean the deck avoids short bans, since a ban on `art` would fire
on `artist`. The words in `deck.ts` are written in base form and are four letters or longer
wherever the card allows it.

## The card

The card is the whole interface, so the render layer only ever swaps its text while it is
face-down: a new word rotates the card away on its vertical axis, the front is rewritten
behind it, and it rotates back. The table is flat black; the card is the only lit thing on
it, and the example ships no image assets.

The word is sized to the card rather than set at a fixed size, because one size cannot serve
a deck that runs from HONEY to LIGHTHOUSE — at 44px, LIGHTHOUSE pushed its last letter onto a
second line. `fitFont` shrinks the text until it fits on one line, and the same applies to
the letter blanks in half two.

In half two the front shows a row of blanks, one per letter, instead of the word — and when
the card finishes, the answer lands in those same blanks a letter at a time before the card
flips away. That reveal is not decoration. Without it the only half where the word is hidden
from you is also the only half where you never find out what it was: the card simply flipped
to the next row of blanks, and a word you had spent thirty seconds circling left the table
unnamed. The letters arrive in the slots you were staring at, in the same monospace metrics,
so nothing shifts as they land, and the eyebrow drops the "say your guess out loud" prompt
for the verdict. At full time the scoreboard waits for it rather than covering the last word.

## The clock is tuned to how long an agent actually takes

The first cut was six cards in ninety seconds. Playing real games against a voice model showed
that is not a game anyone can finish: one exchange — you speak, the model reasons, it calls a
tool, it answers — measures 25 to 35 seconds, so every test game got through three cards and
the half ended on the clock, never on the deck. Four cards in two minutes is thirty seconds a
card, which is what a reasoning model actually needs. A fast realtime model just ends the half
early on cards instead, which is the right failure direction.

**The whistle does not kill a ball already in play.** The same games surfaced a worse version
of the problem: you gave a good clue, the agent spent twenty seconds thinking, and its correct
guess arrived at a half that had closed underneath it. The point vanished with no explanation.
Now the timer hitting zero only sets `expired` — the card stays live, the display reads LAST,
and the half closes when that play resolves. A late correct guess still scores, a late foul
still costs, and a late wrong guess ends the half so nobody can play on past the whistle by
never getting anything right.

## Speaking is what ends the agent's turn

This is the rule half two is built around, and it was learned the hard way. A voice agent's
turn closes when it speaks, so an instruction shaped like *"say this, then call that"* never
reaches the tool: the words come out, the turn ends, and nothing else happens until the human
talks again. On glasses that produced a game where the agent announced it was taking over,
took its first word, and went silent — the player had to say "give me a hint" to restart it,
once per card, all half.

The page had been asking for two calls per card (`password_draw_card`, then
`password_say_clue`) with a sentence of speech in between. So the round trip was removed
rather than reworded:

- **The page deals the word; the agent never asks for it.** The result that ends half one
  carries half two's first word, and the result that closes each card carries the next, both
  in `your_word`. `password_draw_card` still exists, but only as a way back for an agent that
  lost track — it is idempotent and touches nothing.
- **Every half-two `next_action` has one shape: clear the clue first, then speak once.** The
  agent's single utterance carries everything it owes — the score at half time, "you got it"
  or "no" mid-half — *and* the next clue. It is told why, not just told to: a model that
  knows speaking ends its turn holds the line better than one handed a rule.
- **The clock starts on the first cleared clue, not on the handover.** Composing a clue takes
  a reasoning model tens of seconds and half two is two minutes long, so charging it for
  thinking is exactly what the stopped intermission exists to prevent. A *blocked* attempt
  starts it too, so the three-rejects allowance still costs time.

Half time also has a blind spot underneath all this: a half can end on the clock while the
agent is mid-listen, and the page cannot push that to it — its last instruction was "end your
turn and wait", so it waits forever. Two things close that loop:

- **The card stays on the table and reads HALF TIME.** When the half ends on the last card the
  agent opens half two itself, so the screen offers the nudge ("if it stays quiet, say ready")
  rather than demanding it. When the half ended on the clock, the human is the only channel
  back to the agent and the screen has to recruit them.
- **Every gameplay tool called during half time returns the handover, not an error.** An
  `isError` here makes the model apologise for a mistake it did not make; a plain result
  carrying the word and "clear a clue" makes it start half two instead.

## Credits

Card content authored for this example. The game is the familiar parlour format — describe a
word without using the obvious words — not a port of any published edition.
