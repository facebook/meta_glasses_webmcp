/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Agent tool surface: the shared TodoList exposed as todo_* tools through
// the local registry in webmcp.ts, which the host library will replace with
// a real bridge when it lands. The page runs as an ordinary app meanwhile.
//
// Reads report, writes acknowledge: todo_read_list returns the snapshot and
// the add call returns its fresh id; every other write answers "ok".
// Failures are returned as tool errors naming the candidates, never thrown.

import { registerTool } from './webmcp.ts';
import type { TodoList } from './app.ts';
import {
  finishedItems,
  isLate,
  openItem,
  pendingItems,
  summarize,
  todayLocal,
  daysBetween,
  type ItemRef,
  type TodoState,
} from './model.ts';

const ACK = 'ok';

/** The full list picture every read hands to the agent. */
function snapshot(state: TodoState): string {
  const open = openItem(state);
  const today = todayLocal();
  return JSON.stringify({
    today,
    view: open ? 'detail' : 'list',
    showing: open ? { id: open.id, title: open.title } : null,
    completed_section: { count: finishedItems(state).length, expanded: state.drawerOpen },
    active_count: pendingItems(state).length,
    items: state.items.map((item) => ({
      id: item.id,
      title: item.title,
      detail: item.detail,
      done: item.done,
      due: item.due,
      due_in_days: item.due === null ? null : daysBetween(item.due, today),
      overdue: isLate(item, today),
    })),
    summary: summarize(state, today),
  });
}

function refusal(reason: string): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: reason }], isError: true };
}

// Hosts flatten list arguments differently — some join values into prose,
// others JSON-encode the array into the string slot — so JSON is tried first
// and comma/newline splitting is the fallback, with stray brackets and quotes
// trimmed in case the payload was almost-JSON.
function splitRefs(input: unknown): ItemRef[] {
  let value: unknown = input;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value.trim());
      if (Array.isArray(parsed)) value = parsed;
    } catch {
      /* fall through to the separator path */
    }
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === 'number' ? part : String(part ?? '').trim()))
      .filter((part) => part !== '');
  }
  let text = (typeof value === 'string' ? value : String(value ?? '')).trim();
  // Unwrap a bracketed list that failed to parse as JSON, once, around the
  // whole payload. Stripping brackets off every chunk instead would corrupt a
  // reference to a title that legitimately contains them.
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const chunks = text.includes('\n') ? text.split('\n') : text.split(',');
  return chunks.map((chunk) => unquote(chunk.trim())).filter((chunk) => chunk !== '');
}

/** Drop one matched pair of surrounding quotes, leaving inner ones alone. */
function unquote(value: string): string {
  const first = value[0];
  return value.length > 1 && (first === '"' || first === "'") && value.endsWith(first)
    ? value.slice(1, -1).trim()
    : value;
}

// Titles are free text, so brackets and quotes are ordinary characters here
// and must survive. Only splitRefs strips them, and only to clean up ids.
function splitTitles(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((part) => String(part ?? '').trim()).filter((part) => part !== '');
  }
  const text = typeof input === 'string' ? input : String(input ?? '');
  const chunks = text.includes('\n') ? text.split('\n') : text.split(',');
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk !== '');
}

export function registerTodoTools(app: TodoList): void {
  // Registered first on purpose: the smoke suite calls the first tool that
  // takes no arguments, and that must never be a mutating one.
  registerTool({
    name: 'todo_read_list',
    description:
      'Read the whole list without changing anything. The only tool that returns state — writes just acknowledge, so read once and track your own edits after that.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true },
    execute: async () => snapshot(app.current()),
  });

  registerTool({
    name: 'todo_add_item',
    description:
      'Add one item. Keep the title short and put anything longer in detail. Set due only when the user named a deadline. Returns the fresh id, e.g. {"id":"t4a1"}.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Buy milk".' },
        detail: { type: 'string', description: 'Optional longer notes.' },
        due: {
          type: 'string',
          description: 'Optional due day, YYYY-MM-DD. Work relative dates out from the snapshot "today".',
        },
        position: { type: 'number', description: 'Optional 1-based slot. Omit to append.' },
      },
      required: ['title'],
    },
    execute: async ({ title, detail, due, position }: { title: string; detail?: string; due?: string; position?: number }) => {
      const result = app.add(title, detail, due, position);
      if (!result.ok) return refusal(result.error);
      return JSON.stringify({ id: result.item.id });
    },
  });

  registerTool({
    name: 'todo_add_items',
    description:
      'Add SEVERAL items in one call — "peppers, onions, carrots" is one call, not three. Titles as one comma-separated string, or one per line when a title holds a comma. Titles only; anything needing notes or a date goes through todo_add_item on its own. All-or-nothing: one blank title adds nothing. Returns the fresh ids in order.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'string', description: 'Titles in order, e.g. "peppers, onions, carrots".' },
        position: {
          type: 'number',
          description: 'Optional 1-based slot for the first title; the rest follow. Omit to append.',
        },
      },
      required: ['items'],
    },
    execute: async ({ items, position }: { items: unknown; position?: number }) => {
      const result = app.addBatch(splitTitles(items), position);
      if (!result.ok) return refusal(result.error);
      return JSON.stringify({ ids: result.items.map((item) => item.id) });
    },
  });

  registerTool({
    name: 'todo_check_items',
    description:
      'Check off ONE item, or un-check it with done=false. One item per call — name several and the call is refused.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item to check off.' },
        done: { type: 'boolean', description: 'True to check off (default), false to un-check.' },
      },
      required: ['item'],
    },
    execute: async ({ item, done }: { item: string; done?: boolean }) => {
      const result = app.setDone(item, done !== false);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_set_detail',
    description:
      'Replace one item\u2019s notes wholesale — to extend, resend the old text plus the new. Empty string clears.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item to change.' },
        detail: { type: 'string', description: 'The new notes. Empty clears them.' },
      },
      required: ['item', 'detail'],
    },
    execute: async ({ item, detail }: { item: string; detail: string }) => {
      const result = app.setNotes(item, detail);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_set_due_date',
    description:
      'Set, move, or clear (empty string) one item\u2019s due day. YYYY-MM-DD only — work relative dates out from the snapshot "today", never guess it.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item to change.' },
        due: { type: 'string', description: 'YYYY-MM-DD, or empty to clear.' },
      },
      required: ['item', 'due'],
    },
    execute: async ({ item, due }: { item: string; due: string }) => {
      const result = app.setDay(item, due);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_rename_item',
    description: 'Change one item\u2019s title. Notes and done state are untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item to rename.' },
        title: { type: 'string', description: 'The new title.' },
      },
      required: ['item', 'title'],
    },
    execute: async ({ item, title }: { item: string; title: string }) => {
      const result = app.rename(item, title);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_delete_items',
    description:
      'Delete ONE item for good. Checking off is not deleting — only for "remove"/"delete". One item per call.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'The item to delete.' },
      },
      required: ['item'],
    },
    annotations: { destructiveHint: true },
    execute: async ({ item }: { item: string }) => {
      const result = app.remove(item);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_reorder_items',
    description:
      'Reorder the whole list at once. You decide the order — by date, alphabetically, however asked — and send every item exactly once, comma-separated (ids are safest). Moving one item is the same call with that entry pulled to its new slot. Refused when any item is missing.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'string', description: 'Every item in the new order. A complete permutation.' },
      },
      required: ['items'],
    },
    execute: async ({ items }: { items: unknown }) => {
      const result = app.reorder(splitRefs(items));
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_navigate',
    description:
      'Move between the two screens. to="list" shows the whole list; to="detail" opens one item and needs item. Only navigate when the user wants to look at something — any item can be read from the snapshot without opening it.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['list', 'detail'], description: 'Which screen to show.' },
        item: { type: 'string', description: 'Required for to="detail". Ignored for to="list".' },
      },
      required: ['to'],
    },
    execute: async ({ to, item }: { to: 'list' | 'detail'; item?: string }) => {
      if (to === 'detail') {
        if (!item) return refusal('to="detail" needs an `item`. Use to="list" to go back.');
        const opened = app.open(item);
        if (!opened.ok) return refusal(opened.error);
        return ACK;
      }
      const listed = app.home();
      if (!listed.ok) return refusal(listed.error);
      return ACK;
    },
  });

  registerTool({
    name: 'todo_show_completed',
    description:
      'Unfold or fold the Completed drawer at the foot of the list. Say which state you want — the snapshot already reports the current one, so never toggle blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        show: { type: 'boolean', description: 'True to unfold, false to fold.' },
      },
      required: ['show'],
    },
    execute: async ({ show }: { show: boolean }) => {
      const result = app.setDrawer(show);
      if (!result.ok) return refusal(result.error);
      return ACK;
    },
  });
}
