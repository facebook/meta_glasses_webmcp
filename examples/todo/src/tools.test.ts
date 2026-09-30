/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { TodoList } from './app.ts';
import { registerTodoTools } from './tools.ts';
import { clearTools, executeTool, getTools, registerTool } from './webmcp.ts';

interface Snapshot {
  today: string;
  view: string;
  showing: { id: string; title: string } | null;
  completed_section: { count: number; expanded: boolean };
  active_count: number;
  items: Array<{
    id: string;
    title: string;
    detail: string;
    done: boolean;
    due: string | null;
    due_in_days: number | null;
    overdue: boolean;
  }>;
  summary: string;
}

interface UnknownSurface {
  listTools?: () => Array<{ name: string }>;
  callTool?: (name: string, args: unknown) => Promise<unknown>;
}

async function read(): Promise<Snapshot> {
  return JSON.parse((await executeTool('todo_read_list', {})) as string) as Snapshot;
}

beforeEach(() => {
  clearTools();
});

describe('tool registration', () => {
  it('registers eleven tools with the read tool first', () => {
    registerTodoTools(new TodoList());
    const names = getTools().map((tool) => tool.name);
    expect(names[0]).toBe('todo_read_list');
    expect(names).toHaveLength(11);
  });

  it('publishes the tools on the in-page host surface', async () => {
    registerTodoTools(new TodoList());
    const surface = (globalThis as { __webmcp?: UnknownSurface }).__webmcp;
    expect(surface).toBeDefined();
    const listed = surface?.listTools?.() ?? [];
    expect(listed.map((tool) => tool.name)[0]).toBe('todo_read_list');
    expect(listed).toHaveLength(11);
    // Snapshots carry no handler.
    expect(listed.every((tool) => !('handler' in tool) && !('execute' in tool))).toBe(true);
    const answer = (await surface?.callTool?.('todo_read_list', {})) as string;
    expect(JSON.parse(answer).items.length).toBeGreaterThan(0);
  });

  it('fans out to a host-owned surface when one exists', () => {
    const seen: string[] = [];
    const scope = globalThis as { __webmcp?: unknown };
    scope.__webmcp = {
      registerTool: (def: { name: string }) => {
        seen.push(def.name);
      },
      unregisterTool: () => {},
    };
    try {
      registerTodoTools(new TodoList());
      expect(seen).toHaveLength(11);
      expect(seen[0]).toBe('todo_read_list');
    } finally {
      delete scope.__webmcp;
    }
  });

  it('refuses duplicate registration', () => {
    const app = new TodoList();
    registerTodoTools(app);
    expect(() => registerTodoTools(app)).toThrow(/already registered/);
  });
});

describe('tool round-trips', () => {
  it('reads the snapshot, adds by tool, and checks off by tool', async () => {
    const app = new TodoList();
    registerTodoTools(app);

    const before = await read();
    expect(before.items.length).toBeGreaterThan(0);
    expect(before.view).toBe('list');
    expect(before.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const added = JSON.parse((await executeTool('todo_add_item', { title: ' driven by tools' })) as string) as {
      id: string;
    };
    expect(typeof added.id).toBe('string');

    expect(await executeTool('todo_check_items', { item: added.id })).toBe('ok');
    const after = await read();
    expect(after.items.find((item) => item.id === added.id)?.done).toBe(true);
    expect(after.completed_section.count).toBe(before.completed_section.count + 1);
  });

  it('returns errors as values for bad references', async () => {
    registerTodoTools(new TodoList());
    const answer = (await executeTool('todo_check_items', { item: 'no such thing' })) as {
      isError: boolean;
    };
    expect(answer.isError).toBe(true);
  });

  it('moves between screens through todo_navigate', async () => {
    const app = new TodoList();
    registerTodoTools(app);
    const first = (await read()).items[0];

    expect(await executeTool('todo_navigate', { to: 'detail', item: first.id })).toBe('ok');
    const opened = await read();
    expect(opened.view).toBe('detail');
    expect(opened.showing?.id).toBe(first.id);

    expect(await executeTool('todo_navigate', { to: 'list' })).toBe('ok');
    expect((await read()).view).toBe('list');
  });

  it('rejects partial reorders', async () => {
    const app = new TodoList();
    registerTodoTools(app);
    const ids = (await read()).items.map((item) => item.id);
    const short = (await executeTool('todo_reorder_items', { items: ids[0] })) as { isError: boolean };
    expect(short.isError).toBe(true);
    // Nothing moved.
    expect((await read()).items.map((item) => item.id)).toEqual(ids);
  });

  it('guards required inputs before handlers run', async () => {
    registerTodoTools(new TodoList());
    const answer = (await executeTool('todo_add_item', {})) as { isError: boolean };
    expect(answer.isError).toBe(true);
  });

  it('replays the tool set to a host that arrives after registration', () => {
    registerTodoTools(new TodoList());
    const scope = globalThis as { __webmcp?: unknown };
    const seen: string[] = [];
    // A real host replacing the in-page surface after the page registered.
    scope.__webmcp = {
      registerTool: (tool: { name: string }) => void seen.push(tool.name),
      unregisterTool: () => {},
    };
    registerTool({
      name: 'late_tool',
      description: 'registered after the host arrived',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    expect(seen).toContain('todo_read_list');
    expect(seen).toContain('late_tool');
    delete scope.__webmcp;
  });

  // Stripping brackets off each chunk would turn the reference "[a]" into "a",
  // which exact-matches the other item and silently reorders the wrong one.
  it('resolves a bracketed title reference to the bracketed item', async () => {
    const app = new TodoList();
    registerTodoTools(app);
    await executeTool('todo_add_items', { items: ['[a]', 'a'] });
    const titles = app.current().items.map((item) => item.title);
    const swapped = [...titles.slice(0, -2), titles[titles.length - 1], titles[titles.length - 2]];
    expect(await executeTool('todo_reorder_items', { items: swapped.join('\n') })).toBe('ok');
    expect(app.current().items.map((item) => item.title)).toEqual(swapped);
  });

  it('keeps brackets and quotes in added titles', async () => {
    const app = new TodoList();
    registerTodoTools(app);
    await executeTool('todo_add_items', { items: 'Read [draft]\nCall "Sam"' });
    const titles = app.current().items.map((item) => item.title);
    expect(titles).toContain('Read [draft]');
    expect(titles).toContain('Call "Sam"');
  });

  it('returns a tool error when a handler throws', async () => {
    registerTool({
      name: 'boom',
      description: 'throws on purpose',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        throw new Error('kaboom');
      },
    });
    const answer = (await executeTool('boom', {})) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(answer.isError).toBe(true);
    expect(answer.content[0].text).toContain('kaboom');
  });

  it('enforces required inputs through the in-page surface too', async () => {
    registerTodoTools(new TodoList());
    const surface = (globalThis as { __webmcp?: UnknownSurface }).__webmcp;
    const answer = (await surface?.callTool?.('todo_add_item', {})) as { isError: boolean };
    expect(answer.isError).toBe(true);
  });

  it('treats an explicit null required input as missing', async () => {
    registerTodoTools(new TodoList());
    for (const args of [{ title: null }, { title: undefined }]) {
      const answer = (await executeTool('todo_add_item', args)) as { isError: boolean };
      expect(answer.isError).toBe(true);
    }
  });
});
