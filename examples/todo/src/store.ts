/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// localStorage persistence. Only the items persist: which screen is live and
// whether the drawer is unfolded are session UI state, so every visit lands
// on the list with the drawer folded. All access is guarded so the app still
// runs where storage is unavailable — it simply forgets between visits.

import { isDayString, makeId, type TodoState } from './model.ts';

const KEY = 'glasses-webmcp:todo:v1';

interface StoredRow {
  id?: unknown;
  title?: unknown;
  detail?: unknown;
  done?: unknown;
  due?: unknown;
}

/** Load the saved items, or null when nothing usable is stored. */
export function load(): TodoState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
      return null;
    }
    const rows = (parsed as { items: StoredRow[] }).items;
    const items = rows
      .filter((row) => row && typeof row.title === 'string')
      .map((row) => ({
        id: typeof row.id === 'string' ? row.id : makeId(),
        title: row.title as string,
        detail: typeof row.detail === 'string' ? row.detail : '',
        done: row.done === true,
        due: typeof row.due === 'string' && isDayString(row.due) ? row.due : null,
      }));
    return { items, screen: { mode: 'list' }, drawerOpen: false };
  } catch {
    return null;
  }
}

/** Persist the items. Silently skips when storage is unavailable. */
function write(state: TodoState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ items: state.items }));
  } catch {
    /* storage unavailable — run without persistence */
  }
}

let pending: TodoState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Write any coalesced state now. Call before the page goes away. */
export function flush(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending !== null) {
    write(pending);
    pending = null;
  }
}

export function save(state: TodoState): void {
  // Typing in the notes field saves on every keystroke, so coalesce the
  // writes: only the last state in an idle window reaches storage. In-memory
  // state is untouched, so a tool call still reads the current list.
  if (typeof setTimeout !== 'function') {
    write(state);
    return;
  }
  pending = state;
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 250);
}

/** Drop the saved items. */
export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
