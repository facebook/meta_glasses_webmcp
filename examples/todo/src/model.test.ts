/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { describe, expect, it } from 'vitest';
import {
  addMany,
  addOne,
  editDue,
  markDone,
  openDetail,
  removeOne,
  reorderAll,
  resolveOne,
  retitle,
  seedState,
  setDrawer,
  showList,
  summarize,
  todayLocal,
  type TodoState,
} from './model.ts';

function fresh(): TodoState {
  return seedState('2026-09-14');
}

describe('seed', () => {
  it('starts on the list with the drawer folded and a mixed list', () => {
    const state = fresh();
    expect(state.screen).toEqual({ mode: 'list' });
    expect(state.drawerOpen).toBe(false);
    expect(state.items).toHaveLength(5);
    expect(state.items.filter((i) => i.done)).toHaveLength(1);
    expect(state.items.filter((i) => i.due !== null)).toHaveLength(3);
  });

  it('summarizes progress and overdue counts', () => {
    expect(summarize(fresh(), '2026-09-14')).toBe('1 of 5 done · 1 overdue');
  });
});

describe('references', () => {
  it('prefers exact id, then position, then title and detail text', () => {
    const state = fresh();
    const first = state.items[0];
    expect(resolveOne(state, first.id)).toMatchObject({ ok: true, index: 0 });
    expect(resolveOne(state, 2)).toMatchObject({ ok: true, index: 1 });
    expect(resolveOne(state, 'Buy coffee beans')).toMatchObject({ ok: true, index: 1 });
    expect(resolveOne(state, 'corner shop')).toMatchObject({ ok: true, index: 1 });
  });

  it('reports ambiguity with candidates instead of guessing', () => {
    const withDupes = addOne(fresh(), 'Buy coffee beans');
    expect(withDupes.ok).toBe(true);
    if (!withDupes.ok) return;
    const found = resolveOne(withDupes.state, 'coffee');
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error).toMatch(/Ambiguous/);
  });

  it('rejects unknown references and out-of-range positions', () => {
    const state = fresh();
    expect(resolveOne(state, 'no such thing').ok).toBe(false);
    expect(resolveOne(state, 99).ok).toBe(false);
  });
});

describe('mutations', () => {
  it('adds with validation and clamps positions', () => {
    expect(addOne(fresh(), '   ').ok).toBe(false);
    expect(addOne(fresh(), 'Eggs', '', 'next Friday').ok).toBe(false);
    const placed = addOne(fresh(), 'Eggs', 'Half a dozen', null, 1);
    expect(placed.ok).toBe(true);
    if (placed.ok) {
      expect(placed.state.items[0].title).toBe('Eggs');
      expect(placed.item.detail).toBe('Half a dozen');
    }
  });

  it('adds batches atomically', () => {
    expect(addMany(fresh(), ['a', '  ', 'c']).ok).toBe(false);
    const seeded = addMany(fresh(), ['a', 'b']);
    expect(seeded.ok).toBe(true);
    if (seeded.ok) expect(seeded.items).toHaveLength(2);
    // A failed batch leaves the list untouched.
    const failed = addMany(fresh(), ['a', '  ']);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(fresh().items).toHaveLength(5);
  });

  it('checks off, renames, and re-dates through references', () => {
    let state = fresh();
    const done = markDone(state, 'plumber', true);
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    state = done.state;
    expect(state.items[2].done).toBe(true);

    const renamed = retitle(state, state.items[2].id, 'Ring the plumber');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    state = renamed.state;
    expect(state.items[2].title).toBe('Ring the plumber');

    expect(editDue(state, state.items[2].id, '').ok).toBe(true);
  });

  it('falls back to the list when the open item is removed', () => {
    const state = fresh();
    const opened = openDetail(state, 1);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const removed = removeOne(opened.state, 1);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.state.screen).toEqual({ mode: 'list' });
  });

  it('requires reorders to name every item exactly once', () => {
    const state = fresh();
    const ids = state.items.map((i) => i.id);
    expect(reorderAll(state, ids.slice(0, 3)).ok).toBe(false);
    expect(reorderAll(state, [...ids, ids[0]]).ok).toBe(false);
    const reversed = reorderAll(state, [...ids].reverse());
    expect(reversed.ok).toBe(true);
    if (reversed.ok) expect(reversed.order).toEqual([...ids].reverse());
  });

  it('moves between screens and toggles the drawer', () => {
    const state = fresh();
    const opened = openDetail(state, 3);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.state.screen.mode).toBe('detail');
    const home = showList(opened.state);
    expect(home.ok && home.state.screen).toEqual({ mode: 'list' });
    const drawer = setDrawer(state, true);
    expect(drawer.ok && drawer.state.drawerOpen).toBe(true);
  });

  it('builds today in the viewer timezone', () => {
    expect(todayLocal(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
