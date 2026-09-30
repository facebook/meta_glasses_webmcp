/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Human input wiring: the add box, the circles, the rows, the drawer header,
// the back affordance, Escape, and the notes field. Rows repaint on every
// state change, so clicks are handled by delegation on their container — one
// listener covers the main list and the drawer alike.

import type { TodoList } from './app.ts';
import type { Page } from './view.ts';

export function wireEvents(app: TodoList, page: Page): void {
  const addForm = document.getElementById('add') as HTMLFormElement;
  const nameBox = document.getElementById('new-title') as HTMLInputElement;

  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = nameBox.value.trim();
    if (title === '') return;
    app.add(title);
    nameBox.value = '';
    nameBox.focus();
  });

  page.drawerToggle.addEventListener('click', () => {
    app.setDrawer(!app.current().drawerOpen);
  });

  page.scroll.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    if (!button) return;
    const row = button.closest('.item') as HTMLElement | null;
    const id = row?.dataset.itemId;
    if (!id) return;
    if (button.dataset.act === 'toggle') {
      const item = app.current().items.find((entry) => entry.id === id);
      if (item) app.setDone(id, !item.done);
    } else if (button.dataset.act === 'open') {
      app.open(id);
    }
  });

  page.back.addEventListener('click', () => {
    app.home();
  });

  page.detailCircle.addEventListener('click', () => {
    const id = page.detailCircle.dataset.itemId;
    if (!id) return;
    const item = app.current().items.find((entry) => entry.id === id);
    if (item) app.setDone(id, !item.done);
  });

  // Notes commit through the same path the tools use, so typing and a
  // todo_set_detail call land in exactly the same place.
  page.detailText.addEventListener('input', () => {
    const id = page.detailText.dataset.itemId;
    if (id) app.setNotes(id, page.detailText.value);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && app.current().screen.mode === 'detail') app.home();
  });
}
