/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// State-to-DOM painting for both screens. Nothing here listens or reads the
// page back, except the notes box: while typing there, a repaint must not yank
// the caret, so the field is left alone while it holds focus.

import {
  daysBetween,
  finishedItems,
  isLate,
  longDue,
  openItem,
  pendingItems,
  shortDue,
  summarize,
  todayLocal,
  type TodoItem,
  type TodoState,
} from './model.ts';

export interface Page {
  bar: HTMLElement;
  back: HTMLButtonElement;
  heading: HTMLElement;
  progress: HTMLElement;
  listView: HTMLElement;
  scroll: HTMLElement;
  items: HTMLElement;
  empty: HTMLElement;
  drawer: HTMLElement;
  drawerToggle: HTMLButtonElement;
  drawerCount: HTMLElement;
  drawerItems: HTMLElement;
  detailView: HTMLElement;
  detailCircle: HTMLButtonElement;
  detailTitle: HTMLElement;
  detailDue: HTMLElement;
  detailText: HTMLTextAreaElement;
}

export function queryPage(): Page {
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  return {
    bar: byId('bar'),
    back: byId<HTMLButtonElement>('back'),
    heading: byId('heading'),
    progress: byId('progress'),
    listView: byId('list-view'),
    scroll: byId('scroll'),
    items: byId('items'),
    empty: byId('empty'),
    drawer: byId('completed'),
    drawerToggle: byId<HTMLButtonElement>('completed-toggle'),
    drawerCount: byId('completed-count'),
    drawerItems: byId('completed-items'),
    detailView: byId('detail-view'),
    detailCircle: byId<HTMLButtonElement>('detail-circle'),
    detailTitle: byId('detail-title'),
    detailDue: byId('detail-due'),
    detailText: byId<HTMLTextAreaElement>('detail-text'),
  };
}

// The title is context an agent host sees for free: it restates the standing
// rule and names the live screen, which paint() updates on every state change.
const TITLE_RULE =
  'Agentic Todo \u2014 two screens, the full list and one item\u2019s detail. Always act with a todo_* tool: add, check off, edit notes, open an item, go back. Never answer with a description of what you would do.';

function dueCell(item: TodoItem, today: string): string {
  if (item.due === null) return '';
  const late = isLate(item, today);
  return `<span class="due${late ? ' late' : ''}">${shortDue(item.due, today)}</span>`;
}

function row(item: TodoItem, today: string): string {
  const tick = item.done ? '<span class="tick" aria-hidden="true">\u2713</span>' : '';
  return (
    `<li class="item${item.done ? ' is-done' : ''}" data-item-id="${escapeHtml(item.id)}">` +
    `<button class="circle${item.done ? ' on' : ''}" type="button" data-act="toggle" aria-label="${
      item.done ? 'Mark not done' : 'Mark done'
    }" aria-pressed="${item.done}">${tick}</button>` +
    `<button class="row" type="button" data-act="open">` +
    `<span class="name">${escapeHtml(item.title)}</span>${dueCell(item, today)}` +
    `</button></li>`
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function paint(page: Page, state: TodoState): void {
  const open = openItem(state);
  const onDetail = open !== null;
  const today = todayLocal();

  page.listView.hidden = onDetail;
  page.detailView.hidden = !onDetail;
  page.back.hidden = !onDetail;
  page.heading.textContent = onDetail && open ? open.title : 'Agentic Todo';
  page.progress.textContent = summarize(state, today);
  document.title = `${TITLE_RULE} Live screen: ${onDetail && open ? `detail of "${open.title}"` : 'list'}.`;

  if (onDetail && open) {
    page.detailCircle.dataset.itemId = open.id;
    page.detailCircle.classList.toggle('on', open.done);
    page.detailCircle.setAttribute('aria-pressed', String(open.done));
    page.detailCircle.innerHTML = open.done ? '<span class="tick" aria-hidden="true">\u2713</span>' : '';
    page.detailTitle.textContent = open.title;
    page.detailDue.textContent =
      open.due === null
        ? 'No due date.'
        : `Due ${longDue(open.due, today)} \u00b7 ${relativeClause(open.due, today)}${isLate(open, today) ? ' \u00b7 overdue' : ''}`;
    // Focus only earns the caret a reprieve while the same item stays open.
    // When the open item changes the field must follow it, id and text
    // together, or the next keystroke writes the old text onto the new item.
    const sameItem = page.detailText.dataset.itemId === open.id;
    page.detailText.dataset.itemId = open.id;
    if (!sameItem || document.activeElement !== page.detailText) {
      if (page.detailText.value !== open.detail) page.detailText.value = open.detail;
    }
    return;
  }

  const pending = pendingItems(state);
  const finished = finishedItems(state);
  page.items.innerHTML = pending.map((item) => row(item, today)).join('');
  page.empty.hidden = pending.length !== 0;
  page.drawer.hidden = finished.length === 0;
  page.drawerCount.textContent = String(finished.length);
  page.drawerToggle.setAttribute('aria-expanded', String(state.drawerOpen));
  page.drawerItems.hidden = !state.drawerOpen;
  page.drawerItems.innerHTML = state.drawerOpen ? finished.map((item) => row(item, today)).join('') : '';
}

function relativeClause(due: string, today: string): string {
  const gap = daysBetween(due, today);
  if (gap === 0) return 'today';
  if (gap === 1) return 'tomorrow';
  if (gap === -1) return 'yesterday';
  if (gap < -1) return `${-gap} days ago`;
  return `in ${gap} days`;
}
