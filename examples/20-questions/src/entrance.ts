/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The galaxy's one-shot entrance: it spirals out along its own arms and
// blooms until it has filled the glass.
//
// The waterline (see `#orbFill` in style.css) is untouched — this runs once,
// when the page first settles into idle, and hands off to a full orb.
//
// Why a path and not an animation: the arms of `full.jpg` are a two-arm
// spiral with exact 2-fold rotational symmetry, so one traced curve plus a
// 180-degree copy covers both. That is a few hundred bytes of `d` against the
// megabytes a sprite sheet of the same reveal would cost, and it reuses the
// bitmap the page already ships.
import fullOrb from './assets/full.jpg'

/**
 * The arms, in canvas coordinates, traced off the art rather than guessed:
 * `full.jpg` minus `empty.jpg` isolates the galaxy from the glass highlights
 * (both files carry the same specular streaks), and the crest of that
 * difference was tracked outward from the core, folded mod 180 so both arms
 * feed one curve.
 *
 * THREE strands, not one. Counting distinct peaks per radius in the folded
 * polar map, the art carries ~3.6 of them — call it three strands per half
 * turn, so six arms once each is paired with its 180-degree twin. Drawing only
 * the brightest pair read as two fat ribbons and nothing like the picture.
 * Six also means each arm needs far less width to close the gaps: the fill
 * audit lands at 240px against the 528px two arms demanded.
 *
 * Each strand is sampled every 1px of radius with bilinear reads and a
 * 1.5-degree transverse window, so its actual wobble survives instead of being
 * averaged into a generic curve; 22 knots then carry it. Strands are tracked
 * with mutual repulsion (17 degrees) so two never collapse onto one feature.
 *
 * The shape is a quadratic-in-ln-r backbone plus the traced residual, with the
 * residual weighted by how strong the crest signal was and faded out past
 * r=140 where the arms dissolve into star-field and the tracker is guessing.
 * A plain logarithmic spiral was tried first and missed by ~47 degrees RMS:
 * the art is an illustration with secondary swirls, not a mathematical galaxy.
 *
 * All run r 26..172 about the core — a little past the rim, so the end caps
 * finish outside the glass instead of leaving a scallop in it.
 */
const ARMS = [
  'M275.4 260.5C276.2 264.0 277.5 275.7 280.0 281.4C282.5 287.1 286.4 291.0 290.5 294.5C294.7 298.1 299.7 300.9 305.1 302.7C310.6 304.4 317.1 305.3 323.1 305.0C329.2 304.8 336.7 302.1 341.6 301.2' +
    'C346.5 300.4 349.0 300.4 352.6 299.9C356.1 299.3 360.5 297.1 362.9 297.8C365.2 298.5 365.2 302.5 366.9 304.2C368.5 305.9 370.6 307.0 372.8 307.9C375.0 308.7 378.1 308.4 380.3 309.2C382.6 310.0 383.4 313.1 386.3 312.7' +
    'C389.3 312.4 395.5 306.4 397.8 307.0C400.2 307.6 401.0 311.5 400.6 316.2C400.2 321.0 394.4 332.6 395.4 335.4C396.3 338.2 403.2 333.0 406.2 332.8C409.3 332.6 411.8 333.0 413.8 334.2C415.7 335.5 416.8 338.0 418.0 340.3' +
    'C419.1 342.7 419.9 345.6 420.6 348.4C421.4 351.2 422.0 354.1 422.6 357.1C423.1 360.1 423.4 363.2 423.7 366.4C423.9 369.6 423.9 374.7 423.9 376.3',
  'M283.0 237.2C281.4 237.4 276.5 237.5 273.3 238.1C270.2 238.7 266.9 240.4 264.1 240.7C261.4 241.1 259.7 238.7 256.9 240.1C254.2 241.6 250.4 246.2 247.6 249.5C244.8 252.7 242.7 258.3 240.4 259.8' +
    'C238.0 261.4 235.4 256.8 233.3 258.9C231.3 260.9 229.6 267.9 228.1 272.3C226.7 276.6 226.9 284.3 224.7 285.0C222.4 285.6 217.1 275.9 214.7 275.9C212.2 275.9 211.4 281.9 210.0 285.0C208.6 288.1 207.1 291.1 206.1 294.6' +
    'C205.0 298.1 205.1 303.7 203.8 306.3C202.5 308.9 197.0 304.8 198.1 310.4C199.2 316.0 210.8 335.9 210.6 339.9C210.4 343.8 199.8 334.2 196.8 334.2C193.8 334.3 193.6 337.7 192.7 340.3C191.8 342.9 192.0 346.8 191.5 349.8' +
    'C191.0 352.8 190.4 355.6 189.9 358.5C189.4 361.4 189.0 364.3 188.6 367.2C188.2 370.1 187.9 373.0 187.6 375.9C187.3 378.8 187.0 383.2 186.8 384.7',
  'M277.5 267.2C276.8 268.2 274.3 271.0 273.0 273.3C271.7 275.6 271.1 278.7 269.7 280.8C268.3 282.8 266.5 284.2 264.7 285.7C263.0 287.2 260.7 288.0 259.0 289.7C257.4 291.3 256.2 293.6 254.9 295.6' +
    'C253.6 297.6 250.1 297.8 251.0 301.6C251.8 305.4 259.4 314.8 260.1 318.5C260.8 322.1 258.3 323.0 255.1 323.5C252.0 324.0 245.2 321.7 241.3 321.4C237.4 321.1 232.3 319.2 231.7 321.7C231.0 324.2 235.8 332.0 237.5 336.4' +
    'C239.2 340.8 245.0 347.7 241.9 348.1C238.8 348.5 217.5 335.2 219.0 338.6C220.6 342.1 246.0 362.6 251.0 368.8C256.1 374.9 248.4 372.8 249.5 375.7C250.7 378.6 256.0 383.2 258.2 386.4C260.3 389.6 260.9 392.1 262.4 394.9' +
    'C264.0 397.8 265.6 400.6 267.4 403.4C269.1 406.1 270.9 408.9 272.9 411.6C274.8 414.3 276.8 416.9 279.0 419.6C281.1 422.2 284.5 426.0 285.6 427.3',
]

/** The galaxy's core, measured off the difference image. The sphere's centre
 *  is (300, 247.5), so the core sits all but dead centre, 8.5px low. */
const CORE_X = 301
const CORE_Y = 256

/**
 * Feathered edges, without a filter.
 *
 * A blurred mask would be the obvious way and the wrong one: the shape changes
 * every frame, so an feGaussianBlur re-runs every frame, and a per-frame filter
 * is the single most expensive thing that could go in this layer.
 *
 * Instead each arm is stroked LAYERS times over, concentric, from a wide dim
 * stroke to a narrow white one. A luminance mask reads those greys as partial
 * coverage, so the stepped stack resolves as a soft edge out of plain fills.
 *
 * Three layers, not more: this is the per-frame cost that matters on an AR1,
 * and every layer is another stroke rasterised each frame for every one of the
 * six arms. Three across a 32% band was checked against the art and no banding
 * survives its noise.
 *
 * The layers are painted brightest-last across ALL arms (see the loop below),
 * or one arm's dim skirt would darken another's bright core where they
 * overlap — which, by the end, is most of the sphere.
 */
const LAYERS = 3
/** Narrowest layer as a fraction of the widest: the feather is this 32% band. */
const FEATHER_FLOOR = 0.68

/**
 * Stroke width at the start and end of the bloom.
 *
 * Starts as a filament. Two arms had to open to 528px to blanket the disc on
 * their own, which read as a pair of fat ribbons rather than a galaxy; six
 * arms share the work and the fill audit closes at 240px, so the trace can
 * stay thin for most of its run. Everything past the rim is clipped away, so
 * the excess costs only the pixels the clip bounds.
 *
 * Keep both in step with the `spiralBloom` keyframes in style.css, which owns
 * the animation; this end only seeds the starting width.
 */
const WIDTH_FROM = 28

/** Draw and bloom. Long enough to read as three beats: trace, spread, fill. */
export const DRAW_MS = 1800
/** Cross-fade to the ordinary full orb. Invisible by design — by now the two
 *  layers are the same picture — it exists to retire the SVG. */
export const HANDOFF_MS = 500

let layer: SVGSVGElement | null = null

/**
 * Build the reveal layer: the full-galaxy bitmap masked to the two arms.
 *
 * The bloom runs past the rim and the art carries a halo outside the glass, so
 * something has to bound it or the bloom drags that halo out as a rectangle.
 * That job belongs to the static `clip-path` on `#orbIntro`, not to a second
 * SVG mask: a mask is a luminance surface the compositor rebuilds every frame,
 * and on an AR1 an extra render surface is exactly the always-on cost worth
 * avoiding. It also sidesteps a trap — an SVG mask with `userSpaceOnUse` and
 * no explicit region defaults to -10%/120% of the VIEWPORT, which in a viewBox
 * offset to (135, 82.5) cuts everything past x=363, y=363 and takes a bite out
 * of the sphere's bottom-right. The arms mask below sets its region for that
 * reason; the glass no longer needs one at all.
 *
 * Geometry matches `#orbFill` exactly — a 330 box at (135, 82.5) — so the one
 * layer that re-rasters covers 30% of the pixels a full-canvas layer would.
 * The viewBox is in canvas coordinates, which is what lets the path above be
 * quoted in the same space the rest of the module measures in.
 *
 * `pathLength="1"` normalises the curve so the dash offset is a plain 1 -> 0,
 * with no need to measure it at runtime. The second arm is a rotated copy of
 * the same `d` string rather than a `<use>`, because a use-element's shadow
 * tree does not reliably pick up the document stylesheet's animation.
 */
function build(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const el = <K extends keyof SVGElementTagNameMap>(n: K) => document.createElementNS(NS, n)

  const svg = el('svg')
  svg.id = 'orbIntro'
  svg.setAttribute('viewBox', '135 82.5 330 330')
  svg.setAttribute('aria-hidden', 'true')

  const defs = el('defs')

  // --- the arms, feathered ---
  const arms = el('mask')
  arms.id = 'orbIntroArms'
  arms.setAttribute('maskUnits', 'userSpaceOnUse')
  arms.setAttribute('x', '135')
  arms.setAttribute('y', '82.5')
  arms.setAttribute('width', '330')
  arms.setAttribute('height', '330')
  // Layer outermost: every arm's dim skirt is laid down before any arm's
  // bright core, so overlaps resolve to the brighter of the two.
  for (let k = 0; k < LAYERS; k++) {
    // Widest and dimmest first; each pass is brighter and narrower.
    const frac = 1 - (1 - FEATHER_FLOOR) * (k / (LAYERS - 1))
    const grey = Math.round((255 * (k + 1)) / LAYERS)
    for (const d of ARMS) {
      for (const turn of [0, 180]) {
        const arm = el('path')
        arm.setAttribute('d', d)
        arm.setAttribute('pathLength', '1')
        arm.setAttribute('fill', 'none')
        arm.setAttribute('stroke', `rgb(${grey},${grey},${grey})`)
        arm.setAttribute('stroke-linecap', 'round')
        arm.style.setProperty('--f', String(frac.toFixed(3)))
        if (turn) arm.setAttribute('transform', `rotate(180 ${CORE_X} ${CORE_Y})`)
        arms.appendChild(arm)
      }
    }
  }
  defs.appendChild(arms)
  svg.appendChild(defs)

  // The art at its usual place: 500x500 inset 50 in the 600 canvas.
  const img = el('image')
  img.setAttribute('href', fullOrb)
  img.setAttribute('x', '50')
  img.setAttribute('y', '50')
  img.setAttribute('width', '500')
  img.setAttribute('height', '500')
  img.setAttribute('mask', 'url(#orbIntroArms)')
  svg.appendChild(img)

  return svg
}

/** Drop the layer and its decoded bitmap; nothing here is wanted twice. */
export function cancelEntrance() {
  layer?.remove()
  layer = null
}

/**
 * Draw the arms in, then call `done` to bring the full orb up behind the fade.
 *
 * Returns false when the entrance is skipped, in which case the caller should
 * settle straight to a full orb: reduced motion, or the scene having gone
 * missing. The float on `#scene` carries the layer, so the reveal never
 * desyncs from the art beneath it.
 */
export function playEntrance(done: () => void): boolean {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
  const scene = document.getElementById('scene')
  if (!scene) return false

  cancelEntrance()
  layer = build()
  layer.style.setProperty('--spiral-w', `${WIDTH_FROM}px`)
  scene.appendChild(layer)
  void layer.getBoundingClientRect() // commit the initial dash offset and width
  layer.classList.add('go')

  window.setTimeout(() => {
    done() // full orb comes up underneath...
    layer?.classList.add('handoff') // ...as the bloom fades off it
    window.setTimeout(cancelEntrance, HANDOFF_MS + 60)
  }, DRAW_MS)

  return true
}
