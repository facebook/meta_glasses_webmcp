/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css';
import { Store, type Result } from './engine.ts';
import { createRenderer, type Handlers } from './render.ts';
import { hashToRoute, routeToHash, type Route, type View } from './state.ts';
import { registerTools } from './tools.ts';

const store = new Store();

// Presentation state, deliberately outside the Store: the route is where the
// shopper is looking, not what they are buying. Seeded from the URL so a
// reloaded deep link lands where it says it does.
const view: View = { route: hashToRoute(location.hash), animating: false };

let repaint = () => {};

/** Change route, keep the URL honest, repaint once. */
function go(route: Route) {
  view.route = route;
  const hash = routeToHash(route);
  if (location.hash !== hash) {
    // replaceState fires no hashchange, so this repaints exactly once.
    history.replaceState(null, '', hash);
  }
  repaint();
}

const handlers: Handlers = {
  navigate: go,
  add: (id, quantity) => void addWithAnimation(id, quantity),
  setQuantity: (id, quantity) => {
    store.setQuantity(id, quantity);
    repaint();
  },
  remove: (id) => {
    store.remove(id);
    repaint();
  },
  clear: () => {
    store.clear();
  },
};

const renderer = createRenderer(store, view, handlers);
repaint = renderer.render;

/**
 * The single path into the cart, for the page and the agent alike. The
 * engine's Result is captured so a refused add (over the per-item cap) still
 * reaches the caller as a real error instead of a silent no-op.
 */
async function addWithAnimation(id: string, quantity: number): Promise<Result<unknown>> {
  let result: Result<unknown> = { ok: false, error: 'The add never ran.' };
  await renderer.showAndPulse(id, () => {
    result = store.add(id, quantity);
  });
  // No repaint: showAndPulse has already synced the badge and the tile's chip
  // in place, and a full render would rebuild the tile that just pulsed.
  return result;
}

registerTools({
  store,
  view,
  onChange: () => repaint(),
  addWithAnimation,
  go,
});

window.addEventListener('hashchange', () => {
  const next = hashToRoute(location.hash);
  if (routeToHash(next) === routeToHash(view.route)) return;
  view.route = next;
  repaint();
});

renderer.render();

/**
 * Does the cart still fit the 600×600 frame? That is a layout property no
 * headless test can see, so the page measures itself and parks the answer on
 * `window.__marketCartFits` (e.g. `{ fits: true, content: 561, frame: 600 }`).
 * It only warns: an overflowing cart still works, it just scrolls.
 */
function measureCart() {
  if (view.route.kind !== 'cart') return;
  const device = document.getElementById('device')!;
  const fits = device.scrollHeight <= device.clientHeight + 1;
  const report = { fits, content: device.scrollHeight, frame: device.clientHeight };
  (window as unknown as { __marketCartFits?: typeof report }).__marketCartFits = report;
  if (!fits) {
    console.warn(
      `[market] the cart overflows the ${report.frame}px frame by ${report.content - report.frame}px ` +
        `with ${store.lineCount()} lines.`,
    );
  }
}

new MutationObserver(() => requestAnimationFrame(measureCart)).observe(document.getElementById('app')!, {
  childList: true,
});
requestAnimationFrame(measureCart);
