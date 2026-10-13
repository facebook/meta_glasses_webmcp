/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Canvas rendering. Perspective-projects the die, draws each visible face
// back-to-front with its answer painted onto the triangle, then punches out
// everything outside the window so only what is behind the glass survives.
//
// Nothing here reads game state directly: `createRenderer` returns a draw
// function that takes the view object `Ball.view()` produces.

import {
  v3,
  worldVerts,
  FACES,
  FACE_INCIRCLE,
  WIN_R,
  WIN_Z,
  type Body,
  type Vec3,
} from './physics'
import type { BallState } from './ball'

const W = 600
const H = 600
const CX = W / 2
const CY = H / 2
/** Camera distance. Small enough that the die visibly looms as it approaches. */
const PERSP = 700

/**
 * Screen radius of the window aperture — the only geometry the page and the
 * artwork have to agree on. public/magic-ball.jpg is cropped so the violet rim it
 * draws sits on this circle, and #liquid is sized to fill it; see style.css.
 */
const WINDOW_SCR_R = (WIN_R * PERSP) / (PERSP - WIN_Z)
/** Faces this far behind the window have faded out entirely. */
const FOG_DEPTH = 35

type Projected = [number, number, number]

function proj(x: number, y: number, z: number): Projected {
  const s = PERSP / (PERSP - z)
  return [CX + x * s, CY - y * s, s]
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  lineHeight: number,
): void {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)

  const startY = (-(lines.length - 1) * lineHeight) / 2
  lines.forEach((line, i) => ctx.fillText(line, 0, startY + i * lineHeight))
}

function drawDie(
  ctx: CanvasRenderingContext2D,
  body: Body,
  faces: string[],
  opacity: number,
): void {
  const wv = worldVerts(body)
  const pv = wv.map((v) => proj(v[0], v[1], v[2]))

  // Painter's algorithm. Twenty triangles is cheap enough that a full sort
  // beats any cleverness, and it keeps the far faces showing through the
  // fog rather than popping.
  const order = FACES.map((_, fi) => ({
    fi,
    z: FACES[fi].reduce((s, i) => s + wv[i][2], 0) / 3,
  })).sort((a, b) => a.z - b.z)

  for (const { fi } of order) {
    const [ai, bi, ci] = FACES[fi]
    const normal = v3.nrm(v3.cross(v3.sub(wv[bi], wv[ai]), v3.sub(wv[ci], wv[ai])))
    const nz = normal[2]
    if (nz < 0) continue // back face

    const faceZ = (wv[ai][2] + wv[bi][2] + wv[ci][2]) / 3
    const fog = Math.max(0, Math.min(1, (WIN_Z - faceZ) / FOG_DEPTH))
    // The clearing fade rides on the same term the depth fog uses, so the die
    // dims out exactly the way it dimmed in.
    //
    // `vis` is ALPHA, not a multiplier on the colour. It used to scale the rgb
    // components, which fades a face toward black rather than toward whatever
    // is behind it — and the faces are opaque, so a die fading out painted
    // solid black triangles over the liquid for the whole 400ms and then
    // vanished in one frame when the draw was skipped at opacity 0. Against a
    // liquid that is itself fading from black back to purple, that read as
    // "fade to black, then cut to purple". Compositing on alpha instead lets
    // the aura come up through the die, which is the cross-fade this wants.
    const vis = (1 - fog) * opacity
    const shade = 0.2 + 0.8 * nz

    const pa = pv[ai]
    const pb = pv[bi]
    const pc = pv[ci]

    ctx.beginPath()
    ctx.moveTo(pa[0], pa[1])
    ctx.lineTo(pb[0], pb[1])
    ctx.lineTo(pc[0], pc[1])
    ctx.closePath()
    ctx.fillStyle = `rgba(${(180 * shade) | 0},${(60 * shade) | 0},${(255 * shade) | 0},${vis})`
    ctx.fill()
    const edge = vis * (0.3 + 0.7 * nz)
    ctx.strokeStyle = `rgba(255,130,255,${edge})`
    ctx.lineWidth = 1.2
    ctx.stroke()

    const textVis = Math.min(1, nz * 1.3) * vis
    if (nz <= 0.3 || textVis <= 0.05 || !faces[fi]) continue

    // Paint the answer in the face's own plane: build the 2D basis by
    // projecting the face's right and up vectors, then hand it to the canvas
    // as a transform. Text then shears with the triangle for free.
    const centre = v3.sc(v3.add(v3.add(wv[ai], wv[bi]), wv[ci]), 1 / 3)
    const right = v3.nrm(v3.sub(wv[bi], wv[ai]))
    const up: Vec3 = v3.nrm(v3.cross(normal, right))

    const p0 = proj(centre[0], centre[1], centre[2])
    const p1 = proj(centre[0] + right[0], centre[1] + right[1], centre[2] + right[2])
    const p2 = proj(centre[0] + up[0], centre[1] + up[1], centre[2] + up[2])

    const rx = p1[0] - p0[0]
    const ry = p1[1] - p0[1]
    let ux = p2[0] - p0[0]
    let uy = p2[1] - p0[1]
    // Canvas Y grows downward, so flip when the basis came out left-handed —
    // otherwise the text renders mirrored.
    if (rx * uy - ry * ux < 0) {
      ux = -ux
      uy = -uy
    }

    ctx.save()
    ctx.beginPath()
    ctx.moveTo(pa[0], pa[1])
    ctx.lineTo(pb[0], pb[1])
    ctx.lineTo(pc[0], pc[1])
    ctx.closePath()
    ctx.clip()
    ctx.setTransform(rx, ry, ux, uy, p0[0], p0[1])

    const size = Math.max(8, Math.min(16, FACE_INCIRCLE * 0.45))
    ctx.font = `bold ${size}px system-ui, sans-serif`
    ctx.fillStyle = `rgba(255,255,255,${textVis})`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    wrapText(ctx, faces[fi], FACE_INCIRCLE * 1.4, size + 1)
    ctx.restore()
  }
}

export interface RenderView {
  body: Body
  faces: string[]
  visible: boolean
  /** 1 normally; ramps to 0 as the window empties after an answer. */
  opacity: number
}

export function createRenderer(canvas: HTMLCanvasElement): (view: RenderView) => void {
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')

  return function draw(view: RenderView): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)

    if (view.visible && view.opacity > 0) drawDie(ctx, view.body, view.faces, view.opacity)

    // The ball is opaque: erase everything the window does not show. Clearing
    // (rather than painting over) is what lets the ball image in the CSS layer
    // below show through, with #liquid reading as the liquid inside.
    //
    // Nothing draws the rims any more. This used to stroke a circle at
    // SPHERE_SCR_R for the silhouette and one at WINDOW_SCR_R for the glass,
    // back when both edges belonged to CSS gradients that had no edge of their
    // own. The artwork draws both, and the crop is aligned so its violet rim
    // lands on WINDOW_SCR_R — a stroke there now would only dull it.
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, H)
    ctx.arc(CX, CY, WINDOW_SCR_R, 0, Math.PI * 2, true)
    ctx.clip()
    ctx.clearRect(0, 0, W, H)
    ctx.restore()
  }
}

/**
 * The DOM half of the page: the question, the answer, and a status line.
 * Kept out of the animation loop — it only runs on state transitions, so the
 * canvas never pays for a layout.
 */
export function createHudRenderer(root: ParentNode = document): (state: BallState) => void {
  const questionEl = root.querySelector<HTMLElement>('#question')
  const answerEl = root.querySelector<HTMLElement>('#answer')
  const app = root.querySelector<HTMLElement>('#app')

  const STATUS: Record<string, string> = {
    idle: 'Ask the ball anything.',
    shaking: 'Shaking…',
    presenting: 'Shaking…',
  }

  return function renderHud(state: BallState): void {
    const clearing = state.status === 'clearing'
    if (questionEl) {
      // Keep the text through the fade — swapping it to empty here would blank
      // it instantly and defeat the transition.
      if (!clearing) questionEl.textContent = state.question ?? ''
      questionEl.hidden = !clearing && !state.question
      questionEl.dataset.clearing = String(clearing)
    }
    if (answerEl) {
      if (!clearing) answerEl.textContent = state.answer ?? STATUS[state.status] ?? ''
      answerEl.dataset.tone = state.tone ?? 'none'
      answerEl.dataset.status = state.status
    }
    if (app) {
      app.dataset.status = state.status
      // Lets the stylesheet tell the two `clearing` beats apart: a linger that
      // ends in an empty window brings the aura back, a fade with a shake
      // behind it stays dark so the new die is not thrown against purple.
      app.dataset.queued = String(state.queuedShake)
    }
  }
}
