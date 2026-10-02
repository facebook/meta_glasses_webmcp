/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { describe, expect, it } from 'vitest';
import {
  type Card,
  type GameState,
  type Suit,
  SUITS,
  canStackOnFoundation,
  canStackOnTableau,
  cardCode,
  deal,
  drawFromStock,
  hint,
  isWon,
  moveTableauToTableau,
  moveWasteToFoundation,
} from './engine.ts';

function card(rank: number, suit: Suit, faceUp = true): Card {
  return { rank, suit, faceUp };
}

function empty(): GameState {
  return {
    stock: [],
    waste: [],
    foundations: [[], [], [], []],
    tableau: [[], [], [], [], [], [], []],
  };
}

describe('deal', () => {
  it('lays out 28 tableau cards with only each top face up, and 24 in the stock', () => {
    const state = deal(7);
    expect(state.tableau.map((pile) => pile.length)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const pile of state.tableau) {
      expect(pile.map((c) => c.faceUp)).toEqual(pile.map((_, i) => i === pile.length - 1));
    }
    expect(state.stock).toHaveLength(24);
    expect(state.stock.every((c) => !c.faceUp)).toBe(true);
    expect(state.waste).toEqual([]);
    expect(state.foundations.every((f) => f.length === 0)).toBe(true);
  });

  it('uses all 52 distinct cards and is reproducible from a seed', () => {
    const state = deal(42);
    const codes = [...state.stock, ...state.tableau.flat()].map(cardCode);
    expect(new Set(codes).size).toBe(52);
    expect(deal(42)).toEqual(state);
  });
});

describe('placement rules', () => {
  it('builds foundations up by suit from the Ace', () => {
    expect(canStackOnFoundation(card(1, 'H'), [])).toBe(true);
    expect(canStackOnFoundation(card(2, 'H'), [])).toBe(false);
    expect(canStackOnFoundation(card(2, 'H'), [card(1, 'H')])).toBe(true);
    expect(canStackOnFoundation(card(2, 'D'), [card(1, 'H')])).toBe(false);
  });

  it('builds the tableau down in alternating colors, Kings only on empty', () => {
    expect(canStackOnTableau(card(13, 'S'), [])).toBe(true);
    expect(canStackOnTableau(card(12, 'S'), [])).toBe(false);
    expect(canStackOnTableau(card(6, 'H'), [card(7, 'C')])).toBe(true);
    expect(canStackOnTableau(card(6, 'S'), [card(7, 'C')])).toBe(false);
    expect(canStackOnTableau(card(6, 'H'), [card(7, 'C', false)])).toBe(false);
  });
});

describe('moves', () => {
  it('draws one card face up, then recycles the waste when the stock runs out', () => {
    const state = empty();
    state.stock = [card(5, 'S', false)];
    const drawn = drawFromStock(state);
    if (!drawn.ok) throw new Error(drawn.reason);
    expect(drawn.state.waste.map(cardCode)).toEqual(['5S']);
    expect(drawn.state.waste[0].faceUp).toBe(true);
    expect(state.stock).toHaveLength(1);

    const recycled = drawFromStock(drawn.state);
    if (!recycled.ok) throw new Error(recycled.reason);
    expect(recycled.state.stock.map((c) => c.faceUp)).toEqual([false]);
    expect(recycled.state.waste).toEqual([]);

    expect(drawFromStock(empty())).toMatchObject({ ok: false });
  });

  it('moves a valid run and flips the card it uncovers', () => {
    const state = empty();
    state.tableau[0] = [card(2, 'C', false), card(9, 'S'), card(8, 'H')];
    state.tableau[1] = [card(10, 'D')];
    const result = moveTableauToTableau(state, 0, 2, 1);
    if (!result.ok) throw new Error(result.reason);
    expect(result.state.tableau[1].map(cardCode)).toEqual(['10D', '9S', '8H']);
    expect(result.state.tableau[0]).toEqual([card(2, 'C', true)]);
  });

  it('refuses an illegal move with a reason', () => {
    const state = empty();
    state.tableau[0] = [card(9, 'H')];
    state.tableau[1] = [card(10, 'D')];
    expect(moveTableauToTableau(state, 0, 1, 1)).toEqual({
      ok: false,
      reason: 'Cannot move 9H onto tableau 2.',
    });
    expect(moveWasteToFoundation(state)).toEqual({ ok: false, reason: 'Waste is empty.' });
  });
});

describe('status', () => {
  it('is won only when every foundation runs Ace to King', () => {
    const state = empty();
    state.foundations = SUITS.map((suit) => Array.from({ length: 13 }, (_, i) => card(i + 1, suit)));
    expect(isWon(state)).toBe(true);
    state.foundations[3].pop();
    expect(isWon(state)).toBe(false);
  });

  it('hints an Ace up to the foundation before anything else', () => {
    const state = empty();
    state.tableau[2] = [card(1, 'D')];
    state.stock = [card(4, 'C', false)];
    expect(hint(state)).toMatchObject({ from: 'tableau:3', to: 'foundation:1', card: 'AD' });
  });
});
