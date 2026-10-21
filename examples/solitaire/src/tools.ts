/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Agent tool surface: the shared Game exposed as solitaire_* tools through
// the local registry in webmcp.ts. Every tool answers with the full board, and
// illegal moves come back as tool errors carrying the engine's reason.
//
// The board is the agent's to reason over, not to read out: on glasses the
// result is voiced, and card codes and column ids came out as "AC" and
// "tableau one" with the whole board recited after every move. So each result
// leads with `say`, one plain sentence about what just happened, and the board
// names cards the way they are spoken.

import { registerTool } from './webmcp.ts';
import {
  type Card,
  type GameState,
  canStackOnFoundation,
  canStackOnTableau,
  cardName,
  cardNameFromCode,
  isWon,
} from './engine.ts';
import type { Game } from './game.ts';

const SPEECH =
  'Speak plain English: one short sentence, usually just `say`. Name cards in words ("ace of ' +
  'clubs"), call tableau:N "column N", and never use card codes, symbols, arrows, lists or ' +
  'markdown. The human can see the board, so do not read it back.';

function top(pile: Card[]): Card | null {
  return pile.length ? pile[pile.length - 1] : null;
}

function snapshot(state: GameState, say?: string): string {
  const wasteTop = top(state.waste);
  return JSON.stringify({
    ...(say ? { say } : {}),
    speech: SPEECH,
    status: isWon(state) ? 'won' : 'in progress',
    foundations: state.foundations.map((f, i) => {
      const card = top(f);
      return { id: `foundation:${i + 1}`, top: card ? cardName(card) : null, count: f.length };
    }),
    tableau: state.tableau.map((pile, i) => {
      const faceDown = pile.filter((c) => !c.faceUp).length;
      const faceUp = pile.filter((c) => c.faceUp).map(cardName);
      return { id: `tableau:${i + 1}`, faceDown, faceUp };
    }),
    waste: { top: wasteTop ? cardName(wasteTop) : null, count: state.waste.length },
    stock: state.stock.length,
  });
}

function toolError(reason: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

/**
 * A refused move. Errors are voiced too, and the engine's reasons use card codes and column
 * numbers ("Cannot move QS onto tableau 3."), so they get the same plain English as results.
 * Argument errors stay as they are: they name the "tableau:N" ids the agent has to send.
 */
function moveError(reason: string): ReturnType<typeof toolError> {
  return toolError(
    reason
      .replace(/\b(?:A|J|Q|K|10|[2-9])[SHDC]\b/g, (code) => `the ${cardNameFromCode(code)}`)
      .replace(/\bTableau (\d)\b/g, 'Column $1')
      .replace(/\btableau (\d)\b/g, 'column $1'),
  );
}

type Loc = { type: 'waste' } | { type: 'tableau'; index: number } | { type: 'foundation'; index: number };

/** Parses "waste", "tableau:1".."tableau:7", or "foundation:1".."foundation:4". */
function parseLoc(raw: string): Loc | null {
  const s = String(raw).trim().toLowerCase();
  if (s === 'waste') return { type: 'waste' };
  const m = /^(tableau|foundation):(\d+)$/.exec(s);
  if (!m) return null;
  const index = parseInt(m[2], 10) - 1;
  if (m[1] === 'tableau') {
    if (index < 0 || index > 6) return null;
    return { type: 'tableau', index };
  }
  if (index < 0 || index > 3) return null;
  return { type: 'foundation', index };
}

/** Can the top of the waste go anywhere right now? */
function wastePlayable(state: GameState): boolean {
  const card = top(state.waste);
  if (!card) return false;
  return (
    state.foundations.some((f) => canStackOnFoundation(card, f)) ||
    state.tableau.some((pile) => canStackOnTableau(card, pile))
  );
}

/** One sentence for a move that just succeeded, from the boards either side of it. */
function describeMove(before: GameState, after: GameState, src: Loc, dst: Loc, count: number): string {
  const pile = src.type === 'waste' ? before.waste : src.type === 'tableau' ? before.tableau[src.index] : before.foundations[src.index];
  // `count` is exact: the engine refuses any run it cannot move whole, and this only runs after a move succeeded.
  const moved = pile[pile.length - count];
  const name = moved ? cardName(moved) : 'the card';
  let line: string;
  if (dst.type !== 'tableau') {
    line = `Played the ${name} to the foundation.`;
  } else {
    const onto = top(before.tableau[dst.index]);
    const what = count > 1 ? `the ${name} and the ${count - 1} below it` : `the ${name}`;
    line = onto
      ? `Moved ${what} onto the ${cardName(onto)}.`
      : `Moved ${what} to the empty column ${dst.index + 1}.`;
  }
  if (src.type === 'tableau') {
    const left = after.tableau[src.index];
    const turned = top(left);
    const hidden = (p: Card[]) => p.filter((c) => !c.faceUp).length;
    if (!left.length) line += ` Column ${src.index + 1} is empty.`;
    else if (turned && hidden(left) < hidden(before.tableau[src.index])) line += ` That turned up the ${cardName(turned)}.`;
  }
  return line;
}

export function registerSolitaireTools(game: Game): void {
  registerTool({
    name: 'solitaire_draw',
    description:
      'Draw one card from the stock to the waste. When the stock is empty, recycles the waste back into the stock. ' +
      'Pass until_playable=true when the human asks to keep drawing until something can be played: the page draws ' +
      'in one call instead of you calling this over and over. Returns the full board state.',
    inputSchema: {
      type: 'object',
      properties: {
        until_playable: {
          type: 'boolean',
          description:
            'Keep drawing until the waste card can be played, or the whole stock has been gone through once. ' +
            'Use for "draw until we can play".',
        },
      },
    },
    execute: async ({ until_playable }: { until_playable?: boolean } = {}) => {
      if (!until_playable) {
        const result = game.draw();
        if (!result.ok) return moveError(result.reason);
        const drawn = top(result.state.waste);
        return snapshot(
          result.state,
          drawn ? `Drew the ${cardName(drawn)}.` : 'Turned the waste back over into the stock.',
        );
      }
      // One full pass: every card in the stock and waste, plus the recycle.
      const start = game.getState();
      const limit = start.stock.length + start.waste.length + 1;
      // Only cards turned onto the waste count; a recycle draws nothing.
      let drawn = 0;
      for (let step = 0; step < limit; step++) {
        const before = game.getState().waste.length;
        const result = game.draw();
        if (!result.ok) return moveError(result.reason);
        if (result.state.waste.length > before) drawn++;
        if (wastePlayable(result.state)) {
          const card = cardName(top(result.state.waste)!);
          return snapshot(
            result.state,
            `Drew ${drawn === 1 ? 'one card' : `${drawn} cards`}. The ${card} can be played.`,
          );
        }
      }
      return snapshot(game.getState(), 'Went through the whole stock and nothing from it can be played yet.');
    },
  });

  registerTool({
    name: 'solitaire_move',
    description:
      'Move a card (or a run of cards) between locations. `from` may be "waste", "tableau:1".."tableau:7", or "foundation:1".."foundation:4". `to` may be "tableau:1".."tableau:7" or "foundation:1".."foundation:4". Optional `count` moves a run of that many cards for tableau-to-tableau moves (default 1). Moving to a foundation ignores the exact foundation number and places on the correct suit pile. Returns the full board state.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Source: "waste", "tableau:1".."tableau:7", or "foundation:1".."foundation:4".',
        },
        to: {
          type: 'string',
          description: 'Destination: "tableau:1".."tableau:7" or "foundation:1".."foundation:4".',
        },
        count: {
          type: 'number',
          description: 'Number of cards to move (tableau-to-tableau runs only). Defaults to 1.',
        },
      },
      required: ['from', 'to'],
    },
    execute: async ({ from, to, count }: { from: string; to: string; count?: number }) => {
      const src = parseLoc(from);
      const dst = parseLoc(to);
      if (!src) return toolError(`Invalid "from" location: "${from}".`);
      if (!dst) return toolError(`Invalid "to" location: "${to}".`);

      const before = game.getState();
      let result;
      if (src.type === 'waste' && dst.type === 'tableau') {
        result = game.wasteToTableau(dst.index);
      } else if (src.type === 'waste' && dst.type === 'foundation') {
        result = game.wasteToFoundation();
      } else if (src.type === 'tableau' && dst.type === 'foundation') {
        result = game.tableauToFoundation(src.index);
      } else if (src.type === 'tableau' && dst.type === 'tableau') {
        result = game.tableauToTableau(src.index, count ?? 1, dst.index);
      } else if (src.type === 'foundation' && dst.type === 'tableau') {
        result = game.foundationToTableau(src.index, dst.index);
      } else {
        return toolError(`Unsupported move from "${from}" to "${to}".`);
      }

      if (!result.ok) return moveError(result.reason);
      const moved = src.type === 'tableau' && dst.type === 'tableau' ? (count ?? 1) : 1;
      const say = isWon(result.state) ? 'That is every card home — you won!' : describeMove(before, result.state, src, dst, moved);
      return snapshot(result.state, say);
    },
  });

  registerTool({
    name: 'solitaire_hint',
    description: 'Suggest one useful legal move without playing it. Returns the suggestion plus the full board state.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const hint = game.hint();
      const state = game.getState();
      let say: string;
      if (!hint) say = 'There is no move left, and drawing will not help.';
      else if (hint.from === 'stock') say = 'Draw a card.';
      else {
        const card = cardNameFromCode(hint.card);
        const dest = parseLoc(hint.to);
        const onto = dest?.type === 'tableau' ? top(state.tableau[dest.index]) : null;
        say = hint.to.startsWith('foundation')
          ? `Play the ${card} to the foundation.`
          : onto
            ? `Move the ${card} onto the ${cardName(onto)}.`
            : `Move the ${card} to the empty column.`;
      }
      return JSON.stringify({
        hint: hint ? { ...hint, card: cardNameFromCode(hint.card) } : null,
        ...JSON.parse(snapshot(state, say)),
      });
    },
  });

  registerTool({
    name: 'solitaire_new_game',
    description:
      'Deal a fresh game of Klondike solitaire. Returns the new board state. Once cards have been ' +
      'played this deals only with restart=true; without it the game under way is returned as is.',
    inputSchema: {
      type: 'object',
      properties: {
        restart: {
          type: 'boolean',
          description:
            'true when the human asks for a new game, a new deal, or to start over. Without it a ' +
            'game already under way is left alone.',
        },
      },
    },
    annotations: { destructiveHint: true },
    execute: async ({ restart }: { restart?: boolean } = {}) => {
      // The assistant hands each turn to a sub-agent with no memory of the game, which can reach
      // for this tool unprompted; a game in progress survives unless a new deal was asked for.
      const state = game.getState();
      if (!restart && game.hasMoves() && !isWon(state)) {
        return JSON.stringify({
          ...JSON.parse(snapshot(state)),
          already_running:
            'A game is under way, so nothing was dealt. Pass restart=true only if the human asked for a new game.',
        });
      }
      return snapshot(game.newGame(), 'New game dealt.');
    },
  });

  registerTool({
    name: 'solitaire_read_board',
    description:
      'Read the full board (foundations, tableau, waste, stock, status) without making a move. Use this only when you need state you were not just handed by another tool.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => snapshot(game.getState()),
  });
}
