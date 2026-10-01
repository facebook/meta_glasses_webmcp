/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// List motion layered over paint(), which rebuilds the rows from scratch on
// every state change. Rows are matched by id across the rebuild, so the same
// motion plays whether a person tapped or an agent called a tool.

/** How long a just-checked row shows its tick before it collapses. */
const CHECK_HOLD_MS = 450;
/** Matches the flex gap in `.items`; collapsing into it keeps the rows below from jumping. */
const ROW_GAP_PX = 8;

const painted = new WeakSet<HTMLElement>();

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The row ids currently on screen, in order, or null when there is nothing to
 * animate from: the first paint, or a list that was hidden behind the detail
 * screen, whose changes should not replay on the way back.
 */
export function snapshotRows(list: HTMLElement, visible: boolean): string[] | null {
  const first = !painted.has(list);
  painted.add(list);
  if (first || !visible) return null;
  return [...list.querySelectorAll<HTMLElement>(':scope > .item:not(.leaving)')].map(
    (el) => el.dataset.itemId ?? '',
  );
}

export interface CheckedRow {
  id: string;
  /** The row's markup in its done state, tick included. */
  html: string;
}

/**
 * Runs after the rebuild. New rows fade in and are scrolled into view; each
 * just-checked row goes back where it was, shows its tick, then collapses so
 * the rows below slide up into its place. Reduced motion keeps the scroll,
 * which is not decoration, and drops the rest.
 */
export function animateRows(list: HTMLElement, before: string[] | null, checked: CheckedRow[]): void {
  if (before === null) return;
  const still = reducedMotion();
  const live = new Map<string, HTMLElement>();
  for (const el of list.querySelectorAll<HTMLElement>(':scope > .item')) {
    live.set(el.dataset.itemId ?? '', el);
  }

  for (const [id, el] of live) {
    if (before.includes(id)) continue;
    if (!still) el.classList.add('entering');
    el.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }
  if (still) return;

  for (const { id, html } of checked) {
    const at = before.indexOf(id);
    if (at === -1) continue;
    const next = before.slice(at + 1).map((other) => live.get(other)).find((el) => el !== undefined);
    const template = document.createElement('template');
    template.innerHTML = html;
    const ghost = template.content.firstElementChild as HTMLElement | null;
    if (!ghost) continue;
    ghost.classList.add('leaving');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    list.insertBefore(ghost, next ?? null);
    setTimeout(() => collapse(ghost), CHECK_HOLD_MS);
  }
}

function collapse(row: HTMLElement): void {
  if (!row.isConnected) return;
  row.style.height = `${row.offsetHeight}px`;
  // Read layout so the starting height is committed before it transitions.
  void row.offsetHeight;
  row.classList.add('collapsing');
  row.style.height = '0px';
  row.style.marginBottom = `-${ROW_GAP_PX}px`;
  row.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'height') row.remove();
  });
  // A transition that never ends, as in a background tab, must not strand it.
  setTimeout(() => row.remove(), 1000);
}
