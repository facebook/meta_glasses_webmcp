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

  it('keeps a game under way unless a restart is asked for', async () => {
    const before = JSON.parse((await executeTool('solitaire_draw')) as string) as Board;
    const kept = JSON.parse((await executeTool('solitaire_new_game')) as string) as Board & {
      already_running?: string;
    };
    expect(kept.already_running).toBeTypeOf('string');
    expect(kept.waste).toEqual(before.waste);
    const fresh = JSON.parse(
      (await executeTool('solitaire_new_game', { restart: true })) as string,
    ) as Board & { already_running?: string };
    expect(fresh.already_running).toBeUndefined();
    expect(fresh.waste.count).toBe(0);
  });

  it('answers a draw with the full board', async () => {
    const board = JSON.parse((await executeTool('solitaire_draw')) as string) as Board;
    expect(board.status).toBe('in progress');
    expect(board.stock).toBe(23);
    expect(board.waste.count).toBe(1);
    expect(board.tableau.map((t) => t.faceDown)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('leads with one plain sentence and names cards in words', async () => {
    const raw = (await executeTool('solitaire_draw')) as string;
    const board = JSON.parse(raw) as Board & { say: string; speech: string };
    expect(Object.keys(board).slice(0, 2)).toEqual(['say', 'speech']);
    expect(board.say).toBe(`Drew the ${board.waste.top}.`);
    expect(board.waste.top).toMatch(/^(ace|two|three|four|five|six|seven|eight|nine|ten|jack|queen|king) of (spades|hearts|diamonds|clubs)$/);
    expect(raw).not.toMatch(/"(A|J|Q|K|10|[2-9])[SHDC]"/);
    expect(raw).not.toContain('ascii');
  });

  it('draws until something can be played in one call', async () => {
    const board = JSON.parse(
      (await executeTool('solitaire_draw', { until_playable: true })) as string,
    ) as Board & { say: string };
    expect(board.say).toMatch(/^Drew (one card|\d+ cards)\. The .+ can be played\.$|^Went through the whole stock/);
  });

  it('says what a move did in words', async () => {
    const hint = JSON.parse((await executeTool('solitaire_hint')) as string) as {
      say: string;
      hint: { from: string; to: string; count?: number; card: string } | null;
    };
    expect(hint.say).not.toMatch(/tableau|foundation:|\b[AJQK2-9][SHDC]\b/);
    if (!hint.hint || hint.hint.from === 'stock') return;
    const moved = JSON.parse(
      (await executeTool('solitaire_move', { from: hint.hint.from, to: hint.hint.to, count: hint.hint.count })) as string,
    ) as { say: string };
    expect(moved.say).toContain(`the ${hint.hint.card}`);
  });

  it('does not count a recycle as a drawn card', async () => {
    let board = JSON.parse((await executeTool('solitaire_read_board')) as string) as Board;
    while (board.stock > 0) board = JSON.parse((await executeTool('solitaire_draw')) as string) as Board;
    // The stock is empty, so the first step recycles; every card on the waste afterwards was drawn.
    const after = JSON.parse(
      (await executeTool('solitaire_draw', { until_playable: true })) as string,
    ) as Board & { say: string };
    const m = /^Drew (one card|(\d+) cards)\./.exec(after.say);
    if (m) expect(m[2] ? Number(m[2]) : 1).toBe(after.waste.count);
  });

  it('speaks refused moves in words', async () => {
    let refused: { content: Array<{ text: string }> } | null = null;
    for (let from = 1; from <= 7 && !refused; from++) {
      for (let to = 1; to <= 7 && !refused; to++) {
        if (from === to) continue;
        const r = (await executeTool('solitaire_move', { from: `tableau:${from}`, to: `tableau:${to}` })) as
          | string
          | { content: Array<{ text: string }> };
        if (typeof r !== 'string' && /Cannot move/.test(r.content[0].text)) refused = r;
      }
    }
    expect(refused).not.toBeNull();
    const text = refused!.content[0].text;
    expect(text).toMatch(/^Cannot move the \w+ of \w+ onto column \d\.$/);
  });

  it('returns bad locations and missing inputs as tool errors', async () => {
    expect(await executeTool('solitaire_move', { from: 'waste', to: 'tableau:9' })).toMatchObject({
      isError: true,
    });
    expect(await executeTool('solitaire_move', { from: 'waste' })).toMatchObject({ isError: true });
  });
});
