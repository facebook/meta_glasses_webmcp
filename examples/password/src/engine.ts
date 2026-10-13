/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure referee logic — no DOM, no WebMCP, no game state. Everything in here is
// a function of its arguments so the awkward parts (what counts as saying a
// banned word?) can be reasoned about and tested on their own.
import type { Card } from './deck.ts'

// Tuned against live play rather than guessed. One exchange — human speaks,
// agent reasons, agent calls a tool, agent speaks — measured 25-35s against
// a voice model on glasses, so the original 6 cards in 90s (15s a card) was not
// reachable: every test game got through three. Thirty seconds a card matches
// what a reasoning model actually does, and a fast realtime model simply ends
// the half early on cards instead of on the clock.
export const CARDS_PER_HALF = 4
export const HALF_SECONDS = 120
/** Rejected clues allowed per card in half two before the card burns. */
export const MAX_CLUE_REJECTS = 3

export const SCORE_CORRECT = 1
export const SCORE_VIOLATION = -1

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokens(text: string): string[] {
  const norm = normalize(text)
  return norm ? norm.split(' ') : []
}

/**
 * Does `token` count as the banned word `ban`?
 *
 * Prefix matching in both directions, because the deck stores base forms and
 * speech does not: "rings" must trip the ban on "ring", and "ring" must trip a
 * ban written as "rings". The four-character floor on the *shorter* side is
 * what keeps this from being a menace — without it, banning "arch" would fire
 * on "a", and banning "ice" would fire on half the dictionary.
 *
 * It is deliberately a little eager. Saying "planetary" when "planet" is banned
 * is exactly the dodge the rule exists to stop.
 */
export function violates(token: string, ban: string): boolean {
  const a = normalize(token)
  const b = normalize(ban)
  if (!a || !b) return false
  if (a === b) return true
  if (b.length >= 4 && a.startsWith(b)) return true
  if (a.length >= 4 && b.startsWith(a)) return true
  return false
}

/**
 * The first banned word (or the secret itself) present in `text`, or null.
 * Returns the *deck's* spelling of the word rather than what was spoken, so the
 * page and the agent can both point at the same thing.
 */
export function findViolation(text: string, card: Card): string | null {
  const forbidden = [card.secret, ...card.banned]
  for (const token of tokens(text)) {
    for (const ban of forbidden) {
      if (violates(token, ban)) return ban === card.secret ? card.secret : ban
    }
  }
  return null
}

/**
 * Did the speaker land the secret? Looser than the violation check on purpose:
 * a guess arrives as a whole spoken sentence ("uh, is it Saturn?") and only the
 * secret matters, so scan tokens for the secret alone.
 */
export function isCorrectGuess(heard: string, secret: string): boolean {
  return tokens(heard).some((token) => violates(token, secret))
}

/**
 * The first `shown` letters of the secret, the rest still blank:
 * `revealMask('SATURN', 3)` -> `"S A T _ _ _"`.
 *
 * Half two hides the word behind blanks, so this is how it comes back at the
 * end of a card — one letter at a time, in the slots the human has been staring
 * at. Non-letters are never hidden, so they do not animate either.
 */
export function revealMask(secret: string, shown: number): string {
  return secret
    .split('')
    .map((ch, i) => (i < shown || !/[a-z]/i.test(ch) ? ch : '_'))
    .join(' ')
}

/** "SATURN" -> "_ _ _ _ _ _" — what the human sees while the agent clues. */
export function blanks(secret: string): string {
  return revealMask(secret, 0)
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Fisher-Yates against an injectable source so tests can pin the order. */
export function shuffle<T>(items: readonly T[], rand: () => number = Math.random): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Deal a hand of `size` to each half, each from its own pool.
 *
 * The pools are fixed and never mix: half one always comes from the player
 * cards, half two always from the computer cards, so a word that is yours to
 * clue is never one the agent clues in a later game. Each pool is shuffled
 * independently, so which cards come up — and in what order — is still random
 * every round.
 *
 * This used to shuffle one bag and slice it in two, which made the halves
 * equally hard by construction and was the stated reason comparing the two
 * scores meant anything. That argument does not survive the split: the halves
 * now draw from sets curated for different guessers, so a difference in score
 * partly measures the pools. The full-time verdict is a scoreline, not a
 * finding.
 */
export function dealHalves(
  playerPool: readonly Card[],
  computerPool: readonly Card[],
  size = CARDS_PER_HALF,
  rand: () => number = Math.random,
): { first: Card[]; second: Card[] } {
  return {
    first: shuffle(playerPool, rand).slice(0, size),
    second: shuffle(computerPool, rand).slice(0, size),
  }
}
