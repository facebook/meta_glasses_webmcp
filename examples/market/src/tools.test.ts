/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ALL_PRODUCTS, CATEGORIES, imageFor } from './catalog.ts';
import { Store, resolveProduct } from './engine.ts';
import { hashToRoute, routeToHash, type Route, type View } from './state.ts';
import { registerTools } from './tools.ts';
import { clearTools, executeTool, getTools } from './webmcp.ts';

const LASAGNA = ['lasagna-noodles', 'ground-beef', 'crushed-tomatoes', 'ricotta', 'mozzarella'];

interface Answer {
  ok: boolean;
  text: string;
  json: any;
}

/** A live store with its tools registered; the add commits without animating. */
function host() {
  const store = new Store();
  const view: View = { route: { kind: 'home' }, animating: false };
  const adds: string[] = [];
  registerTools({
    store,
    view,
    onChange: () => {},
    go: (route: Route) => {
      view.route = route;
    },
    addWithAnimation: async (id, quantity) => {
      adds.push(id);
      view.route = { kind: 'category', id: CATEGORIES.find((c) => c.products.some((p) => p.id === id))!.id };
      return store.add(id, quantity);
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Answer> => {
    const raw = await executeTool(name, args);
    if (typeof raw === 'string') return { ok: true, text: raw, json: JSON.parse(raw) };
    const failure = raw as { content: Array<{ text: string }> };
    return { ok: false, text: failure.content[0].text, json: null };
  };
  return { store, view, adds, call };
}

beforeEach(() => {
  clearTools();
});

describe('registration', () => {
  it('registers ten shopping_ tools, read-only state first, no batch add', () => {
    host();
    const names = getTools().map((t) => t.name);
    expect(names).toHaveLength(10);
    expect(names[0]).toBe('shopping_get_state');
    expect(names.every((n) => n.startsWith('shopping_'))).toBe(true);
    expect(names.some((n) => /add_many|add_all|add_items/.test(n))).toBe(false);
    expect(getTools().every((t) => t.description.length > 40 && t.inputSchema.type === 'object')).toBe(true);
  });

// Node has no document, so the fake host context is installed for one call.
function withDocument(document: unknown, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  try {
    run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else delete (globalThis as Record<string, unknown>).document;
  }
}

  it('publishes tools to document.modelContext', async () => {
    const registered = new Map<string, { execute: (args: unknown) => unknown | Promise<unknown> }>();
    const document = {
      modelContext: {
        registerTool: (tool: { name: string; execute: (args: unknown) => unknown | Promise<unknown> }) => {
          registered.set(tool.name, tool);
        },
        unregisterTool: (name: string) => {
          registered.delete(name);
        },
      },
    };
    withDocument(document, () => {
      host();
    });
    expect(registered.size).toBe(10);
    expect([...registered.keys()][0]).toBe('shopping_get_state');
    const state = JSON.parse((await registered.get('shopping_get_state')!.execute({})) as string);
    expect(state.store).toBe('Local Market');
  });
});

describe('catalogue', () => {
  it('has 40 unique products across six aisles, each hero its own', () => {
    const ids = ALL_PRODUCTS.map((p) => p.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(CATEGORIES).toHaveLength(6);
    expect(CATEGORIES.every((c) => c.products.some((p) => p.id === c.hero))).toBe(true);
    expect(ALL_PRODUCTS.every((p) => p.unit && p.price > 0)).toBe(true);
    const photos = Object.keys(import.meta.glob('../public/products/*.jpg'));
    expect(ALL_PRODUCTS.filter((p) => !photos.includes(`../public/${imageFor(p.id)}`)).map((p) => p.id)).toEqual([]);
    expect(LASAGNA.every((id) => ids.includes(id))).toBe(true);
  });

  it.each([
    ['mince', 'ground-beef'],
    ['minced beef', 'ground-beef'],
    ['lasagne sheets', 'lasagna-noodles'],
    ['lasagna noodles', 'lasagna-noodles'],
    ['tinned tomatoes', 'crushed-tomatoes'],
    ['ricotta cheese', 'ricotta'],
    ['shredded mozzarella', 'mozzarella'],
    ['parmesan', 'parmesan'],
    ['onion', 'onions'],
    ['tomatoes', 'tomatoes'],
    ['eggs', 'eggs'],
    ['chicken broth', 'chicken-stock'],
    ['motor oil', 'olive-oil'],
  ])('resolves "%s" to %s', (phrase, id) => {
    const r = resolveProduct(phrase);
    expect(r.ok && r.value.id).toBe(id);
  });

  it('fails an unstocked item with a hint naming the way out', () => {
    const r = resolveProduct('batteries');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.hint).toMatch(/shopping_search_products|shopping_browse_categories/);
  });
});

describe('tools', () => {
  it('opens on the aisle grid with an empty cart and the whole catalog', async () => {
    const { call } = host();
    const s = (await call('shopping_get_state')).json;
    expect(s.screen.view).toBe('home');
    expect(s.cart.empty).toBe(true);
    expect(s.totals.subtotal).toBe('$0.00');
    expect(Object.keys(s.catalog)).toHaveLength(6);
    expect(Object.values(s.catalog).flat()).toHaveLength(40);
  });

  it('searches and browses', async () => {
    const { call } = host();
    const search = (await call('shopping_search_products', { query: 'cheese' })).json;
    expect(search.matches.length).toBeGreaterThanOrEqual(2);
    expect(
      search.matches.every(
        (m: { id: string; price: string; aisle: string }) => m.id && m.price.startsWith('$') && m.aisle,
      ),
    ).toBe(true);
    const pantry = (await call('shopping_browse_categories', { category: 'pantry' })).json;
    expect(pantry.aisles).toHaveLength(1);
    expect(pantry.aisles[0].products).toHaveLength(8);
    const bad = await call('shopping_browse_categories', { category: 'hardware' });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/pantry/);
  });

  it('navigates', async () => {
    const { call } = host();
    expect((await call('shopping_navigate', { to: 'cart' })).json.screen.view).toBe('cart');
    expect((await call('shopping_navigate', { to: 'Dairy & Eggs' })).json.screen.view).toBe('category');
    expect((await call('shopping_navigate', { to: 'ricotta' })).json.screen.view).toBe('product');
    expect((await call('shopping_navigate', { to: 'aisles' })).json.screen.view).toBe('home');
    expect((await call('shopping_navigate', { to: 'the moon' })).ok).toBe(false);
  });

  it('turns five spoken items into five lines and a total', async () => {
    const { call, adds, view } = host();
    for (const [item, quantity] of [
      ['lasagne sheets', 1],
      ['mince', 1],
      ['tinned tomatoes', 2],
      ['ricotta', 1],
      ['shredded mozzarella', 1],
    ] as const) {
      expect((await call('shopping_add_to_cart', { item, quantity })).ok).toBe(true);
    }
    expect(adds).toEqual(LASAGNA);
    expect(view.route).toEqual({ kind: 'category', id: 'dairy' });

    const cart = (await call('shopping_view_cart')).json;
    expect(cart.itemCount).toBe(5);
    expect(cart.unitCount).toBe(6);
    expect(cart.subtotal).toBe('$25.54');
    expect(cart.tax).toBe('$2.20');
    expect(cart.taxRate).toBe('8.6%');
    expect(cart.total).toBe('$27.74');
    expect(cart.lines.find((l: { id: string }) => l.id === 'crushed-tomatoes').lineTotal).toBe('$4.58');
  });

  it('edits, caps, merges and clears', async () => {
    const { call, store } = host();
    await call('shopping_add_to_cart', { item: 'ricotta' });
    await call('shopping_add_to_cart', { item: 'tinned tomatoes', quantity: 2 });

    expect((await call('shopping_update_quantity', { item: 'tinned tomatoes', quantity: 3 })).json.totals.units).toBe(
      4,
    );

    const notInCart = await call('shopping_update_quantity', { item: 'bananas', quantity: 2 });
    expect(notInCart.ok).toBe(false);
    expect(notInCart.text).toMatch(/not in the cart/);

    const overCap = await call('shopping_add_to_cart', { item: 'ricotta', quantity: 99 });
    expect(overCap.ok).toBe(false);
    expect(overCap.text).toMatch(/limited to 12/);
    expect(store.quantityOf('ricotta')).toBe(1);

    await call('shopping_add_to_cart', { item: 'ricotta' });
    expect(store.lineCount()).toBe(2);
    expect(store.quantityOf('ricotta')).toBe(2);

    expect((await call('shopping_update_quantity', { item: 'ricotta', quantity: 0 })).json.totals.lines).toBe(1);
    expect((await call('shopping_remove_from_cart', { item: 'tinned tomatoes' })).json.totals.lines).toBe(0);
    expect((await call('shopping_remove_from_cart', { item: 'tinned tomatoes' })).ok).toBe(false);

    await call('shopping_add_to_cart', { item: 'garlic', quantity: 3 });
    const totals = (await call('shopping_get_state')).json.totals;
    expect([totals.subtotal, totals.tax, totals.total]).toEqual(['$2.67', '$0.23', '$2.90']);

    expect((await call('shopping_clear_cart')).json.totals.lines).toBe(0);
  });

  it('refuses a missing required input before the handler runs', async () => {
    const { call } = host();
    const r = await call('shopping_add_to_cart', {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/missing required input: item/);
  });
});

describe('routing', () => {
  it.each<Route>([
    { kind: 'home' },
    { kind: 'cart' },
    { kind: 'category', id: 'pantry' },
    { kind: 'product', id: 'ricotta' },
  ])('round-trips %o', (route) => {
    expect(hashToRoute(routeToHash(route))).toEqual(route);
  });

  it('falls back home on an unknown hash', () => {
    expect(hashToRoute('#/category/nonsense').kind).toBe('home');
  });
});
