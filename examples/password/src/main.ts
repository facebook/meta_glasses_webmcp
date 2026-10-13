/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css'
import { Game } from './game.ts'
import { render } from './render.ts'
import { registerTools } from './mcp.ts'

const game = new Game()

// One state API drives both the DOM and the agent tools.
game.subscribe(render)
registerTools(game)

// Expose the game on window so the card and the clock stay drivable from the
// console when no agent is attached — handy for demoing the flip on its own.
declare global {
  interface Window {
    Password: { game: Game }
  }
}
window.Password = { game }

// Vite keeps the module alive across edits; the interval in Game would not stop.
if (import.meta.hot) import.meta.hot.dispose(() => game.dispose())
