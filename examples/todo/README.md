# Agentic Todo

A two-screen to-do list — the full list, and one item's detail — built as a
`glasses_webmcp` example. One rounded panel on a dark page: white text, a
circle on the left of every row for done / not done, and a due-day column on
the right, where most rows are dateless so dated ones stand out. Tick items by
hand, or let a voice-driven agent add them, check them off, write their notes,
set their days, and move between the two screens through tools — both drive
the same state. The list persists in `localStorage`, so it survives a reload.

Tool registration goes through the small local registry in `src/webmcp.ts`,
so the page runs as an ordinary app with no agent host present and the tools
stay drivable in tests.

| Sample | Install |
| :---: | :---: |
| ![Agentic Todo demo: asked to note the returned books and a package to ship by 5 today, the assistant checks off the books and adds the package due today](demo.gif) | ![QR code that installs the Agentic Todo example on Meta Ray-Ban Display](install-qr.svg) |

## Run the sample

From the workspace root:

```sh
yarn install
PORT=5173
yarn workspace example-todo dev --host 0.0.0.0 --port "$PORT"
```

Then open the printed `http://localhost:$PORT`.

Type in the box to add an item. Click a circle to check it off — it drops out
of the list into the **Completed** drawer at the foot, folded by default;
click the drawer header to unfold it. Click a row to open its detail screen,
`‹` (or `Esc`) to go back. Typing in the notes field writes through the same
state the agent's tools use.

There is deliberately **no delete control on the panel**. A row is a circle, a
label, and its due day — deleting is something you ask for, and
`todo_delete_items` is the only way to do it. Nothing destructive sits one
stray click away.

## What to say to the agent

```text
"add this to the list"            → todo_add_item
"is this done?"                   → answered from the snapshot it already holds
"check off this and this"         → two todo_check_items calls, one per item
"show me item detail"             → todo_navigate with to="detail"
"go back to the whole list"       → todo_navigate with to="list"
"set item notes"                  → todo_set_detail
"does any item talk about X?"     → answered from the snapshot; no search tool
"sort this by due date"           → the agent sorts, then one todo_reorder_items call
"show me what I've finished"      → todo_show_completed with show=true
"make that due Friday"            → todo_set_due_date, with the agent doing the date arithmetic
"what's overdue?"                 → answered from the snapshot too
```

Reads report, writes acknowledge: `todo_read_list` is the only tool returning
state; every write answers `"ok"` except the two add calls, which return the
fresh ids the caller could not derive. Dates are calendar days, never
timestamps, and every snapshot carries `today` so relative dates become
arithmetic. See [`public/agent.md`](public/agent.md) for the agent persona.

## Tools

Eleven tools, all prefixed `todo_`. Every tool that takes an item accepts the
same reference: short id (returned by reads and adds, never shown on screen),
exact title, title substring, a phrase from the notes, or 1-based position
(`"item 2"`). Resolution tries id, then position, then exact title, then title
substring, then notes substring; the first class with exactly one hit wins. A
reference matching several items fails with the candidates listed, so the
caller retries with an id — tools never guess. Missing required inputs are
refused before any handler runs, and failures come back as tool errors,
never thrown exceptions.

- `todo_read_list` — `{}`. Returns the whole snapshot and changes nothing.
  Read once at the start, then track your own edits; it is the only tool that
  returns state.
- `todo_add_item` — `{title, detail?, due?, position?}`. Adds one item and
  returns its fresh id, e.g. `{"id":"t4a1"}` — the one write that answers with
  more than `"ok"`, because the id cannot be derived any other way. Titles are
  required; `due` must be `YYYY-MM-DD`; `position` is 1-based and appends when
  omitted.
- `todo_add_items` — `{items, position?}`. Adds several titles in one call:
  `items` is ONE string, comma-separated or one per line when a title holds a
  comma. Titles only — anything needing notes or a date goes through
  `todo_add_item` on its own. All-or-nothing: one blank title adds nothing at
  all. Returns the fresh ids in order.
- `todo_check_items` — `{item, done?}`. Checks off ONE item, or un-checks it
  with `done=false`. One item per call; several names are refused rather than
  half-applied.
- `todo_set_detail` — `{item, detail}`. Replaces one item's notes wholesale —
  to extend notes, resend the old text plus the new. Empty string clears.
- `todo_set_due_date` — `{item, due}`. Sets, moves, or clears (empty string)
  one item's due day. `YYYY-MM-DD` only, resolved against the snapshot's
  `today`; anything else is refused with a pointer back at `today`.
- `todo_rename_item` — `{item, title}`. Changes one title. Notes, date, and
  done state are untouched.
- `todo_delete_items` — `{item}`. Removes ONE item for good. Checking off is
  not deleting — only for "remove"/"delete". There is no delete control on the
  panel, so this is the only way an item leaves the list.
- `todo_reorder_items` — `{items}`. The whole new order in one call, as one
  comma-separated string (ids are safest) naming every item exactly once —
  including moving a single entry, which is the same call with that entry
  pulled to its new slot. A short list is refused with the missing titles
  named, so no item can silently vanish or teleport.
- `todo_navigate` — `{to, item?}`. Switches screens: `to="list"` shows the
  whole list, `to="detail"` opens one item and requires `item`. Navigate only
  when the user wants to look at something — any item reads fine from the
  snapshot unopened.
- `todo_show_completed` — `{show}`. Unfolds (`true`) or folds (`false`) the
  Completed drawer. State the wanted end state rather than toggling — the
  snapshot already reports the current one.

Every `todo_read_list` answer has the same shape: `today`, `view`
(`"list"`/`"detail"`), `showing` (the open item's id and title, or null),
`completed_section` (`count` plus whether the drawer `expanded`),
`active_count`, `items` (each with `id`, `title`, `detail`, `done`, `due`,
`due_in_days`, and `overdue`), and a one-line `summary`.

## Read the code

Start with these files:

1. `src/main.ts` is the entry point. It builds one `TodoList`, paints on
   every state change, and registers the tools.
2. `src/model.ts` holds the pure list logic: items, screens, references,
   ordering, and dates. Zero dependencies.
3. `src/app.ts` is the shared state holder both the UI and the tools drive;
   `src/store.ts` persists the items with a safe fallback.
4. `src/view.ts` paints both screens from state; `src/events.ts` wires every
   human gesture to the same methods the tools call.
5. `src/tools.ts` exposes the list as `todo_*` tools, including the snapshot
   every read returns. `src/webmcp.ts` is the registry they publish into —
   list them with `getTools()`, call them with `executeTool()`.

Which screen is showing is state, not chrome: it lives beside the items,
every snapshot reports it, and the agent moves through it with
`todo_navigate` exactly the way clicking does. That is what makes "go back"
something an agent can do.

## Tests

```sh
yarn workspace example-todo test
```

`src/model.test.ts` pins the pure logic down: seed shape, reference order
(id → position → exact title → substring → notes), ambiguity errors,
all-or-nothing batches, full-permutation reorders, and the detail fallback
when the open item is removed. `src/tools.test.ts` drives the registered
tools through `executeTool()` the way a host would, asserting the snapshot
shape, the read-first registration order, and the atomic reorder.
