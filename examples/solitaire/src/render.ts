/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { type Card, type GameState, type Suit, cardCode, isRed, isWon, rankLabel, suitSymbol } from './engine.ts';

const RANK_NAMES = ['', 'ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const SUIT_NAMES: Record<Suit, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

function cardName(card: Card): string {
  return `${RANK_NAMES[card.rank]} of ${SUIT_NAMES[card.suit]}`;
}

/** Lets a keyboard, or the glasses' D-pad, reach and press what a click plays. */
function playable(el: HTMLElement, label: string): void {
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-label', label);
}

/** What has focus on the board, by the card or action it stands for. */
function focusKey(board: HTMLElement): string | undefined {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !board.contains(el)) return undefined;
  return el.dataset.code ?? el.dataset.action;
}

/**
 * The rebuild drops focus with the old elements, so it goes back to the same
 * card, or to the stock when that card is no longer playable.
 */
function restoreFocus(board: HTMLElement, key: string | undefined): void {
  if (!key) return;
  const el =
    board.querySelector<HTMLElement>(`[role="button"][data-code="${key}"]`) ??
    board.querySelector<HTMLElement>('[data-action="draw"]');
  el?.focus({ preventScroll: true });
}

function cardEl(card: Card): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  if (!card.faceUp) {
    el.classList.add('back');
    return el;
  }
  el.classList.add('face', isRed(card.suit) ? 'red' : 'black');
  el.dataset.code = cardCode(card);
  const corner = document.createElement('span');
  corner.className = 'corner';
  corner.textContent = `${rankLabel(card.rank)}${suitSymbol(card.suit)}`;
  const pip = document.createElement('span');
  pip.className = 'pip';
  pip.textContent = suitSymbol(card.suit);
  el.append(corner, pip);
  return el;
}

function emptySlot(label: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card slot';
  el.textContent = label;
  return el;
}

/** How long a moved card takes to fly to its new pile. */
const MOVE_MS = 200;

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Where each face-up card sits now, keyed by its code. */
function cardRects(board: HTMLElement): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const el of board.querySelectorAll<HTMLElement>('.card.face[data-code]')) {
    rects.set(el.dataset.code!, el.getBoundingClientRect());
  }
  return rects;
}

/**
 * The board is rebuilt on every change, so a moved card would simply appear in
 * its new pile. Each card that existed before is started back where it was and
 * slides to where it is now. Only `transform` animates, so the compositor moves
 * it without relayout, and positions are read once before and once after the
 * rebuild rather than per card.
 */
function flyMovedCards(board: HTMLElement, before: Map<string, DOMRect>): void {
  if (before.size === 0 || reducedMotion()) return;
  const after = cardRects(board);
  for (const [code, to] of after) {
    const from = before.get(code);
    if (!from) continue;
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    const el = board.querySelector<HTMLElement>(`.card.face[data-code="${code}"]`)!;
    el.classList.add('flying');
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: MOVE_MS,
      easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    }).finished.then(
      () => el.classList.remove('flying'),
      () => el.classList.remove('flying'),
    );
  }
}

export function render(state: GameState): void {
  const board = document.getElementById('board')!;
  const status = document.getElementById('status')!;
  const focused = focusKey(board);
  const before = cardRects(board);
  board.innerHTML = '';

  const top = document.createElement('div');
  top.className = 'top-row';

  const stockWaste = document.createElement('div');
  stockWaste.className = 'stock-waste';

  const stock = document.createElement('div');
  stock.className = 'pile stock';
  stock.dataset.action = 'draw';
  playable(stock, state.stock.length > 0 ? `Draw a card, ${state.stock.length} left` : 'Turn the waste over');
  if (state.stock.length > 0) {
    const back = document.createElement('div');
    back.className = 'card back';
    stock.appendChild(back);
  } else {
    stock.appendChild(emptySlot('↻'));
  }
  const stockCount = document.createElement('span');
  stockCount.className = 'count';
  stockCount.textContent = String(state.stock.length);
  stock.appendChild(stockCount);

  const waste = document.createElement('div');
  waste.className = 'pile waste';
  waste.dataset.loc = 'waste';
  if (state.waste.length > 0) {
    const card = state.waste[state.waste.length - 1];
    const el = cardEl(card);
    playable(el, cardName(card));
    waste.appendChild(el);
  } else {
    waste.appendChild(emptySlot(''));
  }

  stockWaste.append(stock, waste);

  const foundations = document.createElement('div');
  foundations.className = 'foundations';
  for (let i = 0; i < state.foundations.length; i++) {
    const pile = document.createElement('div');
    pile.className = 'pile foundation';
    pile.dataset.loc = `foundation:${i + 1}`;
    const f = state.foundations[i];
    if (f.length === 0) {
      pile.appendChild(emptySlot('A'));
    } else {
      // What the top card covers stays drawn beneath it, so a card flying in
      // lands on the previous card, or the empty slot, rather than on nothing.
      const under = f.length > 1 ? cardEl(f[f.length - 2]) : emptySlot('A');
      under.classList.add('under');
      pile.append(under, cardEl(f[f.length - 1]));
    }
    foundations.appendChild(pile);
  }

  top.append(stockWaste, foundations);
  board.appendChild(top);

  const tableau = document.createElement('div');
  tableau.className = 'tableau';
  for (let c = 0; c < state.tableau.length; c++) {
    const col = document.createElement('div');
    col.className = 'pile column';
    col.dataset.loc = `tableau:${c + 1}`;
    const pile = state.tableau[c];
    if (pile.length === 0) {
      col.appendChild(emptySlot(''));
    } else {
      pile.forEach((card, idx) => {
        const el = cardEl(card);
        el.dataset.col = String(c);
        el.dataset.idx = String(idx);
        if (card.faceUp) playable(el, cardName(card));
        col.appendChild(el);
      });
    }
    tableau.appendChild(col);
  }
  board.appendChild(tableau);
  restoreFocus(board, focused);
  flyMovedCards(board, before);

  status.textContent = isWon(state) ? 'You won! All four foundations are complete.' : '';
}
