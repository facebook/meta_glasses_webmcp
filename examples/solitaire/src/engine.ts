/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure Klondike solitaire logic (draw-1): no DOM, no framework.
//
// Ranks are 1-13 (A=1, J=11, Q=12, K=13). Suits are 'S','H','D','C'.
// Every move validates and returns a fresh state or a reason, never mutating
// its input: { ok: true, state } | { ok: false, reason }.

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = number;

export interface Card {
  suit: Suit;
  rank: Rank;
  faceUp: boolean;
}

export interface GameState {
  stock: Card[];
  waste: Card[];
  foundations: Card[][];
  tableau: Card[][];
}

export type MoveResult = { ok: true; state: GameState } | { ok: false; reason: string };

export interface Hint {
  from: string;
  to: string;
  count?: number;
  card: string;
  reason: string;
}

export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
export const TABLEAU_COLS = 7;
export const FOUNDATION_COUNT = 4;

const RANK_LABELS: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

export function isRed(suit: Suit): boolean {
  return suit === 'H' || suit === 'D';
}

export function color(suit: Suit): 'red' | 'black' {
  return isRed(suit) ? 'red' : 'black';
}

export function rankLabel(rank: Rank): string {
  return RANK_LABELS[rank] ?? String(rank);
}

/** Compact card notation, e.g. "QH" (Queen of Hearts), "10S", "AC". */
export function cardCode(card: Card): string {
  return `${rankLabel(card.rank)}${card.suit}`;
}

const SUIT_SYMBOLS: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function suitSymbol(suit: Suit): string {
  return SUIT_SYMBOLS[suit];
}

// --- Deck + dealing --------------------------------------------------------

function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) {
      deck.push({ suit, rank, faceUp: false });
    }
  }
  return deck;
}

// mulberry32: a small seedable PRNG so `deal(seed)` is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(deck: Card[], rng: () => number): Card[] {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Create and deal a fresh Klondike game. Pass a seed for a reproducible deal. */
export function deal(seed?: number): GameState {
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  const deck = shuffle(makeDeck(), rng);

  const tableau: Card[][] = Array.from({ length: TABLEAU_COLS }, () => []);
  let idx = 0;
  for (let col = 0; col < TABLEAU_COLS; col++) {
    for (let row = 0; row <= col; row++) {
      const card = deck[idx++];
      card.faceUp = row === col;
      tableau[col].push(card);
    }
  }

  const stock = deck.slice(idx).map((c) => ({ ...c, faceUp: false }));
  const foundations: Card[][] = Array.from({ length: FOUNDATION_COUNT }, () => []);
  return { stock, waste: [], foundations, tableau };
}

// --- Cloning + auto-flip ---------------------------------------------------

function clone(state: GameState): GameState {
  return {
    stock: state.stock.map((c) => ({ ...c })),
    waste: state.waste.map((c) => ({ ...c })),
    foundations: state.foundations.map((f) => f.map((c) => ({ ...c }))),
    tableau: state.tableau.map((t) => t.map((c) => ({ ...c }))),
  };
}

function autoFlipInPlace(state: GameState): void {
  for (const pile of state.tableau) {
    const top = pile[pile.length - 1];
    if (top && !top.faceUp) top.faceUp = true;
  }
}

/** Flip any exposed (top) face-down tableau card face up. Returns a new state. */
export function autoFlip(state: GameState): GameState {
  const next = clone(state);
  autoFlipInPlace(next);
  return next;
}

// --- Placement rules -------------------------------------------------------

/** Can `card` be placed on top of a foundation pile? (Ace on empty, then up by suit.) */
export function canStackOnFoundation(card: Card, foundation: Card[]): boolean {
  if (foundation.length === 0) return card.rank === 1;
  const top = foundation[foundation.length - 1];
  return card.suit === top.suit && card.rank === top.rank + 1;
}

/** Can `card` be placed on a tableau pile? (King on empty, then down in alternating color.) */
export function canStackOnTableau(card: Card, pile: Card[]): boolean {
  if (pile.length === 0) return card.rank === 13;
  const top = pile[pile.length - 1];
  if (!top.faceUp) return false;
  return color(card.suit) !== color(top.suit) && card.rank === top.rank - 1;
}

function findFoundationFor(state: GameState, card: Card): number {
  for (let i = 0; i < state.foundations.length; i++) {
    if (canStackOnFoundation(card, state.foundations[i])) return i;
  }
  return -1;
}

function validCol(col: number): boolean {
  return Number.isInteger(col) && col >= 0 && col < TABLEAU_COLS;
}

function validFoundation(i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < FOUNDATION_COUNT;
}

// --- Moves -----------------------------------------------------------------

/** Flip one card from the stock to the waste; recycle the waste into the stock when empty. */
export function drawFromStock(state: GameState): MoveResult {
  const next = clone(state);
  if (next.stock.length === 0) {
    if (next.waste.length === 0) {
      return { ok: false, reason: 'Stock and waste are both empty — nothing to draw.' };
    }
    next.stock = next.waste
      .slice()
      .reverse()
      .map((c) => ({ ...c, faceUp: false }));
    next.waste = [];
    return { ok: true, state: next };
  }
  const card = next.stock.pop()!;
  card.faceUp = true;
  next.waste.push(card);
  return { ok: true, state: next };
}

/** Move the top of the waste onto a tableau column. */
export function moveWasteToTableau(state: GameState, col: number): MoveResult {
  if (!validCol(col)) return { ok: false, reason: `Invalid tableau column ${col + 1}.` };
  if (state.waste.length === 0) return { ok: false, reason: 'Waste is empty.' };
  const card = state.waste[state.waste.length - 1];
  if (!canStackOnTableau(card, state.tableau[col])) {
    return { ok: false, reason: `Cannot move ${cardCode(card)} onto tableau ${col + 1}.` };
  }
  const next = clone(state);
  next.tableau[col].push(next.waste.pop()!);
  autoFlipInPlace(next);
  return { ok: true, state: next };
}

/** Move the top of the waste up to its foundation. */
export function moveWasteToFoundation(state: GameState): MoveResult {
  if (state.waste.length === 0) return { ok: false, reason: 'Waste is empty.' };
  const card = state.waste[state.waste.length - 1];
  const fi = findFoundationFor(state, card);
  if (fi < 0) return { ok: false, reason: `${cardCode(card)} cannot move to any foundation yet.` };
  const next = clone(state);
  next.foundations[fi].push(next.waste.pop()!);
  autoFlipInPlace(next);
  return { ok: true, state: next };
}

/** Move the top face-up card of a tableau column up to its foundation. */
export function moveTableauToFoundation(state: GameState, fromCol: number): MoveResult {
  if (!validCol(fromCol)) return { ok: false, reason: `Invalid tableau column ${fromCol + 1}.` };
  const pile = state.tableau[fromCol];
  if (pile.length === 0) return { ok: false, reason: `Tableau ${fromCol + 1} is empty.` };
  const card = pile[pile.length - 1];
  const fi = findFoundationFor(state, card);
  if (fi < 0) {
    return { ok: false, reason: `${cardCode(card)} cannot move to any foundation yet.` };
  }
  const next = clone(state);
  next.foundations[fi].push(next.tableau[fromCol].pop()!);
  autoFlipInPlace(next);
  return { ok: true, state: next };
}

/** Move a run of `count` face-up cards between tableau columns. */
export function moveTableauToTableau(
  state: GameState,
  fromCol: number,
  count: number,
  toCol: number,
): MoveResult {
  if (!validCol(fromCol)) return { ok: false, reason: `Invalid tableau column ${fromCol + 1}.` };
  if (!validCol(toCol)) return { ok: false, reason: `Invalid tableau column ${toCol + 1}.` };
  if (fromCol === toCol) return { ok: false, reason: 'Source and destination columns are the same.' };
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, reason: `Invalid count ${count}.` };
  }
  const from = state.tableau[fromCol];
  if (count > from.length) {
    return { ok: false, reason: `Tableau ${fromCol + 1} has only ${from.length} card(s).` };
  }
  const run = from.slice(from.length - count);
  if (run.some((c) => !c.faceUp)) {
    return { ok: false, reason: 'Cannot move a face-down card.' };
  }
  for (let i = 0; i < run.length - 1; i++) {
    const upper = run[i];
    const lower = run[i + 1];
    if (color(upper.suit) === color(lower.suit) || upper.rank !== lower.rank + 1) {
      return { ok: false, reason: 'Selected cards are not a valid ordered run.' };
    }
  }
  const moving = run[0];
  if (!canStackOnTableau(moving, state.tableau[toCol])) {
    return {
      ok: false,
      reason: `Cannot move ${cardCode(moving)} onto tableau ${toCol + 1}.`,
    };
  }
  const next = clone(state);
  const moved = next.tableau[fromCol].splice(next.tableau[fromCol].length - count, count);
  next.tableau[toCol].push(...moved);
  autoFlipInPlace(next);
  return { ok: true, state: next };
}

/** Move the top of a foundation back down onto a tableau column. */
export function moveFoundationToTableau(
  state: GameState,
  foundationIndex: number,
  toCol: number,
): MoveResult {
  if (!validFoundation(foundationIndex)) {
    return { ok: false, reason: `Invalid foundation ${foundationIndex + 1}.` };
  }
  if (!validCol(toCol)) return { ok: false, reason: `Invalid tableau column ${toCol + 1}.` };
  const pile = state.foundations[foundationIndex];
  if (pile.length === 0) return { ok: false, reason: `Foundation ${foundationIndex + 1} is empty.` };
  const card = pile[pile.length - 1];
  if (!canStackOnTableau(card, state.tableau[toCol])) {
    return { ok: false, reason: `Cannot move ${cardCode(card)} onto tableau ${toCol + 1}.` };
  }
  const next = clone(state);
  next.tableau[toCol].push(next.foundations[foundationIndex].pop()!);
  autoFlipInPlace(next);
  return { ok: true, state: next };
}

// --- Status + hints --------------------------------------------------------

/** The game is won when all four foundations hold 13 cards (Ace to King). */
export function isWon(state: GameState): boolean {
  return state.foundations.every((f) => f.length === 13);
}

// Longest suffix of a pile that forms a movable run (face-up, descending, alternating color).
function movableRunLength(pile: Card[]): number {
  if (pile.length === 0) return 0;
  const top = pile[pile.length - 1];
  if (!top.faceUp) return 0;
  let len = 1;
  for (let i = pile.length - 1; i > 0; i--) {
    const upper = pile[i - 1];
    const lower = pile[i];
    if (upper.faceUp && color(upper.suit) !== color(lower.suit) && upper.rank === lower.rank + 1) {
      len++;
    } else {
      break;
    }
  }
  return len;
}

/** Suggest one useful legal move, or null if none is available. */
export function hint(state: GameState): Hint | null {
  const toFoundation: Hint[] = [];
  if (state.waste.length > 0) {
    const card = state.waste[state.waste.length - 1];
    const fi = findFoundationFor(state, card);
    if (fi >= 0) {
      toFoundation.push({
        from: 'waste',
        to: `foundation:${fi + 1}`,
        card: cardCode(card),
        reason: 'Play up to the foundation.',
      });
    }
  }
  for (let c = 0; c < TABLEAU_COLS; c++) {
    const pile = state.tableau[c];
    if (pile.length === 0) continue;
    const card = pile[pile.length - 1];
    if (!card.faceUp) continue;
    const fi = findFoundationFor(state, card);
    if (fi >= 0) {
      toFoundation.push({
        from: `tableau:${c + 1}`,
        to: `foundation:${fi + 1}`,
        card: cardCode(card),
        reason: 'Play up to the foundation.',
      });
    }
  }

  // 1. Aces and twos are always safe to play up.
  const safeUp = toFoundation.filter((h) => rankOfCode(h.card) <= 2);
  if (safeUp.length > 0) {
    safeUp.sort((a, b) => rankOfCode(a.card) - rankOfCode(b.card));
    return safeUp[0];
  }

  // 2. A tableau-to-tableau move that reveals a hidden face-down card.
  const tableauMoves: (Hint & { reveals: boolean; empties: boolean })[] = [];
  for (let from = 0; from < TABLEAU_COLS; from++) {
    const pile = state.tableau[from];
    const runLen = movableRunLength(pile);
    for (let count = 1; count <= runLen; count++) {
      const startIdx = pile.length - count;
      const moving = pile[startIdx];
      const reveals = startIdx - 1 >= 0 && !pile[startIdx - 1].faceUp;
      const empties = startIdx === 0;
      for (let to = 0; to < TABLEAU_COLS; to++) {
        if (to === from) continue;
        // A King run that already fills a column gains nothing from moving to another empty one.
        if (moving.rank === 13 && state.tableau[to].length === 0 && empties) continue;
        if (canStackOnTableau(moving, state.tableau[to])) {
          tableauMoves.push({
            from: `tableau:${from + 1}`,
            to: `tableau:${to + 1}`,
            count,
            card: cardCode(moving),
            reason: reveals ? 'Move this run to uncover a face-down card.' : 'Move this run onto another column.',
            reveals,
            empties,
          });
        }
      }
    }
  }

  const revealMove = tableauMoves.find((m) => m.reveals);
  if (revealMove) {
    const { reveals: _r, empties: _e, ...h } = revealMove;
    return h;
  }

  // 3. Move the waste onto a tableau column.
  if (state.waste.length > 0) {
    const card = state.waste[state.waste.length - 1];
    for (let c = 0; c < TABLEAU_COLS; c++) {
      if (canStackOnTableau(card, state.tableau[c])) {
        return {
          from: 'waste',
          to: `tableau:${c + 1}`,
          card: cardCode(card),
          reason: 'Move the waste card into play.',
        };
      }
    }
  }

  // 4. Any remaining play up to a foundation.
  if (toFoundation.length > 0) {
    toFoundation.sort((a, b) => rankOfCode(a.card) - rankOfCode(b.card));
    return toFoundation[0];
  }

  // 5. Any other legal tableau-to-tableau move (e.g. a King into an empty column).
  const other = tableauMoves.find((m) => !m.empties || state.tableau[colIndexOf(m.to)].length === 0);
  if (other) {
    const { reveals: _r, empties: _e, ...h } = other;
    return h;
  }

  // 6. Draw or recycle the stock while there are still cards to cycle through.
  if (state.stock.length > 0 || state.waste.length > 0) {
    return {
      from: 'stock',
      to: 'waste',
      card: 'stock',
      reason: 'Draw from the stock to reveal new options.',
    };
  }

  return null;
}

function colIndexOf(loc: string): number {
  return parseInt(loc.split(':')[1], 10) - 1;
}

const CODE_RANKS: Record<string, number> = { A: 1, J: 11, Q: 12, K: 13 };

function rankOfCode(code: string): number {
  const head = code.slice(0, code.length - 1);
  return CODE_RANKS[head] ?? parseInt(head, 10);
}
