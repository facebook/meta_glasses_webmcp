/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { GameState } from './game'
import { MAX_QUESTIONS } from './engine'
import { playEntrance, cancelEntrance } from './entrance'
import emptyOrb from './assets/empty.jpg'
import fullOrb from './assets/full.jpg'
import loseOrb from './assets/lose.jpg'

// The glass sphere occupies y 93..402 of the 600px canvas. Measured off
// empty.jpg (the only art without a halo to confuse the silhouette).
const SPHERE_TOP = 93
const SPHERE_BOTTOM = 402

const FLASH_COLOR: Record<string, string> = {
  yes: '#6fe3b0',
  no: '#ff7b8a',
  maybe: '#d9b26a',
  gold: '#d9b26a',
}

const $ = (id: string) => document.getElementById(id)

// Warm the art that is swapped in, so the change never shows a blank frame.
// Only the empty shell is needed up front; the reveal art is fetched once a
// round is actually under way, which keeps a megabyte of decoded bitmap off a
// memory-tight device (and out of the critical path) until it can be used.
new Image().src = emptyOrb
let revealWarmed = false
function warmReveal() {
  if (revealWarmed) return
  revealWarmed = true
  new Image().src = loseOrb
}

let pulseTimer: ReturnType<typeof setTimeout> | undefined
/** Tint the aura behind the orb with the human's last answer. */
function pulse(kind: string | null) {
  const aura = $('aura')
  if (!aura) return
  aura.classList.remove('yes', 'no', 'maybe', 'gold')
  void aura.offsetWidth // restart the transition
  if (kind) aura.classList.add(kind)
  clearTimeout(pulseTimer)
  pulseTimer = setTimeout(() => aura.classList.remove('yes', 'no', 'maybe', 'gold'), 1600)
}

/** Longer phrases shrink to stay inside the glass. */
function flashSize(text: string): number {
  const n = text.length
  if (n <= 4) return 68
  if (n <= 9) return 48
  if (n <= 14) return 36
  return 27
}

// Keep in step with the `flyIn` keyframes in style.css: the caption flies in,
// holds, then from 62% shrinks away as though the orb swallows it.
const FLASH_MS = 1900
const FLASH_ABSORB_AT = 0.62
/** When the orb starts swallowing the word — the cue for the level to rise. */
export const ABSORB_MS = Math.round(FLASH_MS * FLASH_ABSORB_AT)

/** Fly a word into the centre of the orb, hold, then shrink away. */
function flash(text: string, kind: string) {
  const el = $('flash')
  if (!el || !text) return
  el.textContent = text
  el.style.color = FLASH_COLOR[kind] ?? FLASH_COLOR.gold
  el.style.fontSize = `${flashSize(text)}px`
  el.classList.remove('go')
  void el.offsetWidth // restart the animation
  el.classList.add('go')
}

// The orb is two stacked layers that never swap during a round:
//   #orb     — the empty glass shell (or the reveal art once the round ends)
//   #orbFill — the same sphere WITH its galaxy, clipped to a band that grows
//              from the bottom of the glass upward
// A full galaxy is therefore just the fill at 100%, which means the idle orb
// and a twenty-of-twenty orb are the same drawing. Only the clip moves, so a
// question is always exactly one twentieth of the sphere's height.
const fillEl = $('orbFill')
if (fillEl) fillEl.style.backgroundImage = `url("${fullOrb}")`

/** Reveal the galaxy from the bottom of the sphere upward. 0 = empty, 1 = full. */
function setFill(fraction: number, animate = true) {
  const el = $('orbFill')
  if (!el) return
  const f = Math.max(0, Math.min(1, fraction || 0))
  const y = SPHERE_BOTTOM - f * (SPHERE_BOTTOM - SPHERE_TOP)
  if (!animate) {
    // Jump without a wipe (page load, and the reset behind the start fade).
    const prev = el.style.transition
    el.style.transition = 'none'
    el.style.setProperty('--fill-y', `${y.toFixed(1)}px`)
    void el.offsetWidth
    el.style.transition = prev
    return
  }
  el.style.setProperty('--fill-y', `${y.toFixed(1)}px`)
}

/** idle/playing share the empty shell; only the end of a round swaps the art. */
function setBase(mode: 'glass' | 'over') {
  const orb = $('orb')
  if (!orb) return
  orb.style.backgroundImage = `url("${mode === 'over' ? loseOrb : emptyOrb}")`
}

let drainTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Starting a round fades the galaxy out rather than cutting to the empty
 * shell, then resets the clip behind the fade so the first question grows
 * from nothing.
 */
function drainToEmpty() {
  const el = $('orbFill')
  if (!el) return
  clearTimeout(drainTimer)
  el.style.opacity = '0'
  drainTimer = setTimeout(() => {
    // Snap both back with no transition: the band is empty at this point, so
    // there is nothing to see fade, and leaving the opacity animating would
    // race a first question recorded within half a second.
    const prev = el.style.transition
    el.style.transition = 'none'
    el.style.setProperty('--fill-y', `${SPHERE_BOTTOM}px`)
    el.style.opacity = '1'
    void el.offsetWidth
    el.style.transition = prev
  }, 520) // just past the .5s opacity transition
}

function renderHud(state: GameState) {
  const hud = $('hud')
  if (!hud) return
  const left = MAX_QUESTIONS - state.used
  const n = hud.querySelector('.n')
  if (n) n.textContent = String(left)
  const label = hud.lastChild
  if (label) label.textContent = left === 1 ? 'question remaining' : 'questions remaining'
  hud.classList.toggle('spent', left <= 3)
  hud.style.opacity = state.status === 'playing' || state.status === 'idle' ? '1' : '0'
}

/** End-of-game card held inside the orb: the answer and the question count. */
function showFinal(word: string, sub: string, missed: boolean) {
  const el = $('final')
  if (!el) return
  const w = el.querySelector('.word')
  const s = el.querySelector('.sub')
  if (w) w.textContent = word
  if (s) s.textContent = sub
  el.classList.toggle('miss', missed)
  el.classList.add('show')
}

function clearFinal() {
  $('final')?.classList.remove('show', 'miss')
}

let lastEvent: GameState['lastEvent'] = null
let lastStatus: GameState['status'] | null = null
let finalTimer: ReturnType<typeof setTimeout> | undefined
let fillTimer: ReturnType<typeof setTimeout> | undefined
/** The entrance is a page-lifetime one-shot, not a per-round flourish. */
let entranceDone = false

export function render(state: GameState) {
  // Only animate on a genuinely new event, so unrelated re-renders stay quiet.
  const flashed = Boolean(state.lastEvent && state.lastEvent !== lastEvent)
  if (flashed && state.lastEvent) {
    pulse(state.lastEvent.kind)
    flash(state.lastEvent.caption, state.lastEvent.kind)
  }
  const captioned = flashed && Boolean(state.lastEvent?.caption)
  lastEvent = state.lastEvent
  const entered = state.status !== lastStatus
  lastStatus = state.status

  clearTimeout(finalTimer)
  clearTimeout(fillTimer)
  if (state.status === 'idle') {
    // A full orb at rest: the galaxy is the fill at 100%, set without a wipe.
    setBase('glass')
    clearFinal()
    const settle = () => {
      const fill = $('orbFill')
      if (fill) fill.style.opacity = '1'
      setFill(1, false)
    }
    if (entranceDone) {
      settle()
    } else {
      // First arrival at idle: let the galaxy draw itself in along its arms,
      // then bring the ordinary full orb up behind the fade. The spiral only
      // covers the arms, so the hand-off is what completes the picture.
      entranceDone = true
      setFill(1, false) // the layer beneath is already right, just invisible
      if (!playEntrance(settle)) settle()
    }
  } else if (state.status === 'playing' || state.status === 'out_of_questions') {
    // A round starting mid-draw wins: drainToEmpty is about to fade the
    // galaxy out, and a reveal still drawing over it would fight that.
    entranceDone = true
    cancelEntrance()
    setBase('glass')
    clearFinal()
    if (entered && state.used === 0) {
      warmReveal() // the round has begun; the end-card art will be wanted soon
      drainToEmpty() // fade the idle galaxy away, then start from empty
    } else if (captioned) {
      // Read the answer first, then watch it count. The level waits until the
      // orb starts swallowing the caption, so the rise looks like the
      // consequence of the word landing rather than something happening beside
      // it. One twentieth of the sphere per question, on the .9s ease.
      fillTimer = setTimeout(() => setFill(state.used / MAX_QUESTIONS), ABSORB_MS)
    } else {
      setFill(state.used / MAX_QUESTIONS)
    }
  } else {
    // The reveal art carries its own interior, so the fill layer steps aside.
    entranceDone = true
    cancelEntrance()
    setBase('over')
    const done = $('orbFill')
    if (done) done.style.opacity = '0'
    const won = state.status === 'won'
    const word = state.secret ?? (won ? 'got it' : 'unknown')
    const sub = won
      ? `guessed in ${state.used} ${state.used === 1 ? 'question' : 'questions'}`
      : `not guessed · ${state.used} questions used`
    // Let the winning flash finish before the card fades in, or the two
    // overlap inside the glass. The flash animation runs 1.9s; when there is
    // no caption to show (a plain reveal) the card can come up almost at once.
    const wait = state.lastEvent?.caption ? 1900 : 300
    finalTimer = setTimeout(() => showFinal(word, sub, !won), wait)
  }

  renderHud(state)
}
