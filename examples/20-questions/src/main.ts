/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css'
import { Game } from './game'
import { render } from './render'
import { registerTools } from './mcp'

const game = new Game()

// One state API drives both the DOM and the agent tools.
game.subscribe(render)
registerTools(game)

// Expose the game on window so it stays drivable from the console when no
// agent is attached — handy for demoing the orb without a voice host.
declare global {
  interface Window {
    TwentyQuestions: { game: Game }
  }
}
window.TwentyQuestions = { game }
