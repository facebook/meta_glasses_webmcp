/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The store. Pure data: no DOM, no tools, no prices computed here. Each row
// feeds both the page (name, unit, price, photo) and the tool surface (id,
// aliases, category, which is how a spoken phrase resolves).

export interface Product {
  /** Stable, spoken-friendly id. Used by every tool that takes an item. */
  id: string;
  name: string;
  /** What one unit of this is, shown under the name and in the cart. */
  unit: string;
  /** Price for one unit, in dollars. */
  price: number;
  /**
   * Extra phrases a shopper might say for this. Matching is fuzzy on the name
   * already; aliases carry the words the name does not contain at all
   * ("mince" for ground beef, "passata" for crushed tomatoes).
   */
  aliases?: string[];
}

export interface Category {
  id: string;
  name: string;
  /** id of the product whose photo represents the aisle on the home grid. */
  hero: string;
  products: Product[];
}

/** Sales tax applied to the cart subtotal. */
export const TAX_RATE = 0.086;

export const STORE_NAME = 'Local Market';

const p = (id: string, name: string, unit: string, price: number, aliases?: string[]): Product => ({
  id,
  name,
  unit,
  price,
  aliases,
});

/** A product's photo, served from `public/products/`. */
export const imageFor = (id: string) => `products/${id}.jpg`;

export const CATEGORIES: Category[] = [
  {
    id: 'fruit',
    name: 'Fruit',
    hero: 'strawberries',
    products: [
      p('bananas', 'Bananas', 'bunch of 5', 1.89),
      p('apples', 'Honeycrisp Apples', '3 lb bag', 4.49),
      p('strawberries', 'Strawberries', '1 lb', 4.99),
      p('lemons', 'Lemons', 'each', 0.79),
      p('avocados', 'Avocados', 'each', 1.49),
      p('oranges', 'Navel Oranges', '4 lb bag', 5.49),
      p('blueberries', 'Blueberries', 'pint', 3.99),
    ],
  },
  {
    id: 'vegetables',
    name: 'Vegetables',
    hero: 'tomatoes',
    products: [
      p('onions', 'Yellow Onions', '3 lb bag', 2.99, ['onion']),
      p('garlic', 'Garlic', 'head', 0.89),
      p('tomatoes', 'Roma Tomatoes', 'lb', 2.49, ['plum tomato']),
      p('carrots', 'Carrots', '2 lb bag', 1.99),
      p('spinach', 'Baby Spinach', '5 oz', 3.49),
      p('broccoli', 'Broccoli Crowns', 'each', 2.29),
      p('mushrooms', 'Cremini Mushrooms', '8 oz', 2.99),
      p('basil', 'Fresh Basil', 'bunch', 2.99),
    ],
  },
  {
    id: 'meat',
    name: 'Meat & Seafood',
    hero: 'ground-beef',
    products: [
      p('ground-beef', 'Ground Beef', '1 lb, 80/20', 7.99, ['mince', 'hamburger meat', 'minced beef']),
      p('italian-sausage', 'Italian Sausage', '1 lb', 6.49),
      p('chicken-breast', 'Chicken Breast', '2 lb', 9.99),
      p('salmon', 'Atlantic Salmon', 'lb', 13.99),
      p('bacon', 'Thick-Cut Bacon', '12 oz', 7.49),
      p('ground-turkey', 'Ground Turkey', '1 lb', 6.99),
    ],
  },
  {
    id: 'dairy',
    name: 'Dairy & Eggs',
    hero: 'mozzarella',
    products: [
      p('milk', 'Whole Milk', 'gallon', 3.79),
      p('eggs', 'Large Eggs', 'dozen', 4.29),
      p('butter', 'Unsalted Butter', '1 lb', 5.49),
      p('ricotta', 'Whole-Milk Ricotta', '15 oz', 4.49, ['ricotta cheese']),
      p('mozzarella', 'Shredded Mozzarella', '16 oz', 5.99, ['mozzarella cheese', 'shredded cheese']),
      p('parmesan', 'Parmigiano-Reggiano', '8 oz', 8.99, ['parmesan cheese', 'parmigiano']),
      p('yogurt', 'Greek Yogurt', '32 oz', 5.99),
    ],
  },
  {
    id: 'pantry',
    name: 'Pantry',
    hero: 'lasagna-noodles',
    products: [
      p('lasagna-noodles', 'Lasagna Noodles', '1 lb box', 2.49, [
        'lasagne sheets',
        'lasagna pasta',
        'pasta sheets',
      ]),
      p('spaghetti', 'Spaghetti', '1 lb box', 1.99),
      p('crushed-tomatoes', 'Crushed Tomatoes', '28 oz can', 2.29, [
        'tomato sauce',
        'passata',
        'tinned tomatoes',
        'canned tomatoes',
      ]),
      p('olive-oil', 'Extra-Virgin Olive Oil', '16.9 oz', 11.99),
      p('flour', 'All-Purpose Flour', '5 lb', 3.49),
      p('rice', 'Jasmine Rice', '5 lb', 6.99),
      p('black-beans', 'Black Beans', '15 oz can', 1.29),
      p('chicken-stock', 'Chicken Stock', '32 oz', 3.29, ['chicken broth', 'stock']),
    ],
  },
  {
    id: 'bakery',
    name: 'Bakery',
    hero: 'sourdough',
    products: [
      p('sourdough', 'Sourdough Loaf', 'each', 5.49, ['bread']),
      p('baguette', 'Baguette', 'each', 3.29),
      p('bagels', 'Everything Bagels', '6 pack', 4.99),
      p('ciabatta', 'Ciabatta Rolls', '4 pack', 4.49),
    ],
  },
];

export const ALL_PRODUCTS: Product[] = CATEGORIES.flatMap((c) => c.products);

export const CATEGORY_OF: Record<string, Category> = Object.fromEntries(
  CATEGORIES.flatMap((c) => c.products.map((prod) => [prod.id, c] as const)),
);

export const PRODUCT_BY_ID: Record<string, Product> = Object.fromEntries(
  ALL_PRODUCTS.map((prod) => [prod.id, prod] as const),
);

export const CATEGORY_BY_ID: Record<string, Category> = Object.fromEntries(CATEGORIES.map((c) => [c.id, c] as const));
