/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import './style.css'
import { Ball } from './ball'
import { createHudRenderer, createRenderer } from './render'
import { callLog, registerTools } from './mcp'
import { MODE } from './mode'

const ball = new Ball()
const draw = createRenderer(document.getElementById('c') as HTMLCanvasElement)
const renderHud = createHudRenderer()

// One state API drives the canvas, the DOM readout, and the agent tools.
ball.subscribe(renderHud)
renderHud(ball.getState())
registerTools(ball, MODE)

// Clicking the ball shakes it with no question attached, so the page is still
// a magic ball when no agent is listening. A hand shake always uses the fair
// die — there is no AI in the loop to write an answer for it.
document.getElementById('app')?.addEventListener('click', () => void ball.ask())

function loop(now: number) {
  ball.tick(now)
  draw(ball.view())
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// A hidden tab stops requestAnimationFrame, which freezes the die mid-fall for
// a shake nobody is watching. The reading is already decided, so jump to it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) ball.settleNow()
})

// Keep it drivable from the console for demos without a voice host.
declare global {
  interface Window {
    MagicBall: { ball: Ball; mode: typeof MODE; log: typeof callLog }
  }
}
// `log` is the tool-invocation ring buffer. A rejected call moves nothing on
// screen, so on a headset it is the only way to tell a malformed call from a
// tool that never fired at all.
window.MagicBall = { ball, mode: MODE, log: callLog }
