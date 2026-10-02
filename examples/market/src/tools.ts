/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The agent-facing tool surface, published through the local registry in
// webmcp.ts. One tool per semantic action, matching what the on-screen
// controls do: the agent and the shopper drive the same app.
//
// Every mutating tool returns the full snapshot, so a follow-up read is rare.
// Expected failures come back as isError results, never thrown, and name the
// valid alternatives so the agent can fix its own call. shopping_get_state is
// registered first so a host that probes the first tool gets a read-only one.
//
// There is deliberately no bulk "add these five things" tool. Each add drives
// to the aisle, scrolls the item into the middle of the frame and pulses it;
// a batch call would collapse five visible beats into one.

import { registerTool } from './webmcp.ts';
import { CATEGORIES, CATEGORY_OF, type Product } from './catalog.ts';
import { MAX_QTY, rankProducts, resolveCategory, resolveProduct, type Result, type Store } from './engine.ts';
import { money, productDetail, snapshot, type Route, type View } from './state.ts';

const toolError = (reason: string) => ({
  content: [{ type: 'text' as const, text: reason }],
  isError: true,
});

/** Flatten an engine Result's error into the one string the agent reads. */
const explain = (r: Extract<Result<unknown>, { ok: false }>) =>
  [r.error, r.hint, r.choices?.length ? `Valid values: ${r.choices.join(', ')}.` : ''].filter(Boolean).join(' ');

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const MAX_QTY_NOTE = `At most ${MAX_QTY} of any one product.`;

export interface ToolDeps {
  store: Store;
  /** Shared with the renderer, so a tool and a tap end up in the same place. */
  view: View;
  /** Repaint. Called after anything that changes state outside an animation. */
  onChange: () => void;
  /**
   * Navigate + scroll + pulse + commit, awaited. This is the renderer's
   * `showAndPulse`, the same path the Add buttons take: the tools get no
   * faster route to the cart, so what the shopper watches is the real app.
   */
  addWithAnimation: (id: string, quantity: number) => Promise<Result<unknown>>;
  /** Change route and repaint. */
  go: (route: Route) => void;
}

export function registerTools({ store, view, onChange, addWithAnimation, go }: ToolDeps): void {
  const snap = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...snapshot(store, view), ...extra });

  /** Resolve a spoken item phrase, or return the error result to hand back. */
  const pick = (item: string): Product | ReturnType<typeof toolError> => {
    const r = resolveProduct(item);
    if (!r.ok) return toolError(explain(r));
    return r.value;
  };
  const isError = (v: unknown): v is ReturnType<typeof toolError> =>
    typeof v === 'object' && v !== null && 'isError' in v;

  // ---------------------------------------------------------------- reading

  registerTool({
    name: 'shopping_get_state',
    description: `Read the whole session in one call: which screen the shopper is looking at, every product id the store stocks grouped by aisle, everything currently in the cart with quantities and line totals, and the running subtotal, tax and total. Call this FIRST to orient yourself — the catalog it returns is what lets you decide what to add without searching for each item one at a time — and again after anything changes. Ids from \`catalog\` are what every other tool wants. ${MAX_QTY_NOTE}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => snap(),
  });

  registerTool({
    name: 'shopping_browse_categories',
    description:
      'List the aisles with the full product line-up of each: id, name, unit size and price. Heavier than the catalog in shopping_get_state, which is ids only — use this when the shopper asks what the store has, or when you need prices before deciding. Pass `category` to get just one aisle.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Optional. One aisle id or name.',
          enum: CATEGORY_IDS,
        },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async ({ category }: { category?: string }) => {
      let wanted = CATEGORIES;
      if (category) {
        const r = resolveCategory(category);
        if (!r.ok) return toolError(explain(r));
        wanted = [r.value];
      }
      return JSON.stringify({
        aisles: wanted.map((c) => ({
          id: c.id,
          name: c.name,
          products: c.products.map((p) => ({
            id: p.id,
            name: p.name,
            unit: p.unit,
            price: money(p.price),
            inCart: store.quantityOf(p.id) || undefined,
          })),
        })),
      });
    },
  });

  registerTool({
    name: 'shopping_search_products',
    description:
      'Resolve a spoken phrase to product ids — "mince", "tinned tomatoes", "something for pasta". Returns ranked matches with prices. This is a DATA lookup; it does not change the screen. To SHOW the shopper something, use shopping_navigate; to put it in the cart, use shopping_add_to_cart, which resolves the same phrases itself and so is usually the only call you need.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the shopper called it, in their own words.' },
        limit: { type: 'integer', description: 'How many matches to return. Default 6.' },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async ({ query, limit }: { query: string; limit?: number }) => {
      if (!query?.trim()) return toolError('Search needs a query.');
      const matches = rankProducts(query, Math.min(Math.max(limit ?? 6, 1), 20));
      return JSON.stringify({
        query,
        matches: matches.map((m) => ({
          id: m.id,
          name: m.name,
          unit: m.unit,
          price: money(m.price),
          aisle: m.category,
        })),
        ...(matches.length ? {} : { note: 'Nothing matched. Call shopping_browse_categories to see the whole store.' }),
      });
    },
  });

  registerTool({
    name: 'shopping_get_product',
    description: 'Price, unit size, aisle and current cart quantity for one product. Does not change the screen.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'A product id, or what the shopper called it.' },
      },
      required: ['item'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async ({ item }: { item: string }) => {
      const product = pick(item);
      if (isError(product)) return product;
      return JSON.stringify(productDetail(product, store));
    },
  });

  registerTool({
    name: 'shopping_view_cart',
    description:
      'Everything in the cart with quantities, line totals, subtotal, tax and total. Reading the cart does NOT put it on screen — call shopping_navigate with "cart" for that, which is what you want at the end of a shop so the shopper can see what they are buying.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => {
      const t = store.totals();
      return JSON.stringify({
        lines: store.lines().map((l) => ({
          id: l.product.id,
          name: l.product.name,
          unit: l.product.unit,
          quantity: l.quantity,
          unitPrice: money(l.product.price),
          lineTotal: money(l.lineTotal),
        })),
        itemCount: t.lines,
        unitCount: t.units,
        subtotal: money(t.subtotal),
        tax: money(t.tax),
        taxRate: `${(t.taxRate * 100).toFixed(1)}%`,
        total: money(t.total),
      });
    },
  });

  // ------------------------------------------------------------- navigating

  registerTool({
    name: 'shopping_navigate',
    description:
      'Put something ON SCREEN — PREFER showing over describing. `to` may be "aisles" (the home grid), "cart", an aisle id or name, or a product id or name. Adding already navigates on its own, so the usual use for this is the closing move: navigate to "cart" once everything is in, so the shopper sees the list and the total.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: '"aisles", "cart", an aisle (e.g. "pantry"), or a product (e.g. "ricotta").',
        },
      },
      required: ['to'],
    },
    execute: async ({ to }: { to: string }) => {
      const raw = String(to ?? '')
        .trim()
        .toLowerCase();
      if (!raw) return toolError('Navigate needs a destination.');

      if (['aisles', 'home', 'menu', 'store', 'browse'].includes(raw)) {
        go({ kind: 'home' });
        return snap({ navigatedTo: 'aisles' });
      }
      if (['cart', 'basket', 'checkout', 'order'].includes(raw)) {
        go({ kind: 'cart' });
        return snap({ navigatedTo: 'cart' });
      }

      const category = resolveCategory(raw);
      const product = resolveProduct(raw);
      // A tie goes to the aisle: "produce" and "vegetables" should show the
      // shelf, not the single best-matching vegetable on it.
      if (category.ok) {
        go({ kind: 'category', id: category.value.id });
        return snap({ navigatedTo: category.value.name });
      }
      if (product.ok) {
        go({ kind: 'product', id: product.value.id });
        return snap({ navigatedTo: product.value.name });
      }
      return toolError(
        `Nothing called "${to}". Aisles are: ${CATEGORY_IDS.join(', ')}. For a product, try shopping_search_products first.`,
      );
    },
  });

  // ----------------------------------------------------------------- buying

  registerTool({
    name: 'shopping_add_to_cart',
    description:
      'Put ONE product in the cart. This is the tool that makes the app move: it walks to the right aisle, scrolls the item to the middle of the screen and highlights it as it drops in, and it does not return until that has finished. `item` takes what the shopper called it ("mince", "lasagne sheets") as well as an id. Call it once per product — for a whole recipe, that is one call per ingredient, in the order you want the shopper to watch them go in. Adding something already in the cart adds to that line rather than making a second one.',
    inputSchema: {
      type: 'object',
      properties: {
        item: {
          type: 'string',
          description: 'A product id from `catalog`, or what the shopper called it.',
        },
        quantity: {
          type: 'integer',
          description: `How many units. Defaults to 1. At most ${MAX_QTY} of any one product.`,
        },
      },
      required: ['item'],
    },
    execute: async ({ item, quantity }: { item: string; quantity?: number }) => {
      const product = pick(item);
      if (isError(product)) return product;
      const q = quantity ?? 1;
      const result = await addWithAnimation(product.id, q);
      if (!result.ok) return toolError(explain(result));
      return snap({
        added: `${product.name} ×${q}`,
        aisle: CATEGORY_OF[product.id].name,
        nowInCart: store.quantityOf(product.id),
      });
    },
  });

  registerTool({
    name: 'shopping_update_quantity',
    description:
      'Set how many of something already in the cart — "make it two", "just one bag". Setting it to 0 removes the line. The item has to be in the cart already; to put it there, use shopping_add_to_cart.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'A product id, or what the shopper called it.' },
        quantity: { type: 'integer', description: `The new count, 0 to ${MAX_QTY}.` },
      },
      required: ['item', 'quantity'],
    },
    execute: async ({ item, quantity }: { item: string; quantity: number }) => {
      const product = pick(item);
      if (isError(product)) return product;
      const r = store.setQuantity(product.id, quantity);
      if (!r.ok) return toolError(explain(r));
      onChange();
      return snap({ updated: `${product.name} → ${quantity}` });
    },
  });

  registerTool({
    name: 'shopping_remove_from_cart',
    description: 'Take one product out of the cart entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'A product id, or what the shopper called it.' },
      },
      required: ['item'],
    },
    execute: async ({ item }: { item: string }) => {
      const product = pick(item);
      if (isError(product)) return product;
      const r = store.remove(product.id);
      if (!r.ok) return toolError(explain(r));
      onChange();
      return snap({ removed: product.name });
    },
  });

  registerTool({
    name: 'shopping_clear_cart',
    description:
      'Empty the cart completely. Destructive and not undoable — only when the shopper actually asks to start over.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
    execute: async () => {
      store.clear();
      onChange();
      return snap({ cleared: true });
    },
  });
}
