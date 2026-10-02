/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Game } from './game.ts';
import { registerSolitaireTools } from './tools.ts';
import { clearTools, executeTool, getTools } from './webmcp.ts';

interface Board {
  status: string;
  stock: number;
  waste: { top: string | null; count: number };
  tableau: Array<{ id: string; faceDown: number; faceUp: string[] }>;
}

beforeEach(() => {
  clearTools();
  registerSolitaireTools(new Game(1));
});

describe('solitaire tools', () => {
  it('registers the five solitaire_* tools', () => {
    expect(getTools().map((tool) => tool.name)).toEqual([
      'solitaire_draw',
      'solitaire_move',
      'solitaire_hint',
      'solitaire_new_game',
      'solitaire_read_board',
    ]);
  });

  it('answers a draw with the full board', async () => {
    const board = JSON.parse((await executeTool('solitaire_draw')) as string) as Board;
    expect(board.status).toBe('in progress');
    expect(board.stock).toBe(23);
    expect(board.waste.count).toBe(1);
    expect(board.tableau.map((t) => t.faceDown)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('returns bad locations and missing inputs as tool errors', async () => {
    expect(await executeTool('solitaire_move', { from: 'waste', to: 'tableau:9' })).toMatchObject({
      isError: true,
    });
    expect(await executeTool('solitaire_move', { from: 'waste' })).toMatchObject({ isError: true });
  });
});
