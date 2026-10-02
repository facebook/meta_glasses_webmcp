/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The store logic. Pure: no DOM, no tools, no timers, no localStorage.
//
// Everything the page and the tools do to the cart goes through this one class,
// so a tap on a quantity stepper and a spoken "make it two" cannot drift apart.
// Expected failures come back as a `Result` with the valid alternatives named;
// nothing in here throws for a shopper's mistake.

import {
  ALL_PRODUCTS,
  CATEGORIES,
  CATEGORY_BY_ID,
  CATEGORY_OF,
  PRODUCT_BY_ID,
  TAX_RATE,
  type Category,
  type Product,
} from './catalog.ts';

export const MAX_QTY = 12;

export type Result<T = void> =
  | ({ ok: true } & (T extends void ? { value?: undefined } : { value: T }))
  | { ok: false; error: string; hint?: string; choices?: string[] };

const fail = (error: string, extra: { hint?: string; choices?: string[] } = {}): Result<never> => ({
  ok: false,
  error,
  ...extra,
});

export interface CartLine {
  product: Product;
  category: Category;
  quantity: number;
  /** price × quantity, rounded to cents. */
  lineTotal: number;
}

export interface Totals {
  /** Number of cart LINES, which is what "5 items in the cart" means on screen. */
  lines: number;
  /** Number of physical units, i.e. quantities summed. */
  units: number;
  subtotal: number;
  taxRate: number;
  tax: number;
  total: number;
}

// ------------------------------------------------------------------ matching

const cents = (n: number) => Math.round(n * 100) / 100;

const norm = (s: string) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Crude de-pluralisation, enough for "tomatoes" → "tomato", "eggs" → "egg". */
const singular = (s: string) =>
  norm(s)
    .replace(/\b(\w+?)ies\b/g, '$1y')
    .replace(/\b(\w+?[^aeiou])oes\b/g, '$1o')
    .replace(/\b(\w{3,}?)s\b/g, '$1');

/**
 * Token-overlap F1 with bonuses for an exact or contained phrase. Good enough
 * that "mince", "ricotta cheese" and "lasagne sheets" all land, and simple
 * enough that a wrong answer is obvious to debug.
 */
export function matchScore(query: string, candidate: string): number {
  const qs = singular(query);
  const cs = singular(candidate);
  const q = qs.split(' ').filter(Boolean);
  const c = cs.split(' ').filter(Boolean);
  if (!q.length || !c.length) return 0;

  const inCandidate = new Set(c);
  const matched = q.filter((t) => inCandidate.has(t)).length;
  if (!matched) return 0;

  const precision = matched / q.length;
  const recall = matched / c.length;
  let score = (2 * precision * recall) / (precision + recall);
  if (cs === qs) score += 1;
  else if (cs.includes(qs)) score += 0.25;
  return score;
}

/** Best score for a product across its name, its id and every alias. */
function productScore(query: string, product: Product): number {
  const phrases = [product.name, product.id.replace(/-/g, ' '), ...(product.aliases ?? [])];
  return Math.max(...phrases.map((phrase) => matchScore(query, phrase)));
}

export interface Ranked {
  id: string;
  name: string;
  unit: string;
  price: number;
  category: string;
  score: number;
}

export function rankProducts(query: string, limit = 6): Ranked[] {
  return ALL_PRODUCTS.map((product) => ({
    id: product.id,
    name: product.name,
    unit: product.unit,
    price: product.price,
    category: CATEGORY_OF[product.id].name,
    score: productScore(query, product),
  }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Resolve a spoken phrase, an id, or a name to exactly one product.
 *
 * An exact id always wins: the agent gets ids back from every read tool, and
 * an id that silently fuzzy-matched something else would be maddening.
 */
export function resolveProduct(query: string): Result<Product> {
  const raw = String(query ?? '').trim();
  if (!raw) return fail('No item given.', { hint: 'Pass `item` as a product name or id.' });
  if (PRODUCT_BY_ID[raw]) return { ok: true, value: PRODUCT_BY_ID[raw] };

  const ranked = rankProducts(raw, 4);
  if (!ranked.length) {
    return fail(`Nothing in the store matches "${raw}".`, {
      hint: 'Call shopping_search_products with a broader word, or shopping_browse_categories to see what the store stocks.',
    });
  }
  return { ok: true, value: PRODUCT_BY_ID[ranked[0].id] };
}

/** Resolve a category by id or name. */
export function resolveCategory(query: string): Result<Category> {
  const raw = String(query ?? '').trim();
  if (!raw) return fail('No category given.');
  if (CATEGORY_BY_ID[raw]) return { ok: true, value: CATEGORY_BY_ID[raw] };
  const scored = CATEGORIES.map((c) => ({ c, s: matchScore(raw, c.name) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
  if (!scored.length) {
    return fail(`No category called "${raw}".`, { choices: CATEGORIES.map((c) => c.id) });
  }
  return { ok: true, value: scored[0].c };
}

// --------------------------------------------------------------------- store

export class Store {
  /** Insertion-ordered: the cart reads top-to-bottom in the order things were added. */
  private items = new Map<string, number>();

  lines(): CartLine[] {
    return [...this.items].map(([id, quantity]) => {
      const product = PRODUCT_BY_ID[id];
      return {
        product,
        category: CATEGORY_OF[id],
        quantity,
        lineTotal: cents(product.price * quantity),
      };
    });
  }

  lineCount(): number {
    return this.items.size;
  }

  unitCount(): number {
    return [...this.items.values()].reduce((a, b) => a + b, 0);
  }

  quantityOf(id: string): number {
    return this.items.get(id) ?? 0;
  }

  totals(): Totals {
    const subtotal = cents(this.lines().reduce((sum, l) => sum + l.lineTotal, 0));
    const tax = cents(subtotal * TAX_RATE);
    return {
      lines: this.items.size,
      units: this.unitCount(),
      subtotal,
      taxRate: TAX_RATE,
      tax,
      total: cents(subtotal + tax),
    };
  }

  /**
   * Add `quantity` more of a product. Adding something already in the cart
   * increases its line rather than creating a second one, which keeps "add two
   * cans of tomatoes" and two separate "add tomatoes" turns identical.
   */
  add(id: string, quantity = 1): Result<CartLine> {
    const product = PRODUCT_BY_ID[id];
    if (!product) return fail(`No product with id "${id}".`);

    const q = Math.round(Number(quantity));
    if (!Number.isFinite(q) || q < 1) {
      return fail(`Quantity must be a whole number of at least 1, not ${quantity}.`);
    }

    const next = this.quantityOf(id) + q;
    if (next > MAX_QTY) {
      return fail(
        `${product.name} is limited to ${MAX_QTY} per order and the cart already has ${this.quantityOf(id)}.`,
        { hint: `Add at most ${MAX_QTY - this.quantityOf(id)} more.` },
      );
    }

    this.items.set(id, next);
    return { ok: true, value: this.lineFor(id) };
  }

  setQuantity(id: string, quantity: number): Result<CartLine | null> {
    if (!PRODUCT_BY_ID[id]) return fail(`No product with id "${id}".`);
    if (!this.items.has(id)) {
      return fail(`${PRODUCT_BY_ID[id].name} is not in the cart.`, {
        hint: 'Use shopping_add_to_cart to put it there first.',
        choices: this.lines().map((l) => l.product.id),
      });
    }
    const q = Math.round(Number(quantity));
    if (!Number.isFinite(q) || q < 0) return fail(`Quantity must be 0 or more, not ${quantity}.`);
    if (q > MAX_QTY) return fail(`${PRODUCT_BY_ID[id].name} is limited to ${MAX_QTY} per order.`);
    if (q === 0) {
      this.items.delete(id);
      return { ok: true, value: null };
    }
    this.items.set(id, q);
    return { ok: true, value: this.lineFor(id) };
  }

  remove(id: string): Result<Product> {
    const product = PRODUCT_BY_ID[id];
    if (!product) return fail(`No product with id "${id}".`);
    if (!this.items.delete(id)) {
      return fail(`${product.name} is not in the cart.`, {
        choices: this.lines().map((l) => l.product.id),
      });
    }
    return { ok: true, value: product };
  }

  clear(): void {
    this.items.clear();
  }

  private lineFor(id: string): CartLine {
    return this.lines().find((l) => l.product.id === id)!;
  }
}
