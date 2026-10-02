/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The snapshot every tool returns, plus the route type the page and the tools
// share. One shape, one source: what the shopper sees and what the agent is
// told can never disagree.

import { CATEGORIES, CATEGORY_BY_ID, CATEGORY_OF, PRODUCT_BY_ID, STORE_NAME, type Product } from './catalog.ts';
import { MAX_QTY, type Store } from './engine.ts';

export type Route =
  { kind: 'home' } | { kind: 'category'; id: string } | { kind: 'product'; id: string } | { kind: 'cart' };

/** Presentation state, owned by main.ts and shared by the page and the tools. */
export interface View {
  route: Route;
  /**
   * Set while a tile is mid-highlight. The renderer owns it; focus handling
   * reads it so the focus ring never competes with the pulse.
   */
  animating: boolean;
}

export const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ------------------------------------------------------------------- routing

export function routeToHash(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '#/';
    case 'category':
      return `#/category/${route.id}`;
    case 'product':
      return `#/product/${route.id}`;
    case 'cart':
      return '#/cart';
  }
}

export function hashToRoute(hash: string): Route {
  const parts = (hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'category' && CATEGORY_BY_ID[parts[1]]) return { kind: 'category', id: parts[1] };
  if (parts[0] === 'product' && PRODUCT_BY_ID[parts[1]]) return { kind: 'product', id: parts[1] };
  if (parts[0] === 'cart') return { kind: 'cart' };
  return { kind: 'home' };
}

/** Human-readable description of what is on the screen right now. */
export function screenOf(route: Route): { view: Route['kind']; title: string; showing: string } {
  switch (route.kind) {
    case 'home':
      return { view: 'home', title: STORE_NAME, showing: 'the aisle grid, all six categories' };
    case 'category': {
      const c = CATEGORY_BY_ID[route.id];
      return { view: 'category', title: c.name, showing: `${c.products.length} products in ${c.name}` };
    }
    case 'product': {
      const p = PRODUCT_BY_ID[route.id];
      return { view: 'product', title: p.name, showing: `the ${p.name} product page` };
    }
    case 'cart':
      return { view: 'cart', title: 'Your cart', showing: 'the cart, with the running total' };
  }
}

// ------------------------------------------------------------------ snapshot

export interface Snapshot {
  store: string;
  screen: ReturnType<typeof screenOf>;
  /**
   * Every product id in the store, grouped by category. In the snapshot rather
   * than behind a second tool: an agent asked for "everything for lasagna"
   * needs to know what is stocked before it can add anything, and ids-only
   * keeps that under a kilobyte.
   */
  catalog: Record<string, string[]>;
  cart: {
    lines: Array<{
      id: string;
      name: string;
      unit: string;
      quantity: number;
      unitPrice: number;
      lineTotal: number;
    }>;
    empty: boolean;
  };
  totals: {
    lines: number;
    units: number;
    subtotal: string;
    tax: string;
    taxRate: string;
    total: string;
  };
  limits: { maxPerItem: number };
  actions: string[];
}

export function snapshot(store: Store, view: View): Snapshot {
  const t = store.totals();
  const lines = store.lines();

  const actions = ['get_state', 'browse_categories', 'search_products', 'get_product', 'navigate', 'add_to_cart'];
  if (lines.length) actions.push('view_cart', 'update_quantity', 'remove_from_cart', 'clear_cart');

  return {
    store: STORE_NAME,
    screen: screenOf(view.route),
    catalog: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.products.map((p) => p.id)])),
    cart: {
      lines: lines.map((l) => ({
        id: l.product.id,
        name: l.product.name,
        unit: l.product.unit,
        quantity: l.quantity,
        unitPrice: l.product.price,
        lineTotal: l.lineTotal,
      })),
      empty: lines.length === 0,
    },
    totals: {
      lines: t.lines,
      units: t.units,
      subtotal: money(t.subtotal),
      tax: money(t.tax),
      taxRate: `${(t.taxRate * 100).toFixed(1)}%`,
      total: money(t.total),
    },
    limits: { maxPerItem: MAX_QTY },
    actions,
  };
}

/** The detail view of one product, shared by shopping_get_product and the page. */
export function productDetail(product: Product, store: Store) {
  return {
    id: product.id,
    name: product.name,
    unit: product.unit,
    price: money(product.price),
    category: CATEGORY_OF[product.id].name,
    categoryId: CATEGORY_OF[product.id].id,
    inCart: store.quantityOf(product.id),
  };
}
