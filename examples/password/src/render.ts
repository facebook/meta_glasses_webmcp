/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The card, and everything around it.
//
// One rule drives the whole file: content is only ever swapped while the card
// is face-down. A new word arrives, the card spins away on its vertical axis,
// the text is replaced behind it, and it spins back. Bumping `flipToken` in the
// state is how game.ts asks for that.
import { HALF_SECONDS, blanks, formatClock, revealMask } from './engine.ts'
import type { Feedback, GameState, Struck } from './game.ts'

/** Half the flip, so the swap lands while the front is hidden. */
const HALF_FLIP_MS = 390
const FLASH_MS = 750
/**
 * How long a burned half-one card sits with the offending word struck through
 * before the table turns over. Long enough to read the word and connect it to
 * what was just said; the CSS animation itself is done well inside it.
 */
const STRIKE_MS = 1150
/** No animation to wait out, so the beat only has to be readable. */
const STRIKE_REDUCED_MS = 700
/** A won word: per-letter stagger left to right, and one letter's spin. */
const SPIN_STEP_MS = 55
const SPIN_MS = 420
/** Beat on the finished green word before the table turns over. */
const SPIN_HOLD_MS = 400
/** Per letter as a half-two word fills its blanks back in, then the beat after. */
const REVEAL_STEP_MS = 62
const REVEAL_HOLD_MS = 720
/** Usable width inside the card, i.e. 330px less its 24px padding each side. */
const CARD_TEXT_PX = 276

/**
 * Shrink the word until it fits on one line.
 *
 * The card is fixed-width and the deck runs from HONEY to LIGHTHOUSE, so a
 * single font size cannot serve both — at 44px, LIGHTHOUSE dropped its final E
 * onto a second line. `emPerChar` is the measured average advance for the face
 * in use: heavy uppercase sans is wide, and the monospace blanks carry an
 * extra 0.08em of letter-spacing per slot.
 */
function fitFont(text: string, maxPx: number, emPerChar: number): number {
  if (!text.length) return maxPx
  return Math.min(maxPx, Math.floor(CARD_TEXT_PX / (text.length * emPerChar)))
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const app = $('app')
const clock = $('clock')
const card = $('card')
const front = document.querySelector<HTMLElement>('.face.front')!
const eyebrow = $('eyebrow')
const secretEl = $('secret')
const bannedLabel = $('bannedLabel')
const bannedEl = $<HTMLUListElement>('banned')
const scoreYou = $('scoreYou')
const scoreAi = $('scoreAi')
const youBox = document.querySelector<HTMLElement>('.score.you')!
const aiBox = document.querySelector<HTMLElement>('.score.ai')!
const ticker = $('ticker')
const verdict = $('verdict')
const tally = $('tally')

let lastToken = -1
let flipTimer: number | null = null
let flashTimer: number | null = null
let revealTimer: number | null = null
let strikeTimer: number | null = null
/** One per letter plus the finish, so an interrupted win can be cancelled. */
let spinTimers: number[] = []

/**
 * Paint the banned list. `struck` names the one entry to mark, which is how a
 * burned card shows what killed it — matched against the deck's spelling, which
 * is what `findViolation` hands back, so it always lines up with a list item.
 */
function setBanned(items: string[], hint: string | null, struck: string | null = null) {
  bannedEl.replaceChildren(
    ...(hint ? [hint] : items).map((text) => {
      const li = document.createElement('li')
      li.textContent = text
      if (struck && text === struck) li.className = 'struck'
      return li
    }),
  )
  front.classList.toggle('guessing', Boolean(hint))
  bannedLabel.style.visibility = items.length || hint ? 'visible' : 'hidden'
  bannedLabel.textContent = hint ? 'You are guessing' : 'Never say'
}

function setSecret(text: string, mono: boolean, maxPx: number) {
  secretEl.textContent = text
  secretEl.classList.toggle('blanks', mono)
  secretEl.classList.remove('filled')
  secretEl.style.fontSize = `${fitFont(text, maxPx, mono ? 0.68 : 0.7)}px`
}

/**
 * The same face, but every character its own element so they can be animated
 * one at a time. Returns just the letters — spaces stay plain text nodes, so
 * the gap between half two's slots is not a box that can be spun.
 */
function setSecretLetters(display: string, mono: boolean, maxPx: number): HTMLElement[] {
  secretEl.classList.toggle('blanks', mono)
  secretEl.classList.remove('filled')
  secretEl.style.fontSize = `${fitFont(display, maxPx, mono ? 0.68 : 0.7)}px`

  const nodes: Node[] = []
  const letters: HTMLElement[] = []
  for (const ch of display) {
    if (ch === ' ') {
      nodes.push(document.createTextNode(' '))
      continue
    }
    const span = document.createElement('span')
    span.className = 'ch'
    span.textContent = ch
    nodes.push(span)
    letters.push(span)
  }
  secretEl.replaceChildren(...nodes)
  return letters
}

/** Write the face for the current card. Only ever called mid-flip. */
function paintFace(state: GameState) {
  const { card: current, phase } = state

  if (phase === 'idle' || !current) {
    eyebrow.textContent = 'Two halves — you clue first'
    setSecret('PASSWORD', false, 44)
    setBanned([], null)
    return
  }

  if (state.secretOnScreen) {
    // Half one: you are the clue-giver, so you get the whole card.
    eyebrow.textContent = 'Describe this — the AI guesses'
    setSecret(current.secret, false, 44)
    setBanned(current.banned, null)
    return
  }

  // Half two — and half time, which is the same picture.
  //
  // Half time used to be its own placard: a card reading HALF TIME with the
  // swap explained underneath. It tested badly. It reads as an interstitial to
  // be waited out, so the human waits, and the one thing they actually needed
  // to know — that they are the guesser now — was buried in small print under a
  // word that is not the word. The page already holds half two's first card by
  // this point (`endHalf` deals it), so the honest thing to draw is that card:
  // the blanks they are about to guess at, labelled as their turn.
  //
  // The nudge survives from the old placard, and it still earns its place — the
  // clock can expire between turns, in which case no tool result carries the
  // news and the agent sits silent until the human speaks first.
  const handingOver = phase === 'intermission'
  eyebrow.textContent = handingOver ? 'Your turn to guess' : 'The AI is describing this'
  setSecret(blanks(current.secret), true, 27)
  setBanned(
    [],
    handingOver
      ? `${current.secret.length} letters. The AI describes now — if it stays quiet, say "ready".`
      : `${current.secret.length} letters. Say your guess out loud.`,
  )
}

function flip(state: GameState) {
  if (flipTimer !== null) clearTimeout(flipTimer)

  // Only full time clears the table; half time keeps a card up (see paintFace).
  const hidden = state.phase === 'over'
  card.classList.remove('revealed')
  card.classList.toggle('gone', hidden)
  if (hidden) return

  flipTimer = globalThis.setTimeout(() => {
    paintFace(state)
    card.classList.add('revealed')
    flipTimer = null
  }, HALF_FLIP_MS)
}

/**
 * Hold a burned half-one card up with the word that killed it struck through,
 * then `done`.
 *
 * Same trick as `revealWord`: the state has already dealt the next card, so the
 * face being drawn here is the outgoing one, carried across in `state.struck`.
 * Until this existed a foul only tinted the table red — the human was told they
 * had said a banned word but never which, which is the one piece of information
 * that makes the next card go better.
 */
function strikeCard(struck: Struck, done: () => void) {
  eyebrow.textContent = 'Card burned'
  setSecret(struck.secret, false, 44)
  setBanned(struck.banned, null, struck.word)

  const instant = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  strikeTimer = globalThis.setTimeout(
    () => {
      strikeTimer = null
      done()
    },
    instant ? STRIKE_REDUCED_MS : STRIKE_MS,
  )
}

/**
 * A won word: each letter turns over left to right and lands green, then `done`.
 *
 * Both halves spin the word in the same face: the heavy sans at the size half
 * one shows its words. Half two's blanks are monospace and smaller, and drawing
 * the win into those slots made the same moment look different in each half.
 *
 * This replaces `revealWord` on a correct guess rather than following it: the
 * spin already shows the word, and playing both put a two-second pause between
 * getting one right and the next card.
 */
function celebrate(word: string, done: () => void) {
  eyebrow.textContent = 'Got it'
  setBanned([], null)

  const letters = setSecretLetters(word, false, 44)

  const instant = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  if (instant) {
    for (const l of letters) l.classList.add('spun')
    spinTimers.push(globalThis.setTimeout(done, SPIN_HOLD_MS))
    return
  }

  letters.forEach((letter, i) => {
    spinTimers.push(globalThis.setTimeout(() => letter.classList.add('spun'), i * SPIN_STEP_MS))
  })
  // The last letter starts last, so the word is only finished a full spin after
  // that — wait for the whole run rather than a fixed guess, or long words get
  // cut off mid-turn.
  const total = Math.max(0, letters.length - 1) * SPIN_STEP_MS + SPIN_MS + SPIN_HOLD_MS
  spinTimers.push(globalThis.setTimeout(done, total))
}

/**
 * Fill a half-two card's blanks in with the word it was hiding, then `done`.
 *
 * The card is still face-up and still showing the blanks the human spent the
 * card looking at, so the letters land in the slots they were guessing at. This
 * runs before the flip, which is the only reason the answer is ever seen at
 * all — the state has already moved on to the next word by the time we get here.
 */
function revealWord(secret: string, feedback: Feedback, done: () => void) {
  // The card is over, so the rest of the face has to stop claiming otherwise —
  // "the AI is describing this / say your guess out loud" sitting under the
  // answer reads as a prompt to keep guessing.
  eyebrow.textContent =
    feedback === 'correct'
      ? 'You got it'
      : feedback === 'violation'
        ? 'Card burned'
        : feedback === 'skip'
          ? 'Passed'
          : 'The word was'
  setBanned([], null)

  const instant = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  let shown = instant ? secret.length : 0

  const tick = () => {
    setSecret(revealMask(secret, shown), true, 27)
    if (shown < secret.length) {
      shown++
      revealTimer = globalThis.setTimeout(tick, REVEAL_STEP_MS)
      return
    }
    secretEl.classList.add('filled')
    revealTimer = globalThis.setTimeout(() => {
      revealTimer = null
      done()
    }, REVEAL_HOLD_MS)
  }
  tick()
}

/**
 * Everything that waits for a pending reveal: the flip to the next card, and
 * the full-time overlay, which would otherwise cover the last word as it lands.
 */
function settleCard(state: GameState) {
  flip(state)
  app.classList.toggle('over', state.phase === 'over')
  if (state.phase !== 'over') return
  const { youScore, aiScore } = state
  verdict.textContent =
    youScore > aiScore ? 'You clue better.' : aiScore > youScore ? 'The AI clues better.' : 'Dead heat.'
  tally.textContent = `YOU ${youScore}  ·  AI ${aiScore}`
}

function flash(kind: NonNullable<GameState['feedback']>) {
  if (flashTimer !== null) clearTimeout(flashTimer)
  app.classList.remove('flash-correct', 'flash-violation', 'flash-skip')
  // Reflow so a repeated verdict re-triggers the transition.
  void app.offsetWidth
  app.classList.add(`flash-${kind}`)
  flashTimer = globalThis.setTimeout(() => {
    app.classList.remove('flash-correct', 'flash-violation', 'flash-skip')
    flashTimer = null
  }, FLASH_MS)
}

export function render(state: GameState) {
  // Before the first card there is no clock and no score to show, so both fade
  // out of the idle screen and arrive with the round. See #app.pregame.
  app.classList.toggle('pregame', state.phase === 'idle')

  // HUD — the clock, and nothing else.
  const running = state.phase === 'half1' || state.phase === 'half2'
  // After the whistle the card in play still counts, so say so rather than
  // showing a dead 0:00 that looks like the game has hung.
  clock.textContent = state.expired && running ? 'LAST' : formatClock(running ? state.secondsLeft : HALF_SECONDS)
  clock.classList.toggle('low', running && (state.expired || state.secondsLeft <= 15))

  // Scores
  scoreYou.textContent = String(state.youScore)
  scoreAi.textContent = String(state.aiScore)
  youBox.classList.toggle('active', state.phase === 'half1')
  aiBox.classList.toggle('active', state.phase === 'half2')

  // Ticker — the last two events, freshest emphasised.
  const recent = state.log.slice(-2)
  ticker.replaceChildren(
    ...recent.map((line, i) => {
      const div = document.createElement('div')
      div.textContent = line
      if (i === recent.length - 1) div.className = 'now'
      return div
    }),
  )

  // Card — reflip only when the word actually changed. Two things can hold the
  // outgoing face up first: a burned card is struck through, and a word the
  // human never saw is filled into its blanks. The flip (and the final
  // scoreboard) waits behind whichever applies.
  if (state.flipToken !== lastToken) {
    lastToken = state.flipToken
    if (state.feedback) flash(state.feedback)
    for (const pending of [revealTimer, strikeTimer]) if (pending !== null) clearTimeout(pending)
    for (const pending of spinTimers) clearTimeout(pending)
    revealTimer = null
    strikeTimer = null
    spinTimers = []

    // Three things can hold the outgoing face up, and only ever one of them: a
    // won word spins itself green, a burned one is struck, and a word the human
    // never saw is filled into its blanks. A win in half two is both the first
    // and the third, and the spin already shows the word — so it wins.
    const settle = () => settleCard(state)
    if (state.solved) celebrate(state.solved, settle)
    else if (state.struck) strikeCard(state.struck, () => (state.reveal ? revealWord(state.reveal, state.feedback, settle) : settle()))
    else if (state.reveal) revealWord(state.reveal, state.feedback, settle)
    else settle()
  }
}
