/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css';
import { TodoList } from './app.ts';
import { wireEvents } from './events.ts';
import { flush } from './store.ts';
import { registerTodoTools } from './tools.ts';
import { paint, queryPage } from './view.ts';

const app = new TodoList();
const page = queryPage();

// One state object feeds the screen, the hand, and the agent alike: checking
// something off by click and by tool pass through the same methods.
app.subscribe((state) => paint(page, state));
wireEvents(app, page);
registerTodoTools(app);

// Saves coalesce, so the last edit before the page goes away needs a nudge.
window.addEventListener('pagehide', flush);
