/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared state holder: the single source of truth both the page and the
// agent tools drive. One method per model operation — apply, persist, notify
// — so a click on a circle and a tool call end up indistinguishable.

import {
  addMany,
  addOne,
  editDetail,
  editDue,
  finishedItems,
  isLate,
  markDone,
  openDetail,
  openItem,
  pendingItems,
  removeOne,
  reorderAll,
  retitle,
  seedState,
  setDrawer,
  showList,
  summarize,
  todayLocal,
  type DraftItem,
  type ItemRef,
  type Outcome,
  type TodoItem,
  type TodoState,
} from './model.ts';
import { load, save } from './store.ts';

export type Listener = (state: TodoState) => void;

export class TodoList {
  private state: TodoState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = load() ?? seedState();
  }

  current(): TodoState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  private commit<R extends Outcome>(result: R): R {
    if (result.ok) {
      this.state = result.state;
      save(this.state);
      this.emit();
    }
    return result;
  }

  add(title: string, detail?: string, due?: string | null, position?: number): Outcome<{ item: TodoItem }> {
    return this.commit(addOne(this.state, title, detail, due, position));
  }

  addBatch(drafts: DraftItem[], position?: number): Outcome<{ items: TodoItem[] }> {
    return this.commit(addMany(this.state, drafts, position));
  }

  setDone(ref: ItemRef, done: boolean): Outcome<{ item: TodoItem }> {
    return this.commit(markDone(this.state, ref, done));
  }

  setNotes(ref: ItemRef, detail: string): Outcome<{ item: TodoItem }> {
    return this.commit(editDetail(this.state, ref, detail));
  }

  setDay(ref: ItemRef, due: string | null): Outcome<{ item: TodoItem }> {
    return this.commit(editDue(this.state, ref, due));
  }

  rename(ref: ItemRef, title: string): Outcome<{ item: TodoItem }> {
    return this.commit(retitle(this.state, ref, title));
  }

  remove(ref: ItemRef): Outcome<{ item: TodoItem }> {
    return this.commit(removeOne(this.state, ref));
  }

  reorder(refs: ItemRef[]): Outcome<{ order: string[] }> {
    return this.commit(reorderAll(this.state, refs));
  }

  open(ref: ItemRef): Outcome<{ item: TodoItem }> {
    return this.commit(openDetail(this.state, ref));
  }

  home(drawerOpen?: boolean): Outcome {
    return this.commit(showList(this.state, drawerOpen));
  }

  setDrawer(open: boolean): Outcome {
    return this.commit(setDrawer(this.state, open));
  }

  /** Restore the seeded list. */
  reset(): TodoState {
    this.state = seedState();
    save(this.state);
    this.emit();
    return this.state;
  }
}

export {
  finishedItems,
  isLate,
  openItem,
  pendingItems,
  summarize,
  todayLocal,
};
