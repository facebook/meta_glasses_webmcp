/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  type GameState,
  type Hint,
  type MoveResult,
  cardCode,
  deal,
  drawFromStock,
  hint,
  isWon,
  moveFoundationToTableau,
  moveTableauToFoundation,
  moveTableauToTableau,
  moveWasteToFoundation,
  moveWasteToTableau,
} from './engine.ts';

type Listener = (state: GameState) => void;

/** The one game both the board and the agent tools drive. */
export class Game {
  private state: GameState;
  private listeners = new Set<Listener>();

  constructor(seed?: number) {
    this.state = deal(seed);
  }

  getState(): GameState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private apply(result: MoveResult): MoveResult {
    if (result.ok) {
      this.state = result.state;
      for (const fn of this.listeners) fn(this.state);
    }
    return result;
  }

  newGame(seed?: number): GameState {
    this.state = deal(seed);
    for (const fn of this.listeners) fn(this.state);
    return this.state;
  }

  draw(): MoveResult {
    return this.apply(drawFromStock(this.state));
  }

  wasteToTableau(col: number): MoveResult {
    return this.apply(moveWasteToTableau(this.state, col));
  }

  wasteToFoundation(): MoveResult {
    return this.apply(moveWasteToFoundation(this.state));
  }

  tableauToFoundation(fromCol: number): MoveResult {
    return this.apply(moveTableauToFoundation(this.state, fromCol));
  }

  tableauToTableau(fromCol: number, count: number, toCol: number): MoveResult {
    return this.apply(moveTableauToTableau(this.state, fromCol, count, toCol));
  }

  foundationToTableau(foundationIndex: number, toCol: number): MoveResult {
    return this.apply(moveFoundationToTableau(this.state, foundationIndex, toCol));
  }

  hint(): Hint | null {
    return hint(this.state);
  }

  isWon(): boolean {
    return isWon(this.state);
  }
}

/** Compact ASCII rendering of the whole board, for agent tool output. */
export function asciiBoard(state: GameState): string {
  const lines: string[] = [];

  const foundations = state.foundations
    .map((f) => (f.length ? cardCode(f[f.length - 1]) : '--'))
    .map((c, i) => `F${i + 1}:${c}`)
    .join('  ');
  lines.push(`Foundations: ${foundations}`);

  const wasteTop = state.waste.length ? cardCode(state.waste[state.waste.length - 1]) : '--';
  lines.push(`Stock: ${state.stock.length}   Waste: ${wasteTop}`);

  lines.push('Tableau:');
  for (let c = 0; c < state.tableau.length; c++) {
    const pile = state.tableau[c];
    const cells = pile.map((card) => (card.faceUp ? cardCode(card) : '##'));
    lines.push(`  T${c + 1}: ${cells.length ? cells.join(' ') : '(empty)'}`);
  }

  return lines.join('\n');
}
