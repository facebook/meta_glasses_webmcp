/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The screen. Every control here maps 1:1 to a tool, and the agent's add goes
// through the SAME `showAndPulse` the on-page Add buttons use, so there is no
// agent-only code path.
//
// The one thing this file owns that the engine does not: TIME. Navigating to a
// category, scrolling the tile to the middle of the 600×600 frame and pulsing
// it only read as deliberate if their durations are fixed rather than left to
// `scrollIntoView`'s discretion.

import { ALL_PRODUCTS, CATEGORIES, CATEGORY_BY_ID, CATEGORY_OF, PRODUCT_BY_ID, STORE_NAME, imageFor, type Product } from './catalog.ts';
import type { CartLine, Store } from './engine.ts';
import { money, routeToHash, type Route, type View } from './state.ts';

/** Beats, in ms, tuned against the 600×600 frame. */
const SCROLL_MS = 420;
const SETTLE_MS = 90;
/** How far into the pulse the cart actually changes, so the badge pops mid-flare. */
const COMMIT_AT_MS = 260;
const PULSE_MS = 900;

export interface Handlers {
  navigate(route: Route): void;
  add(id: string, quantity: number): void;
  setQuantity(id: string, quantity: number): void;
  remove(id: string): void;
  clear(): void;
}

const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const CART_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2.2l2.1 10.4a1.6 1.6 0 0 0 1.6 1.3h7.9a1.6 1.6 0 0 0 1.6-1.2L20 7H6"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>`;

// A leaf, not an emoji: the glasses browser ships no colour emoji font, so an
// emoji in the header would render as nothing at all on device.
const LEAF_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c0 9-5.5 14-12 14-1.2 0-2.3-.2-3.3-.5C6 12 11 8 17 7c-5 .4-9.4 3-11.6 7.6C4 12 5 7.6 9.5 5.6 13 4 17 5 20 4Z" fill="currentColor"/><path d="M4 21c1-3.4 2.6-6 4.6-8" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/></svg>`;

/** Ease-in-out cubic, the same curve the CSS pulse uses, so the two feel related. */
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** A product photo. Decorative copies pass an empty alt so the name is not read twice. */
const photo = (id: string, alt: string) =>
  `<img src="${imageFor(id)}" alt="${esc(alt)}" width="210" height="210" decoding="async" />`;

export function createRenderer(store: Store, view: View, handlers: Handlers) {
  const device = document.getElementById('device') as HTMLElement;
  const main = document.getElementById('app') as HTMLElement;
  const chrome = document.getElementById('chrome') as HTMLElement;

  /**
   * Built view roots, keyed by route hash, kept alive for the life of the page.
   *
   * Rebuilding the screen on every render replayed every entrance animation
   * and flashed a frame of empty cards, which reads as flicker when an agent
   * fires tool calls back to back. Each route is built once; a revisit is an
   * `appendChild` of nodes already laid out, plus syncing what changed.
   */
  const viewCache = new Map<string, HTMLElement>();
  let currentRoot: HTMLElement | null = null;

  /** Parse an HTML string into its single root element. */
  const el = (html: string): HTMLElement => {
    const holder = document.createElement('div');
    holder.innerHTML = html.trim();
    return holder.firstElementChild as HTMLElement;
  };

  // ------------------------------------------------------------- primitives

  /** Scroll `device` so `el` sits in the middle, over a duration we control. */
  function scrollToCentre(el: HTMLElement, ms = SCROLL_MS): Promise<void> {
    const target = Math.max(
      0,
      Math.min(el.offsetTop - (device.clientHeight - el.offsetHeight) / 2, device.scrollHeight - device.clientHeight),
    );
    const from = device.scrollTop;
    const delta = target - from;
    if (Math.abs(delta) < 2) return Promise.resolve();

    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        device.scrollTop = from + delta * ease(t);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // Scanned rather than selected, so no attribute-value escaping is needed.
  function tileIn(root: ParentNode, id: string): HTMLElement | null {
    for (const node of root.querySelectorAll<HTMLElement>('[data-product]')) {
      if (node.dataset.product === id) return node;
    }
    return null;
  }

  const tileFor = (id: string) => tileIn(main, id);

  /**
   * Repaint just the header badge, used mid-animation, when a full render
   * would tear down the very element that is pulsing.
   *
   * Looked up on each call, never cached: a reference held across a repaint
   * can point at a detached node.
   */
  function syncBadge(pop = false) {
    const badge = chrome.querySelector<HTMLElement>('#cart-count');
    if (!badge) return;
    const n = store.unitCount();
    badge.textContent = String(n);
    badge.closest('.cart-pill')?.classList.toggle('has-items', n > 0);
    if (!pop) return;
    badge.classList.remove('pop');
    void badge.offsetWidth;
    badge.classList.add('pop');
  }

  /** Repaint just one tile's in-cart chip, for the same reason. */
  function syncTileIn(root: ParentNode, id: string) {
    const tile = tileIn(root, id);
    if (!tile) return;
    const qty = store.quantityOf(id);
    let chip = tile.querySelector<HTMLElement>('.in-cart');
    if (qty <= 0) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'in-cart';
      tile.querySelector('.shot')?.appendChild(chip);
    }
    chip.textContent = `${qty} in cart`;
  }

  const syncTile = (id: string) => syncTileIn(main, id);

  /**
   * The add beat, for the agent and the on-page Add button alike.
   *
   * Navigate to the product's aisle → scroll its tile to the middle of the
   * frame → pulse it, committing the cart change partway through so the badge
   * pops inside the flare rather than after it. Resolves only once the tile has
   * stopped moving, which is what lets a tool await it.
   */
  async function showAndPulse(id: string, commit: () => void): Promise<void> {
    const product = PRODUCT_BY_ID[id];
    if (!product) {
      commit();
      return;
    }

    view.animating = true;
    try {
      const aisle = CATEGORY_OF[id];
      if (view.route.kind !== 'category' || view.route.id !== aisle.id) {
        handlers.navigate({ kind: 'category', id: aisle.id });
        await nextFrame();
        await nextFrame();
      }

      const tile = tileFor(id);
      if (tile) {
        await scrollToCentre(tile);
        await sleep(SETTLE_MS);
        // See `.enter` in style.css: leaving it on would replay the entrance
        // animation the moment `.adding` comes back off.
        tile.classList.remove('enter', 'adding');
        void tile.offsetWidth;
        tile.classList.add('adding');
      }

      await sleep(COMMIT_AT_MS);
      commit();
      syncBadge(true);
      syncTile(id);

      await sleep(PULSE_MS - COMMIT_AT_MS);
      tile?.classList.remove('adding');
    } finally {
      view.animating = false;
    }
  }

  // ------------------------------------------------------------------ views

  function header(): string {
    const n = store.unitCount();
    // The wordmark is out of the focus order: as the first focusable node it
    // would put the ring on a link to the screen you are already on. Skipping
    // it starts the ring on the first aisle, one step from the cart.
    return `
      <a class="brand" href="#/" tabindex="-1">
        <span class="mark">${LEAF_MARK}</span>
        <span class="wordmark">${esc(STORE_NAME)}</span>
      </a>
      <a class="cart-pill${n > 0 ? ' has-items' : ''}" href="#/cart" aria-label="Cart">
        ${CART_ICON}<span id="cart-count" class="badge">${n}</span>
      </a>`;
  }

  function crumbs(trail: Array<{ label: string; href?: string }>): string {
    return `<nav class="crumbs">${trail
      .map(
        (c, i) =>
          (i ? '<span class="sep">›</span>' : '') +
          (c.href ? `<a href="${c.href}">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`),
      )
      .join('')}</nav>`;
  }

  function productTile(product: Product): string {
    const qty = store.quantityOf(product.id);
    return `
      <article class="tile" data-product="${esc(product.id)}">
        <a class="shot" href="${routeToHash({ kind: 'product', id: product.id })}" aria-label="${esc(product.name)}">
          ${photo(product.id, product.name)}
          ${qty ? `<span class="in-cart">${qty} in cart</span>` : ''}
        </a>
        <h3>${esc(product.name)}</h3>
        <p class="unit">${esc(product.unit)}</p>
        <div class="buy">
          <span class="price">${money(product.price)}</span>
          <button type="button" class="add" data-add="${esc(product.id)}" aria-label="Add ${esc(product.name)}">Add</button>
        </div>
      </article>`;
  }

  function viewHome(): string {
    return `
      ${crumbs([{ label: 'Aisles' }])}
      <h1 class="visually-hidden">Aisles</h1>
      <div class="aisles">
        ${CATEGORIES.map(
          (c) => `
          <a class="aisle" href="${routeToHash({ kind: 'category', id: c.id })}">
            <span class="shot">${photo(PRODUCT_BY_ID[c.hero].id, '')}</span>
            <span class="aisle-name">${esc(c.name)}</span>
            <span class="aisle-count">${c.products.length} items</span>
          </a>`,
        ).join('')}
      </div>`;
  }

  function viewCategory(id: string): string {
    const c = CATEGORY_BY_ID[id];
    return `
      ${crumbs([{ label: 'Aisles', href: '#/' }, { label: c.name }])}
      <h1 class="visually-hidden">${esc(c.name)}</h1>
      <div class="grid">${c.products.map(productTile).join('')}</div>`;
  }

  function viewProduct(id: string): string {
    const product = PRODUCT_BY_ID[id];
    const c = CATEGORY_OF[id];
    const qty = store.quantityOf(id);
    return `
      ${crumbs([
        { label: 'Aisles', href: '#/' },
        { label: c.name, href: routeToHash({ kind: 'category', id: c.id }) },
        { label: product.name },
      ])}
      <div class="detail" data-product="${esc(product.id)}">
        <div class="shot">
          ${photo(product.id, product.name)}
          ${qty ? `<span class="in-cart">${qty} in cart</span>` : ''}
        </div>
        <div class="detail-body">
          <h1>${esc(product.name)}</h1>
          <p class="unit">${esc(product.unit)} · ${esc(c.name)}</p>
          <p class="price big">${money(product.price)}</p>
          <button type="button" class="add primary" data-add="${esc(product.id)}">
            ${qty ? 'Add another' : 'Add to cart'}
          </button>
        </div>
      </div>`;
  }

  function stepper(id: string, qty: number): string {
    return `
      <span class="stepper">
        <button type="button" data-step="${esc(id)}" data-dir="-1" aria-label="One fewer">−</button>
        <span class="qty">${qty}</span>
        <button type="button" data-step="${esc(id)}" data-dir="1" aria-label="One more">+</button>
      </span>`;
  }

  /** One cart row. Split out so syncCart can mint a new one without a rebuild. */
  function cartLine(l: CartLine): string {
    return `
      <li class="cart-line" data-product="${esc(l.product.id)}">
        <span class="thumb">${photo(l.product.id, '')}</span>
        <span class="cart-info">
          <span class="cart-name">${esc(l.product.name)}</span>
          <span class="cart-unit">${esc(l.product.unit)} · ${money(l.product.price)}</span>
        </span>
        ${stepper(l.product.id, l.quantity)}
        <span class="cart-total">${money(l.lineTotal)}</span>
      </li>`;
  }

  function viewCart(): string {
    const lines = store.lines();
    if (!lines.length) {
      return `
        ${crumbs([{ label: 'Aisles', href: '#/' }, { label: 'Cart' }])}
        <div class="empty">
          <span class="empty-mark">${CART_ICON}</span>
          <h1>Your cart is empty</h1>
          <p>Ask for what you are cooking and it will fill itself.</p>
          <a class="add primary" href="#/">Browse the aisles</a>
        </div>`;
    }
    const t = store.totals();
    // Compact on purpose: five lines plus the whole total block have to fit
    // inside 600×600 with nothing scrolled out of frame.
    return `
      ${crumbs([{ label: 'Aisles', href: '#/' }, { label: 'Cart' }])}
      <h1 class="cart-title">Your cart <span class="cart-sub">${t.lines} item${t.lines === 1 ? '' : 's'} · ${t.units} unit${t.units === 1 ? '' : 's'}</span></h1>
      <ul class="cart-lines">${lines.map(cartLine).join('')}</ul>
      <div class="summary">
        <div class="row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
        <div class="row"><span>Estimated tax (${(t.taxRate * 100).toFixed(1)}%)</span><span>${money(t.tax)}</span></div>
        <div class="row grand"><span>Total</span><span>${money(t.total)}</span></div>
      </div>
      <button type="button" class="add primary block" id="checkout">Place order</button>`;
  }

  // ----------------------------------------------------------------- render

  function buildView(route: Route): HTMLElement {
    const inner =
      route.kind === 'home'
        ? viewHome()
        : route.kind === 'category'
          ? viewCategory(route.id)
          : route.kind === 'product'
            ? viewProduct(route.id)
            : viewCart();
    const root = el(`<section class="view">${inner}</section>`);
    root.querySelectorAll('.tile, .aisle, .cart-line').forEach((node, i) => {
      (node as HTMLElement).style.setProperty('--i', String(i));
      node.classList.add('enter');
    });
    return root;
  }

  /**
   * Bring a cached root up to date with the store.
   *
   * Also strips `.enter` the second time a root is shown: the entrance
   * animation is a first-impression thing, and replaying it every time an
   * agent passes back through an aisle is flicker.
   */
  function syncView(root: HTMLElement, route: Route) {
    if (root.dataset.shown) {
      root.querySelectorAll('.enter').forEach((n) => n.classList.remove('enter'));
    } else {
      root.dataset.shown = '1';
    }

    if (route.kind === 'category') {
      for (const product of CATEGORY_BY_ID[route.id].products) syncTileIn(root, product.id);
    } else if (route.kind === 'product') {
      syncTileIn(root, route.id);
      const button = root.querySelector('.detail .add');
      if (button) button.textContent = store.quantityOf(route.id) ? 'Add another' : 'Add to cart';
    } else if (route.kind === 'cart') {
      syncCart(root);
    }
  }

  /**
   * Reconcile the cart in place, keyed by product id, so a stepper click
   * touches two text nodes instead of rebuilding every row.
   */
  function syncCart(root: HTMLElement) {
    const list = root.querySelector('.cart-lines');
    if (!list) return; // the empty-cart view has no list to reconcile

    const lines = store.lines();
    for (const line of lines) {
      let li = tileIn(list, line.product.id);
      if (!li) {
        li = el(cartLine(line));
        li.classList.add('enter');
      }
      list.appendChild(li); // moves an existing node, so order follows the cart
      li.querySelector('.qty')!.textContent = String(line.quantity);
      li.querySelector('.cart-total')!.textContent = money(line.lineTotal);
    }
    for (const li of [...list.children]) {
      const id = (li as HTMLElement).dataset.product;
      if (!lines.some((l) => l.product.id === id)) li.remove();
    }

    const t = store.totals();
    root.querySelector('.cart-sub')!.textContent =
      `${t.lines} item${t.lines === 1 ? '' : 's'} · ${t.units} unit${t.units === 1 ? '' : 's'}`;
    const amounts = root.querySelectorAll('.summary .row span:last-child');
    amounts[0].textContent = money(t.subtotal);
    amounts[1].textContent = money(t.tax);
    amounts[2].textContent = money(t.total);
  }

  /**
   * The first thing in a view worth landing the focus ring on. Document order
   * decides: the first aisle card, an aisle's first tile, a product's Add
   * button, the cart's first stepper.
   */
  function firstCell(root: ParentNode): HTMLElement | null {
    return root.querySelector<HTMLElement>(
      '.aisle, .tile .shot, .detail .add, .cart-line .stepper button, .empty .add',
    );
  }

  let firstRender = true;

  /**
   * Put the focus ring on the new view, but only at boot or when it was focus
   * that moved us here, and never mid-animation. An agent's add navigates to
   * an aisle and pulses a tile down the grid; a ring parked on tile one would
   * be a second highlight competing with it.
   */
  function focusFirstCell(root: HTMLElement, cameFromFocus: boolean) {
    if (!firstRender && (!cameFromFocus || view.animating)) return;
    firstRender = false;
    // preventScroll: the choreography owns `device.scrollTop`, and a browser
    // scroll-into-view here would fight `scrollToCentre` for the same frame.
    firstCell(root)?.focus({ preventScroll: true });
  }

  function render() {
    const route = view.route;

    // The header is static apart from the badge, so it is built once.
    // Rewriting it every render reset the badge element mid-pop.
    if (!chrome.firstElementChild) chrome.innerHTML = header();
    syncBadge();

    const key = routeToHash(route);
    let root = viewCache.get(key);

    // The cart's two shapes (empty / not) are different documents, not
    // different data, so that one transition does need a rebuild.
    if (root && route.kind === 'cart' && !!root.querySelector('.empty') !== (store.lineCount() === 0)) {
      viewCache.delete(key);
      root = undefined;
    }
    if (!root) {
      root = buildView(route);
      viewCache.set(key, root);
    }

    syncView(root, route);

    if (root !== currentRoot) {
      // Read before the swap: once the outgoing root is detached the document's
      // activeElement is <body> and the answer is always "no".
      const cameFromFocus = !!currentRoot?.contains(document.activeElement);

      main.dataset.view = route.kind;
      main.replaceChildren(root);
      // Every aisle starts at the top, so the scroll-to-item beat is the same
      // distance whether or not this aisle has been visited before.
      device.scrollTop = 0;
      root.classList.remove('swap-in');
      void root.offsetWidth;
      root.classList.add('swap-in');
      currentRoot = root;
      focusFirstCell(root, cameFromFocus);
    }
    scheduleWarm();
  }

  /**
   * Fetch every photo once the first screen is up, so an agent driving from
   * aisle to aisle never lands on tiles still loading. It waits for an idle
   * moment after the first paint and asks at low priority, so it only uses
   * bandwidth the visible screen does not need.
   */
  let warmed = false;
  function scheduleWarm() {
    if (warmed) return;
    warmed = true;
    const warm = () => {
      for (const product of ALL_PRODUCTS) {
        const img = new Image();
        img.fetchPriority = 'low';
        img.src = imageFor(product.id);
      }
    };
    const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback;
    if (idle) idle(warm, { timeout: 2000 });
    else setTimeout(warm, 400);
  }

  // One delegated listener for the whole app; every branch is a handler call,
  // which is the same entry point the tools use.
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const add = target.closest<HTMLElement>('[data-add]');
    if (add) {
      event.preventDefault();
      handlers.add(add.dataset.add!, 1);
      return;
    }
    const step = target.closest<HTMLElement>('[data-step]');
    if (step) {
      event.preventDefault();
      const id = step.dataset.step!;
      const next = store.quantityOf(id) + Number(step.dataset.dir);
      if (next <= 0) handlers.remove(id);
      else handlers.setQuantity(id, next);
      return;
    }
    if (target.closest('#checkout')) {
      event.preventDefault();
      const n = store.unitCount();
      const panel = el(`<section class="view swap-in"><div class="empty">
        <span class="empty-mark done">${LEAF_MARK}</span>
        <h1>Order placed</h1>
        <p>${n} item${n === 1 ? '' : 's'} on their way.</p>
      </div></section>`);
      main.replaceChildren(panel);
      currentRoot = panel;
      // The cached cart still has lines in it, so drop it; render() would
      // otherwise reuse a full cart for an empty one.
      viewCache.delete(routeToHash({ kind: 'cart' }));
      handlers.clear();
      syncBadge();
    }
  });

  return { render, showAndPulse, syncBadge };
}
