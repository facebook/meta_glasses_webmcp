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

import { registerTool } from './webmcp.ts';
import { type GameState, cardCode } from './engine.ts';
import { asciiBoard, type Game } from './game.ts';

function snapshot(state: GameState): string {
  return JSON.stringify({
    status: state.foundations.every((f) => f.length === 13) ? 'won' : 'in progress',
    foundations: state.foundations.map((f, i) => ({
      id: `foundation:${i + 1}`,
      top: f.length ? cardCode(f[f.length - 1]) : null,
      count: f.length,
    })),
    tableau: state.tableau.map((pile, i) => {
      const faceDown = pile.filter((c) => !c.faceUp).length;
      const faceUp = pile.filter((c) => c.faceUp).map(cardCode);
      return { id: `tableau:${i + 1}`, faceDown, faceUp };
    }),
    waste: {
      top: state.waste.length ? cardCode(state.waste[state.waste.length - 1]) : null,
      count: state.waste.length,
    },
    stock: state.stock.length,
    ascii: asciiBoard(state),
  });
}

function toolError(reason: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: reason }], isError: true };
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

export function registerSolitaireTools(game: Game): void {
  registerTool({
    name: 'solitaire_draw',
    description:
      'Draw one card from the stock to the waste. When the stock is empty, recycles the waste back into the stock. Returns the full board state.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      const result = game.draw();
      if (!result.ok) return toolError(result.reason);
      return snapshot(result.state);
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

      if (!result.ok) return toolError(result.reason);
      return snapshot(result.state);
    },
  });

  registerTool({
    name: 'solitaire_hint',
    description: 'Suggest one useful legal move without playing it. Returns the suggestion plus the full board state.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () =>
      JSON.stringify({
        hint: game.hint(),
        ...JSON.parse(snapshot(game.getState())),
      }),
  });

  registerTool({
    name: 'solitaire_new_game',
    description: 'Deal a fresh game of Klondike solitaire. Returns the new board state.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
    execute: async () => snapshot(game.newGame()),
  });

  registerTool({
    name: 'solitaire_read_board',
    description:
      'Read the full board (foundations, tableau, waste, stock, status, ASCII) without making a move. Use this only when you need state you were not just handed by another tool.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => snapshot(game.getState()),
  });
}
