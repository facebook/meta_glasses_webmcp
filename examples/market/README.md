# Local Market

A grocery store you shop by voice, built as a `glasses_webmcp` example. Six
aisles, forty products, and a cart that has to fit the 600×600 display. Say
what you are cooking and each ingredient walks to its aisle, scrolls into the
middle of the screen and lights up as it drops into the cart. Tap the Add
buttons by hand or let a voice-driven agent shop through tools; both go
through the same code path. The cart is in memory only, so a reload starts
fresh.

Tool registration goes through the small local registry in `src/webmcp.ts`,
so the page runs as an ordinary app with no agent host present and the tools
stay drivable in tests.

| Sample | Install |
| :---: | :---: |
| ![Local Market demo: asked to add ingredients for lasagna, the assistant adds lasagna noodles, ground beef, two cans of crushed tomatoes, ricotta and mozzarella, then opens the cart at $27.74](demo.gif) | ![QR code that installs the Local Market example on Meta Ray-Ban Display](install-qr.svg) |

## Run the sample

From the workspace root:

```sh
yarn install
PORT=5173
yarn workspace example-market dev --host 0.0.0.0 --port "$PORT"
```

Then open the URL Vite prints.

Pick an aisle, then a product, and press **Add**. The cart pill in the header
counts units; open it to change quantities with the steppers or place the
order. The product photos in `public/products/` are AI-generated (made with
Google AI), and each file carries that label in its metadata.

## What it demonstrates

Most tool surfaces let an agent change state. This one is about letting the
shopper **watch** it change.

- **Adding is choreography, not a mutation.** `shopping_add_to_cart` navigates
  to the product's aisle, scrolls its tile to the centre of the frame over a
  fixed 420 ms, pulses it for 900 ms, and commits the cart change 260 ms into
  that pulse so the header badge pops inside the flare. The tool does not
  resolve until all of it has finished, so an agent's next call cannot land on
  top of the last one.
- **There is deliberately no bulk-add tool.** A batch add would collapse the
  only thing this app has to show into a single frame. Five ingredients is
  five calls, and the order the agent picks is the order the shopper watches.
- **The agent gets the whole catalogue up front.** `shopping_get_state`
  returns every product id grouped by aisle (well under a kilobyte), so an
  agent asked for "everything for a lasagna" can match the recipe against
  what is stocked and start adding without searching item by item.
- **One path into the cart.** The Add buttons and the tools both call the
  renderer's `showAndPulse`; there is no faster agent-only route.
- **The cart is laid out to a frame budget.** Five lines plus subtotal, tax
  and total fit inside 600×600 under a sticky header. The page measures
  itself and parks the verdict on `window.__marketCartFits`.

## What to say to the agent

```text
"add ingredients for lasagna to my cart" → shopping_get_state, then one shopping_add_to_cart per ingredient, then shopping_navigate to "cart"
"what's in the bakery?"                  → shopping_browse_categories, or shopping_navigate to show it
"show me the ricotta"                    → shopping_navigate with to="ricotta"
"make it two cans of tomatoes"           → shopping_update_quantity
"take the bacon out"                     → shopping_remove_from_cart
"start over"                             → shopping_clear_cart
```

Spoken names resolve fuzzily: "mince" finds ground beef, "tinned tomatoes"
finds crushed tomatoes, "lasagne sheets" finds lasagna noodles. See
[`public/agent.md`](public/agent.md) for the agent persona.

## Tools

Ten tools, all prefixed `shopping_`. Every mutating tool returns the full
snapshot. Expected failures come back as tool errors naming the valid
alternatives, never thrown exceptions, and missing required inputs are
refused before any handler runs.

- `shopping_get_state` — `{}`. The screen, every product id by aisle, the
  cart and the running totals. Registered first and read-only.
- `shopping_browse_categories` — `{category?}`. Aisles with each product's
  id, name, unit and price.
- `shopping_search_products` — `{query, limit?}`. Resolve a spoken phrase to
  ranked product ids. Does not change the screen.
- `shopping_get_product` — `{item}`. Price, unit, aisle and cart quantity for
  one product.
- `shopping_view_cart` — `{}`. Lines, subtotal, tax and total. Does not put
  the cart on screen.
- `shopping_navigate` — `{to}`. Show `"aisles"`, `"cart"`, an aisle or a
  product.
- `shopping_add_to_cart` — `{item, quantity?}`. Add one product, with the
  aisle walk, scroll and pulse. At most 12 of any one product.
- `shopping_update_quantity` — `{item, quantity}`. Set a line's count; 0
  removes it.
- `shopping_remove_from_cart` — `{item}`. Take one line out.
- `shopping_clear_cart` — `{}`. Empty the cart. Destructive.

## Read the code

1. `src/main.ts` is the entry point. It builds one `Store`, the renderer and
   the tools, and routes the Add buttons and the agent through the same
   `addWithAnimation`.
2. `src/catalog.ts` is the store: aisles, products, prices, aliases and the
   photo path for each product. Pure data.
3. `src/engine.ts` holds the cart, quantities, money and fuzzy name
   resolution. Pure logic, no DOM.
4. `src/state.ts` is the snapshot every tool returns and the route type the
   page and the tools share.
5. `src/render.ts` paints the screens and owns the add choreography.
6. `src/tools.ts` exposes the store as `shopping_*` tools. `src/webmcp.ts` is
   the registry they publish into: list them with `getTools()`, call them
   with `executeTool()`.

## Tests

```sh
yarn workspace example-market test
```

`src/tools.test.ts` drives the registered tools through `executeTool()` the
way a host would: registration order, catalogue integrity, fuzzy resolution,
the five-item lasagna cart totalling `$27.74`, quantity edits, the per-item
cap, merging, rounding and hash routing.
