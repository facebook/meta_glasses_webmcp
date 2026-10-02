/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css';
import { Game } from './game.ts';
import { render } from './render.ts';
import { registerSolitaireTools } from './tools.ts';

// `?seed=N` deals the same game every time, for demos and bug reports.
const seed = Number(new URLSearchParams(location.search).get('seed'));
const game = new Game(Number.isInteger(seed) && seed > 0 ? seed : undefined);

game.subscribe(render);
registerSolitaireTools(game);

document.getElementById('new-game')!.addEventListener('click', () => game.newGame());
document.getElementById('draw')!.addEventListener('click', () => game.draw());

// Click play: the stock draws, the waste plays to a foundation or else the
// first legal column, and a tableau card sends itself plus everything above
// it to the first legal destination.
document.getElementById('board')!.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;

  if (target.closest('[data-action="draw"]')) {
    game.draw();
    return;
  }

  const loc = target.closest('[data-loc]') as HTMLElement | null;
  if (!loc) return;

  if (loc.dataset.loc === 'waste') {
    if (game.wasteToFoundation().ok) return;
    for (let c = 0; c < 7; c++) {
      if (game.wasteToTableau(c).ok) return;
    }
    return;
  }

  const cardEl = target.closest('[data-col]') as HTMLElement | null;
  if (cardEl && cardEl.dataset.col && cardEl.dataset.idx) {
    const col = Number(cardEl.dataset.col);
    const idx = Number(cardEl.dataset.idx);
    const count = game.getState().tableau[col].length - idx;
    if (count === 1 && game.tableauToFoundation(col).ok) return;
    for (let to = 0; to < 7; to++) {
      if (to === col) continue;
      if (game.tableauToTableau(col, count, to).ok) return;
    }
  }
});

// Enter and Space press the focused card or pile, as they would a button.
document.getElementById('board')!.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = (e.target as HTMLElement).closest<HTMLElement>('[role="button"]');
  if (!el) return;
  e.preventDefault();
  el.click();
});
