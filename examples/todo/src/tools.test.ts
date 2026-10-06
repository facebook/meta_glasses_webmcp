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

interface CapturedTool {
  name: string;
  execute: (args: unknown) => unknown | Promise<unknown>;
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

  it('publishes the tools to document.modelContext', async () => {
    const ctx = fakeContext();
    const seen: CapturedTool[] = [];
    withGlobals(
      {
        document: {
          modelContext: {
            registerTool: (tool: CapturedTool) => {
              ctx.registerTool(tool);
              seen.push(tool);
            },
            unregisterTool: (name: string) => ctx.unregisterTool(name),
          },
        },
      },
      () => {
        registerTodoTools(new TodoList());
      },
    );
    expect(ctx.registered[0]).toBe('todo_read_list');
    expect(ctx.registered).toHaveLength(11);
    // The host gets a live handler.
    expect(seen.every((tool) => typeof tool.execute === 'function')).toBe(true);
    const answer = (await seen[0].execute({})) as string;
    expect(JSON.parse(answer).items.length).toBeGreaterThan(0);
  });

  it('refuses duplicate registration', () => {
    const app = new TodoList();
    registerTodoTools(app);
    expect(() => registerTodoTools(app)).toThrow(/already registered/);
  });
});

interface FakeContext {
  registered: string[];
  unregistered: string[];
  registerTool: (tool: { name: string }) => void;
  unregisterTool: (name: string) => void;
}

function fakeContext(): FakeContext {
  const ctx: FakeContext = {
    registered: [],
    unregistered: [],
    registerTool: (tool) => {
      ctx.registered.push(tool.name);
    },
    unregisterTool: (name) => {
      ctx.unregistered.push(name);
    },
  };
  return ctx;
}

// Node defines its own navigator, so the originals are restored, not deleted.
function withGlobals(globals: { document?: unknown; navigator?: unknown }, run: () => void): void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(globals)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const probe = {
  name: 'probe',
  description: 'Test tool.',
  inputSchema: { type: 'object' as const },
  execute: () => 'ok',
};

describe('document.modelContext handoff', () => {
  it('registers and unregisters with document.modelContext', () => {
    const ctx = fakeContext();
    withGlobals({ document: { modelContext: ctx } }, () => {
      registerTool(probe)();
    });
    expect(ctx.registered).toEqual(['probe']);
    expect(ctx.unregistered).toEqual(['probe']);
  });

  it('registers locally when no host context exists', () => {
    let names: string[] = [];
    withGlobals({ document: {} }, () => {
      const unregister = registerTool(probe);
      names = getTools().map((tool) => tool.name);
      unregister();
    });
    expect(names).toEqual(['probe']);
    expect(getTools()).toEqual([]);
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

  it('treats an explicit null required input as missing', async () => {
    registerTodoTools(new TodoList());
    for (const args of [{ title: null }, { title: undefined }]) {
      const answer = (await executeTool('todo_add_item', args)) as { isError: boolean };
      expect(answer.isError).toBe(true);
    }
  });
});
