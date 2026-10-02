# Solitaire

Standard Klondike solitaire, draw-1, built as a `glasses_webmcp` example. Play
with the mouse, or let a voice-driven agent play through tools — both drive
the same game. Cards are drawn with CSS and inline SVG suits, so the sample
ships no image assets and needs no font with suit symbols.

Tool registration goes through the small local registry in `src/webmcp.ts`,
so the page runs as an ordinary game with no agent host present and the tools
stay drivable in tests.

| Sample | Install |
| :---: | :---: |
| ![Solitaire demo: asked to play through the 3 of hearts, the assistant plays the ace and 2 of hearts, moves the 2 of clubs onto the 3 of diamonds to free the 3 of hearts, and plays it](demo.gif) | ![QR code that installs the Solitaire example on Meta Ray-Ban Display](install-qr.svg) |

## Run the sample

From the workspace root:

```sh
yarn install
PORT=5173
yarn workspace example-solitaire dev --host 0.0.0.0 --port "$PORT"
```

Then open the printed `http://localhost:$PORT`. Add `?seed=N` to the URL to deal
the same game every time.

Click the stock (or **Draw**) to turn a card onto the waste. Click a face-up
card to auto-play it: the waste and single top cards try a foundation first,
then the first column that takes them; a card deeper in a column carries the
run above it along. **New Game** deals a fresh board.

## What to say to the agent

```text
"what's my best move?"          → solitaire_hint
"go ahead and play it"          → solitaire_move with the hinted from/to/count
"draw a card"                   → solitaire_draw
"put the queen on the king"     → solitaire_move between two tableau columns
"play a few moves"              → a sequence of single moves, reading each board it gets back
"start over"                    → solitaire_new_game
```

See [`public/agent.md`](public/agent.md) for the agent persona and strategy
hints.

## Tools

Five tools, all prefixed `solitaire_`. Locations are named `waste`,
`tableau:1` to `tableau:7`, and `foundation:1` to `foundation:4`. Cards use
compact notation: rank then suit, such as `QH` (Queen of Hearts), `10S`, or
`AC`. Illegal moves come back as tool errors carrying the reason, never
thrown exceptions.

- `solitaire_draw` — `{}`. Turns one card from the stock onto the waste, or
  recycles the waste into the stock when the stock is empty.
- `solitaire_move` — `{from, to, count?}`. Moves a card or run between
  locations. `count` sets the run length for tableau-to-tableau moves
  (default 1). A move to any foundation lands on the right suit pile.
- `solitaire_hint` — `{}`. Suggests one useful legal move without playing it.
- `solitaire_new_game` — `{}`. Deals a fresh game.
- `solitaire_read_board` — `{}`. Reads the board without moving.

Every tool returns the same JSON snapshot: `status`, `foundations` (top card
and count), `tableau` (face-up cards plus a face-down count per column),
`waste` (top card and count), `stock` size, and an `ascii` rendering of the
whole board. `solitaire_hint` adds a `hint` field.

## Read the code

1. `src/main.ts` is the entry point. It builds one `Game`, renders on every
   state change, wires clicks, and registers the tools.
2. `src/engine.ts` holds the pure Klondike rules: deal, validated moves,
   auto-flip, win check, and hints. Zero dependencies.
3. `src/game.ts` is the shared state holder both the board and the tools
   drive.
4. `src/render.ts` paints the stock, waste, foundations, and fanned tableau.
5. `src/tools.ts` exposes the game as `solitaire_*` tools. `src/webmcp.ts` is
   the registry they publish into — list them with `getTools()`, call them
   with `executeTool()`.

## Tests

```sh
yarn workspace example-solitaire test
```

`src/engine.test.ts` covers the deal, placement rules, draws and recycling,
run moves with auto-flip, illegal-move reasons, the win check, and the hint
order. `src/tools.test.ts` drives the registered tools through
`executeTool()` the way a host would.
