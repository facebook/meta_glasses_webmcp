/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure checklist logic. No DOM, no tools, no storage: every function takes a
// state value and returns a new one, so the page, the agent tools, and the
// tests all share one implementation of what each operation means.

export interface TodoItem {
  id: string;
  title: string;
  /** Longer free-form notes. Empty string means none yet. */
  detail: string;
  done: boolean;
  /** Calendar day in `YYYY-MM-DD` form, or null when undated. */
  due: string | null;
}

/** The two screens. `detail` points at an item by id. */
export type Screen = { mode: 'list' } | { mode: 'detail'; itemId: string };

export interface TodoState {
  items: TodoItem[];
  screen: Screen;
  /** Whether the Completed drawer at the foot of the list is unfolded. */
  drawerOpen: boolean;
}

/** How a caller may point at an item: id, title, detail phrase, or position. */
export type ItemRef = string | number;

export type Outcome<T = unknown> =
  | ({ ok: true; state: TodoState } & T)
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function clone(state: TodoState): TodoState {
  return {
    items: state.items.map((item) => ({ ...item })),
    screen: { ...state.screen },
    drawerOpen: state.drawerOpen,
  };
}

export function makeId(): string {
  return 't' + Math.random().toString(36).slice(2, 6);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Dates stay calendar days, never timestamps, so a due day cannot slide
// across a timezone boundary. `todayLocal` reads the viewer's own date parts
// rather than UTC, which would flip to tomorrow all evening west of Greenwich.

/** Today as `YYYY-MM-DD` in the viewer's timezone. */
export function todayLocal(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** True for a well-formed `YYYY-MM-DD` naming a real calendar day. */
export function isDayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(y, m - 1, d);
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
}

function toUtcDay(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from `today` until `due`; negative once overdue. */
export function daysBetween(due: string, today: string = todayLocal()): number {
  return Math.round((toUtcDay(due) - toUtcDay(today)) / 86_400_000);
}

/** Compact due label for the list column. */
export function shortDue(due: string, today: string = todayLocal()): string {
  const gap = daysBetween(due, today);
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  const [y, m, d] = due.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return y === Number(today.slice(0, 4)) ? label : `${label} ${y}`;
}

/** Longer due line for the detail screen, always naming weekday and date. */
export function longDue(due: string, today: string = todayLocal()): string {
  const [y, m, d] = due.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return y === Number(today.slice(0, 4)) ? label : `${label}, ${y}`;
}

/** Shift an ISO day by whole days, keeping calendar-day arithmetic. */
function shiftDay(iso: string, offset: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return todayLocal(new Date(y, m - 1, d + offset));
}

/** Accept null/blank as "no date"; anything else must be a real ISO day. */
function cleanDue(
  due: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (due === null || due === undefined) return { ok: true, value: null };
  const trimmed = due.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!isDayString(trimmed)) {
    return fail(
      `"${due}" is not a date. Send YYYY-MM-DD, working the offset out from the ` +
        `"today" field every snapshot carries instead of guessing.`,
    );
  }
  return { ok: true, value: trimmed };
}

/** First-run list: mixed states so every column and drawer has something. */
export function seedState(today: string = todayLocal()): TodoState {
  return {
    items: [
      {
        id: makeId(),
        title: 'Return the library books',
        detail: 'Two novels and the cookbook. Drop box closes at eight.',
        done: false,
        due: shiftDay(today, -1),
      },
      {
        id: makeId(),
        title: 'Buy coffee beans',
        detail: 'The dark roast from the corner shop, one bag.',
        done: false,
        due: null,
      },
      {
        id: makeId(),
        title: 'Call the plumber',
        detail: 'Kitchen tap is dripping. Mornings are best to reach them.',
        done: false,
        due: shiftDay(today, 2),
      },
      {
        id: makeId(),
        title: 'File the travel receipts',
        detail: 'March trip. Photos of all three receipts are in the album.',
        done: true,
        due: null,
      },
      {
        id: makeId(),
        title: 'Renew the parking permit',
        detail: 'Needs the registration number and last year\'s stub.',
        done: false,
        due: shiftDay(today, 30),
      },
    ],
    screen: { mode: 'list' },
    drawerOpen: false,
  };
}

// References resolve in phases so a spoken name finds its row: exact id,
// then 1-based position, then exact title, then title substring, then detail
// substring. The first phase with exactly one match wins; several matches is
// an ambiguity error naming the candidates so the caller can retry with an id.

interface Found {
  ok: true;
  index: number;
  item: TodoItem;
}
type Resolution = Found | { ok: false; error: string };

function matchingIndexes(state: TodoState, test: (item: TodoItem) => boolean): number[] {
  const out: number[] = [];
  state.items.forEach((item, index) => {
    if (test(item)) out.push(index);
  });
  return out;
}

export function resolveOne(state: TodoState, ref: ItemRef): Resolution {
  if (state.items.length === 0) return fail('The list is empty.');
  const raw = typeof ref === 'number' ? String(ref) : ref.trim();
  if (raw === '') return fail('Empty item reference.');
  const needle = raw.toLowerCase();

  const byId = state.items.findIndex((item) => item.id.toLowerCase() === needle);
  if (byId !== -1) return { ok: true, index: byId, item: state.items[byId] };

  if (/^\d+$/.test(needle)) {
    const index = Number.parseInt(needle, 10) - 1;
    if (index < 0 || index >= state.items.length) {
      return fail(`No item at position ${raw}. The list holds ${state.items.length}.`);
    }
    return { ok: true, index, item: state.items[index] };
  }

  const phases: Array<{ kind: string; hits: number[] }> = [
    { kind: 'title', hits: matchingIndexes(state, (i) => i.title.toLowerCase() === needle) },
    { kind: 'title', hits: matchingIndexes(state, (i) => i.title.toLowerCase().includes(needle)) },
    { kind: 'detail', hits: matchingIndexes(state, (i) => i.detail.toLowerCase().includes(needle)) },
  ];
  for (const phase of phases) {
    if (phase.hits.length === 1) {
      const index = phase.hits[0];
      return { ok: true, index, item: state.items[index] };
    }
    if (phase.hits.length > 1) {
      const names = phase.hits.map((i) => `"${state.items[i].title}" [${state.items[i].id}]`).join(', ');
      return fail(
        `Ambiguous reference "${raw}" — ${phase.hits.length} items match by ${phase.kind}: ${names}. Use an id.`,
      );
    }
  }
  return fail(`Nothing matches "${raw}" (tried ids, titles, and details).`);
}

/** Resolve several references atomically, rejecting repeats and misses. */
function resolveMany(
  state: TodoState,
  refs: ItemRef[],
): { ok: true; indexes: number[] } | { ok: false; error: string } {
  if (refs.length === 0) return fail('No items given.');
  const indexes: number[] = [];
  for (const ref of refs) {
    const found = resolveOne(state, ref);
    if (!found.ok) return found;
    if (indexes.includes(found.index)) {
      return fail(`"${state.items[found.index].title}" is listed twice — name each item once.`);
    }
    indexes.push(found.index);
  }
  return { ok: true, indexes };
}

// Item operations. Adds validate everything before inserting so a batch with
// one bad entry changes nothing; the agent's picture of the list and the
// screen can never half-agree.

/** Append one item; `position` is 1-based and clamped into range. */
export function addOne(
  state: TodoState,
  title: string,
  detail = '',
  due: string | null = null,
  position?: number,
): Outcome<{ item: TodoItem }> {
  const name = title.trim();
  if (name === '') return fail('An item needs a title.');
  const when = cleanDue(due);
  if (!when.ok) return when;
  const next = clone(state);
  const item: TodoItem = { id: makeId(), title: name, detail: detail.trim(), done: false, due: when.value };
  next.items.splice(position === undefined ? next.items.length : clamp(position - 1, 0, next.items.length), 0, item);
  return { ok: true, state: next, item };
}

export type DraftItem = string | { title: string; detail?: string; due?: string | null };

/** Insert several items as one contiguous run, or insert none at all. */
export function addMany(state: TodoState, drafts: DraftItem[], position?: number): Outcome<{ items: TodoItem[] }> {
  if (!Array.isArray(drafts) || drafts.length === 0) return fail('No items given.');
  const pending: TodoItem[] = [];
  for (let n = 0; n < drafts.length; n++) {
    const draft = drafts[n];
    const { title, detail = '', due = null } =
      typeof draft === 'string' ? { title: draft } : draft;
    const name = (title ?? '').trim();
    if (name === '') return fail(`Entry ${n + 1} of ${drafts.length} has no title. Nothing was added.`);
    const when = cleanDue(due);
    if (!when.ok) return fail(`Entry ${n + 1} ("${name}"): ${when.error} Nothing was added.`);
    pending.push({ id: makeId(), title: name, detail: String(detail).trim(), done: false, due: when.value });
  }
  const next = clone(state);
  next.items.splice(position === undefined ? next.items.length : clamp(position - 1, 0, next.items.length), 0, ...pending);
  return { ok: true, state: next, items: pending };
}

/** Check off (or un-check) one item. */
export function markDone(state: TodoState, ref: ItemRef, done: boolean): Outcome<{ item: TodoItem }> {
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  next.items[found.index].done = done;
  return { ok: true, state: next, item: next.items[found.index] };
}

/** Replace one item's notes; blank clears them. */
export function editDetail(state: TodoState, ref: ItemRef, detail: string): Outcome<{ item: TodoItem }> {
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  next.items[found.index].detail = detail.trim();
  return { ok: true, state: next, item: next.items[found.index] };
}

/** Set, move, or clear (null/blank) one item's due day. */
export function editDue(state: TodoState, ref: ItemRef, due: string | null): Outcome<{ item: TodoItem }> {
  const when = cleanDue(due);
  if (!when.ok) return when;
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  next.items[found.index].due = when.value;
  return { ok: true, state: next, item: next.items[found.index] };
}

/** Replace one item's title. */
export function retitle(state: TodoState, ref: ItemRef, title: string): Outcome<{ item: TodoItem }> {
  const name = title.trim();
  if (name === '') return fail('An item needs a title.');
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  next.items[found.index].title = name;
  return { ok: true, state: next, item: next.items[found.index] };
}

/** Remove one item; an open detail of it falls back to the list. */
export function removeOne(state: TodoState, ref: ItemRef): Outcome<{ item: TodoItem }> {
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  const [item] = next.items.splice(found.index, 1);
  if (next.screen.mode === 'detail' && next.screen.itemId === item.id) next.screen = { mode: 'list' };
  return { ok: true, state: next, item };
}

// Ordering is one primitive — "here is the whole new order" — because sort
// criteria are judgement calls (by date? alphabetically? undated first?) that
// belong to the requester, not to this module. The list must name every item
// exactly once, so a short list is a loud error instead of a quiet loss.

/** Reorder the full list in one move; `refs` must be a complete permutation. */
export function reorderAll(state: TodoState, refs: ItemRef[]): Outcome<{ order: string[] }> {
  const found = resolveMany(state, refs);
  if (!found.ok) return found;
  if (found.indexes.length !== state.items.length) {
    const seen = new Set(found.indexes);
    const missing = state.items
      .filter((_, i) => !seen.has(i))
      .map((item) => `"${item.title}"`)
      .join(', ');
    return fail(
      `A reorder must name every item once. The list holds ${state.items.length} but got ${found.indexes.length} — missing: ${missing}.`,
    );
  }
  const next = clone(state);
  next.items = found.indexes.map((i) => next.items[i]);
  return { ok: true, state: next, order: next.items.map((item) => item.id) };
}

/** Open one item's detail screen. */
export function openDetail(state: TodoState, ref: ItemRef): Outcome<{ item: TodoItem }> {
  const found = resolveOne(state, ref);
  if (!found.ok) return found;
  const next = clone(state);
  next.screen = { mode: 'detail', itemId: found.item.id };
  return { ok: true, state: next, item: found.item };
}

/** Return to the list, optionally leaving the drawer open or folded. */
export function showList(state: TodoState, drawerOpen?: boolean): Outcome {
  const next = clone(state);
  next.screen = { mode: 'list' };
  if (drawerOpen !== undefined) next.drawerOpen = drawerOpen;
  return { ok: true, state: next };
}

/** Unfold or fold the Completed drawer without leaving the live screen. */
export function setDrawer(state: TodoState, open: boolean): Outcome {
  const next = clone(state);
  next.drawerOpen = open;
  return { ok: true, state: next };
}

/** Unfinished items in list order — the main list. */
export function pendingItems(state: TodoState): TodoItem[] {
  return state.items.filter((item) => !item.done);
}

/** Finished items in list order — the drawer contents. */
export function finishedItems(state: TodoState): TodoItem[] {
  return state.items.filter((item) => item.done);
}

/** The item on the detail screen, or null on the list (or if it is gone). */
export function openItem(state: TodoState): TodoItem | null {
  const screen = state.screen;
  if (screen.mode !== 'detail') return null;
  return state.items.find((item) => item.id === screen.itemId) ?? null;
}

/** True for an unfinished item whose day has already passed. */
export function isLate(item: TodoItem, today: string = todayLocal()): boolean {
  return !item.done && item.due !== null && daysBetween(item.due, today) < 0;
}

/** One-line progress line, shown on the page and inside snapshots. */
export function summarize(state: TodoState, today: string = todayLocal()): string {
  if (state.items.length === 0) return 'Nothing on the list.';
  const done = state.items.filter((item) => item.done).length;
  const late = state.items.filter((item) => isLate(item, today)).length;
  return `${done} of ${state.items.length} done` + (late > 0 ? ` · ${late} overdue` : '');
}
