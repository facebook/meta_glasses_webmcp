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
  private moved = false;

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

  /** Whether anything has been played since the last deal. */
  hasMoves(): boolean {
    return this.moved;
  }

  private apply(result: MoveResult): MoveResult {
    if (result.ok) {
      this.moved = true;
      this.state = result.state;
      for (const fn of this.listeners) fn(this.state);
    }
    return result;
  }

  newGame(seed?: number): GameState {
    this.moved = false;
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
